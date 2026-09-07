import { migrateV0AtStartup } from "./migrations/v0-data.js";
import { nativeOAuthCredentials } from "@open-managed-agents/http-routes";
import { ManagedMemoryFiles } from "./lib/managed-memory-files.js";
import { mountManagedSessionResources, managedSessionReminders, promoteManagedSessionOutputs } from "./lib/managed-session-preparation.js";
/**
 * apps/main-node — self-host Node entry for the Open Managed Agents API.
 *
 * Wiring file. ~280 lines: build services → mount route bundles from
 * @open-managed-agents/http-routes → start server. All route bodies live
 * in packages/http-routes; storage adapters in their respective packages
 * (agents-store, vaults-store, memory-store, etc.).
 */

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { buildBelljarLifecycleRoutes } from "./lib/belljar-lifecycle.js";
import { createEnvironmentSnapshotLoader } from "./lib/environment-snapshot.js";
import { BelljarSandbox } from "@open-managed-agents/sandbox/adapters/belljar";
import { startupEnabled } from "@open-managed-agents/sandbox/startup";
import {
  createNodeLogger,
} from "@open-managed-agents/observability/logger/node";
import {
  createNodeMetricsRecorder,
  type NodeMetricsHandle,
} from "@open-managed-agents/observability/metrics/node";
import {
  createNodeTracer,
  type NodeTracerHandle,
} from "@open-managed-agents/observability/tracer/node";
import {
  requestMetrics,
  tracerMiddleware,
  setRootLogger,
  type Logger,
} from "@open-managed-agents/observability";
import {
  createBetterSqlite3SqlClient,
  createPostgresSqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import { createSqliteAgentService } from "@open-managed-agents/agents-store";
import {
  createSqliteMemoryStoreService,
  SqlMemoryRepo,
} from "@open-managed-agents/memory-store";
import { createSqliteDreamService } from "@open-managed-agents/dreams-store";
import { createSqliteDeploymentService } from "@open-managed-agents/deployments-store";
import { LocalFsBlobStore as MemoryLocalFsBlobStore } from "@open-managed-agents/memory-store/adapters/local-fs-blob";
import {
  S3BlobStore as FilesS3BlobStore,
  type BlobStore,
} from "@open-managed-agents/blob-store";
import { LocalFsBlobStore as FilesLocalFsBlobStore } from "@open-managed-agents/blob-store/adapters/local-fs";
import { createSqliteVaultService } from "@open-managed-agents/vaults-store";
import { createSqliteCredentialService } from "@open-managed-agents/credentials-store";
import { createSqliteSessionService } from "@open-managed-agents/sessions-store";
import { createSqliteFileService } from "@open-managed-agents/files-store";
import { createSqliteEvalRunService } from "@open-managed-agents/evals-store";
import { createSqliteEnvironmentService } from "@open-managed-agents/environments-store";
import { createSqliteModelCardService } from "@open-managed-agents/model-cards-store";
import { buildMemoryGates } from "@open-managed-agents/rate-limit/adapters/memory";
import {
  resolveProxyTargetByTenant,
  forwardWithRefresh,
} from "@open-managed-agents/vault-forward/proxy";
import { forwardManagedMcpRequest } from "@open-managed-agents/vault-forward/managed";
import { toFileRecord } from "@open-managed-agents/files-store";
import { SqlEventLog } from "@open-managed-agents/event-log/sql";
import type { SessionEvent } from "@open-managed-agents/shared";
import {
  generateEventId,
  generateFileId,
  fileR2Key,
  skillFileR2Key,
  listAuthProviders,
} from "@open-managed-agents/shared";
import { registerCoreHarnesses } from "@open-managed-agents/agent/harness/builtins";
import { resolveHarness } from "@open-managed-agents/agent/harness/registry";
import { buildTools } from "@open-managed-agents/agent/harness/tools";
import {
  createPiModelRuntime,
  modelThinkingLevel,
  toAiSdkLanguageModel,
} from "@open-managed-agents/agent/harness/pi-provider";
import type { PiModelConfig } from "@open-managed-agents/agent/harness/pi-provider";
import { generateText } from "ai";
import { composeSystemPrompt } from "@open-managed-agents/agent/harness/platform-guidance";
import type { HarnessContext } from "@open-managed-agents/agent/harness/interface";
import { nodeToMarkdown } from "@open-managed-agents/markdown/adapters/node";
import { applyBetterAuthSchema } from "@open-managed-agents/schema";
import type { OmaDb } from "@open-managed-agents/db-schema";
import { ensureSchema as ensureEventLogSchema } from "@open-managed-agents/event-log/sql";
import {
  buildAgentRoutes as buildLegacyAgentRoutes,
  buildVaultRoutes as buildLegacyVaultRoutes,
  buildModelCardRoutes,
  buildEnvironmentRoutes as buildLegacyEnvironmentRoutes,
  buildSessionRoutes,
  buildMemoryRoutes as buildLegacyMemoryRoutes,
  buildDreamRoutes,
  buildDeploymentRoutes,
  buildTenantRoutes,
  buildMeRoutes,
  buildApiKeyRoutes,
  buildEvalRoutes,
  buildSkillRoutes,
  buildSkillGitHubRoutes,
  nativeGitHubSkillPersistence,
  buildClawhubRoutes,
  buildOAuthRoutes,
  buildCapCliOauthRoutes,
  validateAgentLimits,
  buildIntegrationsRoutes,
  buildIntegrationsGatewayRoutes,
  type RouteServices,
  type ApiKeyStorage,
  type ApiKeyMeta,
  type ApiKeyRecord,
  type InstallProxyForwarder,
  mintApiKeyOnStorage,
  sha256Hex,
} from "@open-managed-agents/http-routes";
import {
  buildAgentRoutes as buildManagedAgentRoutes,
  buildCredentialRoutes as buildManagedCredentialRoutes,
  buildDeploymentRoutes as buildManagedDeploymentRoutes,
  buildDeploymentRunRoutes as buildManagedDeploymentRunRoutes,
  buildDreamRoutes as buildManagedDreamRoutes,
  buildEnvironmentRoutes as buildManagedEnvironmentRoutes,
  buildEnvironmentWorkRoutes as buildManagedEnvironmentWorkRoutes,
  buildFileRoutes as buildManagedFileRoutes,
  buildMemoryStoreRoutes as buildManagedMemoryStoreRoutes,
  buildMemoryRoutes as buildManagedMemoryRoutes,
  buildMemoryVersionRoutes as buildManagedMemoryVersionRoutes,
  buildModelRoutes as buildManagedModelRoutes,
  buildSkillRoutes as buildManagedSkillRoutes,
  buildSkillVersionRoutes as buildManagedSkillVersionRoutes,
  buildTunnelCertificateRoutes as buildManagedTunnelCertificateRoutes,
  buildTunnelRoutes as buildManagedTunnelRoutes,
  buildVaultRoutes as buildManagedVaultRoutes,
  buildUserProfileRoutes as buildManagedUserProfileRoutes,
  buildManagedSessionsApi,
} from "@open-managed-agents/managed-agents-api";
import {
  SessionRuntimeHistoryApplicationService,
  SessionRuntimeProjectionApplicationService,
  type SessionEnvironmentSourcePort,
} from "@open-managed-agents/managed-agents-application";
import { bindPort, defineAppModule, providePort } from "@open-managed-agents/app";
import { managedAgentsPortTokens } from "@open-managed-agents/app/managed-agents";
import {
  deploymentAgentSourcePort,
  deploymentEnvironmentSourcePort,
  deploymentFileSourcePort,
  deploymentMemoryStoreSourcePort,
  deploymentSchedulePlannerPort,
  deploymentSessionLauncherPort,
  deploymentVaultSourcePort,
} from "@open-managed-agents/app/modules/deployments";
import {
  dreamCuratorPort,
  dreamExecutionModule,
  dreamMemoryStoreSourcePort,
  dreamMemoryWorkspacePort,
  dreamSessionSourcePort,
} from "@open-managed-agents/app/modules/dreams";
import {
  environmentSessionWorkEnqueuerPort,
  environmentWorkAvailabilityWaiterPort,
  environmentWorkEnqueuerModule,
  environmentWorkEnvironmentSourcePort,
  environmentWorkSessionCredentialIssuerPort,
} from "@open-managed-agents/app/modules/environment-work";
import {
  memoryContentDescriptorPort,
  memoryStoreForMemorySourcePort,
  memoryVersionActorPort,
} from "@open-managed-agents/app/modules/memories";
import { modelCatalogSourcePort } from "@open-managed-agents/app/modules/models";
import {
  skillPackageCompilerPort,
} from "@open-managed-agents/app/modules/skills";
import {
  tunnelCertificateAuthorityPort,
  tunnelProvisionerPort,
  tunnelTokenManagerPort,
} from "@open-managed-agents/app/modules/tunnels";
import {
  userProfileEnrollmentIssuerPort,
} from "@open-managed-agents/app/modules/user-profiles";
import {
  createNodeManagedAgentsApp,
  createNodePlatform,
} from "@open-managed-agents/platform-node";
import { SqlFileStore } from "@open-managed-agents/file-store-sql";
import {
  SqlCredentialStore,
  type CredentialDocumentCipher,
} from "@open-managed-agents/credential-store-sql";
import { SqlVaultStore } from "@open-managed-agents/vault-store-sql";
import {
  SqlDeploymentStore,
  type DeploymentResourceSecretCipher,
} from "@open-managed-agents/deployment-store-sql";
import { SqlDeploymentRunStore } from "@open-managed-agents/deployment-run-store-sql";
import { SqlDreamStore } from "@open-managed-agents/dream-store-sql";
import { SqlMemoryStoreStore } from "@open-managed-agents/memory-store-store-sql";
import { SqlMemoryDocumentStore } from "@open-managed-agents/memory-document-store-sql";
import { SqlSkillStore } from "@open-managed-agents/skill-store-sql";
import { SqlTunnelStore } from "@open-managed-agents/tunnel-store-sql";
import { SqlUserProfileStore } from "@open-managed-agents/user-profile-store-sql";
import {
  SqlEnvironmentWorkStore,
  type EnvironmentWorkSecretCipher,
} from "@open-managed-agents/environment-work-store-sql";
import {
  SqlAgentPersistence,
  SqlDeploymentAgentSource,
  SqlDeploymentVaultSource,
  SqlEnvironmentPersistence,
  SqlFileMetadataPersistence,
  SqlMemoryStoreSource,
  SqlManagedSessionsComposition,
  SqlSessionEnvironmentSource,
  SqlSessionSource,
  SqlSessionRuntimeProjectionPersistence,
} from "@open-managed-agents/managed-agents-adapters-sql";
import {
  createSqlSessionRuntimeReaders,
} from "@open-managed-agents/session-runtime-sql";
import { MemorySessionRealtimeHub } from "@open-managed-agents/session-realtime-memory";
import {
  AnthropicMessagesDreamCurator,
  ApplicationDreamMemoryWorkspace,
  ModelCardCatalogSource,
  CronDeploymentSchedulePlanner,
  EnvironmentAwareSessionLifecycleRouter,
  TimerEnvironmentWorkAvailabilityWaiter,
  IndeterminateCredentialValidationProbe,
  inProcessDreamExecutionSchedulerModule,
  LocalTunnelProvisioner,
  OpaqueEnvironmentWorkSessionCredentialIssuer,
  DeduplicatingDreamCurator,
  WebCryptoTunnelCertificateAuthority,
  WebCryptoTunnelTokenManager,
  WebCryptoMemoryContentDescriptor,
  ZipSkillPackageCompiler,
} from "@open-managed-agents/managed-agents-adapters-runtime";
import { BlobFileContentStore } from "@open-managed-agents/managed-agents-adapters-blob";
import { buildOmaModelsHttpRoutes } from "@open-managed-agents/managed-agents-adapters-http";
import {
  buildNodeRepos,
  SqlFeishuInstallationRepo,
  SqlFeishuPublicationRepo,
  SqlSlackInstallationRepo,
  SqlSlackPublicationRepo,
  SqlSlackAppRepo,
  WebCryptoAesGcm,
  CryptoIdGenerator,
  WorkerHttpClient,
  type NodeReposEnv,
} from "@open-managed-agents/integrations-adapters-node";
import {
  NodeInstallBridge,
  buildNodeProvidersForRequest,
} from "./lib/node-install-bridge.js";
import { OmaVaultResolver } from "@open-managed-agents/oma-cap-adapter";
import { NodeSessionRouter } from "./lib/node-session-router.js";
import {
  configureFeishuAgentTools,
  resolveFeishuAgentTools,
  sqlSessionMetadataReader,
} from "./lib/feishu-agent-tools.js";
import { nodeOutputsAdapter } from "./lib/node-outputs-adapter.js";
import { nodeSessionLifecycle } from "./lib/node-session-lifecycle.js";
import { NodeWorkspaceBackupService } from "./lib/node-workspace-backup.js";
import { DefaultSandboxOrchestrator } from "@open-managed-agents/sandbox/orchestrator";
import { createAuthMiddleware as buildAuthMw } from "@open-managed-agents/auth";
import {
  buildBetterAuth,
  ensureTenantSqlite,
  oidcFromEnv,
} from "@open-managed-agents/auth-config";
import { senderFromEnv } from "@open-managed-agents/email/adapters/nodemailer";
import { SqlKvStore } from "@open-managed-agents/kv-store/adapters/sql";
import { listAll as kvListAll } from "@open-managed-agents/kv-store";
import {
  selectBrowserHarness,
  buildSelectedBrowserHarness,
} from "@open-managed-agents/browser-harness/select";
import type { BrowserHarness } from "@open-managed-agents/browser-harness";
import { startMemoryBlobWatcher } from "./lib/memory-blob-watcher.js";
import { buildNodeScheduler } from "./lib/node-scheduler-jobs.js";
import { startNodeMemoryQueue } from "./lib/node-memory-queue.js";
import { mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { nanoid } from "nanoid";
import {
  InProcessEventStreamHub,
  type EventStreamHub,
} from "./lib/event-stream-hub";
import { PgEventStreamHub } from "./lib/pg-event-stream-hub";
import { NodeHarnessRuntime } from "./lib/node-harness-runtime";
import { SessionRegistry, resolveSessionMemoryBindings } from "./registry.js";
import { ManagedNodeDefaultHarness } from "./lib/node-managed-default-harness.js";
import {
  allowAllLegacyHarnessTools,
  toLegacyHarnessAgentConfig,
} from "./lib/node-managed-agent-codec.js";
import { NodeManagedConfirmedToolExecutor } from "./lib/node-managed-confirmed-tool-executor.js";
import { NodeManagedOutcomeEvaluator } from "./lib/node-managed-outcome-evaluator.js";
import {
  ApplicationBackedNodeManagedSessionRuntimeEngine,
  DefaultNodeManagedSessionRuntimeDriver,
  NodeManagedSessionRuntimeAdapter,
} from "./lib/node-managed-session-runtime.js";
import { DefaultNodeManagedSessionRunner } from "./lib/node-managed-session-runner.js";

registerCoreHarnesses();

const toMarkdownProvider = nodeToMarkdown();

// ─── Observability bootstrap ─────────────────────────────────────────────
//
// Logger is constructed first so every later step can use it instead of
// raw console.*. Metrics + tracer follow; both are no-ops by default and
// only spin up real backends when the env opts in.
//   - Prometheus metrics: always-on in-process registry; /metrics text
//     endpoint mounted below.
//   - OTel tracing: starts only when OTEL_EXPORTER_OTLP_ENDPOINT is set.
const logger: Logger = await createNodeLogger({
  bindings: { service: "main-node", pid: process.pid },
});
setRootLogger(logger);

const metrics: NodeMetricsHandle = await createNodeMetricsRecorder();
const tracer: NodeTracerHandle = await createNodeTracer({
  serviceName: "oma-main-node",
});

// ─── Bootstrap ───────────────────────────────────────────────────────────

const dbUrl = process.env.DATABASE_URL ?? "";
const usePostgres = dbUrl.startsWith("postgres://") || dbUrl.startsWith("postgresql://");
const dialect = usePostgres ? "postgres" : "sqlite";

let sql: SqlClient;
let backendDescription: string;
// drizzleDb is the dependency-inversion seam new-style adapters take.
// Constructed once at the composition root from the right concrete driver.
// Existing SqlClient is still built alongside for the legacy applySchema /
// integrations adapters until those finish migrating.
let drizzleDb: OmaDb<Record<string, unknown>>;
let v0DataMigrated = false;
if (usePostgres) {
  sql = await createPostgresSqlClient(dbUrl);
  const { drizzle: drizzlePostgresJs } = await import("drizzle-orm/postgres-js");
  const postgresMod = (await import("postgres" as string)) as { default: (dsn: string) => unknown };
  const pgClient = postgresMod.default(dbUrl);
  drizzleDb = drizzlePostgresJs(pgClient as never) as unknown as OmaDb<Record<string, unknown>>;
  const u = new URL(dbUrl);
  backendDescription = `postgres ${u.hostname}:${u.port || 5432}${u.pathname}`;
} else {
  const dbPath = process.env.DATABASE_PATH ?? "./data/oma.db";
  mkdirSync(dirname(dbPath), { recursive: true });
  sql = await createBetterSqlite3SqlClient(dbPath);
  const { drizzle: drizzleBetterSqlite3 } = await import("drizzle-orm/better-sqlite3");
  const BetterSqlite3 = (await import("better-sqlite3")).default;
  const sqliteRaw = new BetterSqlite3(dbPath);
  const dataMigration = await migrateV0AtStartup({
    databasePath: dbPath, dataDir: dirname(dbPath), rootSecret: process.env.PLATFORM_ROOT_SECRET ?? "",
    enabled: process.env.OMA_AUTO_MIGRATE !== "0",
    remoteBlobs: Boolean(process.env.FILES_S3_ENDPOINT || process.env.FILES_S3_BUCKET || process.env.MEMORY_S3_ENDPOINT || process.env.MEMORY_S3_BUCKET),
    backupConfiguration: {
      PLATFORM_ROOT_SECRET: process.env.PLATFORM_ROOT_SECRET ?? "",
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "",
    },
    storagePaths: {
      "auth.db": process.env.AUTH_DATABASE_PATH ?? "./data/auth.db",
      "files-blobs": process.env.FILES_BLOB_DIR ?? "./data/files-blobs",
      "memory-blobs": process.env.MEMORY_BLOB_DIR ?? "./data/memory-blobs",
      sandboxes: process.env.SANDBOX_WORKDIR ?? "./data/sandboxes",
      "session-outputs": process.env.SESSION_OUTPUTS_DIR ?? "./data/session-outputs",
    },
    onProgress: ({ phase, report }) => logger.info({ op: "main-node.data_migration", phase, ...(report && { report }) }, `SQLite data migration: ${phase}`),
  });
  v0DataMigrated = dataMigration !== null;
  // Match D1's runtime default — FK enforcement off. See packages/sql-client
  // for the rationale (publication-first install + a few other paths).
  sqliteRaw.exec("PRAGMA foreign_keys = OFF");
  drizzleDb = drizzleBetterSqlite3(sqliteRaw) as unknown as OmaDb<Record<string, unknown>>;
  backendDescription = `sqlite ${dbPath}`;
}

// Apply the consolidated baseline (Drizzle migrate runner — one folder per
// dialect, generated by `pnpm db:generate:node-{pg,sqlite}`). Replaces the
// pre-Drizzle applySchema / applyTenantSchema / applyIntegrationsSchema /
// applyMemoryPollerSchema chain — those creator functions hand-wrote
// CREATE TABLE IF NOT EXISTS and ad-hoc ALTER backfills, which had been
// drifting from the canonical CF migration files.
//
// session_events (event-log) is still its own concern: its idempotent
// ensureSchema lives in @open-managed-agents/event-log/sql and runs after
// the baseline migration applies the rest.
const migrationsFolder = usePostgres
  ? new URL("../migrations", import.meta.url).pathname
  : new URL("../migrations-sqlite", import.meta.url).pathname;
if (usePostgres) {
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  await migrate(drizzleDb as never, { migrationsFolder });
} else {
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(drizzleDb as never, { migrationsFolder });
}
await ensureEventLogSchema(sql, dialect);
const managedAgentsPersistence = new SqlAgentPersistence(sql);
const managedAgentsPlatform = createNodePlatform({
  features: {
    preset: "none",
    agents: true,
    environments: true,
    files: true,
    memoryStores: true,
    userProfiles: true,
  },
  stores: {
    agents: managedAgentsPersistence,
    environments: new SqlEnvironmentPersistence(sql),
    files: new SqlFileStore(sql),
    memoryStores: new SqlMemoryStoreStore(sql),
    userProfiles: new SqlUserProfileStore(sql),
  },
  fileContent: () => new BlobFileContentStore(filesBlob),
  clock: { now: () => new Date() },
  ids: {
    next: (namespace) =>
      `${namespace === "environment" ? "env" : namespace === "memory_store" ? "memstore" : namespace === "user-profile" ? "uprof" : namespace}_${nanoid()}`,
  },
  modules: () => [
    providePort(userProfileEnrollmentIssuerPort, {
      issue: async () => ({
        type: "conflict" as const,
        message: "User Profile enrollment is unavailable in self-hosted mode",
      }),
    }),
  ],
});

// Integrations subsystem boot is gated on PLATFORM_ROOT_SECRET (used to
// encrypt OAuth tokens etc.). Tables are part of the consolidated baseline
// above so they're always created — the gate now only controls subsystem
// wiring, not schema bootstrap.
const platformRootSecret = process.env.PLATFORM_ROOT_SECRET;

// ─── Auth ───────────────────────────────────────────────────────────────

const authDisabled = process.env.AUTH_DISABLED === "1";
const authDbPath = process.env.AUTH_DATABASE_PATH ?? "./data/auth.db";
const sender = senderFromEnv(process.env);
const oidc = oidcFromEnv(process.env);
const passwordAuthDisabled = process.env.AUTH_PASSWORD_DISABLED === "1";
const signupDisabled = process.env.AUTH_SIGNUP_DISABLED === "1";
const googleEnabled = !!(
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
);
if (!authDisabled && passwordAuthDisabled && !googleEnabled && !oidc) {
  console.warn(
    "[auth] AUTH_PASSWORD_DISABLED=1 with no Google or OIDC provider configured — nobody can sign in",
  );
}

let auth: ReturnType<typeof buildBetterAuth> | null = null;
let authShutdown: (() => Promise<void>) | null = null;

if (!authDisabled) {
  if (usePostgres) {
    const { Pool } = (await import("pg")) as typeof import("pg");
    const pgPool = new Pool({ connectionString: dbUrl });
    await applyBetterAuthSchema({ sql, dialect: "postgres" });
    auth = buildBetterAuth({
      database: pgPool,
      sender,
      secret: process.env.BETTER_AUTH_SECRET ?? randomFallback(),
      baseURL: process.env.PUBLIC_BASE_URL,
      googleClientId: process.env.GOOGLE_CLIENT_ID,
      googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
      githubClientId: process.env.GITHUB_CLIENT_ID,
      githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
      oidc,
      requireEmailVerify: process.env.AUTH_REQUIRE_EMAIL_VERIFY === "1",
      passwordDisabled: passwordAuthDisabled,
      signupDisabled,
      cookieDomain: process.env.AUTH_COOKIE_DOMAIN,
      ensureTenant: (u) => ensureTenantSqlite(sql, u.id, u.name, u.email),
    });
    authShutdown = async () => {
      await pgPool.end();
    };
  } else {
    mkdirSync(dirname(authDbPath), { recursive: true });
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const authDb = new BetterSqlite3(authDbPath);
    // Run the better-auth schema on the auth db via a thin SqlClient shim —
    // applyBetterAuthSchema only uses sql.exec which maps cleanly.
    await applyBetterAuthSchema({
      sql: betterSqliteAsSqlClient(authDb),
      dialect: "sqlite",
    });
    auth = buildBetterAuth({
      database: authDb,
      sender,
      secret: process.env.BETTER_AUTH_SECRET ?? randomFallback(),
      baseURL: process.env.PUBLIC_BASE_URL,
      googleClientId: process.env.GOOGLE_CLIENT_ID,
      googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
      githubClientId: process.env.GITHUB_CLIENT_ID,
      githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
      oidc,
      requireEmailVerify: process.env.AUTH_REQUIRE_EMAIL_VERIFY === "1",
      passwordDisabled: passwordAuthDisabled,
      signupDisabled,
      cookieDomain: process.env.AUTH_COOKIE_DOMAIN,
      ensureTenant: (u) => ensureTenantSqlite(sql, u.id, u.name, u.email),
    });
    authShutdown = async () => {
      authDb.close();
    };
  }
}

// ─── Stores ─────────────────────────────────────────────────────────────

const agentsService = createSqliteAgentService({ db: drizzleDb });
const vaultService = createSqliteVaultService({ db: drizzleDb });
const credentialService = createSqliteCredentialService({ db: drizzleDb });
const sessionsService = createSqliteSessionService({ db: drizzleDb });
const filesService = createSqliteFileService({ db: drizzleDb });
const evalsService = createSqliteEvalRunService({ db: drizzleDb });
const environmentsService = createSqliteEnvironmentService({ db: drizzleDb });
const loadEnvironmentSnapshot = createEnvironmentSnapshotLoader(environmentsService);
const modelCardsService = createSqliteModelCardService(
  { db: drizzleDb },
  {
    crypto: platformRootSecret
      ? new WebCryptoAesGcm(platformRootSecret, "model.cards.keys")
      : undefined,
  },
);

let memoryBlobs: import("@open-managed-agents/memory-store").BlobStore;
let memoryBlobDescription: string;
let memoryBlobLocalDir: string | null = null;
let s3MemoryConfig: {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
} | null = null;

if (
  process.env.MEMORY_S3_ENDPOINT &&
  process.env.MEMORY_S3_BUCKET &&
  process.env.MEMORY_S3_ACCESS_KEY &&
  process.env.MEMORY_S3_SECRET_KEY
) {
  const { S3BlobStore } = await import(
    "@open-managed-agents/memory-store/adapters/s3-blob"
  );
  s3MemoryConfig = {
    endpoint: process.env.MEMORY_S3_ENDPOINT,
    bucket: process.env.MEMORY_S3_BUCKET,
    accessKey: process.env.MEMORY_S3_ACCESS_KEY,
    secretKey: process.env.MEMORY_S3_SECRET_KEY,
    region: process.env.MEMORY_S3_REGION ?? "us-east-1",
  };
  memoryBlobs = new S3BlobStore({
    endpoint: s3MemoryConfig.endpoint,
    bucket: s3MemoryConfig.bucket,
    accessKeyId: s3MemoryConfig.accessKey,
    secretAccessKey: s3MemoryConfig.secretKey,
    region: s3MemoryConfig.region,
  });
  memoryBlobDescription = `s3 ${s3MemoryConfig.endpoint}/${s3MemoryConfig.bucket}`;
} else {
  memoryBlobLocalDir = process.env.MEMORY_BLOB_DIR ?? "./data/memory-blobs";
  memoryBlobs = new MemoryLocalFsBlobStore({ baseDir: memoryBlobLocalDir });
  memoryBlobDescription = `localfs ${memoryBlobLocalDir}`;
}

const memoryService = createSqliteMemoryStoreService({
  db: drizzleDb,
  blobs: memoryBlobs,
});
const deploymentsService = createSqliteDeploymentService({
  client: sql,
  verifyAgentExists: async (tenantId, agentId) => {
    const row = await sql
      .prepare("SELECT 1 FROM agents WHERE id = ? AND tenant_id = ?")
      .bind(agentId, tenantId)
      .first();
    return !!row;
  },
});
const dreamsService = createSqliteDreamService({
  client: sql,
  verifyMemoryStoreExists: async (tenantId, storeId) => {
    const row = await sql
      .prepare("SELECT 1 FROM memory_stores WHERE id = ? AND tenant_id = ?")
      .bind(storeId, tenantId)
      .first();
    return !!row;
  },
  verifySessionExists: async (tenantId, sessionId) => {
    const row = await sql
      .prepare("SELECT 1 FROM sessions WHERE id = ? AND tenant_id = ?")
      .bind(sessionId, tenantId)
      .first();
    return !!row;
  },
});
const memoryRepo = new SqlMemoryRepo(drizzleDb);
// Memory blob watcher — wires chokidar fs events through
// packages/queue's processMemoryEvent so CF + Node share one upsert
// code path. PG mode uses the multi-replica-safe PG queue table; SQLite
// single-instance uses an in-memory queue. Set MEMORY_QUEUE=disabled to
// skip wiring and fall back to the legacy direct-call watcher.
const useQueue = (process.env.MEMORY_QUEUE ?? "auto") !== "disabled";
const memoryWatcher = memoryBlobLocalDir && useQueue
  ? await startNodeMemoryQueue({
      mode: usePostgres ? "pg" : "in-memory",
      sql: usePostgres ? sql : undefined,
      memoryRepo,
      memoryBlobs,
      memoryRoot: memoryBlobLocalDir,
    })
  : memoryBlobLocalDir
    ? startMemoryBlobWatcher({ memoryRoot: memoryBlobLocalDir, memoryRepo })
    : { stop: async () => {} };

let s3Poller: { stop: () => Promise<void> } | null = null;
let feishuRunner: { stop: () => Promise<void> } | null = null;
if (s3MemoryConfig) {
  // memory_blob_poller_lease lives in the consolidated baseline already; no
  // separate schema bootstrap needed here.
  const replicaId = `replica_${process.pid}_${Math.floor(Math.random() * 1e9).toString(36)}`;
  const intervalSec = Number(process.env.MEMORY_S3_POLL_INTERVAL_SEC ?? 30);
  const { startS3MemoryPoller } = await import("./lib/s3-memory-poller.js");
  s3Poller = await startS3MemoryPoller({
    sql,
    sqlDialect: dialect,
    memoryRepo,
    replicaId,
    intervalMs: Math.max(5_000, intervalSec * 1000),
    s3: s3MemoryConfig,
  });
}

const outputsRoot = process.env.SESSION_OUTPUTS_DIR ?? "./data/session-outputs";
mkdirSync(outputsRoot, { recursive: true });
// Shared with the SessionRegistry's output-promotion closure below; the
// sessions routes build their own instance over the same root.
const sessionOutputs = nodeOutputsAdapter(outputsRoot);

// Shell single-quote escape for values interpolated into sandbox exec
// commands (repo URLs, mount paths, branch names). Wrapping in single
// quotes and escaping embedded quotes is the standard POSIX-safe form.
function qsh(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// ── Skill resolution (Node) ──────────────────────────────────────────────
// The Node runtime resolves agent.skills the way the CF SessionDO does:
// inline each skill's SKILL.md into the system prompt and mount its files
// into the sandbox. Skills live as tenant skills in KV (t:<tenant>:skill:<id>
// metadata + :skillver:<id>:<ver> manifest; bytes in the blob store, keyed by
// skillFileR2Key). Anthropic-hosted skills (pdf/docx/xlsx/pptx) are imported
// into the deployment via POST /v1/skills, where they get id skill_<random>
// and keep their frontmatter name — so an agent ref like
// {type:"anthropic", skill_id:"pdf"} is matched to the imported skill by NAME
// (id won't match) and the ref's `type` is ignored.
interface NodeSkillMeta {
  id: string;
  name?: string;
  display_title?: string;
  description?: string;
  latest_version?: string;
}
interface ResolvedNodeSkill {
  name: string;
  addition: string;
  files: Array<{ filename: string; bytes: Uint8Array }>;
}

async function resolveNodeSkills(
  tenantId: string,
  skillRefs: Array<{ skill_id: string; type?: string; version?: string }>,
): Promise<ResolvedNodeSkill[]> {
  if (!skillRefs.length || !filesBlob) return [];

  // Index the tenant's skills by id and by name so a ref matches either.
  const byId = new Map<string, NodeSkillMeta>();
  const byName = new Map<string, NodeSkillMeta>();
  const listed = await kvListAll(kv, `t:${tenantId}:skill:`);
  for (const k of listed) {
    const raw = await kv.get(k.name);
    if (!raw) continue;
    try {
      const m = JSON.parse(raw) as NodeSkillMeta;
      if (m.id) byId.set(m.id, m);
      if (m.name) byName.set(m.name, m);
    } catch {
      /* skip unparseable skill metadata */
    }
  }

  const resolved: ResolvedNodeSkill[] = [];
  const seen = new Set<string>();
  for (const ref of skillRefs) {
    const meta = byId.get(ref.skill_id) ?? byName.get(ref.skill_id);
    if (!meta || seen.has(meta.id)) continue;
    seen.add(meta.id);
    const version =
      ref.version && ref.version !== "latest" ? ref.version : meta.latest_version;
    if (!version) continue;
    const verRaw = await kv.get(`t:${tenantId}:skillver:${meta.id}:${version}`);
    if (!verRaw) continue;
    let fileList: Array<{ filename: string }> = [];
    try {
      fileList = ((JSON.parse(verRaw) as { files?: Array<{ filename: string }> }).files ?? []);
    } catch {
      /* skip skills with an unparseable manifest */
    }
    const files: Array<{ filename: string; bytes: Uint8Array }> = [];
    let skillMd = "";
    for (const f of fileList) {
      const obj = await filesBlob.get(skillFileR2Key(tenantId, meta.id, version, f.filename));
      if (!obj) continue;
      const bytes = await obj.bytes();
      files.push({ filename: f.filename, bytes });
      if (f.filename === "SKILL.md") skillMd = new TextDecoder().decode(bytes);
    }
    const name = meta.name || meta.display_title || ref.skill_id;
    // Inline the full SKILL.md (AMA-aligned: the model sees the instructions
    // up front). Fall back to a metadata line if SKILL.md is missing.
    const addition = skillMd
      ? `<skill name="${name}">\n${skillMd}\n</skill>`
      : `[Skill: ${name}]${meta.description ? " " + meta.description : ""}`;
    resolved.push({ name, addition, files });
  }
  return resolved;
}

// ─── Files-store blob backend ────────────────────────────────────────
//
// Keyed off FILES_S3_* env vars; falls back to a local-FS adapter under
// FILES_BLOB_DIR (default ./data/files-blobs). The blob store backs both
// the files-store table content AND workspace_backups tar archives —
// same single store, two key prefixes.

let filesBlob: BlobStore;
let filesBlobDescription: string;
if (
  process.env.FILES_S3_ENDPOINT &&
  process.env.FILES_S3_BUCKET &&
  process.env.FILES_S3_ACCESS_KEY &&
  process.env.FILES_S3_SECRET_KEY
) {
  filesBlob = new FilesS3BlobStore({
    endpoint: process.env.FILES_S3_ENDPOINT,
    bucket: process.env.FILES_S3_BUCKET,
    accessKeyId: process.env.FILES_S3_ACCESS_KEY,
    secretAccessKey: process.env.FILES_S3_SECRET_KEY,
    region: process.env.FILES_S3_REGION ?? "us-east-1",
  });
  filesBlobDescription = `s3 ${process.env.FILES_S3_ENDPOINT}/${process.env.FILES_S3_BUCKET}`;
} else {
  const filesBlobDir = process.env.FILES_BLOB_DIR ?? "./data/files-blobs";
  mkdirSync(filesBlobDir, { recursive: true });
  filesBlob = new FilesLocalFsBlobStore({ baseDir: filesBlobDir });
  filesBlobDescription = `localfs ${filesBlobDir}`;
}

const workspaceBackups = new NodeWorkspaceBackupService({
  sql,
  blobs: filesBlob,
});

const sandboxOrchestrator = new DefaultSandboxOrchestrator({
  backups: workspaceBackups,
});

// ─── Hub + event log ────────────────────────────────────────────────────

function newEventLog(sessionId: string): SqlEventLog {
  return new SqlEventLog(sql, sessionId, (e) => {
    const ev = e as SessionEvent & { id?: string; processed_at?: string };
    if (!ev.id) ev.id = `sevt_${generateEventId()}`;
    if (!ev.processed_at) ev.processed_at = new Date().toISOString();
  });
}

let hub: EventStreamHub;
if (usePostgres) {
  hub = await PgEventStreamHub.create({
    dsn: dbUrl,
    fetchEventsAfter: (sid, afterSeq) => newEventLog(sid).getEventsAsync(afterSeq),
  });
} else {
  hub = new InProcessEventStreamHub();
}

// ─── Sandbox factory ────────────────────────────────────────────────────

const SANDBOX_PROVIDER_PATHS: Record<string, string> = {
  subprocess: "@open-managed-agents/sandbox/adapters/local-subprocess",
  litebox: "@open-managed-agents/sandbox/adapters/litebox",
  boxlite: "@open-managed-agents/sandbox/adapters/litebox",
  boxrun: "@open-managed-agents/sandbox/adapters/boxrun",
  belljar: "@open-managed-agents/sandbox/adapters/belljar",
  daytona: "@open-managed-agents/sandbox/adapters/daytona",
  e2b: "@open-managed-agents/sandbox/adapters/e2b",
};

async function buildSandbox(
  sessionId: string,
  workdir: string,
  managed?: { workspaceId: string; environment: import("@open-managed-agents/managed-agents-application").Environment },
): Promise<import("@open-managed-agents/sandbox").SandboxExecutor> {
  const provider = (process.env.SANDBOX_PROVIDER ?? "subprocess").toLowerCase();
  const path = SANDBOX_PROVIDER_PATHS[provider];
  if (!path) {
    throw new Error(
      `SANDBOX_PROVIDER=${provider} not recognized; valid: ${Object.keys(SANDBOX_PROVIDER_PATHS).join(", ")}`,
    );
  }
  const mod = (await import(path)) as {
    sandboxFactory: import("@open-managed-agents/sandbox").SandboxFactory;
  };
  const session = managed ? null : await sessionsService.getById({ sessionId });
  const config = managed?.environment.config;
  const startupManaged = config?.type === "cloud" ? startupEnabled(config.startup) : startupEnabled(session?.environment_snapshot?.config?.startup);
  let overrides: Pick<import("@open-managed-agents/sandbox").SandboxFactoryContext, "image" | "registryAuth"> = {};
  if (provider === "belljar" && managed && config?.type === "cloud" && config.image) {
    overrides.image = config.image;
    if (config.imageRegistryAuth) {
      const ref = config.imageRegistryAuth;
      const vault = await new SqlVaultStore(sql).find({ workspaceId: managed.workspaceId, vaultId: ref.vaultId });
      const record = await managedCredentialStore.find({ workspaceId: managed.workspaceId, vaultId: ref.vaultId, credentialId: ref.credentialId });
      if (!vault || vault.vault.archivedAt || !record || record.credential.archivedAt || record.credential.auth.type !== "container_registry") throw new Error("Environment registry credential is unavailable");
      const auth = record.credential.auth;
      overrides.registryAuth = auth.token ? { identityToken: auth.token, serveraddress: auth.registry }
        : { username: auth.username ?? undefined, password: auth.password ?? undefined, serveraddress: auth.registry };
    }
  } else if (!managed && provider === "belljar") overrides = await environmentImageOverrides(sessionId);
  if (startupManaged && provider !== "belljar") throw new Error("Startup scripts require the Belljar sandbox provider");
  if (startupManaged && !process.env.BELLJAR_TOKEN) throw new Error("Startup scripts require BELLJAR_TOKEN for authenticated lifecycle callbacks");
  return mod.sandboxFactory(
    {
      sessionId,
      workdir,
      memoryRoot: managed ? join(memoryBlobLocalDir ?? "./data/memory", managed.workspaceId) : memoryBlobLocalDir ?? "",
      outputsRoot,
      startupManaged,
      // Only belljar honors per-session images today — skip the lookups
      // for providers that would ignore the fields anyway.
      ...overrides,
    },
    process.env,
  );
}

/**
 * Environment-level sandbox overrides: the session's environment may name
 * a custom `config.image` plus a vault credential (`image_registry_auth`)
 * to pull it from a private registry. The credential is resolved here,
 * control-plane-side, and handed to the adapter for the pull only — it
 * never enters the sandbox and is never persisted in any snapshot.
 */
async function environmentImageOverrides(
  sessionId: string,
): Promise<Pick<import("@open-managed-agents/sandbox").SandboxFactoryContext, "image" | "registryAuth">> {
  try {
    const session = await sessionsService.getById({ sessionId });
    const envId = session?.environment_id;
    if (!session || !envId) return {};
    const env = await environmentsService.get({
      tenantId: session.tenant_id,
      environmentId: envId,
    });
    const image = env?.config?.image;
    if (!image) return {};
    const ref = env.config.image_registry_auth;
    if (!ref?.vault_id || !ref?.credential_id) return { image };
    const cred = await credentialService.get({
      tenantId: session.tenant_id,
      vaultId: ref.vault_id,
      credentialId: ref.credential_id,
    });
    if (!cred || cred.archived_at || cred.auth.type !== "container_registry") {
      // Don't fail provisioning — the pull can still succeed from the
      // engine's image cache or the belljar server's own fallback creds.
      logger.warn(
        {
          op: "main-node.image_registry_auth_unusable",
          session_id: sessionId,
          environment_id: envId,
          credential_id: ref.credential_id,
        },
        "environment's image_registry_auth credential is missing, archived, or not container_registry — pulling without credentials",
      );
      return { image };
    }
    return {
      image,
      registryAuth: cred.auth.token
        ? { identityToken: cred.auth.token, serveraddress: cred.auth.registry }
        : {
            username: cred.auth.username,
            password: cred.auth.password,
            serveraddress: cred.auth.registry,
          },
    };
  } catch (err) {
    logger.warn(
      { err, op: "main-node.environment_image_overrides_failed", session_id: sessionId },
      "environment image override resolution failed; using provider defaults",
    );
    return {};
  }
}

// ─── Session registry ───────────────────────────────────────────────────

/** Resolve agent.model (a model_id handle) → wire model + credentials.
 *  Prefer a matching model card; fall back to ANTHROPIC_* env vars. */
async function resolveNodeModelCreds(
  tenantId: string,
  agentModel: import("@open-managed-agents/shared").AgentConfig["model"],
): Promise<{
  wireModel: string;
  apiKey: string;
  baseURL?: string;
  provider?: string;
  customHeaders?: Record<string, string>;
  piConfig?: PiModelConfig;
}> {
  const handle = typeof agentModel === "string" ? agentModel : agentModel.id;
  try {
    const card = await modelCardsService.findByModelId({ tenantId, modelId: handle });
    if (card && !card.archived_at) {
      const key = await modelCardsService.getApiKey({ tenantId, cardId: card.id });
      if (key) {
        return {
          wireModel: card.model,
          apiKey: key,
          baseURL: card.base_url ?? undefined,
          provider: card.provider,
          customHeaders: card.custom_headers ?? undefined,
          piConfig: card.pi_config
            ? card.pi_config as PiModelConfig
            : undefined,
        };
      }
    }
  } catch (err) {
    console.warn(
      `[model-card] lookup failed, falling back to env: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No model card matched and ANTHROPIC_API_KEY is unset — configure a model card or set the env var",
    );
  }
  return {
    wireModel: handle,
    apiKey,
    baseURL: process.env.ANTHROPIC_BASE_URL,
    customHeaders: parseCustomHeaders(process.env.ANTHROPIC_CUSTOM_HEADERS),
  };
}

async function buildNodeLanguageModel(
  tenantId: string,
  agentModel: import("@open-managed-agents/shared").AgentConfig["model"],
) {
  const creds = await resolveNodeModelCreds(tenantId, agentModel);
  return toAiSdkLanguageModel(createPiModelRuntime({
    model: creds.wireModel,
    apiKey: creds.apiKey,
    provider: creds.provider,
    baseURL: creds.baseURL,
    customHeaders: creds.customHeaders,
    piConfig: creds.piConfig,
    thinkingLevel: modelThinkingLevel(agentModel),
    speed: typeof agentModel === "string"
      ? undefined
      : agentModel.speed === "fast" ? "fast" : "standard",
  }));
}

const mcpProxyServices = { sessions: sessionsService, credentials: credentialService };

async function mcpBindingFetch(request: Request): Promise<Response> {
  const tenantId = request.headers.get("x-oma-tenant");
  const sessionId = request.headers.get("x-oma-session");
  const serverName = request.headers.get("x-oma-mcp-server");
  if (!tenantId || !sessionId || !serverName) {
    return new Response(
      '{"error":"missing x-oma-tenant / x-oma-session / x-oma-mcp-server header"}',
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  const target = await resolveProxyTargetByTenant(
    mcpProxyServices,
    tenantId,
    sessionId,
    serverName,
  );
  if (!target) {
    return new Response('{"error":"forbidden"}', {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  const inboundHeaders = new Headers(request.headers);
  inboundHeaders.delete("x-oma-tenant");
  inboundHeaders.delete("x-oma-session");
  inboundHeaders.delete("x-oma-mcp-server");
  const body = ["GET", "HEAD"].includes(request.method)
    ? null
    : await request.arrayBuffer();
  return forwardWithRefresh(
    mcpProxyServices,
    tenantId,
    target,
    request.method,
    inboundHeaders,
    body,
    { sessionId, serverName, callerKind: "rpc-mcp" },
  );
}

async function managedMcpBindingFetch(request: Request): Promise<Response> {
  const workspaceId = request.headers.get("x-oma-tenant");
  const sessionId = request.headers.get("x-oma-session");
  const serverName = request.headers.get("x-oma-mcp-server");
  if (!workspaceId || !sessionId || !serverName) return new Response("Missing session attribution", { status: 400 });
  const context = await managedRuntimeReaders.executionContext.find({ workspaceId, sessionId });
  if (!context) return new Response("Forbidden", { status: 403 });
  const vaultIds = [];
  const vaults = new SqlVaultStore(sql);
  for (const vaultId of context.session.vaultIds) {
    const record = await vaults.find({ workspaceId, vaultId });
    if (record?.vault.archivedAt === null) vaultIds.push(vaultId);
  }
  return forwardManagedMcpRequest({ request, workspaceId, session: { ...context.session, vaultIds }, serverName, credentials: managedCredentialStore });
}

async function mountNodeSessionResources({ sessionId, tenantId, sandbox, strict = false }: {
  sessionId: string; tenantId: string;
  sandbox: import("@open-managed-agents/sandbox").SandboxExecutor;
  strict?: boolean;
}): Promise<void> {
    if (!filesBlob) return;
    const rows = await sessionsService.listResourcesBySession({ sessionId });
    for (const row of rows) {
      try {
        if (row.type === "file" && row.resource.file_id) {
          const fileId = row.resource.file_id;
          const meta = await filesService.get({ tenantId, fileId });
          if (!meta) { if (strict) throw new Error(`File ${fileId} is unavailable`); continue; }
          const obj = await filesBlob.get(meta.r2_key);
          if (!obj) { if (strict) throw new Error(`File ${fileId} content is unavailable`); continue; }
          const bytes = await obj.bytes();
          // Default mount path matches the Anthropic Managed Agents
          // convention the ff-agents bot relies on (/workspace/<name>).
          const path = row.resource.mount_path || `/workspace/${meta.filename}`;
          const slash = path.lastIndexOf("/");
          const dir = slash > 0 ? path.slice(0, slash) : "";
          // belljar's write endpoint does not create parent dirs; ensure
          // the target directory exists first (no-op for /workspace).
          if (dir) await sandbox.exec(`mkdir -p ${qsh(dir)}`, 5000).catch(() => undefined);
          if (sandbox.writeFileBytes) await sandbox.writeFileBytes(path, bytes);
          else await sandbox.writeFile(path, new TextDecoder().decode(bytes));
        } else if (row.type === "github_repository" || row.type === "github_repo") {
          const repoUrl = row.resource.url || row.resource.repo_url;
          if (!repoUrl) continue;
          // Clone into a subdir when mount_path is unset or the bare
          // /workspace (belljar seeds /workspace with the vault CA, so git
          // clone into it would fail "directory not empty").
          const repoName = (repoUrl.split("/").pop() || "repo").replace(/\.git$/, "") || "repo";
          const mp = row.resource.mount_path;
          const targetDir = mp && mp !== "/workspace" ? mp : `/workspace/${repoName}`;
          const parentDir = targetDir.slice(0, Math.max(0, targetDir.lastIndexOf("/"))) || "/";
          // Idempotency: this hook runs every turn — skip once cloned.
          const present = await sandbox
            .exec(`test -d ${qsh(`${targetDir}/.git`)} && echo present || echo absent`, 5000)
            .catch(() => "absent");
          if (present.includes("present")) continue;
          // Under BELLJAR_ISOLATION the sandbox's only egress is the
          // oma-vault proxy: exec already carries HTTPS_PROXY, but git needs
          // the vault CA (it ignores NODE_EXTRA_CA_CERTS) or TLS verification
          // fails. The native sandbox.gitCheckout endpoint is NOT usable here
          // — it runs git without the proxy env, so github.com won't resolve.
          // Configuring the CA is a no-op on a non-isolated sandbox (the env
          // var is unset), so this one path covers belljar + subprocess.
          const clone = [
            `CA="$NODE_EXTRA_CA_CERTS"`,
            `if [ -n "$CA" ] && [ -f "$CA" ]; then git config --global http.sslCAInfo "$CA"; fi`,
            // Fail fast instead of hanging on an auth prompt when the proxy
            // can't satisfy a private repo (public repos need no auth).
            `git config --global core.askpass /bin/true`,
            `git config --global credential.helper "" 2>/dev/null || true`,
            `mkdir -p ${qsh(parentDir)}`,
            `git clone ${qsh(repoUrl)} ${qsh(targetDir)}`,
            `cd ${qsh(targetDir)} && git config user.name Agent && git config user.email "agent@managed-agents.dev"`,
          ].join("; ");
          await sandbox.exec(clone, 180000);
          // Optional branch/commit checkout (mirrors the CF resource-mounter):
          // DWIM a remote branch, else create it locally off the default HEAD.
          const checkout = row.resource.checkout;
          if (checkout?.type === "branch" && checkout.name) {
            const branch = checkout.name.replace(/[^A-Za-z0-9._/-]/g, "");
            if (branch) {
              await sandbox.exec(
                `cd ${qsh(targetDir)} && (git fetch origin ${qsh(branch)}:refs/remotes/origin/${qsh(branch)} 2>/dev/null && git checkout ${qsh(branch)}) || git checkout -b ${qsh(branch)}`,
                60000,
              );
            }
          } else if (checkout?.type === "commit" && checkout.sha) {
            const sha = checkout.sha.replace(/[^A-Za-z0-9]/g, "");
            if (sha) await sandbox.exec(`cd ${qsh(targetDir)} && git checkout ${qsh(sha)}`, 60000);
          }
          // Verify the clone actually landed; log if not (belljar surfaces
          // clone failures as a thrown exec error caught below, but a
          // partial/edge failure should still be visible).
          const ok = await sandbox
            .exec(`test -d ${qsh(`${targetDir}/.git`)} && echo present || echo absent`, 5000)
            .catch(() => "absent");
          if (!ok.includes("present")) {
            if (strict) throw new Error(`Repository checkout failed: ${repoUrl}`);
            logger.warn(
              { op: "node.mount_git_repo", session_id: sessionId, resource_id: row.resource.id, target_dir: targetDir },
              "github_repository clone did not produce a checkout",
            );
          }
        }
      } catch (err) {
        if (strict) throw err;
        logger.warn(
          { op: "node.mount_session_resource", session_id: sessionId, resource_id: row.resource.id, resource_type: row.type, err },
          "session resource mount failed",
        );
      }
    }
}

const sessionRegistry = new SessionRegistry({
  sql,
  hub,
  agentsService,
  memoryService,
  sessionsService,
  sandboxOrchestrator,
  newEventLog,
  buildSandbox,
  sandboxWorkdirRoot: process.env.SANDBOX_WORKDIR ?? "./data/sandboxes",
  sqlDialect: dialect,
  // Mount `file` + `github_repository` session resources into the sandbox
  // before each turn. The CF SessionDO does this itself; the Node runtime
  // did not, so attachments and repos were recorded but never appeared in
  // the sandbox. Files use the sandbox's writeFileBytes primitive (same as
  // the CF mountFile); repos reuse the CF mountGitRepo verbatim, which
  // drives the sandbox's native gitCheckout (belljar proxies it to the
  // cloudflare/sandbox git endpoint).
  mountSessionResources: mountNodeSessionResources,
  // Promote files the agent wrote to /mnt/session/outputs into the Files
  // API (scope_id = session, downloadable) at turn completion, so
  // files.list({scope_id}) surfaces them the way Anthropic's API does.
  // Dedup by (filename, size) against the session's existing file rows so
  // an unchanged output is not re-created — and re-mirrored — every turn.
  promoteSessionOutputs: async ({ sessionId, tenantId }) => {
    if (!filesBlob) return;
    const listed = await sessionOutputs.list(tenantId, sessionId);
    if (listed.length === 0) return;
    const existing = await filesService.list({ tenantId, sessionId, limit: 1000 });
    const seen = new Set(existing.map((r) => `${r.filename}:${r.size_bytes}`));
    for (const out of listed) {
      const key = `${out.filename}:${out.size_bytes}`;
      if (seen.has(key)) continue;
      try {
        const obj = await sessionOutputs.read(tenantId, sessionId, out.filename);
        if (!obj) continue;
        const bytes = new Uint8Array(await new Response(obj.body).arrayBuffer());
        const id = generateFileId();
        const r2Key = fileR2Key(tenantId, id);
        await filesBlob.put(r2Key, bytes, { httpMetadata: { contentType: out.media_type } });
        await filesService.create({
          id,
          tenantId,
          sessionId,
          filename: out.filename,
          mediaType: out.media_type,
          sizeBytes: bytes.byteLength,
          r2Key,
          downloadable: true,
        });
        seen.add(key);
      } catch (err) {
        logger.warn(
          { op: "node.promote_output", session_id: sessionId, filename: out.filename, err },
          "session output promote failed",
        );
      }
    }
  },
  buildModel: (agent, tenantId) => buildNodeLanguageModel(tenantId, agent.model),
  buildTools: async (agent, sandbox, sessionId, tenantId) => {
    const creds = await resolveNodeModelCreds(tenantId, agent.model);
    return buildTools(agent, sandbox, {
      ANTHROPIC_API_KEY: creds.apiKey,
      ANTHROPIC_BASE_URL: creds.baseURL,
      toMarkdown: toMarkdownProvider,
      tenantId,
      sessionId,
      toolResultMaxChars: parseInt(process.env.OMA_TOOL_RESULT_MAX_CHARS ?? "", 10) || undefined,
      // In-process equivalent of CF's MAIN_MCP service binding
      // (McpProxyRpc.fetch): resolve the vault credential by server
      // name, swap Authorization, forward with 401-refresh-and-retry.
      // Credentials stay in this process; the sandbox never sees them.
      mcpBinding: { fetch: mcpBindingFetch },
    });
  },
  buildHarness: (agent) => {
    const h = resolveHarness(agent.harness);
    return {
      run: (ctx: unknown) => h.run(ctx as HarnessContext),
      ...(h.dispose ? {
        dispose: (reason: "replace" | "shutdown" | "destroy") => h.dispose!(reason),
      } : {}),
    };
  },
  buildHarnessContext: async (input) => {
    const creds = await resolveNodeModelCreds(input.tenantId, input.agent.model);
    const pi = createPiModelRuntime({
      model: creds.wireModel,
      apiKey: creds.apiKey,
      provider: creds.provider,
      baseURL: creds.baseURL,
      customHeaders: creds.customHeaders,
      piConfig: creds.piConfig,
      thinkingLevel: modelThinkingLevel(input.agent.model),
      speed:
        typeof input.agent.model === "string"
          ? undefined
          : input.agent.model.speed === "fast" ? "fast" : "standard",
    });
    const runtime = new NodeHarnessRuntime({
      sessionId: input.sessionId,
      log: input.eventLog,
      hub,
      sandbox: input.sandbox,
    });
    await runtime.refreshHistory();
    const rawSystemPrompt = input.agent.system ?? "";
    // Feishu-backed sessions get two live tools (mcp__feishu__im_message_send,
    // mcp__feishu__im_chat_read) wired straight to FeishuApiClient. Non-Feishu
    // sessions resolve to {} (a safe no-op spread). Token handling lives inside
    // FeishuApiClient — see lib/feishu-agent-tools.ts.
    const feishuTools = await resolveFeishuAgentTools(input.sessionId);
    // Memory-store mount descriptors → system prompt, mirroring the CF
    // SessionDO's platformReminders block format. Resolved per turn from
    // the same binding union the mounter uses, so stores attached
    // mid-session are announced on the next turn.
    const memoryReminders: Array<{ source: string; text: string }> = [];
    try {
      const bindings = await resolveSessionMemoryBindings(
        { sql, sessionsService, memoryService },
        input.sessionId,
        input.tenantId,
      );
      for (const b of bindings) {
        const accessLabel = b.readOnly ? "read-only" : "read-write";
        const lines = [
          `## Memory store: ${b.storeName}`,
          `Mounted at /mnt/memory/${b.storeName}/ (${accessLabel})`,
        ];
        if (b.description) lines.push(b.description);
        if (b.instructions) lines.push(b.instructions);
        if (b.readOnly) {
          lines.push("(read-only mount — write attempts to this directory will fail)");
        }
        memoryReminders.push({ source: `memory:${b.storeId}`, text: lines.join("\n") });
      }
    } catch (err) {
      logger.warn(
        { err, op: "main-node.memory_reminders_failed", session_id: input.sessionId },
        "memory store metadata fetch failed; prompt omits mount descriptors",
      );
    }
    // belljar recycles idle sandbox containers but keeps /workspace on a
    // volume for a retention window (server defaults: destroy after ~1h
    // idle, retain ~7 days), transparently reattaching it on the next
    // request. Tell the agent what that means for where to put files.
    if ((process.env.SANDBOX_PROVIDER ?? "").toLowerCase() === "belljar") {
      memoryReminders.push({
        source: "sandbox:workspace",
        text: [
          "## Workspace: /workspace",
          "Semi-persistent scratch space. The sandbox container is recycled after roughly an hour",
          "of inactivity, but /workspace survives recycling and comes back on the next request for",
          "about 7 days of inactivity — after that it is deleted and the session starts with a fresh,",
          "empty workspace. Use /workspace for checkouts, build artifacts and working files; keep",
          "anything that must outlive it in /mnt/memory or /mnt/session/outputs.",
        ].join("\n"),
      });
    }
    // Environment-level custom context (environments.config.context) —
    // injected for every agent running a session in this environment.
    try {
      const sessionRow = await sessionsService.getById({ sessionId: input.sessionId });
      const envId = sessionRow?.environment_id;
      if (envId) {
        const envRow = await environmentsService.get({
          tenantId: input.tenantId,
          environmentId: envId,
        });
        const envContext = envRow?.config?.context;
        if (typeof envContext === "string" && envContext.trim()) {
          memoryReminders.push({ source: `environment:${envId}`, text: envContext });
        }
      }
    } catch (err) {
      logger.warn(
        { err, op: "main-node.environment_context_failed", session_id: input.sessionId },
        "environment context fetch failed; prompt omits it",
      );
    }

    // Resolve agent.skills → inline SKILL.md into the system prompt and mount
    // each skill's files into the sandbox (progressive disclosure). The Node
    // runtime did neither before, so declared skills were inert. Best-effort:
    // a failure here must not break the turn — the agent just loses the skill.
    if (input.agent.skills?.length) {
      try {
        const skills = await resolveNodeSkills(input.tenantId, input.agent.skills);
        for (const skill of skills) {
          if (skill.addition) {
            memoryReminders.push({ source: `skill:${skill.name}`, text: skill.addition });
          }
          if (!skill.files.length) continue;
          // Mount once per session: writing every skill file on every turn
          // would be dozens of round-trips per turn. The .skills dir under the
          // agent's home matches the CF SessionDO's mount location.
          const skillDir = `/home/user/.skills/${skill.name}`;
          const present = await input.sandbox
            .exec(`test -d ${qsh(skillDir)} && echo present || echo absent`, 5000)
            .catch(() => "absent");
          if (present.includes("present")) continue;
          for (const f of skill.files) {
            const dest = `${skillDir}/${f.filename}`;
            const slash = dest.lastIndexOf("/");
            const dir = slash > 0 ? dest.slice(0, slash) : "";
            try {
              if (dir) await input.sandbox.exec(`mkdir -p ${qsh(dir)}`, 5000).catch(() => undefined);
              if (input.sandbox.writeFileBytes) await input.sandbox.writeFileBytes(dest, f.bytes);
              else await input.sandbox.writeFile(dest, new TextDecoder().decode(f.bytes));
            } catch (err) {
              logger.warn(
                { err, op: "main-node.skill_file_mount", session_id: input.sessionId, file: dest },
                "skill file mount failed; skipping",
              );
            }
          }
        }
      } catch (err) {
        logger.warn(
          { err, op: "main-node.skills_failed", session_id: input.sessionId },
          "skill resolution failed; prompt omits skills",
        );
      }
    }

    return {
      agent: input.agent,
      userMessage: input.userMessage,
      session_id: input.sessionId,
      tools: {
        ...(input.tools as Record<string, unknown>),
        ...feishuTools,
      } as HarnessContext["tools"],
      model: input.model,
      pi,
      systemPrompt: composeSystemPrompt(rawSystemPrompt, memoryReminders),
      rawSystemPrompt,
      env: {
        ANTHROPIC_API_KEY: creds.apiKey,
        ANTHROPIC_BASE_URL: creds.baseURL,
      },
      runtime,
    } satisfies HarnessContext;
  },
});

