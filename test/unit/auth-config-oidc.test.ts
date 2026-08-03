// oidcFromEnv: OIDC_* env vars → generic-oauth provider config (or null
// when not fully configured). Both runtimes feed buildBetterAuth /
// createAuth from this, and /auth-info mirrors its enabled condition.

import { describe, it, expect } from "vitest";
import { oidcFromEnv } from "@open-managed-agents/auth-config";

describe("oidcFromEnv", () => {
  const base = {
    OIDC_CLIENT_ID: "console",
    OIDC_DISCOVERY_URL: "https://idp.example.com/.well-known/openid-configuration",
  };

  it("returns null without OIDC_CLIENT_ID", () => {
    expect(oidcFromEnv({})).toBeNull();
    expect(
      oidcFromEnv({ OIDC_DISCOVERY_URL: base.OIDC_DISCOVERY_URL }),
    ).toBeNull();
  });

  it("returns null with a client id but no endpoints", () => {
    expect(oidcFromEnv({ OIDC_CLIENT_ID: "console" })).toBeNull();
    // authorization URL alone isn't enough — token URL is also required
    expect(
      oidcFromEnv({
        OIDC_CLIENT_ID: "console",
        OIDC_AUTHORIZATION_URL: "https://idp.example.com/authorize",
      }),
    ).toBeNull();
  });

  it("enables via discovery URL with defaults", () => {
    expect(oidcFromEnv(base)).toEqual({
      clientId: "console",
      clientSecret: undefined,
      discoveryUrl: base.OIDC_DISCOVERY_URL,
      authorizationUrl: undefined,
      tokenUrl: undefined,
      userInfoUrl: undefined,
      scopes: ["openid", "profile", "email"],
      pkce: true,
    });
  });

  it("enables via explicit authorization + token URLs", () => {
    const oidc = oidcFromEnv({
      OIDC_CLIENT_ID: "console",
      OIDC_CLIENT_SECRET: "s3cret",
      OIDC_AUTHORIZATION_URL: "https://idp.example.com/authorize",
      OIDC_TOKEN_URL: "https://idp.example.com/token",
      OIDC_USERINFO_URL: "https://idp.example.com/userinfo",
    });
    expect(oidc).toMatchObject({
      clientSecret: "s3cret",
      authorizationUrl: "https://idp.example.com/authorize",
      tokenUrl: "https://idp.example.com/token",
      userInfoUrl: "https://idp.example.com/userinfo",
    });
  });

  it("parses OIDC_SCOPES as space- or comma-separated", () => {
    expect(
      oidcFromEnv({ ...base, OIDC_SCOPES: "openid email groups" })?.scopes,
    ).toEqual(["openid", "email", "groups"]);
    expect(
      oidcFromEnv({ ...base, OIDC_SCOPES: "openid, email,groups" })?.scopes,
    ).toEqual(["openid", "email", "groups"]);
  });

  it("OIDC_PKCE=0 disables PKCE", () => {
    expect(oidcFromEnv({ ...base, OIDC_PKCE: "0" })?.pkce).toBe(false);
    expect(oidcFromEnv({ ...base, OIDC_PKCE: "1" })?.pkce).toBe(true);
  });
});
