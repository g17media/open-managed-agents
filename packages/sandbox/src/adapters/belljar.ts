// BelljarSandbox — REST adapter for belljar (self-hosted Cloudflare
// sandbox containers on any Docker/Podman host).
//
// belljar reimplements the Workers-side control plane of
// @cloudflare/sandbox as an ordinary HTTP service: it creates containers
// from the published `cloudflare/sandbox` image via a mounted engine
// socket and proxies `/v1/sandboxes/:id/api/*` verbatim to the container
// runtime on port 3000. This adapter gives OMA the *same container
// runtime* the CloudflareSandbox path uses — exec, process API, git
// checkout, code interpreter — without a Cloudflare account, by talking
// to a belljar instance over REST.
//
// Architecture:
//
//   [OMA main-node]
//        │ HTTP POST /v1/sandboxes/oma-<session>/api/execute
//        ▼
//   [belljar, any Docker/Podman host]
//        │ engine socket (create, start, stop, reap)
//        ▼
//   [cloudflare/sandbox container, runtime on :3000]
//
// Driver dep: zero — uses globalThis.fetch. The wire protocol is the
// @cloudflare/sandbox container API, which belljar mirrors exactly.
//
// Operator setup (out of scope for this adapter):
//   1. Run belljar (docker or `npm run dev`) on a Docker/Podman host.
//      Always set BELLJAR_TOKEN for anything beyond loopback.
//   2. Set `SANDBOX_PROVIDER=belljar BELLJAR_URL=http://belljar:8877
//      BELLJAR_TOKEN=...` on every OMA process.
//
// API surface (REST → SandboxExecutor):
//   exec          →  POST /v1/sandboxes/{id}/api/execute
//   startProcess  →  POST /v1/sandboxes/{id}/api/process/start
//   readFile      →  POST /v1/sandboxes/{id}/api/read   (base64 for bytes)
//   writeFile*    →  POST /v1/sandboxes/{id}/api/write
//   gitCheckout   →  POST /v1/sandboxes/{id}/api/git/checkout
//   destroy       →  DELETE /v1/sandboxes/{id}
//
// Sandbox lifecycle: lazy get-or-create on first use (belljar's
// POST /v1/sandboxes is get-or-create, so an OMA restart re-attaches to
// the session's existing container). belljar auto-stops idle sandboxes
// (BELLJAR_SLEEP_AFTER) and any proxied request wakes them, so a
// long-idle session's next exec transparently restarts the container.
// /workspace survives sleep/wake but not destroy.
//
// Mounts (litebox-style): mountMemoryStore / mountSessionOutputs collect
// bind volumes BEFORE the lazy create — Docker binds are fixed at
// container creation, so mounting after the sandbox exists throws. The
// bind source must be a path on the ENGINE HOST; when OMA itself runs in
// a container (compose), BELLJAR_MOUNT_PATH_MAP translates OMA-visible
// prefixes to host prefixes (e.g. "/app/data=/srv/oma/data"). The belljar
// server only accepts binds under its BELLJAR_ALLOWED_MOUNT_ROOTS
// allowlist. readOnly stores get a real `:ro` bind — OS-enforced.

import { mkdirSync } from "node:fs";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import type { ProcessHandle, SandboxExecutor, SandboxFactory } from "../ports";
import { sessionVaultProxyUrl } from "../vault-proxy";
import { getLogger } from "@open-managed-agents/observability";

const moduleLogger = getLogger("belljar-sandbox");

// Wire shapes mirroring @cloudflare/sandbox (belljar proxies them verbatim).
interface BelljarExecResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}
interface BelljarReadFileResult {
  content: string;
  encoding?: "utf-8" | "base64";
}
interface BelljarProcessRecord {
  id: string;
  pid?: number;
  status: "starting" | "running" | "completed" | "failed" | "killed" | "error";
  exitCode?: number;
}

