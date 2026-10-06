// Verify outbound log fields omit caller-controlled URL content in every representation.
import { describe, expect, it } from "vitest";
import { requestLogFields } from "../src/request-log";

describe("sanitized request log fields", () => {
  it.each(["http", "https"])("retains only method, scheme and hostname (%s)", (scheme) => {
    const url = `${scheme}://sentinel-user:sentinel-password@example.test:8443/sentinel-path?q=sentinel-query#sentinel-fragment`;
    const fields = requestLogFields("POST", url);
    expect(fields).toEqual({ method: "POST", scheme, hostname: "example.test" });
    expect(JSON.stringify(fields)).not.toContain("sentinel");
  });
  it("does not echo malformed URLs", () => {
    expect(requestLogFields("GET", "sentinel-invalid-url")).toEqual({ method: "GET", scheme: "unknown", hostname: "unknown" });
  });
});