await sessionRegistry.bootstrap();

// ─── Official Managed Sessions composition ─────────────────────────────

const managedMemoryFiles = new ManagedMemoryFiles(memoryBlobLocalDir ?? "./data/memory");
const managedMemoryMounts = new WeakMap<import("@open-managed-agents/sandbox").SandboxPort, Set<string>>();
const managedMemorySync = new WeakMap<import("@open-managed-agents/sandbox").SandboxPort, ReturnType<typeof setInterval>>();
async function flushManagedMemoryFiles(workspaceId: string, session: import("@open-managed-agents/managed-agents-application").Session) {
  const results = await Promise.allSettled(session.resources.filter((resource) => resource.type === "memory_store" && resource.access !== "read_only")
    .map((resource) => resource.type === "memory_store"
      ? managedMemoryFiles.flush(workspaceId, resource.memoryStoreId, memoriesForSession(workspaceId, session.id)) : Promise.resolve()));
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length) throw new Error(failed.map((result) => String(result.reason)).join("; "));
}
function memoriesForSession(workspaceId: string, sessionId: string) {
  return managedMemoriesApplicationFor({ var: { tenant_id: workspaceId, session_id: sessionId } }).port(managedAgentsPortTokens.memories);
}
async function prepareManagedMemoryMounts(workspaceId: string, session: import("@open-managed-agents/managed-agents-application").Session, sandbox: import("@open-managed-agents/sandbox").SandboxPort) {
  let mounted = managedMemoryMounts.get(sandbox);
  if (!mounted) { mounted = new Set(); managedMemoryMounts.set(sandbox, mounted); }
  for (const resource of session.resources) {
    if (resource.type !== "memory_store") continue;
    await managedMemoryFiles.prepare(workspaceId, resource.memoryStoreId, memoriesForSession(workspaceId, session.id), resource.access === "read_only");
    if (mounted.has(resource.memoryStoreId)) continue;
    if (!sandbox.mountMemoryStore) throw new Error("The selected sandbox provider does not support memory mounts");
    await sandbox.mountMemoryStore({ storeId: resource.memoryStoreId, storeName: resource.name ?? resource.memoryStoreId, readOnly: resource.access === "read_only" });
    mounted.add(resource.memoryStoreId);
  }
}

