// Exercise the actual extension routes without a live agent or credentials.
import { expect, test } from "bun:test";
import { Hono } from "hono";
import { buildMemberChatSessionRoutes } from "../src/member-chat-session-routes";
import { nodeOutputsAdapter } from "../src/lib/node-outputs-adapter";
import { FilesApplicationService } from "../../../packages/managed-agents-application/src/files/application";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

const beta = { "anthropic-beta": "managed-agents-2026-04-01,files-api-2025-04-14" };
function fixture(outputs: Parameters<typeof buildMemberChatSessionRoutes>[0]["outputs"]) {
  const uploads: unknown[] = [];
  const connections: unknown[] = [];
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => { c.set("tenant_id", "owner"); await next(); });
  app.route("/v1/sessions", buildMemberChatSessionRoutes({
    ports: (workspaceId) => ({
      sessions: { retrieveSession: async ({ sessionId }: { sessionId: string }) => workspaceId === "owner" && sessionId === "native" ? { type: "found" } : { type: "not_found" } },
      files: { uploadFile: async (input: unknown) => { uploads.push(input); return { type: "uploaded", file: { id: "input" } }; } },
    }) as never,
    connectedSandbox: (input) => { connections.push(input); return { execResult: async () => ({ stdout: "[]", stderr: "", exitCode: 0 }) } as never; },
    outputs,
  }));
  return { app, uploads, connections };
}
const emptyOutputs = { deleteAll: async () => {}, list: async () => [] };
test("native exec uses authenticated workspace runner and refuses foreign sessions", async () => {
  const { app, connections } = fixture(emptyOutputs);
  const init = { method: "POST", headers: { ...beta, "content-type": "application/json" }, body: JSON.stringify({ command: "echo", timeout_ms: 30_000 }) };
  const response = await app.request("/v1/sessions/native/exec", init);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ output: "[]", exit_code: 0, truncated: false });
  expect((await app.request("/v1/sessions/foreign/exec", init)).status).toBe(404);
  expect(connections).toEqual([{ workspaceId: "owner", sessionId: "native" }]);
});
test("multipart upload binds scope before returning a receipt and ignores caller scope", async () => {
  const { app, uploads } = fixture(emptyOutputs);
  const body = new FormData();
  body.set("file", new File(["private"], "notes.txt", { type: "application/octet-stream" }));
  body.set("scope_id", "foreign");
  const response = await app.request("/v1/sessions/native/input-files", { method: "POST", headers: beta, body });
  expect(response.status).toBe(201);
  expect(uploads).toEqual([{ scope: { type: "session", id: "native" }, filename: "notes.txt", mimeType: "text/plain;charset=utf-8", content: new TextEncoder().encode("private") }]);
  expect((await app.request("/v1/sessions/foreign/input-files", { method: "POST", headers: beta, body })).status).toBe(404);
  expect(uploads).toHaveLength(1);
});
test("cleanup deletes actual Node output bytes only in the owning workspace", async () => {
  const root = await mkdtemp("/tmp/native-chat-outputs-");
  const adapter = nodeOutputsAdapter(root);
  try {
    for (const workspace of ["owner", "foreign"]) {
      await mkdir(join(root, workspace, "native"), { recursive: true });
      await writeFile(join(root, workspace, "native", "private.txt"), "private");
    }
    const { app } = fixture(adapter);
    expect((await app.request("/v1/sessions/native/outputs", { method: "DELETE", headers: beta })).status).toBe(200);
    expect(await adapter.list("owner", "native")).toEqual([]);
    expect(await adapter.list("foreign", "native")).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("incomplete output deletion is retriable", async () => {
  const { app } = fixture({ deleteAll: async () => {}, list: async () => ["remaining"] });
  expect((await app.request("/v1/sessions/native/outputs", { method: "DELETE", headers: beta })).status).toBe(503);
});
test("a blob deletion failure preserves the scoped metadata for another attempt", async () => {
  let metadata = true;
  let fail = true;
  const service = new FilesApplicationService({ workspaceId: "owner", store: {
    find: async () => metadata ? { id: "input" } : null,
    delete: async () => { metadata = false; return { type: "deleted" }; },
  }, content: { delete: async () => { if (fail) throw new Error("disk failure"); } } } as never);
  await expect(service.deleteFile({ fileId: "input" })).rejects.toThrow("disk failure");
  expect(metadata).toBe(true);
  fail = false;
  expect(await service.deleteFile({ fileId: "input" })).toEqual({ type: "deleted", fileId: "input" });
  expect(metadata).toBe(false);
});

test("actual public events route consumes opaque page and requires the managed beta", async () => {
  const { buildSessionEventRoutes } = await import("../../../packages/managed-agents-api/src/routes/session-events");
  const queries: unknown[] = [];
  const app = buildSessionEventRoutes({ listSessionEvents: async (query: unknown) => {
    queries.push(query);
    return { type: "page", page: { events: [], nextCursor: "opaque/next+page" } };
  } } as never);
  const response = await app.request("/native/events?page=opaque%2Ffirst%2Bpage&order=asc&limit=500", { headers: beta });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: [], next_page: "opaque/next+page" });
  expect(queries).toEqual([{ sessionId: "native", cursor: "opaque/first+page", order: "asc", pageSize: 500 }]);
  expect((await app.request("/native/events")).status).toBe(400);
});
