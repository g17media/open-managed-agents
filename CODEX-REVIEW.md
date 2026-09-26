# Adversarial review

Review baseline: `origin/self-host-parity-new...HEAD` on `fix/always-ask-requires-action`. Original spec and implementation notes read as claims. Initial worktree clean. No pushes or deployments.

## Running log

- Read the actual diff and began tracing both harnesses, DO confirmation admission/execution, Node execution, and pending reconstruction. Started an independent root typecheck (output: `node_modules/.cache/review-typecheck.log`).
- Initial test audit: DO integration uses a scripted harness and private-method fixtures; it tests session plumbing but does not itself prove real harness emission or an actual eviction/restart. Separate harness tests must supply that evidence.
- Independent initial checks: root typecheck exited 0; 11 targeted root files / 101 tests passed; Node runner/subagent files / 32 tests passed. Node 22.23.1 emits the repository's Node 24 engine warning.
- Confirmed F1 (high): real DefaultHarness + buildTools with a custom client tool named `bash` emits `agent.tool_use`/`allow`, although no executor exists. Node consequently reports end_turn; DO asks for confirmation and cannot accept the custom result. New regression failed on the implemented branch. Preserve custom provenance in buildTools metadata and consult it before name classification.
- Confirmed F2 (medium): after a persisted ask event but before harness completion, DO `/event` returns 400 for a valid confirmation because pending_tool_calls is still empty. New regression reproduced expected 202 vs actual 400. Public application admission can already see the call, making rejection at the runtime boundary especially inconsistent.
- Confirmed F3 (medium, introduced by diff): Pi MCP event translation dereferences missing registered tools. A model calling `mcp__missing__tool` throws `Cannot read properties of undefined (reading metadata)` instead of returning the normal unknown-tool error to the model. Regression failed; optional lookup fixed it; all 16 Pi tests pass.
- F2 fixture correction: the first attempt also triggered cold-start orphan recovery (no real running turn had initialized the fixture). Mark the cold-start scan complete to isolate running-turn admission, then rerun against the unchanged admission code before accepting the fix.
- Recovery audit found another concrete hazard: `_finalizeStaleTurns` synthesizes interrupted results for every unresolved tool call, including intentional permission waits. Added a real `evictDurableObject` test rather than an in-memory restart approximation.
- F2 isolated fixture now initializes schema/recovery before inserting the live call (both cold-start scanners are asynchronous). The early-confirmation test passes with the durable-event fallback. Initial failures involving synthesized results were evidence of F4, not isolated evidence of F2.
- Confirmed F4 (high): shared recovery unit test injects `ask_builtin` as interrupted; actual DO eviction test produces synthetic MCP/built-in results (including duplicate interrupted results from two scanners) while pending_tool_calls still holds the calls. Preserve explicit asks and persisted legacy pending IDs in both scanners; custom client waits also remain untouched by the orphan finalizer.
- F2 mutation check: temporarily restored the original admission lookups while keeping the corrected live-turn fixture; it failed with 400 vs 202 and **no synthetic result in history** (`review-early-isolated-red.log`). Restored the fix. This isolates admission from recovery.
- F4 verification: real eviction + continuation passes (all 6 DO tests); shared session-runtime suite passes 53 tests. Constructor SQL reload retains pending call order; both scanners now leave approval waits intact.
- Consumer audit: searched all apps/ and packages/ occurrences (152 initial matches saved in `node_modules/.cache/review-consumers.txt`), then followed camel-case runtime projection/codec paths. `encodeRuntimeSessionEvent` handles accepted inputs, including deny_message; runtime history/produced-event converters preserve evaluation/action fields. Console has a permissive event shape. Shared re-exports api-types. No newly required historical event fields. New optional evaluation/action/stopReason fields are consistent. The new supervisor nullable terminal is consumed safely; production callers ignore its return. Production unchecked casts added around thread IDs remain an existing type-model limitation, not a new permission bypass.
- Broader adapter verification uncovered an existing failing test: `managed-agents-adapters-runtime/test/codec.test.ts:83` expects session.warning to be dropped, but the codec returns it. Both that test and its implementation are byte-identical to origin/self-host-parity-new. Preserve behavior: deciding whether extension warnings should pass is outside this change's policy contract.
- Multiagent probe: appended the reproduction below to `apps/main-node/test/managed-session-subagents.test.ts`, ran it, and observed 1 failure / 13 passes: expected requires_action, received end_turn. Restored the original test file; retained exact probe and output in this report/cache rather than disguising it as a passing regression. Child lifecycle is unchanged from the base. Scope is ambiguous: original required idle/confirmation behavior is specified at the session level, but this review explicitly requests child-thread coverage. Child confirmation/resumption requires thread routing, child-agent tool rebuilding and parent continuation decisions; a stop-reason-only edit would be misleading. Left the existing behavior and flag it as a limitation of any claim of universal parity.

