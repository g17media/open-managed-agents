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
