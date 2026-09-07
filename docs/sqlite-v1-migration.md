# Upgrade an existing SQLite installation to v1

The application automatically migrates existing SQLite data during normal
startup. Before opening its HTTP listener or starting scheduled jobs, it takes
a verified backup, runs the versioned migration in a SQLite transaction,
verifies the result and records completion. Subsequent restarts skip it.
A migration error stops startup with the original data retained; the app cannot
silently present empty lists from an unmigrated database.

The normal Docker upgrade requires no migration command:

```sh
docker compose up -d --build --wait
```

As with any SQLite upgrade, replace the old application instance and let active
turns finish first. Do not run the old and new servers against the same files
at the same time. The migration holds SQLite's write lock throughout planning,
backup and conversion; concurrent startup attempts wait and then see the
completion record. Filesystem changes are rechecked before commit.

Backups are saved under the data directory's `.backups/` folder. Startup logs
record progress, counts and the completed backup path. The backup includes the
SQLite databases, blobs/workspaces and a private `configuration.env` containing
the existing encryption and authentication secrets. Preserve the deployment's
remaining configuration and previous image as usual. Copy the backup off-host
according to the installation's backup policy.

Set `OMA_AUTO_MIGRATE=0` only to opt out deliberately; an old database will then
refuse to serve until manually migrated. The commands below are optional tools
for rehearsals, inspection and recovery, not a required deployment step.

This procedure is for a single SQLite database with local filesystem storage:
`oma.db`, `auth.db`, `files-blobs/`, `memory-blobs/`, `sandboxes/` and
`session-outputs/` under the same data directory, as in `docker-compose.yml`.
Keep the existing `PLATFORM_ROOT_SECRET`, `BETTER_AUTH_SECRET`, authentication
database, data volume and workspace memberships. The server and `oma-vault`
must receive the same `PLATFORM_ROOT_SECRET`.

## What the migration does

- Preserves resource IDs, workspace ownership, timestamps, agent versions,
  session snapshots, deployment launch settings and historical run links.
- Converts every supported event belonging to an existing session, retaining
  ordering and tool/model correlations. v0 stream-local message/thinking IDs
  could repeat between turns; v1 event IDs are derived deterministically from
  the original `(session_id, seq)` key. Original event rows remain untouched.
  String tool results become text blocks; `harness_error` becomes
  `unknown_error` with its original message. Thinking text and provider
  signatures survive history reconstruction.
- Copies uploaded file bytes into the native blob layout; compiles versioned
  skill archives including binary assets; imports current memory content and
  its version history. Copies local session workspaces into the workspace
  scoped directory. Existing files and old tables are never overwritten.
- Re-encrypts credentials and repository tokens for their native stores.
  OAuth refresh credentials remain usable. Reports contain hashes and counts,
  never credential values or conversation content.
- Resumes schedules at their next future slot, without replaying missed runs
  from maintenance. Once migrated, the server disables the old deployment
  scheduler so an old and a new copy cannot both launch a scheduled run.
- Creates a private full-directory backup, snapshots every SQLite database
  with SQLite's online backup API, checks SQLite integrity and reads all
  backup files back to verify their hashes. Pending schema migrations, data
  inserts and the completion ledger commit in one SQLite transaction.
- Checks every inserted row, decrypts each migrated secret for comparison,
  verifies destination bytes and rechecks source files before committing.
  A stale plan, changed key, missing blob or occupied destination ID aborts.
  A repeated apply of the completed plan is a no-op, including after new v1
  edits. It never resets those edits to the old data.

Accounts, API keys, model cards and integration configuration retain their
existing stores. No authentication reset or replacement workspace is needed.
Update clients using the old extension endpoints to the v1 resource APIs;
for example, deployments now use `/v1/deployments`.

## Rehearse before production

Use a consistent copy of **both databases and the entire data directory**,
plus the matching secrets, to rehearse this procedure. Do not use an ordinary
copy of an open SQLite file without its WAL. Either stop all writers before
copying or use a coordinated snapshot/SQLite backup procedure.

The dry-run deliberately refuses configurations it cannot translate faithfully,
including active sessions, secondary session threads, cancelled events,
custom harnesses, auxiliary/explicit model-card bindings and unsupported
credential types. Resolve the reported mapping on the copy and add regression
coverage before proceeding. Do not remove source rows or stamp the completion
ledger to get past an error. Remote/S3 blobs and PostgreSQL are outside this
command's scope.

Read the report's warnings. History whose parent session/store was already
deleted remains in the original tables; no workspace ownership is invented.
Sessions predating stored environment configurations pin the current
configuration, because an earlier configuration was never saved. Where the
current memory bytes have no matching historical version, the migration
adds an explicitly attributed version without replacing existing history.

## Optional manual Docker procedure

For an operator-controlled rehearsal or maintenance migration, run from the
installation directory. Build from the reviewed commit and retain
the previous images. These example backup names must be unused.