Multiagent failing probe (append inside the existing test file, whose `fixture` is used):

```ts
it("review: a child permission wait must not be reported as completed", async () => {
  let childId = "";
  const f = fixture(async ({ session: active, runtime, subagents }) => {
    if (active.agent.name === "Parent") {
      childId = (await subagents!.create({ name: "Worker", message: "Use bash" })).threadId;
      await subagents!.wait({ threadIds: [childId] });
    } else {
      runtime.broadcast({ type: "agent.tool_use", id: "child_ask", name: "bash", input: {}, evaluated_permission: "ask" });
      runtime.pendingConfirmations.push("child_ask");
    }
  });
  await f.run();
  expect(f.frames.find(frame => frame.type === "session.thread_status_idle" && frame.session_thread_id === childId)).toMatchObject({
    stop_reason: { type: "requires_action", action_type: "tool_confirmation", event_ids: ["child_ask"] },
  });
});
```

## Hand traces and test credibility

- **Default, MCP + bash ask:** buildTools uses getToolPermission, strips execute but retains metadata/schema; onStepFinish emits ask/evaluation on the appropriate event kind. Completed result/error IDs settle calls. Unsettled last-step calls populate pendingConfirmations in tool-call order. DO copies their event kind/input into persisted pending_tool_calls; pendingToolStopReason emits tool_confirmation with those IDs. Node independently reconstructs pending calls from emitted history. Canonical runtime projection stores the same stopReason and GET maps it back to the wire.
- **Pi, MCP + bash ask:** metadata evaluation uses the same policy helper; toolsToPi adds each non-executable call to pendingConfirmations and returns the terminate marker. Translation suppresses marker results. Parallel-call test proves all three calls (including client tool) remain pending. DO/Node finalization follows the same paths above. Unknown MCP names now produce a model-visible tool error instead of crashing translation.
- **Allow/auto:** executors remain present, results settle calls, and no-pending turns produce end_turn. Auto still executes with allow and omits a fixed-policy evaluation. Strict byte-for-byte allow parity is not literally achieved by the original diff: MCP history now preserves actual tool names, error replay now carries error semantics, and Pi now emits MCP event kinds. Those are deliberate corrections stated in the notes and required for coherent continuation; preserved rather than reverting working fixes.
- **Two calls, allow/deny, duplicates:** existing DO and Node tests execute the actual admission/continuation methods and verify only the last answer resumes the model; deny_message retains the existing `Denied: ` prefix, absent messages use the default denial. Unknown/resolved IDs fail admission with 400; repeated identical event IDs remain idempotent. Mixed custom/confirmation calls expose confirmations first, then custom results. This one-action-at-a-time interpretation is retained.
- **Restarts:** old implementation tests never evicted a DO. New test actually evicts, invokes both real recovery paths, verifies zero fabricated results and ordered persisted requires_action, then denies the built-in and verifies the remaining MCP pause. It uses seeded SQL/pending state and real confirmation handling; canonical GET persistence is covered separately by the existing HTTP fixture. It is not a full real-model-to-eviction-to-remote-MCP E2E.
- **Limits/budgets:** default loop has a fixed stepCountIs(100); neither reviewed harness chooses a budget_reached stop reason. Pending calls win DO/Node finalization if present, including the last step. A provider failure before pending snapshotting is a different error path, not a budget precedence implementation. No live monetary-budget exhaustion test was run. Existing error-only no-pending DO finalization may omit stop_reason; unchanged and outside successful-turn parity.
- **Memory:** there are no bespoke memory tools; mounted memory uses standard bash/read/write/edit, so the tested built-in permission path applies.
- **Delegation:** call_agent_* classifies as a built-in and inherits the built-in toolset policy. Emission/pending detection follows the bash path. Actual confirmation rebuilding lacks delegateToAgent (DO confirmation builder and Node confirmed-tool builder); an allowed delegate can return the existing "Multi-agent delegation not available" text. Together with child-thread pending handling, this is a pre-existing delegation limitation; not evidence that end-to-end delegation approvals are fixed. Left under the ambiguous multiagent scope above.
- **Outcomes/verifiers:** pending checks surround initial and revision harness runs; DO preserves the outcome and pauses evaluation. Node initial/revision pause checks exist, but outcome resumption after a later confirmation is not an end-to-end scenario in the added tests. Verifier sandbox execution is internal evaluation, not a model-issued agent tool confirmation.
- **Would original tests fail on base?** Default tests omit pendingConfirmations deliberately: base fails to initialize it and omits MCP metadata. Pi base emits agent.tool_use for MCP and lacks evaluation. Node base hardcodes end_turn. API base drops action_type and GET has no stopReason. The new pure pending helper cannot exist on base. Thus these tests detect real differences, although scripted DO and runner harnesses do not prove real model/tool integration. Review regressions were observed red before fixes; no tests merely assert a copied helper.

