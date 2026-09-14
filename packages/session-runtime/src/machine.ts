// SessionStateMachine — single source for turn lifecycle on both CF and
// Node. Phase 2 of the unified-runtime plan: Node adopts this; Phase 3
// CF SessionDO becomes a thin shell that constructs one of these.
//
// Surface (callable from per-platform shell):
//
//   runHarnessTurn(agentId, userMessage)
//     beginTurn → harness.run → endTurn. The whole body is the
//     extracted-and-generalised version of what apps/main-node ran
//     inline before; the same body will replace the CF SessionDO's
//     drainEventQueue+turn-runtime stack in Phase 3.
//
//   onWake()
//     Detect orphan turns (sessions row marked 'running' with a
//     turn_id we don't recognise as our own active turn) and reconcile
//     them via recoverInterruptedState. Called from:
//       - CF DO alarm() (every 30s while a turn is in flight, and on
//         cold start when a request hits an evicted DO)
//       - Node SessionRegistry.bootstrap() at process start
//       - Anywhere a stale-state hint is useful (e.g. an SSE reconnect)
//
//   destroy()
//     Mark the session destroyed. End-of-life signal for graceful
//     shutdown.
//
// Per-platform polymorphism is entirely in the RuntimeAdapter the
// machine holds (one impl, both platforms via SqlClient + the optional
// hintTurnInFlight callback).

import { nanoid } from "nanoid";
import type {
  AgentConfig,
  SessionEvent,
  UserMessageEvent,
} from "@open-managed-agents/shared";
import type { LanguageModel } from "ai";
import { recoverInterruptedState } from "./recovery";
import type { OrphanTurn, RuntimeAdapter, TurnId } from "./ports";
import type { SandboxPort } from "@open-managed-agents/sandbox";

/**
 * Pluggable harness — both CF and Node want the same default-loop
 * harness, but the machine doesn't import it directly so we keep the
 * package's dep graph small (no `@open-managed-agents/agent` dep).
 *
 * The shell wires this with:
 *   buildHarness: (agent) => resolveHarness(agent.harness)
 *   buildContext: () => HarnessContext  // model + tools + system + ...
 */
export interface HarnessRunFn {
  (ctx: unknown): Promise<void>;
}

export type SessionHarnessDisposeReason = "replace" | "shutdown" | "destroy";

export interface SessionHarness {
  run: HarnessRunFn;
  dispose?(reason: SessionHarnessDisposeReason): Promise<void>;
}

export interface SessionMachineDeps {
  sessionId: string;
  tenantId: string;

  /** Single shared adapter for I/O. */
  adapter: RuntimeAdapter;

  /** Per-session sandbox. Constructed by the shell so it can pick the
   *  backend (LocalSubprocess / E2B / Daytona / CloudflareSandbox) and
   *  inject sessionId-scoped paths.  */
  sandbox: SandboxPort;

  /** Look up the agent config. CF reads from a snapshot or the agents
   *  store; Node reads from agentsService. */
  loadAgent(agentId: string): Promise<AgentConfig | null>;

  /** Bind a memory store into the sandbox. Phase 2 keeps the loop in
   *  the shell to avoid pulling memory-store types into this package;
   *  the shell calls sandbox.mountMemoryStore directly via sandbox. */
  mountMemoryStores?(opts: { sandbox: SandboxPort }): Promise<void>;

  /** Mount /mnt/session/outputs/ into the sandbox. Per-session bound
   *  directory the agent uses to deliver final artefacts; the same path
   *  is exposed by the main worker via GET /v1/sessions/:id/outputs.
   *  Optional — sandboxes / hosts that don't support it skip silently. */
  mountSessionOutputs?(opts: { sandbox: SandboxPort }): Promise<void>;

  /** Mount the session's `file` and `github_repository` resources into the
   *  sandbox before the harness runs (client attachments + repo checkouts).
   *  Node's port of the CF resource-mounter; read fresh each turn so a
   *  resource attached mid-session is mounted on the next turn. Optional —
   *  shells that mount resources elsewhere (CF) leave it unset. */
  mountSessionResources?(opts: { sandbox: SandboxPort }): Promise<void>;

  /** Promote files the agent wrote under /mnt/session/outputs into the
   *  Files API (scope_id = this session) at turn completion, so Anthropic
   *  Managed Agents SDK consumers that poll files.list({scope_id}) can
   *  fetch them. Optional; the shell owns the files-store wiring. */
  promoteSessionOutputs?(opts: { sandbox: SandboxPort }): Promise<void>;

