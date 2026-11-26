import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ABI } from "@chan/ghostty-web-ng/vt";

/// What the mocked fetch serves; the compiler is mocked too, so the bytes
/// never reach it.
const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
/// The vendored core, which the binding accepts when the kit is checked.
const module = await WebAssembly.compile(readFileSync("../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm"));

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
    const { loadGhosttyKit, ghosttyLoadIsFinal } = await import("./backend");
    const first = loadGhosttyKit();
    expect(loadGhosttyKit(), "concurrent spawns share the load").toBe(first);
    await expect(first).rejects.toBe(error);
    await expect(loadGhosttyKit()).rejects.toBe(error);
    expect(ghosttyLoadIsFinal(error), "only a reload can get past a compiler rejection").toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledTimes(1);
  });

  test.each(REFUSALS)("remembers a refused core %s for later spawns", async (_, refused, message) => {
    const fetch = vi.fn(() => Promise.resolve(new Response(bytes)));
    vi.stubGlobal("fetch", fetch);
    const compile = vi.spyOn(WebAssembly, "compile").mockResolvedValue(module);
    const spied = vi.spyOn(WebAssembly, "instantiate").mockImplementation(refused);
    const { loadGhosttyKit, ghosttyLoadIsFinal } = await import("./backend");
    const { GhosttyVtRefusal } = await import("@chan/ghostty-web-ng/vt");
    const first = loadGhosttyKit();
    await expect(first).rejects.toThrow(message);
    await expect(first, "the binding marks its refusal").rejects.toBeInstanceOf(GhosttyVtRefusal);
    expect(ghosttyLoadIsFinal(await first.catch((refusal: unknown) => refusal)), "only a reload can get past a refusal").toBe(true);
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
    const { loadGhosttyKit, ghosttyLoadIsFinal } = await import("./backend");
    const kit = loadGhosttyKit();
    await expect(kit, "the core is accepted").resolves.toHaveProperty("instantiate");
    expect(
      ghosttyLoadIsFinal(new RangeError("WebAssembly.instantiate(): Out of memory: Cannot allocate Wasm memory for new instance")),
      "a terminal's own instance failing on the accepted core may pass at its Retry",
    ).toBe(false);
    await expect((await kit).instantiate(), "the checked kit hands out terminals").resolves.toBeDefined();
    expect(dropped.length, "every instance was made without it").toBeGreaterThan(0);
    for (const run of dropped) expect(run, "the vendored core does export it").toBeTypeOf("function");
  });

  // Anything else an instance can throw may pass: the spawn it fails shows
  // Retry, and the next spawn checks again with a new instance of the module
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
    const { loadGhosttyKit, ghosttyLoadIsFinal } = await import("./backend");
    const { GhosttyVtRefusal } = await import("@chan/ghostty-web-ng/vt");
    const first = loadGhosttyKit();
    await expect(first).rejects.toThrow(message);
    await expect(first, "no refusal").rejects.not.toBeInstanceOf(GhosttyVtRefusal);
    expect(ghosttyLoadIsFinal(await first.catch((failure: unknown) => failure)), "the next spawn may pass").toBe(false);
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
    const { loadGhosttyKit, ghosttyLoadIsFinal } = await import("./backend");
    const failed = loadGhosttyKit();
    await expect(failed).rejects.toThrow(failure === "status" ? "503 Unavailable" : "connection lost");
    expect(ghosttyLoadIsFinal(await failed.catch((reason: unknown) => reason)), "the next spawn may pass").toBe(false);
    expect(compile).not.toHaveBeenCalled();
    const retry = loadGhosttyKit();
    await expect(retry).resolves.toHaveProperty("instantiate");
    expect(loadGhosttyKit(), "a successful retry stays cached").toBe(retry);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(compile).toHaveBeenCalledTimes(1);
    await expect((await retry).instantiate(), "the checked kit still hands out terminals").resolves.toBeDefined();
  });
});

