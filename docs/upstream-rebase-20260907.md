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

These checks cover local execution and test adapters. No live Belljar
deployment or production database conversion was performed. The rebased
branch has not been pushed or deployed.