  /** Build the LanguageModel for this turn. CF reads env from
   *  bindings; Node from process.env (and optionally a model card).
   *  May be async when the shell needs to look up credentials. */
  buildModel(agent: AgentConfig): LanguageModel | Promise<LanguageModel>;

  /** Build harness tools. The harness package owns the tool list; the
   *  machine doesn't know which tools exist, just hands the result to
   *  the harness. */
  buildTools(agent: AgentConfig, sandbox: SandboxPort): Promise<unknown>;

  /** Build the harness instance + context for one turn. The shell does
   *  this so the machine doesn't need a hard dep on
   *  `@open-managed-agents/agent`. The machine just calls run().
   *
   *  Async because shells often need to warm up state (e.g. read the
   *  event log into the harness's history cache) before harness.run
   *  reads from it. */
  buildHarness(agent: AgentConfig): SessionHarness;
  buildHarnessContext(input: {
    agent: AgentConfig;
    userMessage: UserMessageEvent;
    sandbox: SandboxPort;
    tools: unknown;
    model: LanguageModel;
    /** Per-turn cancellation signal. The shell must hand this to the
     *  HarnessRuntime it builds (`HarnessRuntime.abortSignal`) so the
     *  default loop passes it to streamText; that's what makes
     *  `interrupt()` below actually stop an in-flight model call.
     *  Aborted by `SessionStateMachine.interrupt()`. */
    abortSignal: AbortSignal;
  }): Promise<unknown>;

  /** Flush provider/filesystem state after harness children stop but before
   * the sandbox resource is destroyed. Hosts wire their checkpoint Port. */
  beforeSandboxDestroy?(): Promise<void>;

  /** Publish a synthetic event to the hub (e.g. session.error,
   *  session.status_idle on recovery). The shell wires this with the
   *  in-process or DO-level hub. */
  publish(event: SessionEvent): void;

  /** Logger. Defaults to console. */
  logger?: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };
}

export class SessionStateMachine {
  private activeHarness: { key: string; harness: SessionHarness } | null = null;
  /** Every turn currently in flight, by id, with its AbortController; empty
   *  when the session is idle.
   *
   *  One map rather than a single `activeTurnId` slot plus a Set of
   *  controllers: Node dispatch sites fire `runHarnessTurn` per `user.message`
   *  with no in-flight check, so several turns can run concurrently. With the
   *  old pair, turn 2 overwrote the slot and turn 1 finishing cleared it — the
   *  session was marked idle (and `hasInflightTurn()` said so) while turn 2 was
   *  still running, and the orphan scan then treated turn 2 as somebody else's
   *  to recover. Keyed by turn id, every question about liveness — is anything
   *  running, is THIS turn ours, is anyone left after mine — is answered off
   *  the one structure.
   *
   *  `interrupt()` aborts all of them, which propagates to each harness through
   *  `HarnessRuntime.abortSignal` → streamText's `abortSignal`. */
  private activeTurns = new Map<TurnId, AbortController>();
  /** True once the terminal `session.status_idle` for the current stretch of
   *  work has been claimed; reset when a new turn registers.
   *
   *  The liveness check alone is not enough to emit exactly one. It is read
   *  after this turn's `await`s (so a turn that started meanwhile is seen),
   *  and by then a sibling finishing in the same window has already removed
   *  itself — both would see an empty map and both would emit. Claiming the
   *  event and flipping this flag in one synchronous step is what makes "the
   *  last turn out" a single turn. */
  private terminalEventClaimed = false;
  private logger: NonNullable<SessionMachineDeps["logger"]>;

  constructor(private deps: SessionMachineDeps) {
    this.logger = deps.logger ?? {
      warn: (msg, ctx) => console.warn(`[session ${deps.sessionId}] ${msg}`, ctx ?? ""),
      log: (msg) => console.log(`[session ${deps.sessionId}] ${msg}`),
    };
  }

  /** True while at least one turn is running. Used by per-platform shells to
   *  decide whether to keep the alarm armed (CF) or skip a recovery scan that
   *  would race an active turn. */
  hasInflightTurn(): boolean {
    return this.activeTurns.size > 0;
  }

