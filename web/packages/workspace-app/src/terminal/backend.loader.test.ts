import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const module = new WebAssembly.Module(bytes);

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("loadGhosttyKit", () => {
  test.each([
    new WebAssembly.CompileError("unsupported SIMD"),
    new Error("compiler unavailable"),
  ])("remembers a compiler rejection for later spawns: %s", async (error) => {
    const fetch = vi.fn(() => Promise.resolve(new Response(bytes)));
    vi.stubGlobal("fetch", fetch);
    const compile = vi.spyOn(WebAssembly, "compile").mockRejectedValue(error);
    const { loadGhosttyKit } = await import("./backend");
    const first = loadGhosttyKit();
    expect(loadGhosttyKit(), "concurrent spawns share the load").toBe(first);
    await expect(first).rejects.toBe(error);
    await expect(loadGhosttyKit()).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledTimes(1);
  });

  test.each(["network", "status", "body"])("retries a %s fetch failure", async (failure) => {
    const error = new Error("connection lost");
    const fetch = vi.fn(() => Promise.resolve(new Response(bytes)));
    if (failure === "network") fetch.mockRejectedValueOnce(error);
    else if (failure === "status") fetch.mockResolvedValueOnce(new Response(null, { status: 503, statusText: "Unavailable" }));
    else {
      const response = new Response(bytes);
      vi.spyOn(response, "arrayBuffer").mockRejectedValueOnce(error);
      fetch.mockResolvedValueOnce(response);
    }
    vi.stubGlobal("fetch", fetch);
    const compile = vi.spyOn(WebAssembly, "compile").mockResolvedValue(module);
    const { loadGhosttyKit } = await import("./backend");
    await expect(loadGhosttyKit()).rejects.toThrow(failure === "status" ? "503 Unavailable" : "connection lost");
    expect(compile).not.toHaveBeenCalled();
    const retry = loadGhosttyKit();
    await expect(retry).resolves.toHaveProperty("instantiate");
    expect(loadGhosttyKit(), "a successful retry stays cached").toBe(retry);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(compile).toHaveBeenCalledTimes(1);
  });
});
