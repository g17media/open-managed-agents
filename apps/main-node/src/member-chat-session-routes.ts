// Native session extensions preserve workspace ownership across file transfer and cleanup retries.
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { FilesApplicationPort } from "@open-managed-agents/managed-agents-application/ports/files";
import type { SessionsApplicationPort } from "@open-managed-agents/managed-agents-application/ports/sessions";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";

interface Dependencies {
  ports(workspaceId: string): { sessions: SessionsApplicationPort; files: FilesApplicationPort };
  connectedSandbox(input: { workspaceId: string; sessionId: string }): SandboxExecutor | null;
  outputs: {
    deleteAll(workspaceId: string, sessionId: string): Promise<void>;
    list(workspaceId: string, sessionId: string): Promise<unknown[] | null>;
  };
}

/** Mount below authenticated /v1. Every operation resolves the native workspace session first. */
export function buildMemberChatSessionRoutes(deps: Dependencies): Hono<{ Variables: { tenant_id: string } }> {
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("/:id/*", async (c, next) => {
    const betas = new Set((c.req.header("anthropic-beta") ?? "").split(",").map((value) => value.trim()));
    if (!betas.has("managed-agents-2026-04-01")) return c.json({ error: "Managed agents beta required" }, 400);
    const found = await deps.ports(c.var.tenant_id).sessions.retrieveSession({ sessionId: c.req.param("id")! });
    if (found.type !== "found") return c.json({ error: "Session not found" }, 404);
    await next();
  });
  app.post("/:id/input-files", bodyLimit({ maxSize: 21 * 1024 * 1024 }), async (c) => {
    // A scoped multipart extension is necessary because public Files intentionally ignores scope.
    const betas = (c.req.header("anthropic-beta") ?? "").split(",").map((value) => value.trim());
    if (!betas.includes("files-api-2025-04-14")) return c.json({ error: "Files beta required" }, 400);
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File) || !file.name || /[\\/\x00-\x1f\x7f]/.test(file.name) || file.size > 20 * 1024 * 1024) return c.json({ error: "Invalid file" }, 400);
    const result = await deps.ports(c.var.tenant_id).files.uploadFile({
      scope: { type: "session", id: c.req.param("id") },
      filename: file.name, mimeType: file.type || "application/octet-stream", content: new Uint8Array(await file.arrayBuffer()),
    });
    if (result.type !== "uploaded") return c.json({ error: "Invalid upload" }, 400);
    return c.json({ id: result.file.id }, 201);
  });
  app.post("/:id/exec", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const body = await c.req.json<{ command?: string; timeout_ms?: number }>().catch(() => null);
    if (!body || typeof body.command !== "string" || !body.command.trim()) return c.json({ error: "Command required" }, 400);
    const timeout = body.timeout_ms ?? 30_000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000) return c.json({ error: "Invalid timeout" }, 400);
    const sandbox = deps.connectedSandbox({ workspaceId: c.var.tenant_id, sessionId: c.req.param("id") });
    if (!sandbox) return c.json({ error: "Session runtime unavailable" }, 409);
    if (!sandbox.execResult) return c.json({ error: "Structured execution unavailable" }, 503);
    // Preserve actual exit status; parsing a provider's decorated stdout can falsely accept failure.
    const result = await sandbox.execResult(body.command, timeout);
    const truncated = Buffer.byteLength(result.stdout) > 4 * 1024 * 1024;
    return c.json({ exit_code: result.exitCode, output: truncated ? "" : result.stdout, truncated });
  });
  app.delete("/:id/outputs", async (c) => {
    const workspaceId = c.var.tenant_id;
    const sessionId = c.req.param("id");
    await deps.outputs.deleteAll(workspaceId, sessionId);
    const remaining = await deps.outputs.list(workspaceId, sessionId);
    if (remaining?.length) return c.json({ error: "Output cleanup incomplete" }, 503);
    return c.json({ type: "session_outputs_deleted", session_id: sessionId });
  });
  return app;
}