const managedRuntimeRunner = new DefaultNodeManagedSessionRunner({
  confirmedTools: new NodeManagedConfirmedToolExecutor({
    buildExecutableTools: async ({ workspaceId, session, sandbox }) => {
      const agent = allowAllLegacyHarnessTools(
        toLegacyHarnessAgentConfig(session),
      );
      const creds = await resolveNodeModelCreds(workspaceId, agent.model);
      return buildTools(agent, sandbox, {
        ANTHROPIC_API_KEY: creds.apiKey,
        ANTHROPIC_BASE_URL: creds.baseURL,
        toMarkdown: toMarkdownProvider,
        tenantId: workspaceId,
        sessionId: session.id,
        toolResultMaxChars: parseInt(process.env.OMA_TOOL_RESULT_MAX_CHARS ?? "", 10) || undefined,
        mcpBinding: { fetch: managedMcpBindingFetch },
      });
    },
  }),
  outcomes: new NodeManagedOutcomeEvaluator({
    buildModel: ({ workspaceId, session }) =>
      buildNodeLanguageModel(workspaceId, session.agent.model),
    judge: async ({ model, system, prompt, abortSignal }) => {
      const result = await generateText({
        model,
        system,
        prompt,
        abortSignal,
      });
      return {
        text: result.text,
        usage: {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
        },
      };
    },
  }),
  buildSandbox: async ({ workspaceId, session, environment }) => {
    const sandbox = await buildSandbox(session.id,
      join(process.env.SANDBOX_WORKDIR ?? "./data/sandboxes", workspaceId, session.id), { workspaceId, environment });
    await prepareManagedMemoryMounts(workspaceId, session, sandbox);
    await sandboxOrchestrator.provision(sandbox, {
      sessionId: session.id, tenantId: workspaceId, environmentId: environment.id,
      mountOutputs: true, backup: { restoreOnWarm: !sandbox.initializesWorkspace },
    });
    return sandbox;
  },
  prepareSession: async ({ workspaceId, session, sandbox }) => {
    await prepareManagedMemoryMounts(workspaceId, session, sandbox);
    await mountManagedSessionResources({ session, sandbox,
      files: managedAgentsPlatform.app({ workspaceId }).port(managedAgentsPortTokens.files) });
    if (session.resources.some((resource) => resource.type === "memory_store" && resource.access !== "read_only")) {
      clearInterval(managedMemorySync.get(sandbox));
      const timer = setInterval(() => {
        void flushManagedMemoryFiles(workspaceId, session).catch((error) =>
          logger.warn({ op: "session.memory_sync.failed", session_id: session.id, error }, "Memory sync failed"));
      }, 30_000);
      timer.unref();
      managedMemorySync.set(sandbox, timer);
    }
  },
  completeSession: async ({ workspaceId, session, sandbox }) => {
    clearInterval(managedMemorySync.get(sandbox));
    managedMemorySync.delete(sandbox);
    const persistOutputs = async () => {
      const outputs = [];
      for (const entry of await sessionOutputs.list(workspaceId, session.id)) {
        const file = await sessionOutputs.read(workspaceId, session.id, entry.filename);
        if (file) outputs.push({ filename: entry.filename, mediaType: entry.media_type, content: new Uint8Array(await new Response(file.body).arrayBuffer()) });
      }
      await promoteManagedSessionOutputs({ sessionId: session.id, outputs,
        files: managedAgentsPlatform.app({ workspaceId }).port(managedAgentsPortTokens.files) });
    };
    // A memory conflict must not prevent output promotion or the workspace backup.
    const results = await Promise.allSettled([
      flushManagedMemoryFiles(workspaceId, session),
      persistOutputs(),
      sandboxOrchestrator.snapshotWorkspaceNow(sandbox, { tenantId: workspaceId, sessionId: session.id }),
    ]);
    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length) throw new Error(failed.map((result) => String(result.reason)).join("; "));
  },
  buildModel: ({ workspaceId, session }) =>
    buildNodeLanguageModel(workspaceId, session.agent.model),
  buildTools: async ({ workspaceId, session, sandbox }) => {
    const agent = toLegacyHarnessAgentConfig(session);
    const creds = await resolveNodeModelCreds(workspaceId, agent.model);
    return buildTools(agent, sandbox, {
      ANTHROPIC_API_KEY: creds.apiKey,
      ANTHROPIC_BASE_URL: creds.baseURL,
      toMarkdown: toMarkdownProvider,
      tenantId: workspaceId,
      sessionId: session.id,
      toolResultMaxChars: parseInt(process.env.OMA_TOOL_RESULT_MAX_CHARS ?? "", 10) || undefined,
      mcpBinding: { fetch: managedMcpBindingFetch },
    });
  },
  buildHarness: () => new ManagedNodeDefaultHarness(),
  buildHarnessContext: async (input) => {
    const agent = toLegacyHarnessAgentConfig(input.session);
    const creds = await resolveNodeModelCreds(input.workspaceId, agent.model);
    const rawSystemPrompt = input.session.agent.system ?? "";
    const feishuTools = await resolveFeishuAgentTools(input.session.id);
    const platformReminders = await managedSessionReminders({ ...input,
      versions: managedSkillsPlatform.app({ workspaceId: input.workspaceId }).port(managedAgentsPortTokens.skillVersions) });
    if (process.env.SANDBOX_PROVIDER === "belljar") platformReminders.push({ source: "sandbox:workspace", text: "The /workspace directory survives container recycling for the sandbox retention period. Store durable results in /mnt/session/outputs and long-term knowledge in /mnt/memory." });
    return {
      agent,
      userMessage: { type: "user.message", content: [] },
      session_id: input.session.id,
      tenant_id: input.workspaceId,
      tools: { ...input.tools, ...feishuTools },
      model: input.model,
      systemPrompt: composeSystemPrompt(rawSystemPrompt, platformReminders),
      platformReminders,
      rawSystemPrompt,
      env: {
        ANTHROPIC_API_KEY: creds.apiKey,
        ANTHROPIC_BASE_URL: creds.baseURL,
      },
      runtime: input.runtime,
    } satisfies HarnessContext;
  },
  clock: { now: () => new Date() },
  ids: { nextEventId: () => `sevt_${nanoid()}` },
});

