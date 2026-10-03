// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { authToken } from "./authToken";

afterEach(() => vi.unstubAllGlobals());

describe("authToken", () => {
  it("reads the launcher bearer from the query", () => {
    vi.stubGlobal("location", { search: "?t=unit%20token" });
    expect(authToken()).toBe("unit token");
  });

  it("returns an empty bearer without a browser location", () => {
    vi.stubGlobal("location", undefined);
    expect(authToken()).toBe("");
  });
});
