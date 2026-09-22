import { describe, expect, it } from "vitest";
import { applyCapOverrides, parseCapOverridesFromEnv } from "../../src/overrides";
import { builtinSpecs, feedforwardSpec, ghSpec, gitSpec } from "../../src/builtin";
import { createSpecRegistry } from "../../src/registry";

describe("applyCapOverrides", () => {
  it("merges endpoints, client_id and scopes onto the matching spec only", () => {
    const out = applyCapOverrides(builtinSpecs, {
      feedforward: {
        endpoints: ["staff.feedforward-collective.com"],
        oauth: { device_flow: { client_id: "cid_123", scopes: ["openid"] } },
      },
    });
    const ff = out.find((s) => s.cli_id === "feedforward")!;
    expect(ff.endpoints).toEqual(["staff.feedforward-collective.com"]);
    expect(ff.oauth!.device_flow).toEqual({
      ...feedforwardSpec.oauth!.device_flow,
      client_id: "cid_123",
      scopes: ["openid"],
    });
    expect(out.find((s) => s.cli_id === "gh")).toBe(ghSpec);
    expect(out).toHaveLength(builtinSpecs.length);
  });

  it("ignores an oauth override on a spec that has no oauth section", () => {
    const out = applyCapOverrides([gitSpec], {
      git: { oauth: { device_flow: { client_id: "cid" } } },
    });
    expect(out[0]).toEqual(gitSpec);
  });

  it("produces specs that still pass registry validation", () => {
    const out = applyCapOverrides(builtinSpecs, {
      feedforward: { oauth: { device_flow: { client_id: "cid" } } },
    });
    expect(() => createSpecRegistry(out)).not.toThrow();
  });
});

describe("parseCapOverridesFromEnv", () => {
  const known = ["feedforward", "gh"];

  it("reads CAP_OVERRIDE_<CLI_ID>_* with space-separated lists", () => {
    const out = parseCapOverridesFromEnv(known, {
      CAP_OVERRIDE_FEEDFORWARD_CLIENT_ID: " cid_123 ",
      CAP_OVERRIDE_FEEDFORWARD_SCOPES: "openid  profile urn:zitadel:iam:org:project:id:42:aud",
      CAP_OVERRIDE_FEEDFORWARD_ENDPOINTS: "members.example.com internal.example.com",
    });
    expect(out).toEqual({
      feedforward: {
        endpoints: ["members.example.com", "internal.example.com"],
        oauth: {
          device_flow: {
            client_id: "cid_123",
            scopes: ["openid", "profile", "urn:zitadel:iam:org:project:id:42:aud"],
          },
        },
      },
    });
  });

  it("reads INITIATE_URL and TOKEN_URL so a deployment can target its own IdP", () => {
    expect(parseCapOverridesFromEnv(known, {
      CAP_OVERRIDE_FEEDFORWARD_INITIATE_URL: "http://idp.local/oauth/v2/device_authorization",
      CAP_OVERRIDE_FEEDFORWARD_TOKEN_URL: "http://idp.local/oauth/v2/token",
    })).toEqual({
      feedforward: {
        oauth: {
          device_flow: {
            initiate_url: "http://idp.local/oauth/v2/device_authorization",
            token_url: "http://idp.local/oauth/v2/token",
          },
        },
      },
    });
  });

  it("emits only the fields that are set", () => {
    expect(parseCapOverridesFromEnv(known, { CAP_OVERRIDE_GH_CLIENT_ID: "cid" })).toEqual({
      gh: { oauth: { device_flow: { client_id: "cid" } } },
    });
    expect(parseCapOverridesFromEnv(known, { CAP_OVERRIDE_GH_ENDPOINTS: "ghe.example.com" })).toEqual({
      gh: { endpoints: ["ghe.example.com"] },
    });
  });

  it("treats blank values as unset", () => {
    expect(parseCapOverridesFromEnv(known, {
      CAP_OVERRIDE_GH_CLIENT_ID: "  ",
      CAP_OVERRIDE_GH_SCOPES: "",
    })).toEqual({});
  });

  it("ignores unrelated env vars and unknown cli_ids", () => {
    expect(parseCapOverridesFromEnv(known, {
      CAP_OVERRIDE_GLAB_CLIENT_ID: "cid",
      CAP_OVERRIDE_FEEDFORWARD_REQUEST_HEADERS: "X-Evil: 1",
      HOME: "/root",
    })).toEqual({});
  });
});
