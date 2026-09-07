import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { EnvironmentConfig, SandboxStartupEvent, SandboxStartupTrigger } from "@open-managed-agents/shared";
import { BelljarSandbox } from "@open-managed-agents/sandbox/adapters/belljar";
import { runStartupScript } from "@open-managed-agents/sandbox/startup";

export interface BelljarLifecyclePayload {
  ownerId: string;
  sandboxId: string;
  bootId: string;
  event: SandboxStartupTrigger;
  initializationToken: string;
}

interface Session {
  id: string;
  tenant_id: string;
  status: string;
  environment_snapshot: EnvironmentConfig | null;
}

export function buildBelljarLifecycleRoutes(deps: {
  token?: string;
  getSession(sessionId: string): Promise<Session | null>;
  completed(sessionId: string, bootId: string): Promise<boolean>;
  emit(sessionId: string, event: SandboxStartupEvent): Promise<void>;
  buildSandbox(payload: BelljarLifecyclePayload): BelljarSandbox;
  prepare(session: Session, sandbox: BelljarSandbox, trigger: SandboxStartupTrigger): Promise<void>;
}) {
  const app = new Hono();
  const active = new Map<string, Promise<void>>();
  app.use("*", bodyLimit({ maxSize: 8192 }));
  app.post("/", async (c) => {
    const expected = Buffer.from(`Bearer ${deps.token ?? ""}`);
    const actual = Buffer.from(c.req.header("authorization") ?? "");
    if (!deps.token || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return c.json({ error: "Invalid Belljar callback credential" }, 401);
    }
    let payload: BelljarLifecyclePayload;
    try { payload = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
    if (!payload || typeof payload.ownerId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(payload.ownerId) ||
      payload.sandboxId !== `oma-${payload.ownerId.slice(0, 40)}` ||
      typeof payload.bootId !== "string" || !/^[a-f0-9]{64}$/.test(payload.bootId) ||
      typeof payload.initializationToken !== "string" || !/^[a-f0-9]{64}$/.test(payload.initializationToken) ||
      !["create", "wake", "revive"].includes(payload.event)) {
      return c.json({ error: "Invalid lifecycle callback" }, 400);
    }
    const session = await deps.getSession(payload.ownerId);
    if (!session || session.status === "terminated") return c.json({ error: "Session is unavailable" }, 404);
    const key = `${session.id}:${payload.bootId}`;
    try {
      let pending = active.get(key);
      if (!pending) {
        pending = (async () => {
          // Durable acknowledgement handles response loss and either service restarting.
          if (await deps.completed(session.id, payload.bootId)) return;
          // Independent adapter: the registry's adapter may be waiting on this callback.
          const sandbox = deps.buildSandbox(payload);
          await runStartupScript({ sandbox, config: session.environment_snapshot?.config.startup,
            bootId: payload.bootId, trigger: payload.event,
            prepare: () => deps.prepare(session, sandbox, payload.event),
            emit: (event) => deps.emit(session.id, event) });
        })();
        active.set(key, pending);
        void pending.finally(() => { if (active.get(key) === pending) active.delete(key); }).catch(() => undefined);
      }
      await pending;
      return c.json({ bootId: payload.bootId, ready: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error), bootId: payload.bootId }, 503);
    }
  });
  return app;
}
