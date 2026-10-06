import type {
  BetaManagedAgentsCredential,
  BetaManagedAgentsCredentialValidation,
  BetaManagedAgentsDeletedCredential,
  CredentialCreateParams,
  CredentialListParams,
  CredentialUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/vaults/credentials";
import { z } from "zod";

export type CredentialCreateBody = Omit<CredentialCreateParams, "betas" | "auth"> & {
  auth: z.infer<typeof credentialCreateAuthSchema>;
};
export type CredentialUpdateBody = Omit<
  CredentialUpdateParams,
  "betas" | "vault_id" | "auth"
> & { auth?: z.infer<typeof credentialUpdateAuthSchema> };
export type CredentialListQuery = Omit<CredentialListParams, "betas">;

const unrestrictedNetworkingSchema = z
  .object({ type: z.literal("unrestricted") })
  .strict();

const limitedNetworkingSchema = z
  .object({
    type: z.literal("limited"),
    allowed_hosts: z.array(z.string()).max(16),
  })
  .strict();

const networkingSchema = z.discriminatedUnion("type", [
  unrestrictedNetworkingSchema,
  limitedNetworkingSchema,
]);

const injectionLocationInputSchema = z
  .object({ body: z.boolean().optional(), header: z.boolean().optional() })
  .strict();

const injectionLocationResponseSchema = z
  .object({ body: z.boolean(), header: z.boolean() })
  .strict();

const tokenEndpointAuthInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z
    .object({
      type: z.literal("client_secret_basic"),
      client_secret: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("client_secret_post"),
      client_secret: z.string(),
    })
    .strict(),
]);

const tokenEndpointAuthUpdateSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("client_secret_basic"),
      client_secret: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("client_secret_post"),
      client_secret: z.string().nullable().optional(),
    })
    .strict(),
]);

const tokenEndpointAuthResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z.object({ type: z.literal("client_secret_basic") }).strict(),
  z.object({ type: z.literal("client_secret_post") }).strict(),
]);

const oauthRefreshInputSchema = z
  .object({
    client_id: z.string(),
    refresh_token: z.string(),
    token_endpoint: z.string(),
    token_endpoint_auth: tokenEndpointAuthInputSchema,
    resource: z.string().nullable().optional(),
    scope: z.string().nullable().optional(),
  })
  .strict();

const oauthRefreshUpdateSchema = z
  .object({
    refresh_token: z.string().nullable().optional(),
    scope: z.string().nullable().optional(),
    token_endpoint_auth: tokenEndpointAuthUpdateSchema.optional(),
  })
  .strict();

const oauthRefreshResponseSchema = z
  .object({
    client_id: z.string(),
    token_endpoint: z.string(),
    token_endpoint_auth: tokenEndpointAuthResponseSchema,
    resource: z.string().nullable().optional(),
    scope: z.string().nullable().optional(),
  })
  .strict();

const handleSchema = z.string().regex(/^[A-Za-z0-9._-]+$/u).max(128);
const basicUsernameSchema = z.string().min(1).regex(/^[^:\x00-\x1f\x7f-\x9f]+$/u);
// Preserve spaces, tabs and exact secret bytes, but reject control characters before storage.
const headerTokenSchema = z.string().min(1).refine(
  (value) => !/[\x00-\x08\x0a-\x1f\x7f-\x9f]/u.test(value),
  "Credential token contains invalid header characters",
);
// Raw bearer/API-key headers are ByteStrings; Basic passwords are UTF-8 encoded before injection.
const bearerHeaderTokenSchema = headerTokenSchema.refine(
  (value) => !/[^\t\x20-\x7e\xa0-\xff]/u.test(value),
  "Credential token contains invalid header characters",
);
const credentialUrlSchema = z.url({ protocol: /^https?$/ });
// WebCrypto keeps API validation portable; signing remains in the vault runtime.
function derElement(tag: number, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const length: number[] = [];
  for (let n = bytes.length; n > 0; n = Math.floor(n / 256)) length.unshift(n & 255);
  return new Uint8Array([tag, ...(bytes.length < 128 ? [bytes.length] : [0x80 | length.length, ...length]), ...bytes]);
}
const rsaPrivateKeySchema = z.string().min(1).refine(async (value) => {
  try {
    const match = /^-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----\s*([A-Za-z0-9+/=\s]+)\s*-----END \1-----$/u.exec(value.trim());
    if (!match) return false;
    let bytes = Uint8Array.from(atob(match[2]!.replace(/\s/gu, "")), c => c.charCodeAt(0));
    if (match[1] === "RSA PRIVATE KEY") {
      // PKCS#1 wrapped in PKCS#8 PrivateKeyInfo (rsaEncryption OID).
      bytes = derElement(0x30, new Uint8Array([0x02, 0x01, 0x00,
        0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
        ...derElement(0x04, bytes)]));
    }
    await crypto.subtle.importKey("pkcs8", bytes, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    return true;
  } catch { return false; }
}, "Provide a valid unencrypted RSA private key in PEM format");
const tokenUriSchema = z.url({ protocol: /^https$/ }).refine((value) => {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash;
  } catch { return false; }
}, "Token URI must be HTTPS without user information or a fragment");
const serviceAccountFields = {
  type: z.literal("service_account_jwt"),
  mcp_server_url: credentialUrlSchema,
  client_email: z.string().trim().min(1),
  private_key: rsaPrivateKeySchema,
  private_key_id: z.string().min(1).optional(),
  token_uri: tokenUriSchema.default("https://oauth2.googleapis.com/token"),
  scopes: z.string().trim().min(1),
  subject: z.string().trim().min(1).optional(),
  audience: z.string().min(1).optional(),
};
const serviceAccountCreateSchema = z.object(serviceAccountFields).strict();
const serviceAccountUpdateSchema = serviceAccountCreateSchema.partial().extend({
  type: z.literal("service_account_jwt"),
  token_uri: tokenUriSchema.optional(),
  private_key: rsaPrivateKeySchema.nullable().optional(),
  private_key_id: z.string().min(1).nullable().optional(),
  subject: z.string().trim().min(1).nullable().optional(),
  audience: z.string().min(1).nullable().optional(),
}).strict();
const serviceAccountKeySchema = z.object({
  client_email: serviceAccountFields.client_email,
  private_key: rsaPrivateKeySchema,
  private_key_id: z.string().min(1).optional(),
  token_uri: tokenUriSchema.optional(),
});

