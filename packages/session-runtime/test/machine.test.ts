// SessionStateMachine turn-lifecycle tests, focused on user.interrupt.
//
// What this proves: a turn cancelled through `machine.interrupt()` ends
// like the CF SessionDO ends one — the harness's abortSignal fires, the
// turn closes with a single terminal `session.status_idle`, NO
// `session.error` is written, and `runHarnessTurn` resolves instead of
// rejecting (a user pressing stop is not a failure). The two shapes an
// aborted harness can take are both covered: streamText rejecting with an
// AbortError, and the AI SDK's onAbort path where run() resolves normally.
//
// Everything below the machine is a hand-rolled fake — the machine's only
// I/O is through RuntimeAdapter + the build* callbacks, so no SQL, no
// sandbox, no model.

import { describe, it, expect } from "vitest";
import type { SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";
import { SessionStateMachine } from "@open-managed-agents/session-runtime/machine";
import type { RuntimeAdapter } from "@open-managed-agents/session-runtime/ports";

interface Harness {
  run: (ctx: unknown) => Promise<void>;
}

interface Fixture {
  machine: SessionStateMachine;
  /** Events appended through the adapter's event log, in order. */
  appended: SessionEvent[];
  /** Events handed to deps.publish, in order. */
  published: SessionEvent[];
  /** beginTurn / endTurn call log: ["begin:<id>", "end:<id>:<status>"]. */
  turnCalls: string[];
  /** The context object buildHarnessContext produced for the last turn. */
  lastCtx: () => { abortSignal?: AbortSignal } | null;
  promoted: () => number;
}

/** Knobs for the failure shapes the machine has to survive. */
interface FixtureOptions {
  /** beginTurn rejects — the session row could not be marked running. */
  failBeginTurn?: boolean;
  /** Runs inside `adapter.endTurn`, i.e. inside the await window between the
   *  machine dropping its own registration and reading liveness for the
   *  terminal event. Lets a test start a turn in exactly that window. */
  onEndTurn?: () => Promise<void>;
}

function makeFixture(harness: Harness, options: FixtureOptions = {}): Fixture {
  const appended: SessionEvent[] = [];
  const published: SessionEvent[] = [];
  const turnCalls: string[] = [];
  let ctx: { abortSignal?: AbortSignal } | null = null;
  let promoted = 0;

  const adapter = {
    sql: {} as never,
    streams: {} as never,
    eventLog: {
      append: async (event: SessionEvent) => {
        appended.push(event);
      },
      getEvents: () => appended.slice(),
      getEventsAsync: async () => appended.slice(),
    },
    beginTurn: async (_sid: string, turnId: string) => {
      turnCalls.push(`begin:${turnId}`);
      if (options.failBeginTurn) throw new Error("db down");
    },
    endTurn: async (_sid: string, turnId: string, status: string) => {
      turnCalls.push(`end:${turnId}:${status}`);
      if (options.onEndTurn) await options.onEndTurn();
    },
    terminate: async () => {},
    listOrphanTurns: async () => [],
  } as unknown as RuntimeAdapter;

  const machine = new SessionStateMachine({
    sessionId: "sess_test",
    tenantId: "tnt_test",
    adapter,
    sandbox: {} as never,
    loadAgent: async () => ({ id: "agt_test", name: "test" }) as never,
    buildTools: async () => ({}),
    buildModel: () => ({}) as never,
    // Hand the input straight back so the test can inspect the signal the
    // machine minted for this turn.
    buildHarnessContext: async (input) => {
      ctx = input as unknown as { abortSignal?: AbortSignal };
      return input;
    },
    buildHarness: () => harness,
    promoteSessionOutputs: async () => {
      promoted += 1;
    },
    publish: (event) => {
      published.push(event);
    },
    logger: { warn: () => {}, log: () => {} },
  });

  return {
    machine,
    appended,
    published,
    turnCalls,
    lastCtx: () => ctx,
    promoted: () => promoted,
  };
}

const userMessage = {
  type: "user.message",
  content: "hello",
} as unknown as UserMessageEvent;

/** Resolves once the harness has actually started (so interrupt() lands
 *  mid-turn rather than before the controller exists). */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const typesOf = (events: SessionEvent[]) => events.map((e) => e.type);

describe("SessionStateMachine.interrupt", () => {
  it("mid-turn interrupt: harness rejects with AbortError → idle, no error", async () => {
    const started = deferred();
    const fx = makeFixture({
      run: async (ctx) => {
        const signal = (ctx as { abortSignal: AbortSignal }).abortSignal;
        started.resolve();
        await new Promise<void>((r) => signal.addEventListener("abort", () => r()));
        // What streamText throws when its abortSignal fires.
        throw new DOMException("aborted", "AbortError");
      },
    });

    const turn = fx.machine.runHarnessTurn("agt_test", userMessage);
    await started.promise;
    expect(fx.machine.hasInflightTurn()).toBe(true);
    fx.machine.interrupt();

    // Resolves — a user interrupt is not a turn failure.
    await expect(turn).resolves.toBeUndefined();

    expect(fx.lastCtx()?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(fx.lastCtx()?.abortSignal?.aborted).toBe(true);
    expect(typesOf(fx.appended)).toEqual(["session.status_idle"]);
    expect(typesOf(fx.published)).toEqual(["session.status_idle"]);
    expect(fx.appended.filter((e) => e.type === "session.error")).toHaveLength(0);
    expect(fx.turnCalls.filter((c) => c.startsWith("end:"))).toHaveLength(1);
    expect(fx.turnCalls[1]).toMatch(/^end:.*:idle$/);
    expect(fx.machine.hasInflightTurn()).toBe(false);
    // Half-written outputs must not be promoted from an aborted turn.
    expect(fx.promoted()).toBe(0);
  });

  it("mid-turn interrupt: harness resolves normally (onAbort path) → idle, no error", async () => {
    const started = deferred();
    const fx = makeFixture({
      run: async (ctx) => {
        const signal = (ctx as { abortSignal: AbortSignal }).abortSignal;
        started.resolve();
        await new Promise<void>((r) => signal.addEventListener("abort", () => r()));
        // The AI SDK's onAbort path: the loop returns cleanly.
      },
    });

    const turn = fx.machine.runHarnessTurn("agt_test", userMessage);
    await started.promise;
    fx.machine.interrupt();
    await expect(turn).resolves.toBeUndefined();

    expect(fx.lastCtx()?.abortSignal?.aborted).toBe(true);
    expect(typesOf(fx.appended)).toEqual(["session.status_idle"]);
    expect(fx.appended.filter((e) => e.type === "session.error")).toHaveLength(0);
    expect(fx.turnCalls.filter((c) => c.startsWith("end:"))).toHaveLength(1);
    expect(fx.machine.hasInflightTurn()).toBe(false);
    expect(fx.promoted()).toBe(0);
  });

  it("interrupt() aborts every in-flight turn, not just the most recently started", async () => {
    // Two turns started concurrently, each waiting on its own abortSignal.
    // interrupt() is called once and must stop both — a single activeAbort
    // slot would only abort the second turn's controller, leaving the
    // first running forever.
    const sig1 = deferred<AbortSignal>();
    const sig2 = deferred<AbortSignal>();
    let callIndex = 0;
    const fx = makeFixture({
      run: async (ctx) => {
        const signal = (ctx as { abortSignal: AbortSignal }).abortSignal;
        if (callIndex++ === 0) sig1.resolve(signal);
        else sig2.resolve(signal);
        await new Promise<void>((r) => signal.addEventListener("abort", () => r()));
        throw new DOMException("aborted", "AbortError");
      },
    });

    const turn1 = fx.machine.runHarnessTurn("agt_test", userMessage);
    const signal1 = await sig1.promise;
    const turn2 = fx.machine.runHarnessTurn("agt_test", userMessage);
    const signal2 = await sig2.promise;

    expect(fx.machine.hasInflightTurn()).toBe(true);
    fx.machine.interrupt();

    await expect(turn1).resolves.toBeUndefined();
    await expect(turn2).resolves.toBeUndefined();

    expect(signal1.aborted).toBe(true);
    expect(signal2.aborted).toBe(true);
    expect(fx.appended.filter((e) => e.type === "session.error")).toHaveLength(0);
    // ONE terminal event for the pair: the first turn to finish still had a
    // sibling in flight, and session.status_idle means "this session is done"
    // to every SSE consumer (the /messages one-shot handler closes on it).
    // Only the last turn out emits it.
    expect(fx.appended.filter((e) => e.type === "session.status_idle")).toHaveLength(1);
    expect(fx.turnCalls.filter((c) => c.startsWith("end:"))).toHaveLength(2);
    expect(fx.machine.hasInflightTurn()).toBe(false);
  });

  it("a finishing turn stays silent while another turn is still in flight", async () => {
    // Two turns, the second deliberately held open. Publishing status_idle when
    // the first one lands tells every consumer the session is done while turn 2
    // is still working — and the single-slot activeTurnId made hasInflightTurn()
    // agree with that lie.
    const hold1 = deferred();
    const hold2 = deferred();
    const started1 = deferred();
    const started2 = deferred();
    let callIndex = 0;
    const fx = makeFixture({
      run: async () => {
        if (callIndex++ === 0) {
          started1.resolve();
          await hold1.promise;
        } else {
          started2.resolve();
          await hold2.promise;
        }
      },
    });

    const turn1 = fx.machine.runHarnessTurn("agt_test", userMessage);
    await started1.promise;
    const turn2 = fx.machine.runHarnessTurn("agt_test", userMessage);
    await started2.promise;

    hold1.resolve();
    await turn1;
    expect(typesOf(fx.published)).toEqual([]);
    expect(typesOf(fx.appended)).toEqual([]);
    expect(fx.machine.hasInflightTurn()).toBe(true);

    hold2.resolve();
    await turn2;
    expect(typesOf(fx.published)).toEqual(["session.status_idle"]);
    expect(fx.machine.hasInflightTurn()).toBe(false);
    // Both turns still close their own row in SQL — only the wire event is
    // deduplicated.
    expect(fx.turnCalls.filter((c) => c.startsWith("end:"))).toHaveLength(2);
  });

  it("a beginTurn failure leaves no phantom in-flight turn", async () => {
    // beginTurn used to be awaited BEFORE the try/finally that clears the
    // turn's registration, so a rejection left the session marked busy for the
    // life of the process: every later hasInflightTurn() said true and the
    // orphan scan skipped the session as "ours".
    const fx = makeFixture({ run: async () => {} }, { failBeginTurn: true });

    await expect(fx.machine.runHarnessTurn("agt_test", userMessage)).rejects.toThrow(
      "db down",
    );

    expect(fx.machine.hasInflightTurn()).toBe(false);
    // The turn never opened, so it must not be closed either.
    expect(fx.turnCalls.filter((c) => c.startsWith("end:"))).toHaveLength(0);
    // Terminal for the session too: nothing else is coming, and a client on
    // /messages waits for status_idle specifically.
    expect(typesOf(fx.appended)).toEqual(["session.error", "session.status_idle"]);
    // And no stale controller for a later interrupt to abort.
    expect(() => fx.machine.interrupt()).not.toThrow();
  });

  it("the last turn out ends the session even when it is the one that failed", async () => {
    // Turn 1 completes while turn 2 is live, so turn 1 suppresses its idle.
    // Turn 2 then throws. If the error path skipped the terminal event the
    // session would emit NO status_idle at all and turn 1's /messages stream —
    // which closes on nothing else — would hang for the life of the process.
    const hold1 = deferred();
    const hold2 = deferred();
    const started1 = deferred();
    const started2 = deferred();
    let callIndex = 0;
    const fx = makeFixture({
      run: async () => {
        if (callIndex++ === 0) {
          started1.resolve();
          await hold1.promise;
          return;
        }
        started2.resolve();
        await hold2.promise;
        throw new Error("model 429");
      },
    });

    const turn1 = fx.machine.runHarnessTurn("agt_test", userMessage);
    await started1.promise;
    const turn2 = fx.machine.runHarnessTurn("agt_test", userMessage);
    await started2.promise;

    hold1.resolve();
    await turn1;
    expect(typesOf(fx.published)).toEqual([]);
    // Turn 1's own artefacts are still promoted — suppressing the wire event
    // must not suppress the work behind it.
    expect(fx.promoted()).toBe(1);

    hold2.resolve();
    await expect(turn2).rejects.toThrow("model 429");

    expect(typesOf(fx.appended)).toEqual(["session.error", "session.status_idle"]);
    expect(typesOf(fx.published)).toEqual(["session.error", "session.status_idle"]);
    expect(fx.machine.hasInflightTurn()).toBe(false);
  });

  it("an ordinary harness error still appends session.error and rethrows", async () => {
    const fx = makeFixture({
      run: async () => {
        throw new Error("model 429");
      },
    });

    await expect(fx.machine.runHarnessTurn("agt_test", userMessage)).rejects.toThrow(
      "model 429",
    );
    // session.error is terminal for a client that reads it, but the /messages
    // one-shot handler closes its SSE body on session.status_idle alone and
    // there is no inactivity timer behind it — so the last turn out ends the
    // session whatever its outcome, error included.
    expect(typesOf(fx.appended)).toEqual(["session.error", "session.status_idle"]);
    expect(fx.machine.hasInflightTurn()).toBe(false);
    expect(fx.promoted()).toBe(0);
  });

  it("a completed turn still promotes outputs and emits status_idle", async () => {
    const fx = makeFixture({ run: async () => {} });
    await fx.machine.runHarnessTurn("agt_test", userMessage);
    expect(typesOf(fx.appended)).toEqual(["session.status_idle"]);
    expect(fx.promoted()).toBe(1);
  });

  it("a turn that starts while the previous one is closing gets no idle under it", async () => {
    // Liveness used to be sampled BEFORE endTurn and promoteSessionOutputs were
    // awaited, so a turn that registered inside that window was invisible to the
    // guard: turn 1 published the session's terminal event while turn 2 was
    // already streaming, cutting turn 2's /messages consumer off mid-flight.
    const started2 = deferred();
    const hold2 = deferred();
    let callIndex = 0;
    let turn2: Promise<void> | null = null;
    // Indirection so the endTurn hook can reach the fixture it is part of.
    const holder: { fx?: Fixture } = {};
    holder.fx = makeFixture(
      {
        run: async () => {
          if (callIndex++ === 0) return;
          started2.resolve();
          await hold2.promise;
        },
      },
      {
        onEndTurn: async () => {
          // Only for turn 1's close; turn 2 must not spawn a third turn.
          if (turn2) return;
          turn2 = holder.fx!.machine.runHarnessTurn("agt_test", userMessage);
          await started2.promise;
        },
      },
    );
    const fx = holder.fx;

    await fx.machine.runHarnessTurn("agt_test", userMessage);
    expect(typesOf(fx.published)).toEqual([]);
    expect(fx.machine.hasInflightTurn()).toBe(true);

    hold2.resolve();
    await turn2!;
    expect(typesOf(fx.published)).toEqual(["session.status_idle"]);
    expect(fx.machine.hasInflightTurn()).toBe(false);
  });

  it("each sequential turn gets its own terminal event", async () => {
    // The claim flag that keeps two turns finishing at once from both
    // publishing must not survive into the NEXT turn, or a session goes quiet
    // after its first answer.
    const fx = makeFixture({ run: async () => {} });
    await fx.machine.runHarnessTurn("agt_test", userMessage);
    await fx.machine.runHarnessTurn("agt_test", userMessage);
    expect(typesOf(fx.published)).toEqual(["session.status_idle", "session.status_idle"]);
  });

  it("interrupt() while idle is a no-op", async () => {
    const fx = makeFixture({ run: async () => {} });
    expect(() => fx.machine.interrupt()).not.toThrow();
    expect(fx.appended).toHaveLength(0);
    expect(fx.turnCalls).toHaveLength(0);

    // And a turn started afterwards is unaffected by the stale call.
    await fx.machine.runHarnessTurn("agt_test", userMessage);
    expect(typesOf(fx.appended)).toEqual(["session.status_idle"]);
  });
});