const managedRuntimeReaders = createSqlSessionRuntimeReaders(sql);
const managedRuntimeEngine = new ApplicationBackedNodeManagedSessionRuntimeEngine({
  historyFor: (workspaceId) =>
    new SessionRuntimeHistoryApplicationService({
      workspaceId,
      source: managedRuntimeReaders.history,
    }),
  runner: managedRuntimeRunner,
});
const managedRuntimeDriver = new DefaultNodeManagedSessionRuntimeDriver({
  engine: managedRuntimeEngine,
  realtime: new MemorySessionRealtimeHub(),
  projectionFor: (workspaceId) =>
    new SessionRuntimeProjectionApplicationService({
      workspaceId,
      persistence: new SqlSessionRuntimeProjectionPersistence(sql),
    }),
});
const managedSessionRuntime = new NodeManagedSessionRuntimeAdapter(
  managedRuntimeDriver,
);

const persistedManagedEnvironments = new SqlSessionEnvironmentSource(sql);
const nodeManagedEnvironments: SessionEnvironmentSourcePort = {
  find: async (input) => {
    if (input.environmentId !== "env-local-runtime") {
      return persistedManagedEnvironments.find(input);
    }
    return {
      id: input.environmentId,
      archivedAt: null,
      config: {
        type: "cloud",
        networking: { type: "unrestricted" },
        packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
      },
      createdAt: "1970-01-01T00:00:00.000Z",
      description: "Node self-hosted runtime",
      metadata: {},
      name: "Local runtime",
      updatedAt: "1970-01-01T00:00:00.000Z",
    };
  },
};
const managedSessionLifecycle = new EnvironmentAwareSessionLifecycleRouter({
  environments: nodeManagedEnvironments,
  runtime: managedSessionRuntime,
  selfHostedWork: {
    enqueue: (input) =>
      managedEnvironmentWorkEnqueuerFor(input.workspaceId).enqueue(input),
    stop: (input) =>
      managedEnvironmentWorkEnqueuerFor(input.workspaceId).stop(input),
  },
});
const managedResourceCipher = platformRootSecret === undefined
  ? null
  : new WebCryptoAesGcm(platformRootSecret, "managed.sessions.resources");