// Extract only supported identity fields; Google project/certificate metadata is not stored.
// Explicit auth fields override their JSON-key counterparts after both inputs validate.
function normalizeServiceAccountKey(value: unknown, ctx: z.RefinementCtx): unknown {
  if (value === null || typeof value !== "object" || !("type" in value) ||
      value.type !== "service_account_jwt" || !("key_json" in value)) return value;
  let key: unknown = value.key_json;
  try { if (typeof key === "string") key = JSON.parse(key); } catch {
    ctx.addIssue({ code: "custom", path: ["key_json"], message: "Provide a valid service account JSON key" });
    return z.NEVER;
  }
  return serviceAccountKeySchema.safeParseAsync(key).then((parsed) => {
    if (!parsed.success) {
      ctx.addIssue({ code: "custom", path: ["key_json"], message: "JSON key requires client_email, an RSA private_key and a valid HTTPS token_uri when provided" });
      return z.NEVER;
    }
    const { key_json: _key, ...fields } = value;
    return { ...parsed.data, ...fields };
  });
}

const registryAuthSchema = z.object({
  type: z.literal("container_registry"),
  registry: z.string().min(1).optional(),
  username: z.string().nullable().optional(),
  password: z.string().nullable().optional(),
  token: z.string().nullable().optional(),
}).strict();
const credentialCreateAuthSchema = z.preprocess(normalizeServiceAccountKey, z.discriminatedUnion("type", [
  serviceAccountCreateSchema,
  z.object({ type: z.literal("static_basic"), username: basicUsernameSchema, token: headerTokenSchema, mcp_server_url: credentialUrlSchema }).strict(),
  registryAuthSchema.refine((auth) => !!auth.token || (!!auth.username && !!auth.password), {
    message: "Provide a registry token or both username and password",
  }),
  z.object({ type: z.literal("cap_cli"), cli_id: z.string().min(1), token: bearerHeaderTokenSchema,
    mcp_server_url: credentialUrlSchema.optional(), handle: handleSchema.optional(),
    extras: z.record(z.string(), z.string()).optional() }).strict(),
  z
    .object({
      type: z.literal("mcp_oauth"),
      access_token: z.string(),
      mcp_server_url: z.string(),
      expires_at: z.string().nullable().optional(),
      refresh: oauthRefreshInputSchema.nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("static_bearer"),
      handle: handleSchema.optional(),
      token: bearerHeaderTokenSchema,
      mcp_server_url: credentialUrlSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("environment_variable"),
      networking: networkingSchema,
      secret_name: z.string(),
      secret_value: z.string(),
      injection_location: injectionLocationInputSchema.optional(),
    })
    .strict(),
]));