export interface BelljarSandboxOptions {
  /** belljar base URL, e.g. `http://127.0.0.1:8877`. */
  baseUrl: string;
  /** Bearer token (BELLJAR_TOKEN on the belljar side). Optional only for
   *  loopback experiments — belljar refuses non-loopback binds without it. */
  token?: string;
  /** Sandbox image. Must be `cloudflare/sandbox` or a derived image — the
   *  adapter talks to that image's runtime API. When omitted, the belljar
   *  server's own BELLJAR_IMAGE default applies. */
  image?: string;
  /** Default per-command timeout in ms. */
  defaultTimeoutMs?: number;
  /** Used to name the sandbox — `oma-<sessionId>` is easy to spot in
   *  `GET /v1/sandboxes` and `docker ps`. */
  sessionId: string;
  /** Memory blob root as THIS process sees it — mountMemoryStore binds
   *  `<memoryRoot>/<storeId>` at /mnt/memory/<storeName>. */
  memoryRoot?: string;
  /** Session-outputs root as this process sees it — mountSessionOutputs
   *  binds `<outputsRoot>/<tenant>/<session>` at /mnt/session/outputs. */
  outputsRoot?: string;
  /** OMA-visible → engine-host path prefix rewrites applied to bind
   *  sources (needed when OMA runs in a container and the roots above are
   *  bind-mounted from the host). Longest matching prefix wins. */
  mountPathMap?: Array<{ from: string; to: string }>;
  /** Network-isolate the sandbox (BELLJAR_ISOLATION=1). belljar puts the
   *  container on a per-sandbox internal Docker network with no gateway —
   *  kernel-enforced, unlike the advisory HTTP_PROXY env. When oma-vault
   *  is configured (OMA_VAULT_PROXY_URL with a container hostname), it is
   *  attached to that network as the sandbox's ONLY egress path and
   *  belljar's own egress proxy is disabled — outbound traffic that
   *  doesn't go through the vault simply has no route. Requires a belljar
   *  build with isolation support (older servers ignore the field). */
  isolation?: boolean;
  /** Logger. */
  logger?: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };
}

export class BelljarSandbox implements SandboxExecutor {
  private readonly sandboxId: string;
  private createPromise: Promise<void> | null = null;
  private volumes: Array<{ hostPath: string; containerPath: string; readOnly: boolean }> = [];
  private envVars: Record<string, string> = {};
  private commandSecrets: Array<{ prefix: string; secrets: Record<string, string> }> = [];
  private pendingCaUpload: { hostPath: string; guestPath: string } | null = null;
  private defaultTimeoutMs: number;
  private logger: NonNullable<BelljarSandboxOptions["logger"]>;

  constructor(private opts: BelljarSandboxOptions) {
    if (!opts.baseUrl) throw new Error("BelljarSandbox: baseUrl required");
    this.sandboxId = `oma-${opts.sessionId.slice(0, 40)}`;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 120_000;
    this.logger = opts.logger ?? {
      warn: (msg, ctx) => moduleLogger.warn({ ...(ctx as Record<string, unknown> ?? {}) }, msg),
      log: (msg) => moduleLogger.info(msg),
    };
  }

  // ── core API ─────────────────────────────────────────────────────────

  async exec(command: string, timeout?: number): Promise<string> {
    // Subshell-wrap: the runtime executes commands in a session's
    // persistent shell, so a bare `exit 1` kills the shell and every
    // later exec 410s with SESSION_TERMINATED. `( … )` confines exit to
    // the command — same semantics as the other adapters' `/bin/sh -c`.
    // The newline before `)` keeps trailing `# comments` from eating it.
    const res = await this.runtimePost("/api/execute", {
      command: `(\n${command}\n)`,
      cwd: "/workspace",
      env: this.buildEnv(command),
      timeoutMs: timeout ?? this.defaultTimeoutMs,
    });
    const result = (await res.json()) as BelljarExecResult;
    // Match @cloudflare/sandbox's behaviour: combined stdout+stderr,
    // newline-trimmed, plus an exit-code suffix the harness can parse.
    return (
      (result.stdout + (result.stderr ? `\n${result.stderr}` : "")).replace(/\s+$/, "") +
      (result.exitCode !== 0 ? `\n[exit ${result.exitCode}]` : "")
    );
  }