const managedSessionsComposition = new SqlManagedSessionsComposition({
  client: sql,
  environments: nodeManagedEnvironments,
  lifecycle: managedSessionLifecycle,
  runtime: managedSessionRuntime,
  sealer: {
    seal: async (value) => {
      if (managedResourceCipher === null) {
        throw new Error(
          "PLATFORM_ROOT_SECRET is required for managed Session resource credentials",
        );
      }
      return managedResourceCipher.encrypt(value);
    },
  },
  clock: { now: () => new Date() },
  ids: {
    nextSessionId: () => `session_${nanoid()}`,
    nextEventId: () => `sevt_${nanoid()}`,
    nextOutcomeId: () => `outc_${nanoid()}`,
    nextResourceId: () => `sesrsc_${nanoid()}`,
  },
});

const managedDeploymentCrypto = platformRootSecret === undefined
  ? null
  : new WebCryptoAesGcm(platformRootSecret, "managed.deployments.resources");
const managedDeploymentCipher: DeploymentResourceSecretCipher = {
  seal: async ({ plaintext }) => {
    if (managedDeploymentCrypto === null) {
      throw new Error(
        "PLATFORM_ROOT_SECRET is required for managed Deployment resource credentials",
      );
    }
    return { ciphertext: await managedDeploymentCrypto.encrypt(plaintext) };
  },
  open: async ({ ciphertext }) => {
    if (managedDeploymentCrypto === null) {
      throw new Error(
        "PLATFORM_ROOT_SECRET is required for managed Deployment resource credentials",
      );
    }
    return { plaintext: await managedDeploymentCrypto.decrypt(ciphertext) };
  },
};
const managedDeploymentSchedulePlanner = new CronDeploymentSchedulePlanner();
const managedEnvironmentWorkAvailability =
  new TimerEnvironmentWorkAvailabilityWaiter();
const managedEnvironmentWorkCrypto = platformRootSecret === undefined
  ? null
  : new WebCryptoAesGcm(platformRootSecret, "managed.environment-work.secret");
const managedEnvironmentWorkCipher: EnvironmentWorkSecretCipher = {
  seal: async ({ plaintext }) => {
    if (managedEnvironmentWorkCrypto === null) {
      throw new Error(
        "PLATFORM_ROOT_SECRET is required for managed Environment Work credentials",
      );
    }
    return {
      ciphertext: await managedEnvironmentWorkCrypto.encrypt(plaintext),
    };
  },
  open: async ({ ciphertext }) => {
    if (managedEnvironmentWorkCrypto === null) {
      throw new Error(
        "PLATFORM_ROOT_SECRET is required for managed Environment Work credentials",
      );
    }
    return {
      plaintext: await managedEnvironmentWorkCrypto.decrypt(ciphertext),
    };
  },
};
const managedEnvironmentWorkCredentials =
  new OpaqueEnvironmentWorkSessionCredentialIssuer({
    nextToken: () => nanoid(48),
    ...(process.env.PUBLIC_BASE_URL !== undefined && {
      apiBaseUrl: process.env.PUBLIC_BASE_URL,
    }),
  });
const managedEnvironmentWorkPlatform = createNodePlatform({
  features: { preset: "none", environmentWork: true },
  stores: {
    environmentWork: new SqlEnvironmentWorkStore(
      sql,
      managedEnvironmentWorkCipher,
    ),
  },
  clock: { now: () => new Date() },
  ids: {
    next: (namespace) =>
      `${namespace === "environment-work" ? "work" : namespace}_${nanoid()}`,
  },
  modules: () => [
    providePort(environmentWorkEnvironmentSourcePort, nodeManagedEnvironments),
    providePort(
      environmentWorkAvailabilityWaiterPort,
      managedEnvironmentWorkAvailability,
    ),
    providePort(
      environmentWorkSessionCredentialIssuerPort,
      managedEnvironmentWorkCredentials,
    ),
    environmentWorkEnqueuerModule(),
  ],
});
function managedEnvironmentWorkEnqueuerFor(
  workspaceId: string,
) {
  return managedEnvironmentWorkPlatform
    .app({ workspaceId })
    .port(environmentSessionWorkEnqueuerPort);
}
const managedDeploymentsPlatform = createNodePlatform({
  features: {
    preset: "none",
    deploymentRuns: true,
    deployments: true,
  },
  stores: {
    deployments: new SqlDeploymentStore(sql, managedDeploymentCipher),
    deploymentRuns: new SqlDeploymentRunStore(sql),
  },
  clock: { now: () => new Date() },
  ids: {
    next: (namespace) =>
      `${namespace === "deployment" ? "depl" : namespace === "deployment-run" ? "drun" : namespace}_${nanoid()}`,
  },
  modules: (scope) => [
    providePort(deploymentAgentSourcePort, new SqlDeploymentAgentSource(sql)),
    providePort(deploymentEnvironmentSourcePort, nodeManagedEnvironments),
    providePort(deploymentFileSourcePort, new SqlFileMetadataPersistence(sql)),
    providePort(deploymentMemoryStoreSourcePort, new SqlMemoryStoreSource(sql)),
    providePort(deploymentSchedulePlannerPort, managedDeploymentSchedulePlanner),
    providePort(
      deploymentSessionLauncherPort,
      managedSessionsComposition.portsFor(scope.workspaceId)
        .deploymentSessionLauncher,
    ),
    providePort(deploymentVaultSourcePort, new SqlDeploymentVaultSource(sql)),
  ],
});
const managedDeploymentsRoutes = buildManagedDeploymentRoutes((context) => {
  const workspaceId = (context.var as { tenant_id: string }).tenant_id;
  return managedDeploymentsPlatform
    .app({ workspaceId })
    .port(managedAgentsPortTokens.deployments);
});
const managedDeploymentRunsRoutes = buildManagedDeploymentRunRoutes((context) => {
  const workspaceId = (context.var as { tenant_id: string }).tenant_id;
  return managedDeploymentsPlatform
    .app({ workspaceId })
    .port(managedAgentsPortTokens.deploymentRuns);
});

const managedEnvironmentsRoutes = buildManagedEnvironmentRoutes((context) =>
  managedAgentsPlatform
    .app({
      workspaceId: (context.var as { tenant_id: string }).tenant_id,
    })
    .port(managedAgentsPortTokens.environments),
);

const managedEnvironmentWorkRoutes = buildManagedEnvironmentWorkRoutes(
  (context) =>
    managedEnvironmentWorkPlatform
      .app({ workspaceId: (context.var as { tenant_id: string }).tenant_id })
      .port(managedAgentsPortTokens.environmentWork),
);

const managedDreamApiKey = process.env.ANTHROPIC_API_KEY?.trim();
const managedDreamCurator =
  process.env.DREAM_CURATOR_MODE === "dedup" ||
    !managedDreamApiKey
  ? new DeduplicatingDreamCurator()
  : new AnthropicMessagesDreamCurator({
      apiKey: managedDreamApiKey,
      ...(process.env.ANTHROPIC_BASE_URL !== undefined && {
        baseUrl: process.env.ANTHROPIC_BASE_URL,
      }),
    });
const managedDreamsPlatform = createNodePlatform({
  features: {
    preset: "none",
    dreams: true,
    memories: true,
    memoryStores: true,
  },
  stores: {
    dreams: new SqlDreamStore(sql),
    memoryStores: new SqlMemoryStoreStore(sql),
    memories: new SqlMemoryDocumentStore(sql),
  },
  clock: { now: () => new Date() },
  ids: {
    next: (namespace) => `${
      namespace === "memory_store"
        ? "memstore"
        : namespace === "memory"
          ? "mem"
          : namespace === "memory-version"
            ? "memver"
            : "dream"
    }_${nanoid()}`,
  },
  modules: (scope) => {
    const memoryStoreSource = new SqlMemoryStoreSource(sql);
    return [
      providePort(dreamMemoryStoreSourcePort, memoryStoreSource),
      providePort(memoryStoreForMemorySourcePort, memoryStoreSource),
      providePort(memoryContentDescriptorPort, managedMemoryContent),
      providePort(memoryVersionActorPort, {
        kind: "service_account",
        serviceAccountId: "dream_executor",
      }),
      providePort(dreamSessionSourcePort, new SqlSessionSource(sql)),
      providePort(dreamCuratorPort, managedDreamCurator),
      defineAppModule({
        name: "managed-agents:dream-memory-workspace",
        provides: [dreamMemoryWorkspacePort],
        requires: [
          managedAgentsPortTokens.memoryStores,
          managedAgentsPortTokens.memories,
        ],
        setup: ({ port }) => ({
          ports: [bindPort(
            dreamMemoryWorkspacePort,
            new ApplicationDreamMemoryWorkspace({
              workspaceId: scope.workspaceId,
              memoryStores: port(managedAgentsPortTokens.memoryStores),
              memories: port(managedAgentsPortTokens.memories),
            }),
          )],
        }),
      }),
      dreamExecutionModule(),
      inProcessDreamExecutionSchedulerModule({
        defer: (task) => {
          void task;
        },
      }),
    ];
  },
});
const managedDreamsRoutes = buildManagedDreamRoutes((context) =>
  managedDreamsPlatform
    .app({
      workspaceId: (context.var as { tenant_id: string }).tenant_id,
    })
    .port(managedAgentsPortTokens.dreams),
);

const managedModelsRoutes = buildManagedModelRoutes((context) =>
  createNodeManagedAgentsApp({
    workspaceId: (context.var as { tenant_id: string }).tenant_id,
    features: { preset: "none", models: true },
    modules: () => [providePort(
      modelCatalogSourcePort,
      new ModelCardCatalogSource(modelCardsService),
    )],
  }).port(managedAgentsPortTokens.models)
);

const managedTunnelProvisioner = new LocalTunnelProvisioner({
  domainSuffix: process.env.TUNNEL_DOMAIN_SUFFIX ?? "tunnels.localhost",
  nextTokenId: () => `ttok_${nanoid()}`,
});
const managedTunnelTokens = new WebCryptoTunnelTokenManager({
  rootSecret: platformRootSecret,
  nextTokenId: () => `ttok_${nanoid()}`,
});
const managedTunnelCertificates = new WebCryptoTunnelCertificateAuthority();
const managedTunnelsPlatform = createNodePlatform({
  features: {
    preset: "none",
    tunnelCertificates: true,
    tunnels: true,
  },
  stores: { tunnels: new SqlTunnelStore(sql) },
  clock: { now: () => new Date() },
  ids: {
    next: (namespace) =>
      `${namespace === "tunnel" ? "tnl" : "tcrt"}_${nanoid()}`,
  },
  modules: () => [
    providePort(tunnelProvisionerPort, managedTunnelProvisioner),
    providePort(tunnelTokenManagerPort, managedTunnelTokens),
    providePort(tunnelCertificateAuthorityPort, managedTunnelCertificates),
  ],
});
const managedTunnelsRoutes = buildManagedTunnelRoutes((context) =>
  managedTunnelsPlatform.app({
    workspaceId: (context.var as { tenant_id: string }).tenant_id,
  }).port(managedAgentsPortTokens.tunnels),
);
const managedTunnelCertificateRoutes = buildManagedTunnelCertificateRoutes(
  (context) => managedTunnelsPlatform.app({
    workspaceId: (context.var as { tenant_id: string }).tenant_id,
  }).port(managedAgentsPortTokens.tunnelCertificates),
);

const managedFilesRoutes = buildManagedFileRoutes((context) =>
  managedAgentsPlatform
    .app({
      workspaceId: (context.var as { tenant_id: string }).tenant_id,
    })
    .port(managedAgentsPortTokens.files)
);

const managedMemoryStoresRoutes = buildManagedMemoryStoreRoutes((context) =>
  managedAgentsPlatform
    .app({
      workspaceId: (context.var as { tenant_id: string }).tenant_id,
    })
    .port(managedAgentsPortTokens.memoryStores),
);

const managedMemoryContent = new WebCryptoMemoryContentDescriptor();
const managedMemoryDocuments = new SqlMemoryDocumentStore(sql);
function managedMemoryActor(userId: string | undefined) {
  return userId === undefined
    ? { kind: "api" as const, apiKeyId: "self_hosted" }
    : { kind: "user" as const, userId };
}
function managedMemoriesApplicationFor(context: unknown) {
  const request = (context as {
    var: { tenant_id: string; user_id?: string; session_id?: string };
  }).var;
  return createNodeManagedAgentsApp({
    workspaceId: request.tenant_id,
    features: {
      preset: "none",
      memories: true,
      memoryVersions: true,
    },
    stores: {
      memoryStores: new SqlMemoryStoreStore(sql),
      memories: managedMemoryDocuments,
    },
    clock: { now: () => new Date() },
    ids: {
      next: (namespace) => `${
        namespace === "memory"
          ? "mem"
          : namespace === "memory-version"
            ? "memver"
            : namespace
      }_${nanoid()}`,
    },
    modules: () => [
      providePort(
        memoryStoreForMemorySourcePort,
        new SqlMemoryStoreSource(sql),
      ),
      providePort(memoryContentDescriptorPort, managedMemoryContent),
      providePort(
        memoryVersionActorPort,
        request.session_id ? { kind: "session", sessionId: request.session_id } : managedMemoryActor(request.user_id),
      ),
    ],
  });
}
const managedMemoriesRoutes = buildManagedMemoryRoutes((context) =>
  managedMemoriesApplicationFor(context)
    .port(managedAgentsPortTokens.memories),
);
const managedMemoryVersionsRoutes = buildManagedMemoryVersionRoutes((context) =>
  managedMemoriesApplicationFor(context)
    .port(managedAgentsPortTokens.memoryVersions),
);

const managedSkillCompiler = new ZipSkillPackageCompiler();
let lastManagedSkillVersion = 0n;
function nextManagedSkillVersion(): string {
  const now = BigInt(Date.now()) * 1_000n;
  lastManagedSkillVersion = now > lastManagedSkillVersion
    ? now
    : lastManagedSkillVersion + 1n;
  return lastManagedSkillVersion.toString();
}
const managedSkillsPlatform = createNodePlatform({
  features: {
    preset: "none",
    skills: true,
    skillVersions: true,
  },
  stores: { skills: new SqlSkillStore(sql) },
  clock: { now: () => new Date() },
  ids: {
    next: (namespace) =>
      namespace === "skill-version-value"
        ? nextManagedSkillVersion()
        : `${namespace === "skill-version" ? "skv" : namespace}_${nanoid()}`,
  },
  modules: () => [
    providePort(skillPackageCompilerPort, managedSkillCompiler),
  ],
});
const managedSkillsRoutes = buildManagedSkillRoutes((context) =>
  managedSkillsPlatform.app({
    workspaceId: (context.var as { tenant_id: string }).tenant_id,
  }).port(managedAgentsPortTokens.skills),
);
const managedSkillVersionsRoutes = buildManagedSkillVersionRoutes((context) =>
  managedSkillsPlatform.app({
    workspaceId: (context.var as { tenant_id: string }).tenant_id,
  }).port(managedAgentsPortTokens.skillVersions),
);