- Final adversarial probe confirmed F5 (high, Pi-specific): a real buildTools client tool named `mcp__client__answer` is classified as MCP/allow, so Node can silently end the turn. The new test failed (1 failed / 16 passed); Pi now checks the custom provenance metadata before the MCP prefix. Final Pi/default permission files: 26 tests passed; final root tsc exited 0. This is separate from F1's default-loop built-in-name collision.

## Findings

| Severity | File / path | What | Resolution |
|---|---|---|---|
| High | `apps/agent/src/harness/default-loop.ts`, `tools.ts` | Custom `bash` classified as allow/built-in; wrong action or silent end_turn | Fixed, `b8848cf`; real buildTools + DefaultHarness regression |
| Medium | `apps/agent/src/runtime/session-do.ts` admission | Valid emitted ask rejected while harness is still running | Fixed, `fde1f57`; isolated red/green admission regression |
| Medium | `apps/agent/src/harness/pi-loop.ts` | Unknown MCP name crashes permission-event translation | Fixed, `7e4723d`; real PiHarness regression |
| High | `apps/agent/src/runtime/session-do.ts`, `packages/session-runtime/src/recovery.ts` | Recovery fabricates results for intentional approval waits; stored pending state and event log disagree | Fixed, `cbca830`; shared recovery + actual DO eviction regressions |
| High | `apps/agent/src/harness/pi-loop.ts` | Client names beginning with `mcp__` misclassified as allowed MCP calls | Fixed in the fifth `review:` commit; real buildTools + PiHarness regression |
| High, scope disputed | `apps/main-node/src/lib/node-managed-subagents.ts`, runner; DO `runSubAgent` / confirmation builder | Child asks still complete with end_turn, and confirmed delegation lacks the normal delegate callback | Left: pre-existing behavior, ambiguous expansion beyond primary-session contract; failing child probe documented above. Universal multiagent approval parity is not established. |
| Low, unrelated | `packages/managed-agents-adapters-runtime/test/codec.test.ts:83` | Suite expects extension warning to be dropped; unchanged codec passes it through | Left: source/test unchanged from base; do not alter unrelated extension behavior |

## Checked and found clean

Primary MCP/built-in ask metadata, ordered parallel pending IDs, ordinary allow/auto execution, default custom tool provenance after review fix, allow/deny settlement, duplicate/unknown ID admission, action_type API mapping, stored GET stop reason, pending reconstruction from historical events, shared/api-types additive compatibility, and supervisor pause guards. New recovery tests preserve both current asks and the DO's persisted pending state; pre-existing interrupted **executable** tool recovery tests still pass. No CLI/SDK source changes or changesets. No pushes, deployments, or edits to `.codex-task.md` / `CODEX-DECISIONS.md`.

## Final verification output

All commands were run independently; logs are under `node_modules/.cache/review-*.log`. Counts below overlap where focused files were rerun.

| Command / scope | Actual output | Exit |
|---|---|---|
| `pnpm run typecheck` (initial and final broad run) | All workspace typechecks completed; Node 22.23.1 vs requested Node 24 warning | 0 |
| `pnpm exec tsc --noEmit` after the final Pi collision fix | No diagnostics (engine warning only) | 0 |
| Root vitest: all `apps/agent/tests`, API/application tests, DO confirmations, history conversion, MCP port | **116 files passed; 525 tests passed** (before the last additional Pi regression) | 0 |
| Final Pi + default permission files after last fix | **2 files passed; 26 tests passed** | 0 |
| `pnpm --filter @open-managed-agents/session-runtime test` | **5 files passed; 53 tests passed** | 0 |
| Node runner + native subagents | **2 files passed; 32 tests passed** | 0 |
| Node confirmed-tool executor | **1 file passed; 2 tests passed** | 0 |
| Runtime-adapter full suite | **1 file failed, 16 passed; 1 test failed, 67 passed** — pre-existing session.warning expectation | 1 |
| Deliberate child-approval probe (not retained in the normal suite; code above) | **1 failed; 13 passed** — pending child reported end_turn | 1 |
| `git diff --check` | No whitespace errors | 0 |

Five defect fixes are committed separately with `review:` prefixes. The primary-session fixes are verified, but the requested delegation/thread surface still lacks a complete approval lifecycle and the broader adapter check is not green. Do not represent this branch as universal always_ask parity until that scope is resolved.

DO NOT SHIP
