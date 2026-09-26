# Decisions

- Work only in the existing `fix/always-ask-requires-action` worktree at c10bea1; preserve the pre-existing untracked `.codex-review.md`. No deploys or pushes. User's targeted-suite instruction overrides CONTRIBUTING's full `pnpm test`.
- Noninteractive execution: implement the supplied parity contract without approval questions. Plan: reproduce with regression tests; fix harness event/pending propagation and both runtime confirmation paths; run typecheck and touched suites; review and commit.
- Independent Node and Durable Object runtime fixes delegated in parallel; primary agent owns harness/type changes and final verification.
- Initial evidence: default harness only fills an already-initialized pendingConfirmations array; Node runtime does not initialize it and runner hardcodes end_turn. MCP events omit permission metadata. DO pending restoration ignores MCP, confirmation rebuild strips execute again, and continuation resumes before all pending calls are answered.
- Preserve auto execution semantics. Client custom tools continue to request custom_tool_result. Shared types re-export api-types; update the source DTO once and retain compatibility with historical events.
- Additional verified gaps: public event mapping dropped action_type; canonical Session/GET did not carry stop_reason. Extend those contracts and projections. Mixed pending calls expose tool_confirmation first, then custom_tool_result, preserving order within each action.
- Rebuild confirmed tools with an explicit skipPermissionCheck flag; retain metadata when stripping execute. Persist event kind instead of classifying pending calls by tool name, including legacy DO history fallback.
- Denials already used deny_message; preserve text and mark/project error results to the model. History incorrectly rewrote projected MCP names to legacy names; keep the recorded name for continuation. MCP results support existing content-block form consistently.
- No CLI/SDK files touched, so no changeset. No auto-policy evaluator or infrastructure changes. Regression tests use local scripted models/MCP endpoints; no live deployment needed.
- Independent review found DO pending calls could be replaced by a new ordinary message, and duplicate confirmations could be accepted while the first answer was queued. Add guards/reservation checks and regressions. Outcome evaluation must pause while tool input is outstanding.
- Test-first failures reproduced missing metadata/pending IDs, discarded API action_type, early parallel continuation, incorrect MCP history names, and Pi denial replay. Corrected one test fixture that reused a closed fake MCP server; no production transport change.
- Environment provides Node 22.23.1 although .node-version requests 24.18.0; use installed dependencies/runtime and record actual suite/typecheck results below.
- Installed AI SDK source confirms toolResults excludes tool-error. Pending detection now counts emitted success/error results alike; regression tests prove failed always_allow and invalid always_ask calls do not request confirmation again.
- Preserve pending-call order across self-host restarts using the prior idle event's ordered event_ids when stored events have equal timestamps. GET regression fixture must create canonical /v1 sessions; legacy /v1/oma creation followed by canonical GET returned 404.
- Preserve pre-fix asks using the pinned agent's configured always_ask. Review rejected a broad missing-metadata fallback: old allowed calls lacked metadata too, so that would block normal crash recovery.
- Validation adjustment: full Node run discovered a Bun-only test under Vitest, a process-tree assertion blocked by unreaped PID-1 zombies, and global temp-directory checks noticing validation logs. Run the Bun file with Bun, process-tree under a Linux subreaper, and remaining Node suite without concurrent /tmp log creation. Validation logs now live under ignored node_modules/.cache/codex-validation.

Files and coverage:
- `apps/agent/src/harness/{tools,default-loop,pi-loop,acp-recovery}.ts` and `runtime/{history,session-do,outcome-supervisor}.ts`: permission metadata, pending/error detection, confirmation execution, history fidelity, outcome pause and interrupt preservation. ACP change only handles MCP content blocks.
- `apps/main-node/src/lib/node-managed-{harness-runtime,session-runner}.ts`: initialized tracking, batch confirmations and ordered stop reasons.
- `packages/api-types/src/types.ts`, `managed-agents-domain/src/sessions/{event,session}.ts`, API session/event contracts and mappers plus `session-stop-reason.ts`: additive evaluation/action/GET fields. Shared already re-exports these types.
- Application `session-events/{application,pending-tool-uses}.ts`, `session-execution/application.ts`, and index export: admission validation, legacy policy inference, pending reconstruction and persisted stop reason.
- Added `tool-permission-events`, API `tool-permissions`, application `pending-tool-uses`, and integration `session-tool-confirmations` tests; extended Pi, outcome, Node runner, application admission/projection, API retrieve, history and MCP-builder suites. Covers ask/allow/auto, custom, parallel answers, deny text/error, invalid/duplicate IDs, error settlement, restart ordering, GET and end_turn.

Verification (all final runs green):
- `pnpm run typecheck`: exit 0; final root `pnpm exec tsc --noEmit` and Node package typecheck also exit 0 after the last changes.
- Targeted root suites covering agent tests, tools/history/MCP, API, application, api-types/shared: 116 files, 568 tests passed. Final legacy/admission rerun: 17 passed. API official-worker contract: 1 passed.
- DO confirmation integration + outcome supervisor: 14 passed, including stored GET, independent confirmations, ordinary messages, duplicate answers and interrupts.
- Node package: 64 Vitest files / 393 tests passed with only the separately-run Bun and process-tree files excluded; Bun passed 6 tests, process-tree passed 1 under the temporary subreaper (400 tests across all 66 files). No source changes for runner/environment issues.
- Independent review completed; reported pending-message, duplicate-answer and legacy-policy issues corrected. `git diff --check` clean. Commit on the requested branch only; no push, merge, deployment or changeset.