const managedCredentialCrypto = platformRootSecret === undefined
  ? null
  : new WebCryptoAesGcm(platformRootSecret, "managed.vault.credentials");
const managedCredentialCipher: CredentialDocumentCipher = {
  seal: async ({ plaintext }) => {
    if (managedCredentialCrypto === null) {
      throw new Error(
        "PLATFORM_ROOT_SECRET is required for managed Vault credentials",
      );
    }
    return { ciphertext: await managedCredentialCrypto.encrypt(plaintext) };
  },
  open: async ({ ciphertext }) => {
    if (managedCredentialCrypto === null) {
      throw new Error(
        "PLATFORM_ROOT_SECRET is required for managed Vault credentials",
      );
    }
    return { plaintext: await managedCredentialCrypto.decrypt(ciphertext) };
  },
};
const managedCredentialStore = new SqlCredentialStore(sql, managedCredentialCipher);
const managedCredentialValidation = new IndeterminateCredentialValidationProbe();
const managedCredentialsPlatform = createNodePlatform({
  features: {
    preset: "none",
    credentials: true,
    vaults: true,
  },
  stores: {
    credentials: managedCredentialStore,
    vaults: new SqlVaultStore(sql),
  },
  credentialValidation: managedCredentialValidation,
  clock: { now: () => new Date() },
  ids: {
    next: (namespace) =>
      `${namespace === "credential" ? "vcrd" : namespace === "vault" ? "vlt" : namespace}_${nanoid()}`,
  },
});
const managedVaultsRoutes = buildManagedVaultRoutes((context) =>
  managedCredentialsPlatform
    .app({ workspaceId: (context.var as { tenant_id: string }).tenant_id })
    .port(managedAgentsPortTokens.vaults),
);
const managedCredentialsRoutes = buildManagedCredentialRoutes((context) =>
  managedCredentialsPlatform
    .app({ workspaceId: (context.var as { tenant_id: string }).tenant_id })
    .port(managedAgentsPortTokens.credentials),
);

const managedUserProfilesRoutes = buildManagedUserProfileRoutes((context) =>
  managedAgentsPlatform
    .app({ workspaceId: (context.var as { tenant_id: string }).tenant_id })
    .port(managedAgentsPortTokens.userProfiles),
);

// ─── Services bundle ────────────────────────────────────────────────────

const kv = new SqlKvStore({ db: drizzleDb, tenantId: "default" });

const services: RouteServices = {
  sql,
  agents: agentsService,
  vaults: vaultService,
  credentials: credentialService,
  memory: memoryService,
  sessions: sessionsService,
  dreams: dreamsService,
  deployments: deploymentsService,
  environments: environmentsService,
  modelCards: modelCardsService,
  filesBlob,
  kv,
  newEventLog,
  hub: {
    publish: (sid, ev) => hub.publish(sid, ev as SessionEvent),
    attach: (sid, writer) => hub.attach(sid, writer),
  },
  sessionRegistry: {
    enqueueUserMessage: (sid, tenantId, agentId, ev) => {
      void sessionRegistry
        .getOrCreate(sid, tenantId)
        .then((entry) =>
          entry.machine.runHarnessTurn(agentId, ev as import("@open-managed-agents/shared").UserMessageEvent),
        )
        .catch((err) => {
          // session.error persistence + publish happens inside
          // SessionStateMachine.runHarnessTurn's catch — log only here.
          logger.error(
            { err, op: "session.harness_turn.failed", session_id: sid, agent_id: agentId },
            "harness turn failed",
          );
        });
    },
    interrupt: (sid) => {
      sessionRegistry.interrupt?.(sid);
    },
  },
  background: {
    run: (p) => {
      void p.catch((err) =>
        logger.error({ err, op: "main-node.background.failed" }, "background task failed"),
      );
    },
  },
  outputsRoot,
  logger,
  metrics,
  tracer,
};

// ─── API key storage (SQL) ──────────────────────────────────────────────

const apiKeyStorage: ApiKeyStorage = {
  async insert({ id, hash, prefix, record }) {
    await sql
      .prepare(
        `INSERT INTO api_keys (id, tenant_id, user_id, name, prefix, hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        record.tenant_id,
        record.user_id ?? null,
        record.name,
        prefix,
        hash,
        Date.parse(record.created_at),
      )
      .run();
  },
  async listByTenant(tenantId) {
    const r = await sql
      .prepare(
        `SELECT id, name, prefix, created_at FROM api_keys
          WHERE tenant_id = ? AND revoked_at IS NULL
          ORDER BY created_at DESC`,
      )
      .bind(tenantId)
      .all<{ id: string; name: string; prefix: string; created_at: number }>();
    return (r.results ?? []).map<ApiKeyMeta>((row) => ({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      created_at: new Date(row.created_at).toISOString(),
    }));
  },
  async findByHash(hash) {
    const row = await sql
      .prepare(
        `SELECT id, tenant_id, user_id, name, created_at FROM api_keys
          WHERE hash = ? AND revoked_at IS NULL`,
      )
      .bind(hash)
      .first<{
        id: string;
        tenant_id: string;
        user_id: string | null;
        name: string;
        created_at: number;
      }>();
    if (!row) return null;
    const rec: ApiKeyRecord = {
      id: row.id,
      tenant_id: row.tenant_id,
      ...(row.user_id ? { user_id: row.user_id } : {}),
      name: row.name,
      created_at: new Date(row.created_at).toISOString(),
    };
    return rec;
  },
  async deleteById(tenantId, id) {
    const r = await sql
      .prepare(
        `UPDATE api_keys SET revoked_at = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL`,
      )
      .bind(Date.now(), tenantId, id)
      .run();
    return (r.meta?.changes ?? 0) > 0;
  },
};

// ─── HTTP ───────────────────────────────────────────────────────────────

const app = new Hono<{
  Variables: { tenant_id: string; user_id?: string };
}>();

// Observability middleware first so it captures auth failures, rate-limit
// rejects, and unhandled exceptions. Mirrors apps/main's CF wiring.
app.use("*", requestMetrics({ recorder: metrics }));
app.use("*", tracerMiddleware({ tracer }));

async function managedLifecycleContext(sessionId: string) {
  const rows = await sql.prepare("SELECT workspace_id FROM managed_sessions WHERE id = ? LIMIT 2").bind(sessionId).all<{ workspace_id: string }>();
  if (!rows.results?.length) return null;
  if (rows.results.length !== 1) throw new Error("Ambiguous sandbox owner");
  const workspaceId = rows.results[0]!.workspace_id;
  const context = await managedRuntimeReaders.executionContext.find({ workspaceId, sessionId });
  return context ? { ...context, workspaceId } : null;
}

app.route("/internal/belljar/lifecycle", buildBelljarLifecycleRoutes({
  token: process.env.BELLJAR_TOKEN,
  getSession: async (sessionId) => {
    const context = await managedLifecycleContext(sessionId);
    if (!context) return sessionsService.getById({ sessionId });
    const startup = context.environment.config.type === "cloud" ? context.environment.config.startup : undefined;
    return { id: sessionId, tenant_id: context.workspaceId, status: context.session.archivedAt ? "terminated" : context.session.status,
      environment_snapshot: { id: context.environment.id, name: context.environment.name, created_at: context.environment.createdAt,
        config: { type: "cloud" as const, ...(startup && { startup: { script: startup.script, enabled: startup.enabled,
          triggers: startup.triggers, timeout_seconds: startup.timeoutSeconds } }) } },
    };
  },
  completed: async (sessionId, bootId) => {
    const context = await managedLifecycleContext(sessionId);
    if (context) {
      const records = await sql.prepare("SELECT document FROM managed_session_events WHERE workspace_id = ? AND session_id = ? AND type = ?")
        .bind(context.workspaceId, sessionId, "session.sandbox_startup").all<{ document: string }>();
      return (records.results ?? []).some((record) => {
        const event = JSON.parse(record.document) as { bootId: string; status: string };
        return event.bootId === bootId && (event.status === "succeeded" || event.status === "skipped");
      });
    }
    const rows = await sql.prepare("SELECT data FROM session_events WHERE session_id = ? AND type = ? ORDER BY seq DESC")
      .bind(sessionId, "session.sandbox_startup").all<{ data: string }>();
    return (rows.results ?? []).some((row) => {
      const event = JSON.parse(row.data) as { boot_id?: string; status?: string };
      return event.boot_id === bootId && (event.status === "succeeded" || event.status === "skipped");
    });
  },
  emit: async (sessionId, event) => {
    logger.info({ op: "sandbox.startup", session_id: sessionId, boot_id: event.boot_id,
      trigger: event.trigger, status: event.status, duration_ms: event.duration_ms, exit_code: event.exit_code }, "Sandbox startup");
    event.id = `sevt_${generateEventId()}`;
    event.processed_at = new Date().toISOString();
    const context = await managedLifecycleContext(sessionId);
    if (context) {
      await managedRuntimeDriver.recordRuntimeEvent(context.workspaceId, sessionId, event);
      return;
    }
    const log = newEventLog(sessionId);
    await log.appendAsync(event);
    const events = await log.getEventsAsync();
    const stored = events.find((e) => e.id === event.id);
    if (stored) hub.publish(sessionId, stored);
  },
  buildSandbox: (payload) => new BelljarSandbox({
    baseUrl: process.env.BELLJAR_URL ?? "", token: process.env.BELLJAR_TOKEN,
    sessionId: payload.ownerId, initialization: { bootId: payload.bootId, token: payload.initializationToken },
  }),
  prepare: async (session, sandbox, trigger) => {
    // Revival/wake keep the authoritative workspace volume. Only a fresh
    // container without retained workspace may need the archive fallback.
    if (trigger === "create") {
      const handle = await workspaceBackups.latest({ sessionId: session.id, tenantId: session.tenant_id });
      if (handle) {
        const restored = await workspaceBackups.restore({ sessionId: session.id, tenantId: session.tenant_id, sandbox, handle });
        if (!restored.ok) throw new Error(`Workspace restore failed: ${restored.error ?? "unknown error"}`);
      }
    }
    // Restore can contain an older CA file; always refresh trust afterwards.
    await sandbox.prepareInitialization({ sessionId: session.id, tenantId: session.tenant_id });
    const context = await managedRuntimeReaders.executionContext.find({ workspaceId: session.tenant_id, sessionId: session.id });
    if (context) await mountManagedSessionResources({ session: context.session, sandbox,
      files: managedAgentsPlatform.app({ workspaceId: session.tenant_id }).port(managedAgentsPortTokens.files) });
    else await mountNodeSessionResources({ sessionId: session.id, tenantId: session.tenant_id, sandbox, strict: true });
  },
}));

// Prometheus scrape endpoint. When METRICS_BIND_TOKEN is set, callers must
// pass it in `x-metrics-token`; absent, the endpoint is open on the same
// port (acceptable for self-host single-operator deploys, documented in
// .env.example). For prod, ops should either set the token or front the
// app with a reverse proxy that filters /metrics.
const metricsToken = process.env.METRICS_BIND_TOKEN;
app.get("/metrics", async (c) => {
  if (metricsToken && c.req.header("x-metrics-token") !== metricsToken) {
    return c.text("forbidden", 403);
  }
  const text = await metrics.getPromText();
  return new Response(text, {
    headers: { "Content-Type": metrics.promContentType() },
  });
});

app.get("/health", (c) =>
  c.json({
    status: "ok",
    runtime: "node",
    pid: process.pid,
    uptime_s: Math.round(process.uptime()),
    auth: authDisabled
      ? "disabled"
      : usePostgres
        ? "better-auth-pg"
        : "better-auth-sqlite",
    backends: {
      agents: dialect,
      events: dialect,
      hub: usePostgres ? "pg-notify" : "in-process",
      memory_blobs: memoryBlobDescription,
      db: backendDescription,
    },
  }),
);

app.get("/auth-info", (c) =>
  c.json({
    providers: authDisabled
      ? []
      : [
          ...(passwordAuthDisabled ? [] : ["email"]),
          ...(process.env.AUTH_REQUIRE_EMAIL_VERIFY === "1" && !passwordAuthDisabled
            ? ["email-otp"]
            : []),
          ...(googleEnabled ? ["google"] : []),
          ...(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET ? ["github"] : []),
          ...(oidc ? ["oidc"] : []),
        ],
    oidc_name:
      !authDisabled && oidc ? (process.env.OIDC_PROVIDER_NAME ?? "SSO") : null,
    signup_disabled: signupDisabled,
    turnstile_site_key: null,
  }),
);

// In-memory rate-limit gates — same five buckets + limits as CF's
// Workers Rate Limiting bindings (see apps/main/src/rate-limit.ts).
// Single-process only; multi-replica deploys need Postgres/Redis-backed
// gates behind the same interface.
const rateLimitGates = buildMemoryGates();

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "anonymous";
}

const EMAIL_SEND_PATHS = new Set([
  "/auth/sign-up/email",
  "/auth/sign-in/email",
  "/auth/forget-password",
  "/auth/email-otp/send-verification-otp",
  "/auth/email-otp/reset-password",
]);

// /auth/* limiter — same three layers as CF, minus the Turnstile gate
// (no bot challenge on self-host).
app.use("/auth/*", async (c, next) => {
  if (authDisabled) return next();
  const ip = clientIp(c);
  const path = new URL(c.req.url).pathname;

  if (!(await rateLimitGates.authIp.consume(ip)).ok) {
    return c.json({ error: "Too many requests" }, 429);
  }
  if (!EMAIL_SEND_PATHS.has(path)) return next();

  if (!(await rateLimitGates.authSendIp.consume(ip)).ok) {
    return c.json({ error: "Too many email requests from this IP" }, 429);
  }
  let email = "";
  try {
    const body = (await c.req.raw.clone().json()) as { email?: string };
    email = (body?.email ?? "").toLowerCase().trim();
  } catch { /* no body / not JSON */ }
  if (email && !(await rateLimitGates.authSendEmail.consume(email)).ok) {
    return c.json({ error: "Please wait a minute before requesting another email" }, 429);
  }
  return next();
});

if (auth) {
  app.on(["GET", "POST"], "/auth/*", (c) => auth!.handler(c.req.raw));
}

// Auth middleware via packages/auth — same five-priority resolution as
// apps/main on CF.
const authMw = buildAuthMw({
  disabled: authDisabled,
  bypassPath: (path) => path === "/health" || path.startsWith("/auth/"),
  resolveSession: async (headers) => {
    if (!auth) return null;
    const session = (await auth.api.getSession({ headers })) as
      | { user?: { id: string; email?: string | null; name?: string | null } }
      | null;
    if (!session?.user) return null;
    return {
      userId: session.user.id,
      email: session.user.email ?? null,
      name: session.user.name ?? null,
    };
  },
  resolveApiKey: async (apiKey) => {
    const hash = await sha256Hex(apiKey);
    const rec = await apiKeyStorage.findByHash(hash);
    if (!rec) return null;
    return { tenantId: rec.tenant_id, userId: rec.user_id };
  },
  defaultTenantForUser: async (userId) => {
    const row = await sql
      .prepare(
        `SELECT tenant_id FROM membership WHERE user_id = ? ORDER BY created_at ASC, tenant_id ASC LIMIT 1`,
      )
      .bind(userId)
      .first<{ tenant_id: string }>();
    return row?.tenant_id ?? null;
  },
  hasMembership: async (userId, tenantId) => {
    const row = await sql
      .prepare(
        `SELECT 1 AS one FROM membership WHERE user_id = ? AND tenant_id = ? LIMIT 1`,
      )
      .bind(userId, tenantId)
      .first<{ one: number }>();
    return row !== null;
  },
  ensureTenantForUser: (s) => ensureTenantSqlite(sql, s.userId, s.name, s.email),
});

const v1 = new Hono<{
  Variables: { tenant_id: string; user_id?: string };
}>();
v1.use("*", authMw);
// /v1/* write limiter — keyed by authenticated principal (api key > user >
// IP), writes only, mirroring CF's rateLimitMiddleware.
v1.use("*", async (c, next) => {
  if (authDisabled) return next();
  const m = c.req.method;
  if (m !== "POST" && m !== "PUT" && m !== "DELETE") return next();
  const apiKey = c.req.header("x-api-key");
  const userId = c.get("user_id" as never) as string | undefined;
  const principal = apiKey
    ? `apikey:${apiKey.slice(0, 16)}`
    : userId
      ? `user:${userId}`
      : `ip:${clientIp(c)}`;
  const r = await rateLimitGates.apiWrite.consume(principal);
  if (!r.ok) {
    if (r.retryAfter !== undefined) c.header("Retry-After", String(r.retryAfter));
    return c.json({ error: "Rate limit exceeded" }, 429);
  }
  return next();
});

// Mount route bundles. Same paths CF uses; behavior preserved. Once a tenant
// has configured model cards, agent model handles must resolve to an active
// card; an empty card set keeps the legacy ANTHROPIC_API_KEY fallback usable.
v1.route("/agents", buildManagedAgentRoutes((context) =>
  managedAgentsPlatform
    .app({
      workspaceId: (context.var as { tenant_id: string }).tenant_id,
    })
    .port(managedAgentsPortTokens.agents),
));
v1.route("/oma/agents", buildLegacyAgentRoutes({
  services,
  validateModel: async (tenantId, model) => {
    const cards = await modelCardsService.list({ tenantId });
    const active = cards.filter((card) => card.archived_at === null);
    if (active.length === 0) return { valid: true };
    const modelId = typeof model === "string" ? model : model.id;
    if (!active.some((card) => card.model_id === modelId)) {
      return {
        valid: false,
        error: `No model card with model_id "${modelId}". Create a card with that handle, or set agent.model to an existing card's model_id.`,
      };
    }
    return { valid: true };
  },
  validateAgentLimits: (body) =>
    validateAgentLimits(body as Parameters<typeof validateAgentLimits>[0]),
  hasActiveSessionsByAgent: (tenantId, agentId) =>
    sessionsService.hasActiveByAgent({ tenantId, agentId }),
  hasActiveEvalsByAgent: (tenantId, agentId) =>
    evalsService.hasActiveByAgent({ tenantId, agentId }),
}));
const sessionRouter = new NodeSessionRouter({
  sql,
  hub,
  registry: sessionRegistry,
  newEventLog,
});
v1.route("/sessions", buildManagedSessionsApi({
  sessions: (context) =>
    managedSessionsComposition.portsFor(
      (context.var as { tenant_id: string }).tenant_id,
    ).sessions,
  sessionEvents: (context) =>
    managedSessionsComposition.portsFor(
      (context.var as { tenant_id: string }).tenant_id,
    ).sessionEvents,
  sessionResources: (context) =>
    managedSessionsComposition.portsFor(
      (context.var as { tenant_id: string }).tenant_id,
    ).sessionResources,
  sessionThreads: (context) =>
    managedSessionsComposition.portsFor(
      (context.var as { tenant_id: string }).tenant_id,
    ).sessionThreads,
  sessionThreadEvents: (context) =>
    managedSessionsComposition.portsFor(
      (context.var as { tenant_id: string }).tenant_id,
    ).sessionThreadEvents,
}));
v1.route("/oma/sessions", buildSessionRoutes({
  services,
  supportsStartupScripts: process.env.SANDBOX_PROVIDER?.toLowerCase() === "belljar",
  router: sessionRouter,
  outputs: nodeOutputsAdapter(outputsRoot),
  lifecycle: {
    ...nodeSessionLifecycle({ files: filesService, filesBlob }),
    preCreateRateLimit: async ({ tenantId }) => {
      const r = await rateLimitGates.sessionsTenant.consume(`tenant:${tenantId}`);
      return r.ok
        ? null
        : { status: 429, body: { error: "Too many session creations — wait a minute" } };
    },
    onResourceAttached: async ({ tenantId, sessionId }) => {
      await sessionRegistry.syncMemoryMounts(sessionId, tenantId);
    },
  },
  // Preserve actual environment configuration in session snapshots. The
  // synthetic fallback keeps legacy local-runtime environments working.
  localRuntimeEnvId: "env-local-runtime",
  loadEnvironment: loadEnvironmentSnapshot,
}));
v1.post("/sessions/:id/startup/retry", async (c) => {
  const sessionId = c.req.param("id");
  const workspaceId = c.get("tenant_id");
  const native = await managedRuntimeReaders.executionContext.find({ workspaceId, sessionId });
  if (native) {
    const config = native.environment.config;
    if (native.session.archivedAt) return c.json({ error: "Session not found" }, 404);
    if (config.type !== "cloud" || !startupEnabled(config.startup)) return c.json({ error: "Session has no active startup script" }, 400);
  } else {
    const session = await sessionsService.getById({ sessionId });
    if (!session || session.tenant_id !== workspaceId) return c.json({ error: "Session not found" }, 404);
    if (session.status === "terminated" || !startupEnabled(session.environment_snapshot?.config?.startup)) {
      return c.json({ error: "Session has no active startup script" }, 400);
    }
  }
  if (process.env.SANDBOX_PROVIDER?.toLowerCase() !== "belljar") return c.json({ error: "Startup scripts require Belljar" }, 400);
  const sandbox = new BelljarSandbox({ baseUrl: process.env.BELLJAR_URL ?? "", token: process.env.BELLJAR_TOKEN, sessionId });
  try { await sandbox.retryStartup(); return c.json({ ready: true }); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 503); }
});
v1.route("/vaults", managedVaultsRoutes);
v1.route("/vaults", managedCredentialsRoutes);
v1.route("/user_profiles", managedUserProfilesRoutes);
v1.route("/oma/vaults", buildLegacyVaultRoutes({ services }));
v1.route("/memory_stores", managedMemoryStoresRoutes);
v1.route("/memory_stores", managedMemoriesRoutes);
v1.route("/memory_stores", managedMemoryVersionsRoutes);
v1.route("/models", managedModelsRoutes);
v1.route("/oma/memory_stores", buildLegacyMemoryRoutes({ services }));
v1.route("/skills", managedSkillsRoutes);
v1.route("/skills", managedSkillVersionsRoutes);
v1.route("/deployments", managedDeploymentsRoutes);
v1.route("/deployment_runs", managedDeploymentRunsRoutes);
v1.route("/environments", managedEnvironmentWorkRoutes);
v1.route("/dreams", managedDreamsRoutes);
v1.route("/oma/dreams", buildDreamRoutes({
  services,
  curatorEnv: {
    DREAM_CURATOR_MODE: process.env.DREAM_CURATOR_MODE,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  },
}));
v1.route("/tunnels", managedTunnelsRoutes);
v1.route("/tunnels", managedTunnelCertificateRoutes);
v1.route("/oma/me", buildMeRoutes({
  services,
  authDisabled,
  loadTenant: async (tenantId) => {
    const r = await sql
      .prepare(`SELECT id, name FROM "tenant" WHERE id = ?`)
      .bind(tenantId)
      .first<{ id: string; name: string }>();
    return r ?? null;
  },
  listMemberships: async (userId) => {
    const r = await sql
      .prepare(
        `SELECT t.id AS id, t.name AS name, m.role AS role, m.created_at AS created_at
           FROM "membership" m JOIN "tenant" t ON t.id = m.tenant_id
          WHERE m.user_id = ? ORDER BY m.created_at ASC, t.id ASC`,
      )
      .bind(userId)
      .all<{ id: string; name: string; role: string; created_at: number }>();
    return r.results ?? [];
  },
  hasMembership: async (userId, tenantId) => {
    const row = await sql
      .prepare(
        `SELECT 1 AS one FROM membership WHERE user_id = ? AND tenant_id = ? LIMIT 1`,
      )
      .bind(userId, tenantId)
      .first<{ one: number }>();
    return row !== null;
  },
  mintApiKey: (input) => mintApiKeyOnStorage(apiKeyStorage, input),
}));
v1.route("/oma/tenants", buildTenantRoutes({ services }));
v1.route("/oma/api_keys", buildApiKeyRoutes({ storage: apiKeyStorage }));
v1.route("/oma/clawhub", buildClawhubRoutes({ services }));
const oauthCredentialsFor = (workspaceId: string) => nativeOAuthCredentials({
  workspaceId, store: managedCredentialStore,
  vaults: managedCredentialsPlatform.app({ workspaceId }).port(managedAgentsPortTokens.vaults),
  nextId: () => `vcrd_${nanoid()}`,
});
v1.route("/oma/oauth", buildOAuthRoutes({ services, env: process.env, credentialsFor: oauthCredentialsFor }));
v1.route("/oma/cap-cli/oauth", buildCapCliOauthRoutes({ services, credentialsFor: oauthCredentialsFor }));
v1.route("/oma/evals", buildEvalRoutes({
  evals: evalsService,
  agents: agentsService,
  environments: environmentsService,
}));

