import { describe, expect, it } from "vitest";
import { handleHttp } from "../../../src/handle-http";
import { buildDeviceInitiateRequest, buildDevicePollRequest } from "../../../src/oauth";
import { feedforwardSpec } from "../../../src/builtin";
import { buildDeps, get, setTok, NOW_MS } from "./_helpers";

describe("feedforward — header injection", () => {
  it.each([
    "app.members.feedforward-collective.com",
    "app.internal.feedforward-collective.com",
    "deep.app.internal.feedforward-collective.com",
  ])("%s → Authorization: Bearer <token>", async (host) => {
    const deps = buildDeps();
    setTok(deps.resolver, "feedforward", host, "tok_ffc");
    const out = await handleHttp(get(`https://${host}/_whoami`), { principal: "p1" }, deps);
    expect(out.kind).toBe("forward");
    if (out.kind !== "forward") return;
    expect(out.req.headers["Authorization"]).toBe("Bearer tok_ffc");
  });

  it.each([
    "auth.feedforward-collective.com",
    "members.feedforward-collective.com",
    "internal.feedforward-collective.com",
    "feedforward-collective.com",
  ])("does not match %s (IdP or apex)", (host) => {
    expect(buildDeps().registry.byHostname(host)).toBeNull();
  });

  it("byCliId round-trips", () => {
    expect(buildDeps().registry.byCliId("feedforward")).toBe(feedforwardSpec);
  });

  it("strips an attempted Authorization smuggle from the inbound request", async () => {
    const deps = buildDeps();
    setTok(deps.resolver, "feedforward", "app.members.feedforward-collective.com", "tok_real");
    const out = await handleHttp(
      get("https://app.members.feedforward-collective.com/", { Authorization: "Bearer tok_smuggled" }),
      { principal: "p1" },
      deps,
    );
    if (out.kind !== "forward") throw new Error("expected forward");
    const values = Object.entries(out.req.headers)
      .filter(([k]) => k.toLowerCase() === "authorization")
      .map(([, v]) => v);
    expect(values).toEqual(["Bearer tok_real"]);
  });
});

describe("feedforward — OAuth device flow", () => {
  it("buildDeviceInitiateRequest hits Zitadel's device_authorization endpoint", () => {
    const req = buildDeviceInitiateRequest(feedforwardSpec);
    expect(req.url).toBe("https://auth.feedforward-collective.com/oauth/v2/device_authorization");
    const params = new URLSearchParams(new TextDecoder().decode(req.body!));
    expect(params.get("client_id")).toBe(feedforwardSpec.oauth!.device_flow.client_id);
    expect(params.get("scope")).toBe(
      "openid email profile offline_access urn:zitadel:iam:org:project:roles",
    );
  });

  it("buildDevicePollRequest uses the device-code grant_type against the token endpoint", () => {
    const state = {
      device_code: "dev_xyz",
      user_code: "X",
      verification_uri: "https://x",
      interval_seconds: 5,
      expires_at_ms: NOW_MS + 900_000,
    };
    const req = buildDevicePollRequest(feedforwardSpec, state);
    expect(req.url).toBe("https://auth.feedforward-collective.com/oauth/v2/token");
    const params = new URLSearchParams(new TextDecoder().decode(req.body!));
    expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(params.get("device_code")).toBe("dev_xyz");
  });
});
