# Upstream rebase — 7 September 2026

Our changes are rebased onto upstream `origin/main` at
`d2acd825f7dd7e3ebc31fccea241dfad936af89d` on
`integrate/upstream-v1-20260907`.

The original branch contained 34 commits after the common ancestor
`6692a30b`. The rebase replayed 33. Commit `449aed30` (preventing Anthropic
environment settings from leaking into OpenAI model cards) was already
covered by upstream and became empty. A subsequent integration commit
adapts the replayed features to upstream's contracts and runtime.

## Recovery

Both `self-host-parity` and `backup/self-host-parity-20260907-6c1d2092`
still point to the original tip:
`6c1d2092d74c9d5264d8c3cf7bb046b50ac6d930`.

A separate, verified Git bundle contains that branch's complete history:

```text
/Users/april/Projects/open-managed-agents-backups/self-host-parity-20260907-6c1d2092.bundle
```

`git bundle verify` succeeds, and `origin/main` is an ancestor of the
rebased branch. The original working tree was clean before the rebase.

## Integration

- Deployments use upstream's `/v1/deployments` and `/v1/deployment_runs`
  records. Scheduled runs reserve a due slot atomically and advance the
  schedule even if launch fails. Editing memory attachments preserves
  existing repository credentials, other resources and initial events.
- Environment images, registry credentials, context and startup scripts
  use the upstream environment model. Sessions retain their creation-time
  environment configuration. Startup events use the upstream event log
  and stream.
- Vault credentials and OAuth grants use upstream's encrypted credential
  store. Session vault changes take effect in the proxy, including an
  empty vault set. Git credentials remain scoped to the relevant resource;
  registry credentials are resolved for container provisioning.
- File and repository attachments, versioned skill archives, memory mounts
  and output files connect to the upstream session runtime. Restoring a
  workspace preserves edits to mounted files. Memory writes use content
  preconditions and version history; conflicts preserve the filesystem
  copy. Memory persistence failures do not skip output promotion or
  workspace backup.
- GitHub skill import and sync create upstream skill versions, and file
  previews read those version archives. Agent model settings use upstream's
  `effort` field. The interface uses the existing shared components and SDK.
- Belljar provisioning, proxy egress controls, credential handles, OIDC,
  password/signup controls and the remaining fork fixes are retained.

The obsolete changesets describing the removed custom SDK were replaced
with a changeset for the CLI's workspace selection during OAuth.

## Validation

- Repository suite: 303 files, 2,344 tests passed.
- Node application: 33 files, 171 tests passed.
- Interface: 43 files, 158 tests passed; production build passed.
- SDK, CLI, ACP, CAP, runtime, session runtime, sandbox, integration,
  SQL, blob and runtime adapter package suites passed.
- Website tests, including its production build, passed.
- Repository-wide typechecking, test discovery, architecture boundaries
  and `git diff --check` passed.

Validation ran on the available Node 25.6.1; the repository specifies Node
24.x. The interface tests used
`NODE_OPTIONS=--no-experimental-webstorage` to avoid Node 25's built-in
storage conflicting with jsdom. The interface build reports its existing
large-chunk warning.

## Local Docker data upgrade — 8 September 2026

SQLite data conversion now runs automatically at application startup, before
the HTTP listener and scheduled jobs. It takes a verified backup, converts
the old records and blobs transactionally, verifies the result and records
completion. Restarts skip completed migrations. The manual command remains
available for optional rehearsals and recovery; see
[SQLite migration and recovery](sqlite-v1-migration.md).

Normal Docker startup migrated the existing local database at
`2026-09-07T23:03:11.601Z` (8 September in London). The authenticated API
verified 65 sessions and all 3,996 events belonging to them, both deployments,
8 agents, 11 environments, 3 vaults, 3 credentials, all 23 file downloads,
2 memories and 4 skill archives. Original source tables still match the
pre-migration backup, including history whose parent records were already
absent before the upgrade.

The automatic backup is
`data/.backups/20260907-v0-data-to-v1-sqlite-1-rAjQPy/`, with its verified
manifest hash recorded in SQLite. The original Git branch and bundle above
remain intact.

Additional validation: 177 Node tests, 182 API contract tests and 36 runtime
adapter tests pass, including real application startup on an old database,
concurrent migration attempts, SQL rollback, repeat application, frozen
session configuration and preserved tool arguments/provider signatures.
Repository-wide typechecks passed; the Docker image builds and runs locally.

