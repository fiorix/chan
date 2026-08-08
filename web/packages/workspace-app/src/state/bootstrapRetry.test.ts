// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import { ApiError, isTransientApiError } from "../api/errors";

// bug 8 (desktop auto-reload + hang on loading): when WKWebView
// recycles a workspace window's web-content process and the SPA reloads
// while the embedded loopback server is briefly unreachable, bootstrap
// must retry transient failures instead of sticking on "loading...".
// These pin which failures count as transient (retry) vs terminal
// (surface immediately). The classifier is shared: bootstrap
// (workspaceWithRetry), the server-instance health check, and the
// extension-catalog refresh all retry on exactly this set.
describe("isTransientApiError", () => {
  test("connection-refused / dropped-socket fetch (bare Error) is transient", () => {
    // fetch() to a refused loopback socket rejects with a TypeError.
    expect(isTransientApiError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransientApiError(new Error("network down"))).toBe(true);
  });

  test("our transport timeout (ApiError status 0) is transient", () => {
    expect(isTransientApiError(new ApiError(0, "request timed out"))).toBe(true);
  });

  test("5xx from a still-spinning-up server is transient", () => {
    expect(isTransientApiError(new ApiError(502, "bad gateway"))).toBe(true);
    expect(isTransientApiError(new ApiError(503, "unavailable"))).toBe(true);
    expect(isTransientApiError(new ApiError(504, "gateway timeout"))).toBe(true);
  });

  test("401 (missing token) is NOT transient: must surface the overlay", () => {
    expect(isTransientApiError(new ApiError(401, "unauthorized"))).toBe(false);
  });

  test("404 / other 4xx is NOT transient: a real error", () => {
    expect(isTransientApiError(new ApiError(404, "not found"))).toBe(false);
    expect(isTransientApiError(new ApiError(409, "conflict"))).toBe(false);
  });

  test("a non-Error throwable is NOT transient", () => {
    expect(isTransientApiError("boom")).toBe(false);
    expect(isTransientApiError(undefined)).toBe(false);
  });
});
