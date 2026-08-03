// Build a better-auth instance with the OMA-shared config.
//
// CF passes a drizzle-adapter wrapping MAIN_DB; Node passes either a
// better-sqlite3 db or a pg.Pool — kysely-adapter inside better-auth
// detects the dialect from the shape (`aggregate in db` → SqliteDialect,
// `connect in db` → PostgresDialect).
//
// Email-OTP / sendResetPassword / sendVerificationEmail mount only when
// the caller passes a non-null `sender` — preserves P0-followup default-off
// behavior. The tenant-create databaseHook lives here so the same
// "sign up auto-creates a workspace" flow runs on either runtime.

import { betterAuth } from "better-auth";
import { emailOTP, genericOAuth } from "better-auth/plugins";
import type { EmailSender } from "@open-managed-agents/email";
import type { SqlClient } from "@open-managed-agents/sql-client";

export interface BuildBetterAuthOpts {
  /** Driver handle. better-sqlite3 Database, pg.Pool, or a drizzle adapter
   *  (CF). better-auth's kysely-adapter detects the dialect; CF callers
   *  pass `drizzleAdapter(db, { provider: "sqlite", schema })` — that
   *  satisfies the same `database` slot. */
  database: unknown;
  /** Cookie signing + token HMAC. Required in prod; main-node mints a
   *  per-process random one when omitted (callers SHOULD warn). */
  secret: string;
  /** Public origin (used for redirect URLs + cookie domain). */
  baseURL?: string;
  /** Email sender; null disables every email-bearing better-auth flow.
   *  CF prod always passes a real sender; self-host without SMTP passes
   *  null. */
  sender: EmailSender | null;
  /** Optional Google OAuth. */
  googleClientId?: string;
  googleClientSecret?: string;
  /** Optional generic OIDC / OAuth2 login (any spec-compliant IdP — Okta,
   *  Keycloak, Authentik, ...). Build from OIDC_* env vars via
   *  oidcFromEnv(). Mounts as providerId "oidc"; the redirect URI to
   *  register with the IdP is `${origin}/auth/oauth2/callback/oidc`. */
  oidc?: OidcProviderOptions | null;
  /** When true, sign-up requires email verification before the user is
   *  signed in. Default: false on self-host (no SMTP path), true on CF prod. */
  requireEmailVerify?: boolean;
  /** When true, email+password auth is off entirely — sign-in AND sign-up —
   *  and the email-OTP plugin (whose sign-in / verification / reset flows
   *  only serve email-based accounts) is not mounted. SSO-only mode; make
   *  sure Google or OIDC is configured or nobody can log in. */
  passwordDisabled?: boolean;
  /** When true, existing users can still sign in but new-account creation
   *  is blocked on every method: password sign-up, OTP sign-in for unknown
   *  emails, and Google / OIDC auto-provisioning. Create the first account
   *  before flipping this on. */
  signupDisabled?: boolean;
  /** Cross-subdomain cookie domain (e.g. ".openma.dev"). Skip for default
   *  per-host scoping. */
  cookieDomain?: string;
  /** Idempotent ensure-tenant; called from databaseHooks.user.create.after.
   *  Runtimes pass their own implementation: CF writes to the legacy
   *  `tenant` + `membership` + `tenant_shard` tables; Node writes to the
   *  packages/schema tenant tables only (no shard router). */
  ensureTenant: (user: {
    id: string;
    name?: string | null;
    email?: string | null;
  }) => Promise<unknown>;
  /** Optional drizzle-adapter pre-built by CF; pass `database` instead
   *  on Node. Ignored when not provided. */
  drizzleProvider?: "sqlite" | "pg";
}

export type BetterAuth = ReturnType<typeof betterAuth>;

export interface OidcProviderOptions {
  clientId: string;
  /** Optional for public clients doing PKCE-only. */
  clientSecret?: string;
  /** OIDC discovery document URL (…/.well-known/openid-configuration).
   *  Either this or authorizationUrl+tokenUrl must be set. */
  discoveryUrl?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
  scopes: string[];
  pkce: boolean;
}