Production has not been changed, and the rebased branch has not been pushed.

## Session startup and deployment controls — 8 September 2026

- Belljar accepts upstream's mixed-case session IDs through a stable sandbox
  name derived from the full ID. Existing sandbox names remain unchanged,
  and lifecycle callbacks use the same mapping.
- Plain-text tool results become content blocks before persistence and SSE,
  so fetching history no longer fails when a tool returns a string.
- Initial messages are admitted into the native event log and dispatched.
  Their stable IDs prevent duplicate admission, while the original initial
  event records remain intact and appear only once in runtime history.
- Empty sessions start idle. Startup also restores previously empty running
  sessions to idle, guarded by their revision and absence of accepted or
  initial events.
- Each deployment row has a visible Run now button with pending state and
  duplicate-click protection.

Real local Docker checks created temporary sessions, executed a shell command,
and fetched complete history with no session errors. A separate check verified
that an initial message runs automatically. Test sessions were deleted afterward.
The Node suite passed 181 tests before the empty-state correction; the six SDK
and initialization checks and 18 application checks passed after it. Runtime
adapter, SQL history and deployment interface tests also passed, along with
typechecking and architecture checks.

## Session views and duplicate writers — 8 September 2026

The checked upstream commit already exposes both `/v1/sessions` and
`/v1/oma/sessions`. New sessions are stored in `managed_sessions`, but its
additional detail, trajectory, pending and output handlers still looked up
the old `sessions` table. That explains the observed combination of a
successful session creation and subsequent "Session not found" responses.
This was reproduced in the local Docker application; it is not a claim
about upstream's hosted service.

The fix changes those existing handlers to use the same workspace-scoped
application ports as `/v1/sessions`. It keeps the upstream interface URLs,
uses the existing serializers and trajectory builder, and reads complete
history with the pinned environment. Both runtime compositions provide those
ports. The temporary route override bundles have been removed.

The fork's old deployment store, HTTP handlers and scheduler have also been
removed. Manual and scheduled runs now use the native deployment and run
stores exclusively. The obsolete Node file upload writer is removed, and
manual CLI credentials use the native vault API. Applied SQL migrations and
the original source tables remain intact for recovery.

The final local Docker checks at `2026-09-08T10:58:26Z` verified:

- Native deployments, deployment runs, vaults and files return HTTP 200.
- The retired deployment and file upload endpoints return HTTP 404.
- Session detail, history, trajectory, pending and outputs return HTTP 200
  for newly created sessions without old-table counterparts.
- All 3,996 original events, 23 file downloads, both deployments, 8 agents,
  11 environments, 3 vaults, 3 credentials, 2 memories and 4 skill archives
  remain accessible. There are now 70 sessions, including subsequent runs.

Validation includes 185 Node tests for the session and writer cleanup, the
native SDK deployment launch checks, and the scheduled-run claim/failure
checks. Architecture and test-discovery checks pass. The final image is
`sha256:3d0bac1dfd2ff3b16a4d78169eb85b36f1b67c830a508998e4ae471e991bcaf9`.

## Edinburgh Weather MCP diagnosis — 8 September 2026

The failed weather run at `10:29:36Z` had its Dendrite MCP configuration and
vault attachment, but MCP setup returned HTTP 401. The access token expired
on 4 August. A native vault-forwarding probe at `10:33:43Z` confirmed that
the OAuth token endpoint rejected renewal with
`Errors.OIDCSession.RefreshTokenInvalid`. The access token, refresh token,
client settings and scopes matched the automatic pre-migration backup
exactly. The provider did not specify whether the refresh token had expired,
been revoked or previously rotated.

The harness logged the MCP setup failure and continued with only its basic
tools. It now also emits the existing `session.warning` event, which passes
through native persistence, history and SSE to the interface. The vault page
has a Reconnect action that reuses the saved client settings and scopes and
updates the existing credential ID, preserving attachments.

A replacement credential was saved at `10:41:39Z`. The subsequent weather
run made eight MCP calls, deployed the site, and received a healthy status
from Dendrite. A separate read-only handshake and tool listing at `10:51:50Z`
confirmed all 14 MCP tools are available. The reconnect login redirect was
also verified in local Docker without modifying that new credential.

The OAuth/runner/integration checks pass all 18 tests; the MCP warning and
API contract checks pass all 54; the SQLite session-view checks pass all 4.
All 162 interface tests and Node, interface and Cloudflare typechecks pass.
These checks do not require running a deployment or publishing a site.
