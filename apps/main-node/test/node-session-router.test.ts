// NodeSessionRouter.appendEvent: what the HTTP layer does with an event
// before (and after) it reaches the session registry. Everything under the
// router is a hand-rolled fake — its only I/O is the event log, the hub and
// the registry — so there is no SQL, no sandbox and no model here.
import { describe, expect, it } from "vitest";
import { NodeSessionRouter } from "../src/lib/node-session-router";

/**
 * An in-memory stand-in for SqlEventLog: rows get a per-session `seq` on
 * insert, and reads honour `afterSeq` exactly as the SQL impl does.
 * `onAppend` runs after a row lands, which is how a test interleaves a
 * concurrent write into the window between persisting and publishing.
 */
function makeLog(onAppend?: (rows: any[]) => void) {
  const rows: any[] = [];
  const reads: (number | undefined)[] = [];
  return {
    rows,
    reads,
    log: {
      appendAsync: async (event: any) => {
        rows.push({ ...event, seq: rows.length + 1 });
        onAppend?.(rows);
      },
      getEventsAsync: async (afterSeq?: number) => {
        reads.push(afterSeq);
        return afterSeq === undefined ? rows.slice() : rows.filter((r) => r.seq > afterSeq);
      },
      getLastEventSeqAsync: async (type: string) =>
        rows.reduce((max, r) => (r.type === type && r.seq > max ? r.seq : max), -1),
    },
  };
}

describe("NodeSessionRouter", () => {
  it("publishes session.error when session initialization fails", async () => {
    const events: any[] = [];
    const log = {
      appendAsync: async (event: any) => {
        events.push(event);
      },
      getEventsAsync: async () => events,
    };
    const router = new NodeSessionRouter({
      sql: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({ tenant_id: "tenant-1", agent_id: "agent-1" }),
          }),
        }),
      } as any,
      hub: { publish: (_sessionId: string, event: unknown) => events.push(event) } as any,
      registry: {
        getOrCreate: async () => {
          throw new Error("sandbox unavailable");
        },
        interrupt: () => undefined,
      } as any,
      newEventLog: () => log as any,
    });

    await expect(
      router.appendEvent("session-1", {
        type: "user.message",
        message: { role: "user", content: "hello" },
      } as any),
    ).resolves.toMatchObject({ status: 202 });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "session.error",
          error: "session_initialization_failed",
          message: "sandbox unavailable",
        }),
      ]),
    );
  });

  it("interrupt publishes the row it appended, not whatever landed last", async () => {
    // The abort races the aborted turn's own terminal event, so another row
    // can land between our append and our read. Publishing "the last row in
    // the log" then announced session.status_idle under the interrupt's name.
    const published: any[] = [];
    const { log, reads, rows } = makeLog((all) => {
      if (all.length === 1) all.push({ type: "session.status_idle", seq: all.length + 1 });
    });
    let interrupted = 0;
    const router = new NodeSessionRouter({
      sql: {} as any,
      hub: { publish: (_sid: string, event: unknown) => published.push(event) } as any,
      registry: { interrupt: () => { interrupted++; } } as any,
      newEventLog: () => log as any,
    });

    await expect(
      router.appendEvent("session-1", { type: "user.interrupt" } as any),
    ).resolves.toMatchObject({ status: 202 });

    expect(published.map((e) => e.type)).toEqual(["user.interrupt"]);
    expect(published[0].seq).toBe(1);
    expect(rows).toHaveLength(2);
    expect(interrupted).toBe(1);
    // And the publish must not cost a full-history read: a long-lived session's
    // log is unbounded, and the abort waits behind it.
    expect(reads.every((afterSeq) => afterSeq !== undefined)).toBe(true);
  });

  it("interrupt still aborts the turn when persisting it fails", async () => {
    // A DB failure must not leave the harness running with no way to stop it.
    let interrupted = 0;
    const router = new NodeSessionRouter({
      sql: {} as any,
      hub: { publish: () => undefined } as any,
      registry: { interrupt: () => { interrupted++; } } as any,
      newEventLog: () =>
        ({
          appendAsync: async () => { throw new Error("db down"); },
          getEventsAsync: async () => [],
          getLastEventSeqAsync: async () => -1,
        }) as any,
    });

    await expect(
      router.appendEvent("session-1", { type: "user.interrupt" } as any),
    ).resolves.toMatchObject({ status: 202 });
    expect(interrupted).toBe(1);
  });
});