  /**
   * Drive one harness turn. beginTurn → harness.run → endTurn.
   *
   * Throws on any harness failure; caller (the shell's HTTP route or
   * registry) decides whether to mark session error or just let the
   * status flip back to idle for the user to retry.
   */
  async runHarnessTurn(
    agentId: string,
    userMessage: UserMessageEvent,
  ): Promise<void> {
    const agent = await this.deps.loadAgent(agentId);
    if (!agent) throw new Error(`agent ${agentId} not found`);

    const turnId = nanoid();
    // Per-turn cancellation. Handed to the shell via buildHarnessContext so
    // it lands on HarnessRuntime.abortSignal → streamText({ abortSignal }).
    // `interrupt()` fires it; the catch/finally below translate an abort
    // into the same "turn ended, session idle" shape the CF SessionDO
    // produces for user.interrupt.
    const abort = new AbortController();

    // Set once the harness returns normally. Gates output promotion only —
    // the terminal session.status_idle no longer depends on the outcome (see
    // the finally block). An interrupt sets neither this nor session.error: a
    // user-initiated abort is not a failure, mirroring the CF SessionDO, which
    // appends user.interrupt + session.status_idle and skips session.error.
    let harnessCompleted = false;
    // Set once beginTurn succeeded, i.e. the sessions row really is marked
    // running. Only then may the finally block close the turn: endTurn on a
    // turn that never opened would flip a row this call never owned.
    let turnOpened = false;

    try {
      // Registration and beginTurn belong INSIDE the try: everything the
      // finally block undoes has to be set up where the finally block can see
      // it. With beginTurn awaited outside, a rejection (DB down, row gone)
      // left the turn registered forever — the session read as busy for the
      // life of the process and its controller was never released.
      this.activeTurns.set(turnId, abort);
      // New work: the session owes a terminal event again.
      this.terminalEventClaimed = false;
      await this.deps.adapter.beginTurn(this.deps.sessionId, turnId);
      turnOpened = true;
      this.deps.adapter.hintTurnInFlight?.(this.deps.sessionId, turnId);

      // Memory store mounts: optional adapter step, runs once per turn
      // so a session newly bound to a store picks it up on the next
      // user.message without restarting.
      if (this.deps.mountMemoryStores) {
        await this.deps.mountMemoryStores({ sandbox: this.deps.sandbox });
      }

      // /mnt/session/outputs/ mount. Idempotent on the supported adapters
      // (LocalSubprocess re-symlinks, CF re-mounts the R2 prefix), so
      // re-running per turn is safe and means the path is always present
      // for a fresh sandbox that warmed in this turn.
      if (this.deps.mountSessionOutputs) {
        await this.deps.mountSessionOutputs({ sandbox: this.deps.sandbox });
      }

      // Mount the session's file + github_repository resources (client
      // attachments and repo checkouts) so the agent can use them this
      // turn. Runs after the outputs/memory mounts and before tools are
      // built, mirroring their per-turn, idempotent contract.
      if (this.deps.mountSessionResources) {
        await this.deps.mountSessionResources({ sandbox: this.deps.sandbox });
      }

      const tools = await this.deps.buildTools(agent, this.deps.sandbox);
      const model = await this.deps.buildModel(agent);
      const ctx = await this.deps.buildHarnessContext({
        agent,
        userMessage,
        sandbox: this.deps.sandbox,
        tools,
        model,
        abortSignal: abort.signal,
      });

      const harness = await this.resolveHarness(agent);
      await harness.run(ctx);
      // An aborted turn can also *resolve* rather than reject: the AI SDK
      // routes a mid-stream abort through onAbort and the loop returns
      // normally. Check the signal on both exits so the two shapes are
      // treated identically.
      harnessCompleted = !abort.signal.aborted;
    } catch (err) {
      // User-initiated interrupt — streamText rejects with an AbortError.
      // Not an error condition: swallow it, skip session.error, and let
      // the finally block close the turn with session.status_idle.
      if (abort.signal.aborted) {
        this.logger.log(`turn ${turnId} interrupted by user`);
        return;
      }
      // Surface the failure to the user: persist + publish session.error
      // so the console shows the actual diagnostic (model 4xx, tool
      // crash, …) instead of a turn that silently produces nothing.
      // Then re-throw — the shell keeps its own logging/decisions.
      const message = err instanceof Error ? err.message : String(err);
      const errorEvent = {
        type: "session.error",
        error: { type: "harness_error", message: message.slice(0, 1000) },
      } as unknown as SessionEvent;
      try {
        await this.deps.adapter.eventLog.append(errorEvent);
        this.deps.publish(errorEvent);
      } catch (persistErr) {
        this.logger.warn(
          `failed to persist session.error: ${(persistErr as Error).message}`,
        );
      }
      throw err;
    } finally {
      // Delete by identity: only ever removes this turn's own entry, never a
      // concurrent turn's.
      this.activeTurns.delete(turnId);
      if (turnOpened) {
        await this.deps.adapter.endTurn(this.deps.sessionId, turnId, "idle");
      }

      // Promote files the agent wrote to /mnt/session/outputs into the Files
      // API, so a consumer that reacts to session.status_idle by polling
      // files.list({scope_id}) (the ff-agents bot's file mirroring) sees them
      // already present. Runs for THIS turn's own completion, whether or not
      // this turn is the one that will emit the terminal event — a turn that
      // stays silent because a sibling is still live has still produced its
      // artefacts.
      // Best-effort: a promote failure must never block the terminal event
      // below — that would re-introduce the turn-never-ends hang. Success path
      // only: an interrupted or failed turn may have half-written files under
      // /mnt/session/outputs, and promoting those would publish partial
      // artefacts to the Files API as if they were the turn's deliverable.
      if (harnessCompleted && this.deps.promoteSessionOutputs) {
        try {
          await this.deps.promoteSessionOutputs({ sandbox: this.deps.sandbox });
        } catch (promoteErr) {
          this.logger.warn(
            `promoteSessionOutputs failed: ${(promoteErr as Error).message}`,
          );
        }
      }

      // Emit the terminal session.status_idle the Anthropic Managed Agents
      // wire contract requires at the end of a session's work. endTurn() above
      // only flips the sessions-row status in SQL; without this event, SSE
      // consumers that discriminate on session.status_idle (every Anthropic
      // SDK — the /messages one-shot handler closes its body on it, and the
      // hub has no inactivity timer behind that) never see the turn end and
      // block forever. Persist + publish, mirroring the session.error path.
      // stop_reason=end_turn because the default harness runs to completion
      // rather than pausing for requires_action tool results (and because
      // Anthropic's StopReason union has no `interrupted` variant — the
      // user.interrupt event in the log carries the actual cause).
      //
      // Two rules, and they are the same rule: the LAST turn out terminates
      // the session, whatever its own outcome.
      //  - Not before then. session.status_idle means "this session is done"
      //    to every consumer, so a turn finishing while a sibling still
      //    streams would cut that sibling off mid-flight.
      //  - Not conditional on success. A thrown harness already appended
      //    session.error, which is terminal for a client that reads it — but
      //    a client waiting on /messages is waiting for status_idle
      //    specifically. When a completed turn has already suppressed its own
      //    idle for a sibling that then throws, gating on success left the
      //    session with NO terminal event at all and that first turn's stream
      //    open for the life of the process.
      //
      // The size is re-read HERE, after every await above (endTurn, promote):
      // a turn that registered while those ran is live now, and publishing an
      // idle under it is exactly the mid-flight cut this guard exists to stop.
      // Read together with the claim flag, and both in ONE synchronous step —
      // see terminalEventClaimed for why the size alone would let two turns
      // finishing in the same window each publish a terminal event.
      const claimed = this.activeTurns.size === 0 && !this.terminalEventClaimed;
      if (claimed) {
        this.terminalEventClaimed = true;
        const idleEvent = {
          type: "session.status_idle",
          stop_reason: { type: "end_turn" },
        } as unknown as SessionEvent;
        try {
          await this.deps.adapter.eventLog.append(idleEvent);
          this.deps.publish(idleEvent);
        } catch (persistErr) {
          this.logger.warn(
            `failed to persist session.status_idle: ${(persistErr as Error).message}`,
          );
        }
      }
    }
  }