describe("onGhosttyKitLoaded", () => {
  test("calls its listeners when a load passes, not on a failed load or a cached answer", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(bytes)));
    fetch.mockRejectedValueOnce(new Error("connection lost"));
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(WebAssembly, "compile").mockResolvedValue(module);
    const { loadGhosttyKit, onGhosttyKitLoaded, ghosttyLoadIsFinal } = await import("./backend");
    const loaded = vi.fn();
    const removed = vi.fn();
    onGhosttyKitLoaded(loaded);
    onGhosttyKitLoaded(removed)();

    const failed = loadGhosttyKit();
    await expect(failed).rejects.toThrow("connection lost");
    expect(ghosttyLoadIsFinal(await failed.catch((reason: unknown) => reason)), "the next load may pass").toBe(false);
    expect(loaded, "a failed load").not.toHaveBeenCalled();
    await loadGhosttyKit();
    expect(loaded, "the load that passed").toHaveBeenCalledTimes(1);
    await loadGhosttyKit();
    await loadGhosttyKit();
    expect(loaded, "a cached answer is no load").toHaveBeenCalledTimes(1);
    expect(removed, "a removed listener").not.toHaveBeenCalled();
  });
});

describe("the widget's import on an engine that keeps a failed module import", () => {
  const mocked: string[] = [];
  afterEach(() => {
    for (const id of mocked.splice(0)) vi.doUnmock(id);
  });

  /// The widget's module as an engine that keeps a failed import serves it,
  /// as WebKit does: an import at a URL that failed rejects for the page's
  /// life, and at any other URL loads while `serving`. `asked` lists the
  /// URLs the page asked for; `chunk` stands for the chunk's own URL.
  async function widgetEngine() {
    const { default: url } = await import("virtual:ghostty-widget-url");
    const engine = { serving: true, asked: [] as string[] };
    const failed = new Set<string>();
    const serve = (name: string) => async (importOriginal: () => Promise<unknown>) => {
      engine.asked.push(name);
      if (!engine.serving || failed.has(name)) {
        failed.add(name);
        throw new TypeError("Importing a module script failed.");
      }
      return importOriginal();
    };
    const ids: Array<[string, string]> = [["@chan/ghostty-web-ng", "chunk"]];
    for (const retry of [1, 2, 3]) ids.push([`${url}?retry=${retry}`, `chunk?retry=${retry}`]);
    for (const [id, name] of ids) {
      mocked.push(id);
      vi.doMock(id, serve(name));
    }
    return engine;
  }

  test("each failed import moves the next to a URL the page has not failed", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(bytes))));
    vi.spyOn(WebAssembly, "compile").mockResolvedValue(module);
    const engine = await widgetEngine();
    const { loadGhosttyKit, ghosttyLoadIsFinal } = await import("./backend");
    engine.serving = false;
    const failed = loadGhosttyKit();
    await expect(failed).rejects.toThrow();
    expect(ghosttyLoadIsFinal(await failed.catch((reason: unknown) => reason)), "the next spawn may pass").toBe(false);
    await expect(loadGhosttyKit(), "the network still down").rejects.toThrow();
    engine.serving = true;
    const kit = loadGhosttyKit();
    await expect(kit).resolves.toHaveProperty("instantiate");
    expect(engine.asked).toEqual(["chunk", "chunk?retry=1", "chunk?retry=2"]);
    await expect((await kit).instantiate(), "the kit hands out terminals").resolves.toBeDefined();
  });

  test("a widget that loaded is asked for at the same URL when the core's fetch fails", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(bytes)));
    fetch.mockRejectedValueOnce(new Error("connection lost"));
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(WebAssembly, "compile").mockResolvedValue(module);
    const engine = await widgetEngine();
    const { loadGhosttyKit } = await import("./backend");
    await expect(loadGhosttyKit()).rejects.toThrow("connection lost");
    await expect(loadGhosttyKit()).resolves.toHaveProperty("instantiate");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(engine.asked.length, "the widget was asked for").toBeGreaterThan(0);
    expect(engine.asked.filter((name) => name !== "chunk"), "only at the chunk's own URL").toEqual([]);
  });

  test("a widget that loaded at a retry URL is asked for there when the core's fetch fails", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(bytes)));
    fetch.mockRejectedValueOnce(new Error("connection lost"));
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(WebAssembly, "compile").mockResolvedValue(module);
    const engine = await widgetEngine();
    const { loadGhosttyKit } = await import("./backend");
    engine.serving = false;
    await expect(loadGhosttyKit(), "the widget's chunk failed").rejects.toThrow();
    engine.serving = true;
    await expect(loadGhosttyKit(), "the widget loaded, the core's fetch failed").rejects.toThrow("connection lost");
    await expect(loadGhosttyKit()).resolves.toHaveProperty("instantiate");
    expect(engine.asked).toEqual(["chunk", "chunk?retry=1"]);
  });
});