const credentialUpdateAuthSchema = z.preprocess(normalizeServiceAccountKey, z.discriminatedUnion("type", [
  serviceAccountUpdateSchema,
  z.object({ type: z.literal("static_basic"), username: basicUsernameSchema.optional(), mcp_server_url: credentialUrlSchema.optional(), token: headerTokenSchema.nullable().optional() }).strict(),
  registryAuthSchema,
  z.object({ type: z.literal("cap_cli"), token: bearerHeaderTokenSchema.nullable().optional(),
    mcp_server_url: credentialUrlSchema.optional(), handle: handleSchema.nullable().optional(),
    extras: z.record(z.string(), z.string()).optional() }).strict(),
  z
    .object({
      type: z.literal("mcp_oauth"),
      access_token: z.string().nullable().optional(),
      expires_at: z.string().nullable().optional(),
      refresh: oauthRefreshUpdateSchema.nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("static_bearer"),
      mcp_server_url: credentialUrlSchema.optional(),
      handle: handleSchema.nullable().optional(),
      token: bearerHeaderTokenSchema.nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("environment_variable"),
      injection_location: injectionLocationInputSchema.optional(),
      networking: networkingSchema.nullable().optional(),
      secret_value: z.string().nullable().optional(),
    })
    .strict(),
]));

const credentialResponseAuthSchema = z.discriminatedUnion("type", [
  serviceAccountCreateSchema.omit({ private_key: true }),
  z.object({ type: z.literal("static_basic"), username: z.string(), mcp_server_url: z.string() }).strict(),
  z.object({ type: z.literal("container_registry"), registry: z.string().optional(), username: z.string().nullable().optional() }).strict(),
  z.object({ type: z.literal("cap_cli"), cli_id: z.string(), mcp_server_url: z.string().optional(),
    handle: handleSchema.optional() }).strict(),
  z
    .object({
      type: z.literal("mcp_oauth"),
      mcp_server_url: z.string(),
      expires_at: z.string().nullable().optional(),
      refresh: oauthRefreshResponseSchema.nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("static_bearer"),
      handle: handleSchema.optional(),
      mcp_server_url: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("environment_variable"),
      injection_location: injectionLocationResponseSchema,
      networking: networkingSchema,
      secret_name: z.string(),
    })
    .strict(),
]);

export const credentialCreateBodySchema: z.ZodType<CredentialCreateBody> = z
  .object({
    auth: credentialCreateAuthSchema,
    display_name: z.string().max(255).nullable().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const credentialUpdateBodySchema: z.ZodType<CredentialUpdateBody> = z
  .object({
    auth: credentialUpdateAuthSchema.optional(),
    display_name: z.string().min(1).max(255).nullable().optional(),
    metadata: z
      .record(z.string(), z.string().nullable())
      .nullable()
      .optional(),
  })
  .strict();

export const credentialListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    page: z.string().min(1).optional(),
    include_archived: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .strict();

export type ManagedCredentialResponse = Omit<BetaManagedAgentsCredential, "auth"> & {
  auth: z.infer<typeof credentialResponseAuthSchema>;
};
export const credentialResponseSchema: z.ZodType<ManagedCredentialResponse> =
  z
    .object({
      id: z.string().min(1),
      archived_at: z.string().nullable(),
      auth: credentialResponseAuthSchema,
      created_at: z.string(),
      metadata: z.record(z.string(), z.string()),
      type: z.literal("vault_credential"),
      updated_at: z.string(),
      vault_id: z.string().min(1),
      display_name: z.string().nullable().optional(),
    })
    .strict();

export const credentialPageResponseSchema = z
  .object({
    data: z.array(credentialResponseSchema),
    next_page: z.string().nullable(),
  })
  .strict();

export const deletedCredentialResponseSchema: z.ZodType<BetaManagedAgentsDeletedCredential> =
  z
    .object({
      id: z.string().min(1),
      type: z.literal("vault_credential_deleted"),
    })
    .strict();

const validationHttpResponseSchema = z
  .object({
    body: z.string(),
    body_truncated: z.boolean(),
    content_type: z.string(),
    status_code: z.number().int(),
  })
  .strict();

export const credentialValidationResponseSchema: z.ZodType<BetaManagedAgentsCredentialValidation> =
  z
    .object({
      credential_id: z.string().min(1),
      has_refresh_token: z.boolean(),
      mcp_probe: z
        .object({
          http_response: validationHttpResponseSchema.nullable(),
          method: z.string(),
        })
        .strict()
        .nullable(),
      refresh: z
        .object({
          http_response: validationHttpResponseSchema.nullable(),
          status: z.enum([
            "succeeded",
            "failed",
            "connect_error",
            "no_refresh_token",
          ]),
        })
        .strict()
        .nullable(),
      status: z.enum(["valid", "invalid", "unknown"]),
      type: z.literal("vault_credential_validation"),
      validated_at: z.string(),
      vault_id: z.string().min(1),
    })
    .strict();