async function countManagedPages(
  load: (cursor?: string) => Promise<{
    items: readonly unknown[];
    nextCursor: string | null;
  }>,
): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  const visited = new Set<string>();

  for (;;) {
    const page = await load(cursor);
    total += page.items.length;
    if (page.nextCursor === null) return total;
    if (visited.has(page.nextCursor)) {
      throw new Error(`Managed stats pagination repeated cursor ${page.nextCursor}`);
    }
    visited.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

// OMA extensions shared with the Cloudflare entrypoint.
v1.route("/oma/skills", buildSkillGitHubRoutes({ services,
  persistenceFor: (workspaceId) => {
    const app = managedSkillsPlatform.app({ workspaceId });
    return nativeGitHubSkillPersistence(app.port(managedAgentsPortTokens.skills), app.port(managedAgentsPortTokens.skillVersions));
  },
}));
v1.route("/oma/skills", buildSkillRoutes({ services }));
v1.get("/oma/runtimes", (c) => c.json({ data: [] }));
v1.get("/oma/stats", async (c) => {
  const tenantId = c.get("tenant_id");
  const managedApp = managedAgentsPlatform.app({ workspaceId: tenantId });
  const managedAgents = managedApp.port(managedAgentsPortTokens.agents);
  const managedEnvironments = managedApp.port(managedAgentsPortTokens.environments);
  const managedSessions = managedSessionsComposition.portsFor(tenantId).sessions;
  const managedSkills = managedSkillsPlatform
    .app({ workspaceId: tenantId })
    .port(managedAgentsPortTokens.skills);
  const managedVaults = managedCredentialsPlatform
    .app({ workspaceId: tenantId })
    .port(managedAgentsPortTokens.vaults);
  const [
    agents,
    sessions,
    environments,
    vaults,
    skills,
    modelCards,
    apiKeys,
  ] = await Promise.all([
    countManagedPages(async (cursor) => {
      const result = await managedAgents.listAgents({
        pageSize: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (result.type !== "page") throw new Error(result.message);
      return { items: result.page.agents, nextCursor: result.page.nextCursor };
    }),
    countManagedPages(async (cursor) => {
      const result = await managedSessions.listSessions({
        pageSize: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (result.type !== "page") throw new Error(result.message);
      return { items: result.page.sessions, nextCursor: result.page.nextCursor };
    }),
    countManagedPages(async (cursor) => {
      const result = await managedEnvironments.listEnvironments({
        pageSize: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (result.type !== "page") throw new Error(result.message);
      return { items: result.page.environments, nextCursor: result.page.nextCursor };
    }),
    countManagedPages(async (cursor) => {
      const result = await managedVaults.listVaults({
        pageSize: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (result.type !== "page") throw new Error(result.message);
      return { items: result.page.vaults, nextCursor: result.page.nextCursor };
    }),
    countManagedPages(async (cursor) => {
      const result = await managedSkills.listSkills({
        pageSize: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (result.type !== "page") throw new Error(result.message);
      return { items: result.page.skills, nextCursor: result.page.nextCursor };
    }),
    modelCardsService.list({ tenantId }),
    apiKeyStorage.listByTenant(tenantId),
  ]);

  return c.json({
    agents,
    sessions,
    environments,
    vaults,
    skills,
    model_cards: modelCards.filter((card) => card.archived_at === null).length,
    api_keys: apiKeys.length,
  });
});
v1.route("/environments", managedEnvironmentsRoutes);
v1.route("/oma/environments", buildLegacyEnvironmentRoutes({ services }));
v1.route("/files", managedFilesRoutes);
v1.route("/oma/model_cards", buildModelCardRoutes({ services }));
v1.route("/oma/models", buildOmaModelsHttpRoutes({
  fetch: (input, init) => fetch(input, init),
}));
v1.get("/oma/integrations/github/credentials", (c) => c.json({ data: [] }));
v1.get("/oma/integrations/linear/credentials", (c) => c.json({ data: [] }));
v1.get("/oma/integrations/slack/credentials", (c) => c.json({ data: [] }));

// Real integration CRUD + lookup (linear/github/slack publications,
// installations, dispatch rules). Active only when PLATFORM_ROOT_SECRET is
// set — otherwise the routes 503 with a remediation message. Install-proxy
// endpoints (start-a1 / credentials / handoff-link / personal-token) return
// 503 because the OAuth/install gateway is not yet ported to Node (P4
// follow-up); the read endpoints work standalone.
// Real integration CRUD + lookup (linear/github/slack publications,
// installations, dispatch rules). Active only when PLATFORM_ROOT_SECRET is
// set — otherwise the routes 503 with a remediation message. The
// install-proxy endpoints (start-a1 / credentials / handoff-link /
// personal-token) call into the in-process InstallBridge, mirroring the
// CF /linear/publications/* etc. wire shapes verbatim.
const integrationsInternalToken = process.env.INTEGRATIONS_INTERNAL_TOKEN ?? null;
const gatewayOrigin = process.env.GATEWAY_ORIGIN ?? process.env.PUBLIC_BASE_URL ?? "http://localhost:8787";
let installBridge: NodeInstallBridge | null = null;
if (platformRootSecret) {
  installBridge = new NodeInstallBridge({
    sql,
    db: drizzleDb,
    platformRootSecret,
    gatewayOrigin: gatewayOrigin.replace(/\/+$/, ""),
    vaults: vaultService,
    credentials: credentialService,
    sessions: sessionsService,
    agents: agentsService,
    resolveTenantId: async (userId) => {
      const row = await sql
        .prepare(
          `SELECT tenant_id FROM membership WHERE user_id = ? ORDER BY created_at ASC, tenant_id ASC LIMIT 1`,
        )
        .bind(userId)
        .first<{ tenant_id: string }>();
      return row?.tenant_id ?? null;
    },
    appendUserEvent: async (sessionId, _tenantId, _agentId, event) => {
      // Webhook → session-resume drives the same NodeSessionRouter the
      // public POST /v1/sessions/:id/events route uses, so the harness
      // wakes up via the existing event-driven runtime.
      await sessionRouter.appendEvent(sessionId, event);
    },
  });
}

// Feishu WebSocket long-connection runner — the production ingest path for
// Feishu and the driver of the `credentials_filled / awaiting_install → live`
// status flip. The bot dials OUT, so (unlike the legacy HTTP webhook) no
// public URL is needed. Opt-in (`FEISHU_WS_RUNNER=1`) until it has been
// exercised against real Feishu app credentials — otherwise a stale
// publication with fake creds would dial out and backoff-loop on every boot.
if (platformRootSecret && installBridge && process.env.FEISHU_WS_RUNNER === "1") {
  try {
    const { startFeishuWsRunner } = await import("./lib/ws-feishu-runner.js");
    const feishuContainer = installBridge.buildContainers().feishu;
    const feishuProvider = buildNodeProvidersForRequest(installBridge, gatewayOrigin).feishu;
    // HTTP adapter for the automatic-egress send path (FeishuApiClient). One
    // instance serves all Feishu Apps; the client mints/caches its own token.
    const feishuHttp = new WorkerHttpClient();
    // Wire the live Feishu agent tools (send/read) into the harness tool map
    // for Feishu-backed sessions. Same publication repo + HTTP adapter as the
    // runner — the WS runner is the only ingest path that produces Feishu
    // sessions, so this is the only place that needs configuring.
    configureFeishuAgentTools({
      reader: sqlSessionMetadataReader(sql),
      pubs: feishuContainer.feishuPublications,
      http: feishuHttp,
    });
    feishuRunner = await startFeishuWsRunner({
      sql,
      pubs: feishuContainer.feishuPublications,
      installations: feishuContainer.feishuInstallations,
      webhookEvents: feishuContainer.webhookEvents,
      provider: feishuProvider,
      hub,
      http: feishuHttp,
    });
  } catch (err) {
    logger.warn(
      { err, op: "main-node.feishu_ws_runner_start_failed" },
      "feishu ws runner failed to start",
    );
  }
}

if (platformRootSecret) {
  const integrationsRepoEnv: NodeReposEnv = {
    sql,
    db: drizzleDb,
    PLATFORM_ROOT_SECRET: platformRootSecret,
  };
  v1.route(
    "/oma/integrations",
    buildIntegrationsRoutes({
      bags: () => {
        const repos = buildNodeRepos(integrationsRepoEnv);
        const slackCrypto = new WebCryptoAesGcm(platformRootSecret, "integrations.tokens");
        const slackIds = new CryptoIdGenerator();
        return {
          linear: {
            installations: repos.linearInstallations,
            publications: repos.linearPublications,
            apps: repos.apps,
            dispatchRules: repos.dispatchRules,
          },
          github: {
            installations: repos.githubInstallations,
            publications: repos.githubPublications,
            githubApps: repos.githubApps,
          },
          slack: {
            installations: new SqlSlackInstallationRepo(drizzleDb, slackCrypto, slackIds),
            publications: new SqlSlackPublicationRepo(drizzleDb, slackIds, slackCrypto),
            apps: new SqlSlackAppRepo(drizzleDb, slackCrypto, slackIds),
          },
          feishu: {
            installations: new SqlFeishuInstallationRepo(drizzleDb, slackCrypto, slackIds),
            publications: new SqlFeishuPublicationRepo(drizzleDb, slackIds, slackCrypto),
          },
        };
      },
      installProxy: installBridge ? bridgeAsInstallProxy(installBridge) : null,
    }),
  );
}

// ── Files API (subset of apps/main/src/routes/files.ts) ──
//
// CF mounts a richer files surface with synthesized session-output ids
// (R2-prefix listing); Node skips those — session outputs are served via
// the outputsRoot adapter on /v1/sessions/:id/outputs instead.
v1.post("/oma/files", async (c) => {
  const t = c.var.tenant_id;

  let filename: string;
  let mediaType: string;
  let body: ArrayBuffer;
  let scopeId: string | undefined;
  let downloadable = false;

  const contentType = c.req.header("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return c.json({ error: "file field is required in multipart upload" }, 400);
    }
    filename = file.name;
    mediaType = file.type || "application/octet-stream";
    body = await file.arrayBuffer();
    const sc = formData.get("scope_id");
    if (typeof sc === "string") scopeId = sc;
    const d = formData.get("downloadable");
    if (typeof d === "string") downloadable = d === "true" || d === "1";
  } else {
    // JSON body upload — content is base64-encoded for binary, raw text for text/*
    const json = await c.req.json<{
      filename: string;
      content: string;
      media_type?: string;
      scope_id?: string;
      encoding?: "base64" | "utf8";
      downloadable?: boolean;
    }>();

    if (!json.filename || json.content === undefined || json.content === null) {
      return c.json({ error: "filename and content are required" }, 400);
    }
    filename = json.filename;
    mediaType = json.media_type || "application/octet-stream";
    scopeId = json.scope_id;
    downloadable = json.downloadable === true;

    const encoding = json.encoding || (mediaType.startsWith("text/") ? "utf8" : "base64");
    if (encoding === "base64") {
      const bin = atob(json.content);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      body = bytes.buffer;
    } else {
      body = new TextEncoder().encode(json.content).buffer as ArrayBuffer;
    }
  }

  const id = generateFileId();
  const r2Key = fileR2Key(t, id);
  // Blob PUT first, then metadata insert — same failure semantics as CF
  // (orphan blob on metadata failure, never the reverse).
  await filesBlob.put(r2Key, body, { httpMetadata: { contentType: mediaType } });

  const row = await filesService.create({
    id,
    tenantId: t,
    sessionId: scopeId,
    filename,
    mediaType,
    sizeBytes: body.byteLength,
    r2Key,
    downloadable,
  });

  return c.json(toFileRecord(row), 201);
});
v1.get("/oma/files", async (c) => {
  const t = c.var.tenant_id;
  const scopeId = c.req.query("scope_id") ?? undefined;
  const limitParam = c.req.query("limit");
  let requested = limitParam ? parseInt(limitParam, 10) : 100;
  if (isNaN(requested) || requested < 1) requested = 100;
  if (requested > 1000) requested = 1000;
  const rows = await filesService.list({
    tenantId: t,
    sessionId: scopeId,
    limit: requested,
  });
  return c.json({ data: rows.map(toFileRecord), has_more: false });
});
v1.get("/oma/files/:id/content", async (c) => {
  const id = c.req.param("id");
  const t = c.var.tenant_id;
  const row = await filesService.get({ tenantId: t, fileId: id });
  if (!row) return c.json({ error: "File not found" }, 404);
  if (!row.downloadable) return c.json({ error: "This file is not downloadable" }, 403);
  const obj = await filesBlob.get(row.r2_key);
  if (!obj) return c.json({ error: "File content not found" }, 404);
  return new Response(obj.body, {
    headers: { "Content-Type": row.media_type },
  });
});
v1.get("/oma/files/:id", async (c) => {
  const id = c.req.param("id");
  const t = c.var.tenant_id;
  const row = await filesService.get({ tenantId: t, fileId: id });
  if (!row) return c.json({ error: "File not found" }, 404);
  return c.json(toFileRecord(row));
});
v1.delete("/oma/files/:id", async (c) => {
  try {
    const deleted = await filesService.delete({
      tenantId: c.var.tenant_id,
      fileId: c.req.param("id"),
    });
    await filesBlob.delete(deleted.r2_key).catch(() => undefined);
    return c.json({ type: "file_deleted", id: deleted.id });
  } catch (err) {
    if ((err as { code?: string }).code === "file_not_found") {
      return c.json({ error: "File not found" }, 404);
    }
    throw err;
  }
});

// ── Session ↔ memory_store binding (Node-specific; not in package yet) ──
v1.post("/oma/sessions/:id/memory_stores", async (c) => {
  const sid = c.req.param("id");
  const session = await sql
    .prepare(`SELECT id FROM sessions WHERE tenant_id = ? AND id = ?`)
    .bind(c.var.tenant_id, sid)
    .first();
  if (!session) return c.json({ error: "Session not found" }, 404);
  const body = await c.req.json<{ store_id: string; access?: string }>();
  if (!body.store_id) return c.json({ error: "store_id is required" }, 400);
  const store = await memoryService.getStore({
    tenantId: c.var.tenant_id,
    storeId: body.store_id,
  });
  if (!store) return c.json({ error: "Memory store not found" }, 404);
  const access = body.access === "read_only" ? "read_only" : "read_write";
  await sql
    .prepare(
      `INSERT INTO session_memory_stores (session_id, store_id, access, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id, store_id) DO UPDATE SET access = excluded.access`,
    )
    .bind(sid, body.store_id, access, Date.now())
    .run();
  // Live-mount into an already-provisioned sandbox — same sync the
  // standard resources route triggers via lifecycle.onResourceAttached.
  await sessionRegistry
    .syncMemoryMounts(sid, c.var.tenant_id)
    .catch((err) =>
      logger.warn({ err, op: "main-node.memory_bind.sync_failed", session_id: sid }, "live memory mount failed"),
    );
  return c.json({ session_id: sid, store_id: body.store_id, access }, 201);
});
v1.get("/oma/sessions/:id/memory_stores", async (c) => {
  const r = await sql
    .prepare(
      `SELECT store_id, access, created_at FROM session_memory_stores WHERE session_id = ?`,
    )
    .bind(c.req.param("id"))
    .all<{ store_id: string; access: string; created_at: number }>();
  return c.json({ data: r.results ?? [] });
});

app.route("/v1", v1);

app.route("/v1/oma/deployments", buildDeploymentRoutes({
  services,
  router: sessionRouter,
  localRuntimeEnvId: "env-local-runtime",
  // Pin environment configuration for manual and scheduled deployments too.
  loadEnvironment: loadEnvironmentSnapshot,
}));
// ─── Integrations gateway (OAuth callbacks, setup pages, Linear MCP,
// GitHub internal refresh, webhooks) — mounted on `app` (NOT under /v1)
// because the upstream OAuth/webhook URLs are at /linear/oauth/...,
// /linear-setup/..., /linear/webhook/..., etc. Active only when
// PLATFORM_ROOT_SECRET is set (encryption requires it). The bridge
// constructs providers per-request off the same Container builder used
// by the read-side routes, so a write hits the same underlying tables.
if (installBridge) {
  const containers = installBridge.buildContainers();
  app.route(
    "/",
    buildIntegrationsGatewayRoutes({
      installBridge,
      jwt: containers.linear.jwt,
      webhooks: {
        linear: (req) => buildNodeProvidersForRequest(installBridge!, gatewayOrigin).linear.handleWebhook(req),
        github: (req) => buildNodeProvidersForRequest(installBridge!, gatewayOrigin).github.handleWebhook(req),
        slack: (req) => buildNodeProvidersForRequest(installBridge!, gatewayOrigin).slack.handleWebhook(req),
      },
      internalSecret: integrationsInternalToken,
      // Node has no per-tenant rate-limit binding by default; soft-pass.
      rateLimit: undefined,
    }),
  );
}

// oma-cap-adapter wire — exposes a Resolver against the in-process vault
// services so a future Node outbound proxy (mirroring CF's mcp-proxy) can
// inject cap_cli credentials into sandbox traffic. Wired here at the
// services construction site so the resolver is available even before
// the outbound surface lands.
const _capResolver = new OmaVaultResolver({
  sessions: {
    get: ({ tenantId, sessionId }) => sessionsService.get({ tenantId, sessionId }) as never,
  },
  credentials: {
    listByVaults: ({ tenantId, vaultIds }) =>
      credentialService.listByVaults({ tenantId, vaultIds }) as never,
    update: ({ tenantId, vaultId, credentialId, auth }) =>
      credentialService.update({ tenantId, vaultId, credentialId, auth }) as never,
    create: ({ tenantId, vaultId, displayName, auth }) =>
      credentialService.create({ tenantId, vaultId, displayName, auth }) as never,
  },
});
void _capResolver;

// ── Console UI (optional) ──
const consoleDir = process.env.CONSOLE_DIR;
if (consoleDir) {
  const cwd = process.cwd();
  const rootRel = consoleDir.startsWith("/")
    ? relative(cwd, consoleDir)
    : consoleDir;
  app.use("/*", serveStatic({ root: rootRel }));
  // SPA fallback for client-side routes ONLY. Never serve index.html for
  // API/auth/health paths — a missing /v1/* handler used to fall through
  // here and the console would fail with
  // `Unexpected token '<' ... is not valid JSON` (HTML parsed as JSON).
  app.get("/*", async (c, next) => {
    const p = c.req.path;
    if (
      p === "/health" ||
      p.startsWith("/v1/") ||
      p.startsWith("/auth") ||
      p.startsWith("/linear") ||
      p.startsWith("/github")
    ) {
      return next();
    }
    return serveStatic({ root: rootRel, path: "index.html" })(c, next);
  });
  logger.info({ op: "main-node.console_ui", dir: consoleDir, cwd_rel: rootRel }, "console UI served");
}

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  logger.error({ err, op: "main-node.unhandled" }, "unhandled error");
  return c.json({ error: "internal_error", message: err.message }, 500);
});

// ─── Listen ──────────────────────────────────────────────────────────────

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  logger.info(
    { op: "main-node.listening", address: info.address, port: info.port, db: backendDescription },
    `listening on http://${info.address}:${info.port}`,
  );
});

// Cron — eval-tick + memory retention sweep + (when integrations schema is
// applied) webhook-events retention. Linear dispatch is left un-wired here
// because main-node doesn't construct a LinearProvider; pass `linearSweeper`
// when an in-process gateway lands.
const scheduler = buildNodeScheduler({
  managedDeploymentsTick: async () => {
    const records = await sql.prepare("SELECT workspace_id, id, document FROM managed_deployments WHERE status = 'active' AND archived_at IS NULL").all<{ workspace_id: string; id: string; document: string }>();
    const now = new Date().toISOString();
    for (const record of records.results ?? []) {
      const deployment = JSON.parse(record.document) as import("@open-managed-agents/managed-agents-application").Deployment;
      const scheduledAt = deployment.schedule?.upcomingRunsAt?.[0];
      if (!scheduledAt || scheduledAt > now) continue;
      try {
        const result = await managedDeploymentsPlatform.app({ workspaceId: record.workspace_id }).port(managedAgentsPortTokens.deployments)
          .runDeployment({ deploymentId: record.id, scheduledAt });
        if (result.type === "started" && result.run.error) logger.warn({ op: "deployment.schedule.failed", deployment_id: record.id, error: result.run.error }, "Scheduled deployment failed");
      } catch (error) { logger.warn({ op: "deployment.schedule.failed", deployment_id: record.id, error }, "Scheduled deployment failed"); }
    }
  },
  evalServices: {
    agents: agentsService,
    environments: environmentsService,
    sessions: sessionsService,
    evals: evalsService,
    kv,
  },
  memory: memoryService,
  integrationsSql: platformRootSecret ? sql : null,
  deployments: v0DataMigrated ? undefined : {
    services: {
      deployments: deploymentsService,
      sessions: sessionsService,
      agents: agentsService,
    },
    router: sessionRouter,
    localRuntimeEnvId: "env-local-runtime",
    loadEnvironment: loadEnvironmentSnapshot,
  },
});
await scheduler.start();
logger.info({ op: "main-node.scheduler.started" }, "scheduler started");

const shutdown = async (signal: string) => {
  logger.info({ op: "main-node.shutdown", signal }, `received ${signal}, shutting down`);
  try { await managedSessionsComposition.stopAll(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.managed_sessions_stop_failed" }, "managed Sessions app graphs stop failed"); }
  try { await managedAgentsPlatform.stopAll(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.managed_platform_stop_failed" }, "managed platform stop failed"); }
  try { await managedCredentialsPlatform.stopAll(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.managed_credentials_platform_stop_failed" }, "managed Credentials platform stop failed"); }
  try { await managedDeploymentsPlatform.stopAll(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.managed_deployments_platform_stop_failed" }, "managed Deployments platform stop failed"); }
  try { await managedDreamsPlatform.stopAll(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.managed_dreams_platform_stop_failed" }, "managed Dreams platform stop failed"); }
  try { await scheduler.stop(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.scheduler_stop_failed" }, "scheduler stop failed"); }
  try { await memoryWatcher.stop(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.watcher_stop_failed" }, "memory watcher stop failed"); }
  if (s3Poller) {
    try { await s3Poller.stop(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.s3_poller_stop_failed" }, "s3-poller stop failed"); }
  }
  if (feishuRunner) {
    try { await feishuRunner.stop(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.feishu_runner_stop_failed" }, "feishu ws runner stop failed"); }
  }
  if (hub instanceof PgEventStreamHub) {
    try { await hub.stop(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.pg_hub_stop_failed" }, "pg-hub stop failed"); }
  }
  if (authShutdown) {
    try { await authShutdown(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.auth_failed" }, "auth shutdown failed"); }
  }
  try { await sessionRegistry.shutdown(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.session_registry_failed" }, "session registry shutdown failed"); }
  try { await tracer.shutdown(); } catch { /* tracer shutdown is best-effort */ }
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// ─── Helpers ─────────────────────────────────────────────────────────────

function parseCustomHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const [name, ...rest] = part.split(":");
    if (!name || rest.length === 0) continue;
    out[name.trim()] = rest.join(":").trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function randomFallback(): string {
  // Pre-bootstrap fallback — logger is built before BetterAuth in the
  // current ordering, so this can use the structured logger.
  logger.warn(
    { op: "main-node.auth_secret_missing" },
    "BETTER_AUTH_SECRET not set — generating per-process random secret. Sessions will not survive restart.",
  );
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * In-process forwarder for the package's `installProxy` deps. Each subpath
 * (e.g. "linear/publications/start-a1") routes to bridge.startInstallation.
 * Mirrors apps/main/src/routes/integrations.ts but skips the
 * INTEGRATIONS.fetch hop.
 *
 * Linear's publication-first endpoints use distinct subpath shapes:
 *   - POST  linear/publications                       → mode='create-publication'
 *   - PATCH linear/publications/<id>/credentials      → mode='submit-credentials-pub'
 * Slack/GitHub continue using the legacy /start-a1, /credentials,
 * /handoff-link variants until they ship their own publication-first
 * refactors.
 */
function bridgeAsInstallProxy(bridge: NodeInstallBridge): InstallProxyForwarder {
  return {
    async forward({ subpath, body, method }) {
      // Linear publication-first endpoints first — they share a subpath
      // prefix with the legacy ones so order matters.
      const newPub = /^linear\/publications$/.exec(subpath);
      if (newPub && method === "POST") {
        const result = await bridge.startInstallation!({
          provider: "linear",
          mode: "create-publication",
          body: (body ?? {}) as Record<string, unknown>,
        });
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "content-type": "application/json" },
        });
      }
      const newCreds = /^linear\/publications\/([^/]+)\/credentials$/.exec(subpath);
      if (newCreds && (method === "PATCH" || method === "POST")) {
        const result = await bridge.startInstallation!({
          provider: "linear",
          mode: "submit-credentials-pub",
          body: { ...(body ?? {}), publicationId: newCreds[1] } as Record<string, unknown>,
        });
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "content-type": "application/json" },
        });
      }

      // Form-token reissue (wizard resume path): `<provider>/publications/<id>/form-token`.
      // Has a dynamic :id segment so it can't fold into the static-mode regex below —
      // handle it first and inject the id as body.publicationId (the bridge's
      // `form-token` mode reads it). Mounted for slack/github/feishu; linear returns
      // 410 inside the bridge.
      const formTokenRe = /^([^/]+)\/publications\/([^/]+)\/form-token$/.exec(subpath);
      // The http-routes forwarder omits `method` on this path; the CF
      // counterpart defaults to POST (apps/main/src/routes/integrations.ts)
      // — mirror that here so wizard refresh-resume works on Node.
      if (formTokenRe && (method ?? "POST") === "POST") {
        const result = await bridge.startInstallation!({
          provider: formTokenRe[1] as "linear" | "github" | "slack" | "feishu",
          mode: "form-token",
          body: {
            ...(body ?? {}),
            publicationId: formTokenRe[2],
          } as Record<string, unknown>,
        });
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "content-type": "application/json" },
        });
      }

      const m = /^([^/]+)\/publications\/(start-a1|credentials|handoff-link|personal-token)$/.exec(
        subpath,
      );
      if (!m) {
        return new Response(
          JSON.stringify({ error: `unsupported install proxy subpath: ${subpath}` }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      const [, provider, mode] = m;
      const result = await bridge.startInstallation!({
        provider: provider as "linear" | "github" | "slack" | "feishu",
        mode: mode as "start-a1" | "credentials" | "handoff-link" | "personal-token",
        body: (body ?? {}) as Record<string, unknown>,
      });
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

/**
 * Lightweight SqlClient shim around a better-sqlite3 Database. Used only
 * to run the better-auth schema apply against the auth db (separate
 * connection from the main SqlClient). We don't ship a full adapter — only
 * .exec() is needed.
 */
function betterSqliteAsSqlClient(
  db: import("better-sqlite3").Database,
): SqlClient {
  return {
    exec: async (s: string) => {
      db.exec(s);
    },
    prepare: () => {
      throw new Error("not implemented");
    },
    batch: async () => [],
  } as SqlClient;
}