  /**
   * Abort every in-flight turn, if any. Called by the per-platform shell
   * when a `user.interrupt` event arrives (Node: SessionRegistry.interrupt;
   * the CF DO aborts its own per-thread controller). No-op when idle.
   *
   * Aborts every controller in `activeTurns`, not just the most
   * recently started one — Node's dispatch sites fire `runHarnessTurn`
   * per `user.message` with no in-flight check, so several turns can be
   * running concurrently and an interrupt must stop all of them.
   *
   * The turn(s) do not end synchronously: aborting each signal unblocks
   * its streamText call, and `runHarnessTurn`'s finally block appends the
   * terminal session.status_idle. No session.error is written — a
   * user-initiated abort is not a failure.
   */
  interrupt(): void {
    for (const c of this.activeTurns.values()) c.abort();
  }

  /**
   * Reconcile orphan turns. Reads sessions WHERE status='running',
   * filters out our own active turn, and runs recoverInterruptedState
   * for each. Recovery injects placeholder events into the event log so
   * the next user.message sees a clean tool-use bijection.
   *
   * Idempotent + safe to call repeatedly.
   */
  async onWake(): Promise<void> {
    const orphans = await this.deps.adapter.listOrphanTurns(this.deps.sessionId);
    for (const o of orphans) {
      if (this.activeTurns.has(o.turn_id)) continue; // we own it
      await this.recoverOrphan(o);
    }
  }

