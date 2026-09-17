import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, liveApi } from "./library";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("liveApi.liveTerminalCount", () => {
  it("gets the encoded window count route and reads its count field", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ count: 2 }),
    });
    vi.stubGlobal("fetch", fetch);

    await expect(liveApi.liveTerminalCount("w/one")).resolves.toBe(2);
    expect(fetch).toHaveBeenCalledWith("/api/library/windows/w%2Fone/live-terminals", {
      method: "GET",
      headers: {},
      body: undefined,
    });
  });

  it("reports a missing count route as a 404 ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: async () => "missing window",
      }),
    );

    await expect(liveApi.liveTerminalCount("missing")).rejects.toEqual(
      new ApiError(404, "missing window"),
    );
  });
});