  async startProcess(command: string): Promise<ProcessHandle | null> {
    const res = await this.runtimePost("/api/process/start", {
      command,
      cwd: "/workspace",
      env: this.buildEnv(command),
    });
    const body = (await res.json()) as { processId?: string; pid?: number };
    if (!body.processId) return null;
    return new BelljarProcessHandle(body.processId, body.pid ?? 0, this);
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    // Stored locally; merged into every execute / process-start request.
    // The runtime applies per-command env, so no container restart needed.
    this.envVars = { ...this.envVars, ...envVars };
  }

  registerCommandSecrets(commandPrefix: string, secrets: Record<string, string>): void {
    this.commandSecrets.push({ prefix: commandPrefix, secrets });
  }

  async setOutboundContext(opts?: { tenantId: string; sessionId: string }): Promise<void> {
    // Same env-var pattern as the other remote adapters: point the
    // container at the oma-vault MITM proxy and trust its CA. The sandbox
    // is a sibling container on the belljar host — a localhost proxy URL
    // resolves to the *sandbox* container, not the OMA host. Use
    // host.docker.internal / a routable address instead.
    const baseProxyUrl = process.env.OMA_VAULT_PROXY_URL;
    const caCertPath = process.env.OMA_VAULT_CA_CERT;
    if (!baseProxyUrl || !caCertPath) return;
    if (baseProxyUrl.startsWith("http://localhost") || baseProxyUrl.startsWith("http://127.")) {
      this.logger.warn(
        `belljar: OMA_VAULT_PROXY_URL points at localhost (${baseProxyUrl}) — ` +
        `unreachable from inside the sandbox container. Use host.docker.internal or a routable host.`,
      );
    }
    if (this.opts.isolation && !containerHostname(baseProxyUrl)) {
      this.logger.warn(
        `belljar: sandbox is isolated but OMA_VAULT_PROXY_URL (${baseProxyUrl}) is not a ` +
        `container name — an isolated sandbox has no route to host addresses, so vault ` +
        `traffic will fail. Point OMA_VAULT_PROXY_URL at the oma-vault container name.`,
      );
    }
    const proxyUrl = sessionVaultProxyUrl(baseProxyUrl, opts);
    const inBoxCaPath = "/etc/ssl/oma-vault-ca.crt";
    await this.setEnvVars({
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NODE_EXTRA_CA_CERTS: inBoxCaPath,
      SSL_CERT_FILE: inBoxCaPath,
      CURL_CA_BUNDLE: inBoxCaPath,
    });
    this.pendingCaUpload = { hostPath: caCertPath, guestPath: inBoxCaPath };
    // Never trigger creation from here: the orchestrator runs outbound
    // wiring BEFORE mounts, and mounts must be collected pre-create.
    // createSandbox applies the pending upload; if the sandbox somehow
    // already exists, apply now.
    if (this.createPromise) {
      try {
        await this.createPromise;
        await this.uploadPendingCaRaw();
      } catch (err) {
        this.logger.warn(`belljar vault CA upload failed: ${(err as Error).message}`);
      }
    }
  }

  async mountMemoryStore(opts: {
    storeName: string;
    storeId: string;
    readOnly: boolean;
  }): Promise<void> {
    if (this.createPromise) {
      throw new Error(
        "BelljarSandbox.mountMemoryStore: sandbox already created — Docker binds " +
        "are fixed at creation, so mounts must be configured before the first " +
        "exec/readFile/writeFile call",
      );
    }
    if (!this.opts.memoryRoot) {
      throw new Error(
        "BelljarSandbox.mountMemoryStore: memoryRoot not configured — wire " +
        "ctx.memoryRoot (MEMORY_BLOB_DIR) through the factory",
      );
    }
    const sourceDir = join(resolve(this.opts.memoryRoot), opts.storeId);
    mkdirSync(sourceDir, { recursive: true });
    this.volumes.push({
      hostPath: this.toEngineHostPath(sourceDir),
      containerPath: `/mnt/memory/${opts.storeName}`,
      readOnly: opts.readOnly,
    });
  }

