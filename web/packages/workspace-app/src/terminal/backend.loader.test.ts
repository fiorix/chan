import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ABI } from "./ghosttyVt";

/// What the mocked fetch serves; the compiler is mocked too, so the bytes
/// never reach it.
const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
/// The vendored core, which the binding accepts when the kit is checked.
const module = await WebAssembly.compile(readFileSync("vendor/ghostty-vt/ghostty-vt.wasm"));

type Fn = (...args: number[]) => number;

/// Kept before any test spies on it.
const instantiate = WebAssembly.instantiate;

/// Instantiates `module` with its build info reporting `major`.
async function instantiateReporting(major: number): Promise<WebAssembly.Instance> {
  const instance = await instantiate(module, {});
  const exports = instance.exports as Record<string, unknown>;
  const memory = exports.memory as WebAssembly.Memory;
  const real = exports.ghostty_build_info as Fn;
  const ghostty_build_info: Fn = (data, out) => {
    if (data !== ABI.GhosttyBuildInfo.VERSION_MAJOR) return real(data, out);
    new DataView(memory.buffer).setUint32(out, major, true);
    return ABI.GhosttyResult.SUCCESS;
  };
  return { exports: { ...exports, ghostty_build_info } } as unknown as WebAssembly.Instance;
}

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

  test("remembers a refused core for later spawns", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(bytes)));
    vi.stubGlobal("fetch", fetch);
    const compile = vi.spyOn(WebAssembly, "compile").mockResolvedValue(module);
    const spied = vi.spyOn(WebAssembly, "instantiate").mockImplementation(() => instantiateReporting(2));
    const { loadGhosttyKit } = await import("./backend");
    await expect(loadGhosttyKit()).rejects.toThrow("libghostty-vt 2.x");
    await expect(loadGhosttyKit(), "the refusal is kept").rejects.toThrow("libghostty-vt 2.x");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(spied).toHaveBeenCalledTimes(1);
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
    await expect((await retry).instantiate(), "the checked kit still hands out terminals").resolves.toBeDefined();
  });
});