/** Parse the OIDC_* env vars into an OidcProviderOptions, or null when the
 *  provider isn't (fully) configured: OIDC_CLIENT_ID plus either
 *  OIDC_DISCOVERY_URL or both OIDC_AUTHORIZATION_URL and OIDC_TOKEN_URL
 *  are required. OIDC_SCOPES is space- or comma-separated (default
 *  "openid profile email"); PKCE is on unless OIDC_PKCE=0. */
export function oidcFromEnv(
  env: Record<string, string | undefined>,
): OidcProviderOptions | null {
  const clientId = env.OIDC_CLIENT_ID;
  if (!clientId) return null;
  const discoveryUrl = env.OIDC_DISCOVERY_URL;
  const authorizationUrl = env.OIDC_AUTHORIZATION_URL;
  const tokenUrl = env.OIDC_TOKEN_URL;
  if (!discoveryUrl && !(authorizationUrl && tokenUrl)) return null;
  return {
    clientId,
    clientSecret: env.OIDC_CLIENT_SECRET,
    discoveryUrl,
    authorizationUrl,
    tokenUrl,
    userInfoUrl: env.OIDC_USERINFO_URL,
    scopes: env.OIDC_SCOPES?.split(/[\s,]+/).filter(Boolean) ?? [
      "openid",
      "profile",
      "email",
    ],
    pkce: env.OIDC_PKCE !== "0",
  };
}

function otpEmailHtml(code: string, label: string): string {
  return [
    '<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px">',
    `<h2 style="margin:0 0 16px">${label}</h2>`,
    `<p style="font-size:32px;letter-spacing:8px;font-weight:bold;margin:24px 0">${code}</p>`,
    '<p style="color:#666;font-size:14px">This code expires in 5 minutes. If you did not request this, ignore this email.</p>',
    "</div>",
  ].join("");
}