  async mountSessionOutputs(opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<void> {
    if (this.createPromise) {
      throw new Error(
        "BelljarSandbox.mountSessionOutputs: sandbox already created — mounts " +
        "must be configured before the first exec/readFile/writeFile call",
      );
    }
    if (!this.opts.outputsRoot) {
      throw new Error(
        "BelljarSandbox.mountSessionOutputs: outputsRoot not configured — wire " +
        "ctx.outputsRoot (SESSION_OUTPUTS_DIR) through the factory",
      );
    }
    const sourceDir = join(resolve(this.opts.outputsRoot), opts.tenantId, opts.sessionId);
    mkdirSync(sourceDir, { recursive: true });
    this.volumes.push({
      hostPath: this.toEngineHostPath(sourceDir),
      containerPath: "/mnt/session/outputs",
      readOnly: false,
    });
  }

  async gitCheckout(
    repoUrl: string,
    options: { branch?: string; targetDir?: string },
  ): Promise<unknown> {
    const res = await this.runtimePost("/api/git/checkout", {
      repoUrl,
      branch: options.branch,
      targetDir: options.targetDir ?? `/workspace/${repoNameFromUrl(repoUrl)}`,
    });
    return res.json();
  }

  // ── files ────────────────────────────────────────────────────────────

  async readFile(path: string): Promise<string> {
    const res = await this.runtimePost("/api/read", { path });
    const body = (await res.json()) as BelljarReadFileResult;
    // The runtime base64-encodes content it detects as binary.
    if (body.encoding === "base64") return Buffer.from(body.content, "base64").toString("utf-8");
    return body.content;
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const res = await this.runtimePost("/api/read", { path, encoding: "base64" });
    const body = (await res.json()) as BelljarReadFileResult;
    const buf = body.encoding === "base64" || !body.encoding
      ? Buffer.from(body.content, "base64")
      : Buffer.from(body.content, "utf-8");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async writeFile(path: string, content: string): Promise<string> {
    await this.runtimePost("/api/write", { path, content });
    return path;
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    await this.runtimePost("/api/write", {
      path,
      content: Buffer.from(bytes).toString("base64"),
      encoding: "base64",
    });
    return path;
  }

  // ── lifecycle ────────────────────────────────────────────────────────

  async renewActivityTimeout(): Promise<void> {
    // Any proxied request resets belljar's idle timer (BELLJAR_SLEEP_AFTER)
    // and wakes a sleeping container. Ping only if we ever created it —
    // pinging first would needlessly provision a container.
    if (!this.createPromise) return;
    try {
      await this.fetch(`/v1/sandboxes/${this.sandboxId}/api/ping`);
    } catch (err) {
      this.logger.warn(`belljar renewActivityTimeout failed: ${(err as Error).message}`);
    }
  }

  async destroy(): Promise<void> {
    // Unconditional DELETE (not gated on createPromise): with get-or-create
    // semantics the container may pre-date this adapter instance (OMA
    // restart). 404 = already gone.
    try {
      const res = await this.fetch(`/v1/sandboxes/${this.sandboxId}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        this.logger.warn(`belljar destroy non-OK: ${res.status} ${await res.text()}`);
      }
    } catch (err) {
      this.logger.warn(`belljar destroy error: ${(err as Error).message}`);
    } finally {
      this.createPromise = null;
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private ensureSandbox(): Promise<void> {
    if (!this.createPromise) {
      this.createPromise = this.createSandbox();
      this.createPromise.catch(() => {
        this.createPromise = null;
      });
    }
    return this.createPromise;
  }

  private async createSandbox(): Promise<void> {
    const body: Record<string, unknown> = { id: this.sandboxId };
    if (this.opts.image) body.image = this.opts.image;
    if (this.volumes.length) body.mounts = this.volumes;
    if (this.opts.isolation) body.isolation = this.buildIsolation();
    const res = await this.fetch("/v1/sandboxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`belljar create failed: ${res.status} ${await res.text()}`);
    }
    this.logger.log(`sandbox ${this.sandboxId} ready (${this.opts.image ?? "server default image"})`);
    if (this.pendingCaUpload) {
      try {
        await this.uploadPendingCaRaw();
      } catch (err) {
        this.logger.warn(`belljar vault CA upload failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Isolation shape for the belljar create request. When the vault proxy
   * URL names a container (the compose case: http://oma-vault:14322),
   * that container becomes the sandbox's egress: belljar attaches it to
   * the sandbox's internal network and disables its own egress proxy, so
   * the vault's attribution/credential-injection cannot be bypassed. A
   * vault URL that is NOT a container name (localhost, host.docker.internal,
   * an IP) is unreachable from an internal network — fall back to belljar's
   * sidecar proxy as the egress and warn, rather than provisioning a
   * sandbox whose vault path is dead.
   */
  private buildIsolation(): boolean | Record<string, unknown> {
    const vaultUrl = process.env.OMA_VAULT_PROXY_URL;
    const vaultHost = vaultUrl ? containerHostname(vaultUrl) : null;
    if (vaultHost) return { egress: false, attach: [vaultHost] };
    if (vaultUrl) {
      this.logger.warn(
        `belljar isolation: OMA_VAULT_PROXY_URL (${vaultUrl}) does not name a container, ` +
        `so it cannot be attached to the sandbox's internal network — falling back to ` +
        `belljar's sidecar proxy for egress. Run oma-vault as a container and point ` +
        `OMA_VAULT_PROXY_URL at its container name to make the vault the enforced egress.`,
      );
    }
    return true;
  }

  /** Rewrite an OMA-visible path to the engine-host path Docker binds
   *  need, via the configured prefix map. Longest matching prefix wins;
   *  unmapped paths pass through (OMA running directly on the host). */
  private toEngineHostPath(p: string): string {
    let best: { from: string; to: string } | null = null;
    for (const m of this.opts.mountPathMap ?? []) {
      if (p === m.from || p.startsWith(`${m.from}/`)) {
        if (!best || m.from.length > best.from.length) best = m;
      }
    }
    return best ? best.to + p.slice(best.from.length) : p;
  }

  /**
   * Write the pending CA cert with a direct runtime call, NOT via
   * writeFileBytes/runtimePost. Those await ensureSandbox — called from
   * inside createSandbox that would await the still-pending createPromise,
   * i.e. createSandbox awaiting its own completion. (Deadlocked exactly
   * that way once: session provisioning froze forever on the CA upload.)
   */
  private async uploadPendingCaRaw(): Promise<void> {
    if (!this.pendingCaUpload) return;
    const { hostPath, guestPath } = this.pendingCaUpload;
    const { promises: nodeFs } = await import("node:fs");
    const buf = await nodeFs.readFile(hostPath);
    const res = await this.fetch(`/v1/sandboxes/${this.sandboxId}/api/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: guestPath,
        content: Buffer.from(buf).toString("base64"),
        encoding: "base64",
      }),
    });
    if (!res.ok) {
      throw new Error(`belljar CA write failed: ${res.status} ${await res.text()}`);
    }
    this.pendingCaUpload = null;
  }

  private async runtimePost(path: string, body: Record<string, unknown>): Promise<Response> {
    await this.ensureSandbox();
    const send = () =>
      this.fetch(`/v1/sandboxes/${this.sandboxId}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(stripUndefined(body)),
      });
    let res = await send();
    // 410 SESSION_TERMINATED: the session's shell died (crash, OOM, an
    // unwrapped exit). The runtime recreates the session on the next
    // call, so one retry recovers.
    if (res.status === 410) {
      this.logger.warn(`belljar ${path}: session terminated, retrying once`);
      res = await send();
    }
    if (!res.ok) {
      throw new Error(`belljar ${path} failed: ${res.status} ${await res.text()}`);
    }
    return res;
  }

  /** GET/DELETE on the runtime API for process-handle plumbing. */
  async runtimeFetch(path: string, init: RequestInit = {}): Promise<Response> {
    await this.ensureSandbox();
    return this.fetch(`/v1/sandboxes/${this.sandboxId}${path}`, init);
  }

  private fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}${path}`;
    const headers = new Headers(init.headers);
    if (this.opts.token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${this.opts.token}`);
    }
    return globalThis.fetch(url, { ...init, headers });
  }

  private buildEnv(command: string): Record<string, string> | undefined {
    const env: Record<string, string> = { ...this.envVars };
    for (const { prefix, secrets } of this.commandSecrets) {
      if (command.startsWith(prefix)) Object.assign(env, secrets);
    }
    return Object.keys(env).length > 0 ? env : undefined;
  }
}

class BelljarProcessHandle implements ProcessHandle {
  constructor(
    public id: string,
    public pid: number,
    private sandbox: BelljarSandbox,
  ) {}

