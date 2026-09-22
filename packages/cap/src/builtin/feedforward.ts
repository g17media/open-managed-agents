// feedforward — FeedForward Collective internal apps behind ff-ingress-proxy.
//
// Header injection: the proxy accepts only `Authorization: Bearer <token>`,
// where the token is either a Zitadel OAuth access token (device flow) or a
// Zitadel service-user Personal Access Token pasted in manually.
//
// OAuth device flow: Zitadel's RFC 8628 endpoints at the shared IdP. The
// public client_id and the project-audience scope are per-deployment values
// that do not live in code — supply them with CAP_OVERRIDE_FEEDFORWARD_CLIENT_ID
// and CAP_OVERRIDE_FEEDFORWARD_SCOPES (see ../overrides.ts).
//
// Endpoints are listed explicitly rather than as `*.feedforward-collective.com`
// so the IdP host (`auth.`) is never matched.

import type { CapSpec } from "../types";

export const feedforwardSpec: CapSpec = {
  cli_id: "feedforward",
  description: "FeedForward Collective internal apps (members/internal) — Zitadel-backed",
  endpoints: [
    "members.feedforward-collective.com",
    "internal.feedforward-collective.com",
  ],
  inject_mode: "header",
  header: {
    strip: ["authorization"],
    set: { name: "Authorization", value: "Bearer ${token}" },
  },
  oauth: {
    device_flow: {
      initiate_url: "https://auth.feedforward-collective.com/oauth/v2/device_authorization",
      token_url: "https://auth.feedforward-collective.com/oauth/v2/token",
      client_id: "unset-see-CAP_OVERRIDE_FEEDFORWARD_CLIENT_ID",
      scopes: ["openid", "email", "profile", "offline_access", "urn:zitadel:iam:org:project:roles"],
    },
  },
};
