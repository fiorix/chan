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

/// Instantiates `module` with its exports changed by `change`.
async function instantiateChanged(
  change: (exports: Record<string, unknown>, memory: WebAssembly.Memory) => Record<string, unknown>,
): Promise<WebAssembly.Instance> {
  const instance = await instantiate(module, {});
  const exports = instance.exports as Record<string, unknown>;
  return { exports: change({ ...exports }, exports.memory as WebAssembly.Memory) } as unknown as WebAssembly.Instance;
}

/// Instantiates `module` with its build info reporting `major`.
function instantiateReporting(major: number): Promise<WebAssembly.Instance> {
  return instantiateChanged((exports, memory) => {
    const real = exports.ghostty_build_info as Fn;
    const ghostty_build_info: Fn = (data, out) => {
      if (data !== ABI.GhosttyBuildInfo.VERSION_MAJOR) return real(data, out);
      new DataView(memory.buffer).setUint32(out, major, true);
      return ABI.GhosttyResult.SUCCESS;
    };
    return { ...exports, ghostty_build_info };
  });
}

/// The binding's refusals of a core, each with the instance that draws it.
const REFUSALS: Array<[string, () => Promise<WebAssembly.Instance>, string]> = [
  ["of another major", () => instantiateReporting(2), "libghostty-vt 2.x"],
  [
    "without search",
    () =>
      instantiateChanged((exports, memory) => {
        const real = exports.ghostty_build_info as Fn;
        const ghostty_build_info: Fn = (data, out) => {
          if (data !== ABI.GhosttyBuildInfo.FEATURE_SEARCH) return real(data, out);
          new DataView(memory.buffer).setUint8(out, 0);
          return ABI.GhosttyResult.SUCCESS;
        };
        return { ...exports, ghostty_build_info };
      }),
    "no search",
  ],
  [
    "missing an export the binding calls",
    () => instantiateChanged(({ ghostty_search_new: _, ...exports }) => exports),
    "missing export ghostty_search_new",
  ],
];

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

  test.each(REFUSALS)("remembers a refused core %s for later spawns", async (_, refused, message) => {
    const fetch = vi.fn(() => Promise.resolve(new Response(bytes)));
    vi.stubGlobal("fetch", fetch);
    const compile = vi.spyOn(WebAssembly, "compile").mockResolvedValue(module);
    const spied = vi.spyOn(WebAssembly, "instantiate").mockImplementation(refused);
    const { loadGhosttyKit } = await import("./backend");
    const { GhosttyVtRefusal } = await import("./ghosttyVt");
    const first = loadGhosttyKit();
    await expect(first).rejects.toThrow(message);
    await expect(first, "the binding marks its refusal").rejects.toBeInstanceOf(GhosttyVtRefusal);
    await expect(loadGhosttyKit(), "the refusal is kept").rejects.toThrow(message);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(spied, "one instance across both spawns").toHaveBeenCalledTimes(1);
  });

  // The binding requires the exports it calls and no others: a core is not
  // refused for lacking one the binding never reaches. The core's search
  // exports a `run` beside the `tick` and `feed` the binding scans with.
  test("loads a core without a search export the binding does not call", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(bytes))));
    vi.spyOn(WebAssembly, "compile").mockResolvedValue(module);
    const dropped: unknown[] = [];
    vi.spyOn(WebAssembly, "instantiate").mockImplementation(() =>
      instantiateChanged(({ ghostty_search_run: run, ...exports }) => {
        dropped.push(run);
        return exports;
      }),
    );
    const { loadGhosttyKit } = await import("./backend");
    const kit = loadGhosttyKit();
    await expect(kit, "the core is accepted").resolves.toHaveProperty("instantiate");
    await expect((await kit).instantiate(), "the checked kit hands out terminals").resolves.toBeDefined();
    expect(dropped.length, "every instance was made without it").toBeGreaterThan(0);
    for (const run of dropped) expect(run, "the vendored core does export it").toBeTypeOf("function");
  });

  // Anything else an instance can throw may pass: the spawn it fails falls
  // back, and the next spawn checks again with a new instance of the module
  // compiled before.
  test.each([
    [
      "a wasm memory RangeError",
      () => Promise.reject(new RangeError("WebAssembly.instantiate(): Out of memory: Cannot allocate Wasm memory for new instance")),
      "Out of memory",
    ],
    [
      "the binding's out of memory",
      () => instantiateChanged((exports) => ({ ...exports, ghostty_wasm_alloc: () => 0 })),
      "ghostty-vt: out of memory",
    ],
  ])("retries a core instance that fails with %s from the module compiled before", async (_, failing, message) => {
    const fetch = vi.fn(() => Promise.resolve(new Response(bytes)));
    vi.stubGlobal("fetch", fetch);
    const compile = vi.spyOn(WebAssembly, "compile").mockResolvedValue(module);
    const spied = vi.spyOn(WebAssembly, "instantiate").mockImplementationOnce(failing).mockImplementationOnce(failing);
    const { loadGhosttyKit } = await import("./backend");
    const { GhosttyVtRefusal } = await import("./ghosttyVt");
    const first = loadGhosttyKit();
    await expect(first).rejects.toThrow(message);
    await expect(first, "no refusal").rejects.not.toBeInstanceOf(GhosttyVtRefusal);
    const second = loadGhosttyKit();
    expect(second, "the next spawn loads again").not.toBe(first);
    await expect(second).rejects.toThrow(message);
    const retry = loadGhosttyKit();
    expect(retry, "and so does the one after").not.toBe(second);
    await expect(retry).resolves.toHaveProperty("instantiate");
    expect(spied, "each spawn instantiates again").toHaveBeenCalledTimes(3);
    expect(loadGhosttyKit(), "a successful retry stays cached").toBe(retry);
    expect(fetch, "one fetch across the retries").toHaveBeenCalledTimes(1);
    expect(compile, "one compile across the retries").toHaveBeenCalledTimes(1);
    await expect((await retry).instantiate(), "the checked kit still hands out terminals").resolves.toBeDefined();
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