  async kill(_signal: string): Promise<void> {
    // The runtime's process API has a single kill (no signal choice).
    const res = await this.sandbox.runtimeFetch(
      `/api/process/${encodeURIComponent(this.id)}`,
      { method: "DELETE" },
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`kill failed: ${res.status} ${await res.text()}`);
    }
  }

  async getLogs(): Promise<{ stdout: string; stderr: string }> {
    const res = await this.sandbox.runtimeFetch(
      `/api/process/${encodeURIComponent(this.id)}/logs`,
    );
    if (!res.ok) return { stdout: "", stderr: "" };
    const body = (await res.json()) as { stdout?: string; stderr?: string };
    return { stdout: body.stdout ?? "", stderr: body.stderr ?? "" };
  }

  async getStatus(): Promise<string> {
    const res = await this.sandbox.runtimeFetch(
      `/api/process/${encodeURIComponent(this.id)}`,
    );
    // Record gone (autoCleanup / container recycled): report a terminal
    // state so the harness's poll loop stops instead of hanging.
    if (res.status === 404) return "completed";
    if (!res.ok) return "error";
    const body = (await res.json()) as { process?: BelljarProcessRecord };
    const status = body.process?.status ?? "error";
    // Map onto the vocabulary the harness polls for exactly:
    // "completed" / "error" / "killed" terminal, anything else = running.
    if (status === "starting") return "running";
    if (status === "failed") return "error";
    return status;
  }
}