```sh
umask 077
mkdir -p data/.backups/upgrade-v1
cp .env docker-compose.yml data/.backups/upgrade-v1/
docker image tag openma/main-node:dev openma/main-node:before-v1
docker image tag openma/oma-vault:dev openma/oma-vault:before-v1
docker compose build oma-server oma-vault
```

Enter maintenance: stop accepting new turns/webhooks, let running turns and
sandbox writes finish, then stop **every** server, credential proxy, CLI bridge,
background worker or other process that can write either database or its files.
For the default stack, after draining sessions:

```sh
docker compose stop oma-server oma-vault
docker compose run --rm --no-deps oma-server pnpm migrate:v0 plan \
  --data-dir /app/data \
  --report /app/data/.backups/upgrade-v1/plan.json
```

Review the counts and warnings against the pre-upgrade inventory. The plan is
read-only. If any writer changes the source, generate a fresh plan at a new
report path. `--maintenance` is the operator's assertion that all writers are
stopped; SQLite's write lock cannot stop a sandbox writing files.

```sh
docker compose run --rm --no-deps oma-server pnpm migrate:v0 apply \
  --data-dir /app/data \
  --plan /app/data/.backups/upgrade-v1/plan.json \
  --maintenance \
  --report /app/data/.backups/upgrade-v1/applied.json
docker compose run --rm --no-deps oma-server pnpm migrate:v0 status \
  --data-dir /app/data
```

The output records the verified backup directory, its manifest hash, source
and destination counts, and completion time. Keep an off-host copy of that
backup and the saved configuration before reopening traffic.

```sh
docker compose up -d --no-build --wait oma-server oma-vault
curl --fail http://localhost:8787/health
```

Log in using the existing account. Check agent/environment/vault counts,
deployment settings and runs, session titles and complete paginated histories,
downloaded files, memory contents/history and skill archives. Resume a selected
session and confirm its existing workspace files and credentials work before
reopening production traffic. Health alone does not verify migrated data.

For a checkout without Docker, the same command is available through:

```sh
pnpm --filter @open-managed-agents/main-node migrate:v0 plan \
  --data-dir /absolute/path/to/data \
  --config /absolute/path/to/.env \
  --report /absolute/path/to/plan.json
```

Paths are relative to `apps/main-node` when invoked through the package filter;
absolute paths avoid ambiguity. `--config` loads secrets from that environment
file and includes it in the automatic apply backup. `--data-dir` selects the
entire storage layout above. Use `--backup-dir` to place the automatic backup
elsewhere when necessary. Report files use exclusive creation; choose a fresh
filename instead of overwriting an earlier audit.

## Failure and rollback

An apply failure rolls back all SQL changes. It may leave unreferenced copies
in the new filesystem layout. A retry verifies matching files and refuses
conflicts; original files remain in place. The error names the verified backup.
If the process dies just after commit, `status` reads the completion record
directly from SQLite even if the external report was not written.

Before accepting any v1 writes, rollback consists of stopping all writers,
retaining the failed/current data directory, restoring the complete verified
backup and saved configuration, and starting the previous images. For example,
substitute the actual backup directory printed by apply:

```sh
docker compose stop oma-server oma-vault
mv data data.after-v1
cp -a data.after-v1/.backups/20260907-v0-data-to-v1-sqlite-1-XXXXXX/data data
cp data.after-v1/.backups/upgrade-v1/.env .env
docker image tag openma/main-node:before-v1 openma/main-node:dev
docker image tag openma/oma-vault:before-v1 openma/oma-vault:dev
docker compose up -d --no-build --wait oma-server oma-vault
```

Restore compatible compose/configuration files if those changed too. Preserve
file ownership expected by the container. Do not restore only `oma.db`: the
authentication database and blobs/workspaces must match its snapshot.

After accepting v1 writes, a pre-upgrade restore would discard those new
changes. Keep both complete snapshots and reconcile/export the new records
before rolling back. A migration rerun is not a reverse migration.

## Recorded local verification, 7–8 September 2026

The pre-upgrade backup was restored to an isolated directory and migrated with
the same command. An authenticated application instance verified 8 agents,
11 environments, 65 sessions, 2 deployments, 3 vaults and 3 credentials;
all 3,996 events belonging to those sessions; all 23 file downloads byte for
byte; 2 current memories; and 4 skill archives byte for byte.

The original 4,683 event rows remain intact: 687 already belonged to 36 missing
session rows before the upgrade. Of 22 original memory-version rows, 20 belong
to the retained store; two belong to previously removed test stores and remain
in the original table. The migration also recovered 33 deployment run links.
Normal Docker startup subsequently performed the automatic migration on the
local installation, completing at `2026-09-07T23:03:11.601Z` (8 September in
London), before starting its HTTP listener or scheduler. The same authenticated
checks passed against that Docker instance. The original source tables still
match its verified pre-migration backup. This is evidence from the local
dataset, not a claim that production was run.