  /**
   * Externally-driven destroy. The shell calls this on graceful
   * shutdown of a session (DELETE /v1/sessions/:id). Kills any
   * in-flight sandbox + flips status to 'destroyed'.
   */
  async destroy(): Promise<void> {
    // Snapshot and clear: every live turn is being torn down, and a turn's own
    // finally block must not find itself still registered afterwards.
    const turnIds = [...this.activeTurns.keys()];
    this.activeTurns.clear();
    // Stateful harness children and the checkpoint need the live sandbox,
    // so preserve their cleanup order before closing every tracked turn.
    await this.releaseSandbox("destroy");
    if (turnIds.length > 0) {
      // Every turn that was in flight, not just one: with concurrent turns the
      // rows the others opened would otherwise stay 'running' forever and be
      // rediscovered as orphans on the next wake.
      for (const turnId of turnIds) {
        await this.deps.adapter.endTurn(this.deps.sessionId, turnId, "destroyed");
      }
    } else {
      // No active turn — directly mark the row destroyed.
      await this.deps.adapter.endTurn(this.deps.sessionId, "", "destroyed");
    }
  }

  /** Process/isolate shutdown without changing the durable session state.
   * Stateful harness children are released before the sandbox resource so
   * protocol close/cancel can still use the live transport. */
  async shutdown(): Promise<void> {
    await this.releaseSandbox("shutdown");
  }

  // ── helpers ─────────────────────────────────────────────────────────

  private async resolveHarness(agent: AgentConfig): Promise<SessionHarness> {
    const key = `${agent.id}:${agent.version}:${agent.harness ?? "default"}`;
    if (this.activeHarness?.key === key) return this.activeHarness.harness;
    await this.disposeHarness("replace");
    const harness = this.deps.buildHarness(agent);
    this.activeHarness = { key, harness };
    return harness;
  }

  private async disposeHarness(reason: SessionHarnessDisposeReason): Promise<void> {
    const active = this.activeHarness;
    this.activeHarness = null;
    try {
      await active?.harness.dispose?.(reason);
    } catch (err) {
      this.logger.warn(`harness dispose failed: ${(err as Error).message}`);
    }
  }

  private async releaseSandbox(reason: "shutdown" | "destroy"): Promise<void> {
    await this.disposeHarness(reason);
    try {
      await this.deps.beforeSandboxDestroy?.();
    } catch (err) {
      this.logger.warn(`sandbox checkpoint failed: ${(err as Error).message}`);
    }
    try {
      if (this.deps.sandbox.destroy) await this.deps.sandbox.destroy();
    } catch (err) {
      this.logger.warn(`sandbox destroy failed: ${(err as Error).message}`);
    }
  }

  private async recoverOrphan(o: OrphanTurn): Promise<void> {
    this.logger.warn(
      `recovering orphan turn ${o.turn_id} (started ${
        Date.now() - o.turn_started_at
      }ms ago)`,
    );

    // recoverInterruptedState wants an EventLogRepo with sync getEvents
    // — same contract the CF DO uses. The adapter's eventLog satisfies
    // it on both platforms (SqlEventLog implements the async surface,
    // and we serve the sync requirement via the same in-memory cache
    // the harness already uses... but here on cold start we don't have
    // a cache). The shell's `publish` is for warning broadcast; the
    // recovery-injected events themselves go through eventLog.append.

    // Read the event log into a synchronous snapshot (recovery is pure;
    // it just needs the array). We cast the SQL-backed log to the sync
    // shape with a wrapper.
    const allEvents = await (
      this.deps.adapter.eventLog as unknown as {
        getEventsAsync(): Promise<SessionEvent[]>;
      }
    ).getEventsAsync();

    const syncLog: Pick<typeof this.deps.adapter.eventLog, "append" | "getEvents"> = {
      append: (event: SessionEvent) => this.deps.adapter.eventLog.append(event),
      getEvents: () => allEvents,
    };

    const report = await recoverInterruptedState(
      this.deps.adapter.streams,
      syncLog,
    );

    // Broadcast warnings so live SSE subscribers see what happened.
    for (const w of report.warnings) {
      this.deps.publish({
        type: "session.warning",
        source: w.source,
        message: w.message,
        ...w.details,
      } as unknown as SessionEvent);
    }

    // Mark the orphaned turn done so subsequent listOrphanTurns calls
    // don't re-trigger recovery.
    await this.deps.adapter.endTurn(this.deps.sessionId, o.turn_id, "idle");
  }
}