function repoNameFromUrl(repoUrl: string): string {
  const last = repoUrl.split("/").pop() ?? "repo";
  return last.replace(/\.git$/, "") || "repo";
}

/** Hostname of `url` when it plausibly names a sibling container (a Docker
 *  DNS name), else null: localhost, host-gateway aliases and IP literals
 *  are host-side addresses no internal-network sandbox can reach. */
function containerHostname(url: string): string | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!hostname || isIP(hostname.replace(/^\[|\]$/g, ""))) return null;
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower === "host.docker.internal" || lower === "gateway.docker.internal") {
    return null;
  }
  return hostname;
}

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

// ── Factory (DIP entry point) ───────────────────────────────────────
//
// Host code (apps/main-node) only knows the provider name → import path
// map and never reads BELLJAR_* env vars itself.

export const sandboxFactory: SandboxFactory = async (ctx, env) => {
  const baseUrl = env.BELLJAR_URL;
  if (!baseUrl) {
    throw new Error(
      "SANDBOX_PROVIDER=belljar requires BELLJAR_URL " +
        "(e.g. http://127.0.0.1:8877)",
    );
  }
  return new BelljarSandbox({
    baseUrl,
    token: env.BELLJAR_TOKEN,
    // NOTE: unlike other providers, SANDBOX_IMAGE here must be
    // `cloudflare/sandbox` or an image derived from it — the adapter
    // speaks that image's runtime API. Leave unset to use the belljar
    // server's BELLJAR_IMAGE default.
    image: env.SANDBOX_IMAGE,
    sessionId: ctx.sessionId,
    memoryRoot: ctx.memoryRoot,
    outputsRoot: ctx.outputsRoot,
    mountPathMap: parseMountPathMap(env.BELLJAR_MOUNT_PATH_MAP),
    isolation: env.BELLJAR_ISOLATION === "1" || env.BELLJAR_ISOLATION === "true",
  });
};

/** Parse "from=to[,from2=to2]" (e.g. "/app/data=/srv/oma/data"). */
function parseMountPathMap(
  raw: string | undefined,
): Array<{ from: string; to: string }> {
  if (!raw) return [];
  return raw
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf("=");
      if (idx < 1 || idx === pair.length - 1) {
        throw new Error(
          `BELLJAR_MOUNT_PATH_MAP entry "${pair}" is not "from=to"`,
        );
      }
      return { from: pair.slice(0, idx), to: pair.slice(idx + 1) };
    });
}