export function buildBetterAuth(opts: BuildBetterAuthOpts) {
  const socialProviders: Record<string, unknown> = {};
  if (opts.googleClientId && opts.googleClientSecret) {
    socialProviders.google = {
      clientId: opts.googleClientId,
      clientSecret: opts.googleClientSecret,
      disableSignUp: !!opts.signupDisabled,
    };
  }

  const sender = opts.sender;
  const requireVerify = !!opts.requireEmailVerify;

  const plugins: unknown[] = [];
  if (sender && !opts.passwordDisabled) {
    plugins.push(
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        sendVerificationOnSignUp: requireVerify,
        disableSignUp: !!opts.signupDisabled,
        async sendVerificationOTP({ email, otp, type }) {
          const labels: Record<string, string> = {
            "sign-in": "Your sign-in code",
            "email-verification": "Verify your email",
            "forget-password": "Your password reset code",
          };
          const label = labels[type] ?? "Your verification code";
          await sender.send({
            to: email,
            subject: `${label} — openma`,
            html: otpEmailHtml(otp, label),
            text: `${label}: ${otp}`,
          });
        },
      }),
    );
  }

  if (opts.oidc) {
    plugins.push(
      genericOAuth({
        config: [
          {
            providerId: "oidc",
            ...opts.oidc,
            disableSignUp: !!opts.signupDisabled,
          },
        ],
      }),
    );
  }

  const emailVerification = sender
    ? {
        sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
          await sender.send({
            to: user.email,
            subject: "Verify your email — openma",
            html: `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px"><h2>Verify your email</h2><p>Click the button below to verify your email address.</p><a href="${url}" style="display:inline-block;padding:12px 24px;background:#111;color:#fff;text-decoration:none;border-radius:6px;margin:16px 0">Verify email</a></div>`,
            text: `Verify your email: ${url}`,
          });
        },
        sendOnSignUp: true,
        autoSignInAfterVerification: true,
      }
    : undefined;

  const sendResetPassword = sender
    ? async ({ user, url }: { user: { email: string }; url: string }) => {
        await sender.send({
          to: user.email,
          subject: "Reset your password — openma",
          html: `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px"><h2>Reset your password</h2><a href="${url}" style="display:inline-block;padding:12px 24px;background:#111;color:#fff;text-decoration:none;border-radius:6px;margin:16px 0">Reset password</a></div>`,
          text: `Reset your password: ${url}`,
        });
      }
    : undefined;

  return betterAuth({
    basePath: "/auth",
    secret: opts.secret,
    baseURL: opts.baseURL,
    database: opts.database as never,
    emailAndPassword: {
      enabled: !opts.passwordDisabled,
      disableSignUp: !!opts.signupDisabled,
      requireEmailVerification: requireVerify,
      ...(sendResetPassword ? { sendResetPassword } : {}),
    },
    ...(emailVerification ? { emailVerification } : {}),
    plugins: plugins as never,
    socialProviders,
    trustedOrigins: opts.baseURL ? [opts.baseURL] : ["*"],
    ...(opts.cookieDomain
      ? {
          advanced: {
            crossSubDomainCookies: {
              enabled: true,
              domain: opts.cookieDomain,
            },
            defaultCookieAttributes: {
              domain: opts.cookieDomain,
              sameSite: "lax" as const,
              secure: true,
            },
          },
        }
      : {}),
    user: {
      additionalFields: {
        tenantId: { type: "string", required: false },
        role: { type: "string", required: false, defaultValue: "member" },
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user: { id: string; name?: string | null; email?: string | null }) => {
            try {
              await opts.ensureTenant(user);
            } catch (err) {
              // Don't block sign-up on tenant creation — auth middleware's
              // self-heal path retries on first authenticated request.
              console.error("[auth-config] ensureTenant hook failed:", err);
            }
          },
        },
      },
    },
  });
}

/** Run an idempotent ensure-tenant against an arbitrary SqlClient (the
 *  Node-style flow). Used by both apps/main-node's auth-config hook and
 *  the auth-middleware self-heal path. CF runs an analogous helper that
 *  also assigns a shard — see apps/main/src/auth-config.ts:ensureTenant. */
export async function ensureTenantSqlite(
  sql: SqlClient,
  userId: string,
  userName: string | null | undefined,
  userEmail: string | null | undefined,
): Promise<string> {
  const existing = await sql
    .prepare(
      `SELECT tenant_id FROM membership WHERE user_id = ? ORDER BY created_at ASC, tenant_id ASC LIMIT 1`,
    )
    .bind(userId)
    .first<{ tenant_id: string }>();
  if (existing) return existing.tenant_id;

  const tenantId = `tn_${randomHex(16)}`;
  const now = Date.now();
  const trimmedName = (userName ?? "").trim();
  const emailPrefix = (userEmail ?? "").split("@")[0]?.trim() ?? "";
  const display = trimmedName || emailPrefix || "User";
  const tenantName = `${display}'s workspace`;

  await sql
    .prepare(`INSERT INTO "tenant" (id, name, "createdAt", "updatedAt") VALUES (?, ?, ?, ?)`)
    .bind(tenantId, tenantName, now, now)
    .run();

  await sql
    .prepare(
      `INSERT INTO "membership" (user_id, tenant_id, role, created_at)
       VALUES (?, ?, 'owner', ?)
       ON CONFLICT (user_id, tenant_id) DO NOTHING`,
    )
    .bind(userId, tenantId, now)
    .run();

  // Re-read in case a concurrent caller raced.
  const final = await sql
    .prepare(
      `SELECT tenant_id FROM membership WHERE user_id = ? ORDER BY created_at ASC, tenant_id ASC LIMIT 1`,
    )
    .bind(userId)
    .first<{ tenant_id: string }>();
  return final?.tenant_id ?? tenantId;
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
