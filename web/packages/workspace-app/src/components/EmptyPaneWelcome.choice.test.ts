// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import { reportingWebgl2, type AnimationRun } from "../__tests__/canvas";
import {
  EMPTY_PANE_ANIMATIONS,
  type EmptyPaneAnimationId,
} from "./emptyPaneAnimations";

// The runner each mounted animation asked for, oldest first. Kept here and
// not in the shared canvas fixture: each page below loads the modules again,
// and a recorder inside a reloaded module would not be the one read here.
const asked = vi.hoisted(() => [] as AnimationRun["runner"][]);
const gpuProbe = vi.hoisted(() =>
  vi.fn(
    (_canvas: HTMLCanvasElement, _windowMs: number): Promise<{
      windowMs: number;
      callbackCount: number;
      frames: Array<{ timestampMs: number; costMs: number }>;
    }> => new Promise(() => {}),
  ),
);

vi.mock("./canvasAnimation", async (importOriginal) => {
  const record = (runner: AnimationRun["runner"]) => (): (() => void) => {
    asked.push(runner);
    return () => {};
  };
  return {
    ...(await importOriginal<typeof import("./canvasAnimation")>()),
    runCanvasAnimation: record("2d"),
    runWebglAnimation: record("webgl"),
    runWebgl2Animation: record("webgl2"),
    probeGpuFrames: gpuProbe,
  };
});

const START_DELAY_MS = 2000;
const SAVED_ANIMATION_KEY = "chan.empty-pane-animation";

const SWIFTSHADER =
  "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)";
const LLVMPIPE = "llvmpipe (LLVM 21.1.8, 256 bits)";
const WARP =
  "ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)";
// A hardware driver built on LLVM, which a software match must not catch.
const RADEON =
  "ANGLE (AMD, AMD Radeon 780M Graphics (radeonsi, phoenix, LLVM 20.1.8, DRM 3.64), OpenGL ES 3.2)";
// What a WebKit engine answers whatever it draws on.
const MASKED = "Apple GPU";

interface Shown {
  id: string | null;
  runner: AnimationRun["runner"] | undefined;
}

interface Page {
  getContext: ReturnType<typeof vi.spyOn>;
  /// Mount a welcome and wait, by default through its start delay.
  show(animation?: EmptyPaneAnimationId, waitMs?: number): void;
  wait(ms: number): void;
  settle(): Promise<void>;
  /// Unmount the welcome shown last.
  close(): void;
  /// The saved choice and the runner the mounted animation asked for.
  shown(): Shown;
  press(key: string): Promise<Shown>;
  /// The runner an animation asks for when it is shown by name.
  runnerOf(id: EmptyPaneAnimationId): AnimationRun["runner"] | undefined;
}

const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
  asked.length = 0;
  gpuProbe.mockClear();
  gpuProbe.mockImplementation(() => new Promise(() => {}));
  document.body.innerHTML = "";
  document.head.querySelector('meta[name="chan-gpu"]')?.remove();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// A new page: the modules are loaded again, since the page's renderer is
// read once and kept, and a `webgl2` request answers with a context that
// reports `renderer`, or with none for null.
async function openPage(
  renderer: string | null,
  gpuMeta?: "0" | "1",
): Promise<Page> {
  document.head.querySelector('meta[name="chan-gpu"]')?.remove();
  if (gpuMeta !== undefined) {
    const meta = document.createElement("meta");
    meta.name = "chan-gpu";
    meta.content = gpuMeta;
    document.head.append(meta);
  }
  vi.resetModules();
  const svelte = await import("svelte");
  const EmptyPaneWelcome = (await import("./EmptyPaneWelcome.svelte")).default;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(((kind: string) =>
      kind === "webgl2" && renderer !== null
        ? reportingWebgl2(renderer)
        : null) as never);

  let welcome: HTMLElement | null = null;
  const wait = (ms: number): void => {
    vi.advanceTimersByTime(ms);
    svelte.flushSync();
  };
  const show = (
    animation?: EmptyPaneAnimationId,
    waitMs = START_DELAY_MS,
  ): void => {
    const target = document.createElement("div");
    document.body.append(target);
    const instance = svelte.mount(EmptyPaneWelcome, {
      target,
      props: animation ? { animation } : {},
    });
    svelte.flushSync();
    wait(waitMs);
    welcome = target.querySelector<HTMLElement>(".welcome");
    closers.push(() => {
      svelte.unmount(instance);
      target.remove();
    });
  };
  const close = (): void => {
    closers.pop()?.();
    svelte.flushSync();
  };
  const settle = async (): Promise<void> => {
    await Promise.resolve();
    await svelte.tick();
    svelte.flushSync();
  };
  const shown = (): Shown => ({
    id: welcome?.dataset.animationId ?? null,
    runner: asked.at(-1),
  });
  const press = async (key: string): Promise<Shown> => {
    welcome?.focus();
    welcome?.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
    await svelte.tick();
    svelte.flushSync();
    return shown();
  };
  const runnerOf = (
    id: EmptyPaneAnimationId,
  ): AnimationRun["runner"] | undefined => {
    asked.length = 0;
    show(id);
    const runner = asked.at(-1);
    close();
    return runner;
  };
  return { getContext, show, wait, settle, close, shown, press, runnerOf };
}

function probes(page: Page): unknown[][] {
  const calls: unknown[][] = page.getContext.mock.calls;
  return calls.filter((call) => call[0] === "webgl2");
}

describe("EmptyPaneWelcome choice on a software WebGL context", () => {
  test("each catalog entry names the runner its animation asks for", async () => {
    const page = await openPage(null);
    for (const { id, runner } of EMPTY_PANE_ANIMATIONS) {
      expect(page.runnerOf(id), `runner of ${id}`).toBe(runner);
    }
  });

  test.each([
    ["a SwiftShader renderer", SWIFTSHADER],
    ["an llvmpipe renderer", LLVMPIPE],
    ["the Windows WARP renderer", WARP],
    ["no WebGL2 context", null],
  ])("draws only 2D-canvas animations on %s", async (_name, renderer) => {
    const page = await openPage(renderer);
    const twoD = EMPTY_PANE_ANIMATIONS.filter(
      ({ id }) => page.runnerOf(id) === "2d",
    ).map(({ id }) => id);
    expect(twoD.length, "2D animations in the catalog").toBeGreaterThan(0);
    expect(twoD.length, "2D animations in the catalog").toBeLessThan(
      EMPTY_PANE_ANIMATIONS.length,
    );
    const random = vi.spyOn(Math, "random");

    // The first choice, at both ends of the draw.
    for (const draw of [0, 0.999]) {
      window.sessionStorage.clear();
      random.mockReturnValue(draw);
      page.show();
      expect(page.shown().runner, `first choice at ${draw}`).toBe("2d");
      expect(twoD, `first choice at ${draw}`).toContain(page.shown().id);
      page.close();
    }

    // A saved choice the page cannot afford is replaced, and the
    // replacement is what stays saved.
    window.sessionStorage.setItem(SAVED_ANIMATION_KEY, "sixfold-vortex");
    random.mockReturnValue(0);
    page.show();
    expect(page.shown().runner, "saved WebGL2 choice").toBe("2d");
    expect(twoD, "saved WebGL2 choice").toContain(page.shown().id);

    // The random key, across the whole draw.
    for (let step = 0; step < 20; step += 1) {
      random.mockReturnValue(step / 20);
      const after = await page.press("?");
      expect(after.runner, `random key at ${step / 20}`).toBe("2d");
    }

    // The arrow keys walk the 2D animations in catalog order and wrap.
    const start = page.shown().id;
    const walked: Array<string | null> = [];
    for (let step = 0; step < twoD.length; step += 1) {
      const after = await page.press("ArrowRight");
      expect(after.runner, `arrow walk step ${step}`).toBe("2d");
      walked.push(after.id);
    }
    expect(new Set(walked).size, "animations the arrow walk visits").toBe(
      twoD.length,
    );
    expect(walked.at(-1), "arrow walk wraps to its start").toBe(start);
    // Backward the walk retraces itself, through the wrap from the first
    // 2D animation to the last.
    const retraced: Array<string | null> = [];
    for (let step = 0; step < twoD.length; step += 1) {
      const after = await page.press("ArrowLeft");
      expect(after.runner, `arrow walk backward step ${step}`).toBe("2d");
      retraced.push(after.id);
    }
    expect(retraced, "arrow walk backward").toEqual(
      [...walked.slice(0, -1).reverse(), start],
    );
    page.close();

    // A caller may show an animation outside the choices by name. A step
    // from it lands on the nearest 2D animation in catalog order each way,
    // here past WebGL2 neighbors on both sides and through the wrap.
    for (const [key, neighbor] of [
      ["ArrowRight", "swaying-branches"],
      ["ArrowLeft", "chaotic-halo"],
    ] as const) {
      page.show("striated-current");
      expect(page.shown().runner, "animation shown by name").toBe("webgl2");
      const after = await page.press(key);
      expect(after.id, `${key} from a WebGL2 animation`).toBe(neighbor);
      expect(after.runner, `${key} from a WebGL2 animation`).toBe("2d");
      page.close();
    }
  });

  test.each([
    ["a hardware renderer", RADEON],
    ["a renderer the engine masks", MASKED],
  ])("keeps the whole catalog on %s", async (_name, renderer) => {
    const page = await openPage(renderer);
    const random = vi.spyOn(Math, "random");

    random.mockReturnValue(0);
    page.show();
    expect(page.shown().id, "first choice at 0").toBe("sixfold-vortex");
    expect(page.shown().runner, "first choice at 0").toBe("webgl2");
    page.close();

    window.sessionStorage.clear();
    random.mockReturnValue(0.999);
    page.show();
    expect(page.shown().id, "first choice at 0.999").toBe("bitwise-spheres");
    expect(page.shown().runner, "first choice at 0.999").toBe("webgl2");
    page.close();

    window.sessionStorage.setItem(SAVED_ANIMATION_KEY, "polar-drift");
    page.show();
    expect(page.shown().id, "saved WebGL2 choice").toBe("polar-drift");
    expect(page.shown().runner, "saved WebGL2 choice").toBe("webgl2");

    const walked = new Set<string | null>();
    for (let step = 0; step < EMPTY_PANE_ANIMATIONS.length; step += 1) {
      walked.add((await page.press("ArrowRight")).id);
    }
    expect(walked.size, "animations the arrow walk visits").toBe(
      EMPTY_PANE_ANIMATIONS.length,
    );
  });

  test("reads the renderer once for the page, and not before the start", async () => {
    const page = await openPage(SWIFTSHADER);
    vi.spyOn(Math, "random").mockReturnValue(0);

    page.show(undefined, START_DELAY_MS - 1);
    expect(probes(page).length, "readings before the start").toBe(0);
    page.wait(1);
    expect(probes(page).length, "readings after one welcome").toBe(1);
    page.close();
    window.sessionStorage.clear();
    page.show();
    expect(page.shown().runner, "second welcome").toBe("2d");
    expect(probes(page).length, "readings after two welcomes").toBe(1);
  });
});

describe("EmptyPaneWelcome choice without a desktop GPU", () => {
  test.each(["Apple GPU", RADEON])(
    "keeps the unnamed welcome on 2D when WebGL reports %s",
    async (renderer) => {
      const page = await openPage(renderer, "0");
      const twoD = EMPTY_PANE_ANIMATIONS.filter(
        ({ runner }) => runner === "2d",
      ).map(({ id }) => id);
      expect(twoD[0]).toBe("radial-ribbons");
      const random = vi.spyOn(Math, "random").mockReturnValue(0);

      page.show();
      expect(page.shown()).toEqual({ id: "radial-ribbons", runner: "2d" });
      expect(probes(page), "renderer context requests").toHaveLength(0);
      expect(gpuProbe, "GPU probes").not.toHaveBeenCalled();
      page.close();

      window.sessionStorage.setItem(SAVED_ANIMATION_KEY, "sixfold-vortex");
      random.mockReturnValue(0);
      page.show();
      expect(page.shown()).toEqual({ id: "radial-ribbons", runner: "2d" });
      expect(window.sessionStorage.getItem(SAVED_ANIMATION_KEY)).toBe(
        "radial-ribbons",
      );
      page.close();

      window.sessionStorage.setItem(SAVED_ANIMATION_KEY, "radial-ribbons");
      page.show();
      expect((await page.press("ArrowRight")).id).toBe(twoD[1]);
      expect((await page.press("ArrowLeft")).id).toBe("radial-ribbons");
      expect((await page.press("ArrowLeft")).id).toBe(twoD.at(-1));
      expect((await page.press("ArrowRight")).id).toBe("radial-ribbons");
      expect((await page.press("?")).runner).toBe("2d");
      await page.settle();
      expect(probes(page), "renderer context requests after keys").toHaveLength(0);
      expect(gpuProbe, "GPU probes after keys").not.toHaveBeenCalled();
    },
  );

  test("keeps a saved WebGL choice without a desktop GPU hint", async () => {
    const page = await openPage(MASKED);
    window.sessionStorage.setItem(SAVED_ANIMATION_KEY, "sixfold-vortex");
    page.show();
    await page.settle();
    expect(page.shown()).toEqual({ id: "sixfold-vortex", runner: "webgl2" });
    expect(probes(page), "renderer context request").toHaveLength(1);
    expect(gpuProbe, "ordinary browser probe").toHaveBeenCalledOnce();
  });
});

describe("EmptyPaneWelcome GPU probe", () => {
  const slow = { windowMs: 1500, callbackCount: 3, frames: [
    { timestampMs: 500, costMs: 4 },
    { timestampMs: 1000, costMs: 4 },
    { timestampMs: 1500, costMs: 4 },
  ] };
  const fast = { windowMs: 1500, callbackCount: 36, frames: Array.from({ length: 36 }, (_, index) => ({
    timestampMs: (index + 1) * 40,
    costMs: 4,
  })) };

  test("swaps a slow WebGL choice, persists it and keeps arrows on 2D", async () => {
    gpuProbe.mockResolvedValue(slow);
    const page = await openPage(MASKED);
    window.sessionStorage.setItem(SAVED_ANIMATION_KEY, "sixfold-vortex");
    page.show();
    await page.settle();
    expect(gpuProbe, "first WebGL choice is probed").toHaveBeenCalledOnce();
    expect(page.shown().id, "persisted next 2D choice").toBe("radial-ribbons");
    expect(window.sessionStorage.getItem(SAVED_ANIMATION_KEY), "swap persisted").toBe("radial-ribbons");
    expect(page.shown().runner).toBe("2d");
    const reading = JSON.parse(
      document.querySelector<HTMLElement>(".welcome")?.dataset.gpuProbe ?? "null",
    );
    expect(reading).toMatchObject({
      choice: "sixfold-vortex",
      windowMs: 1500,
      callbackFps: 2,
      medianCostMs: 4,
      decision: "swap",
    });
    expect(reading.resolvedAtEpochMs).toBeGreaterThanOrEqual(
      reading.requestedAtEpochMs,
    );
    for (let step = 0; step < 15; step += 1) {
      expect((await page.press("ArrowRight")).runner, `arrow ${step}`).toBe("2d");
    }
    expect(gpuProbe, "one probe for the page").toHaveBeenCalledOnce();
  });

  test("keeps a fast WebGL choice", async () => {
    gpuProbe.mockResolvedValue(fast);
    const page = await openPage(MASKED);
    window.sessionStorage.setItem(SAVED_ANIMATION_KEY, "sixfold-vortex");
    page.show();
    await page.settle();
    expect(gpuProbe, "fast WebGL choice is probed").toHaveBeenCalledOnce();
    expect(page.shown().id).toBe("sixfold-vortex");
    expect(page.shown().runner).toBe("webgl2");
    expect(JSON.parse(
      document.querySelector<HTMLElement>(".welcome")?.dataset.gpuProbe ?? "null",
    )).toMatchObject({
      choice: "sixfold-vortex",
      callbackFps: 24,
      medianCostMs: 4,
      decision: "keep",
    });
  });

  test("an empty retry leaves the next WebGL choice probed", async () => {
    let finishRetry: ((probe: { windowMs: number; callbackCount: number; frames: [] }) => void) | undefined;
    gpuProbe.mockResolvedValueOnce({ windowMs: 1500, callbackCount: 0, frames: [] });
    gpuProbe.mockImplementationOnce(() => new Promise((resolve) => { finishRetry = resolve; }));
    const page = await openPage(MASKED);
    window.sessionStorage.setItem(SAVED_ANIMATION_KEY, "threefold-veil");
    page.show();
    await page.settle();
    expect(page.shown().runner, "starts on WebGL").toBe("webgl2");
    expect(gpuProbe, "the first WebGL choice is retried").toHaveBeenCalledTimes(2);
    const next = await page.press("ArrowRight");
    expect(next.runner, "the arrow reaches WebGL").toBe("webgl2");
    finishRetry?.({ windowMs: 1500, callbackCount: 0, frames: [] });
    await page.settle();
    await page.settle();
    expect(gpuProbe, "the next WebGL choice is probed after an empty retry").toHaveBeenCalledTimes(3);
  });

  test("an arrow before the empty result still probes the new WebGL choice", async () => {
    let finishFirst: ((probe: { windowMs: number; callbackCount: number; frames: [] }) => void) | undefined;
    gpuProbe.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
    const page = await openPage(MASKED);
    window.sessionStorage.setItem(SAVED_ANIMATION_KEY, "threefold-veil");
    page.show();
    expect(gpuProbe, "first WebGL choice").toHaveBeenCalledOnce();
    const next = await page.press("ArrowRight");
    expect(next.id).toBe("striated-current");
    finishFirst?.({ windowMs: 1500, callbackCount: 0, frames: [] });
    await page.settle();
    await page.settle();
    expect(gpuProbe, "new choice after the old runner tears down").toHaveBeenCalledTimes(2);
  });

  test("a kept probe spends the page's one probe", async () => {
    gpuProbe.mockResolvedValue(fast);
    const page = await openPage(MASKED);
    window.sessionStorage.setItem(SAVED_ANIMATION_KEY, "threefold-veil");
    page.show();
    await page.settle();
    expect(gpuProbe, "first WebGL choice").toHaveBeenCalledOnce();
    const next = await page.press("ArrowRight");
    await page.settle();
    expect(next.id).toBe("striated-current");
    expect(next.runner).toBe("webgl2");
    expect(gpuProbe, "kept probe is not repeated").toHaveBeenCalledOnce();
  });

  test("does not probe a 2D choice or a caller-named WebGL choice", async () => {
    const page = await openPage(MASKED);
    window.sessionStorage.setItem(SAVED_ANIMATION_KEY, "radial-ribbons");
    page.show();
    await page.settle();
    expect(gpuProbe, "2D choice").not.toHaveBeenCalled();
    page.close();
    page.show("sixfold-vortex");
    await page.settle();
    expect(gpuProbe, "caller-named choice").not.toHaveBeenCalled();
  });

  test("probes WebGL reached by an arrow after a 2D start", async () => {
    gpuProbe.mockResolvedValue(slow);
    const page = await openPage(MASKED);
    window.sessionStorage.setItem(SAVED_ANIMATION_KEY, "radial-ribbons");
    page.show();
    await page.settle();
    expect(gpuProbe, "initial 2D choice").not.toHaveBeenCalled();
    await page.press("ArrowRight");
    await page.settle();
    expect(gpuProbe, "later WebGL choice").toHaveBeenCalledOnce();
    expect(asked.slice(-2), "WebGL draw then 2D swap").toEqual(["webgl2", "2d"]);
    expect(page.shown().id, "persisted next 2D choice").toBe("concentric-pulse");
    expect(window.sessionStorage.getItem(SAVED_ANIMATION_KEY), "swap persisted").toBe("concentric-pulse");
    expect(page.shown().runner).toBe("2d");
  });

  test("an empty result retries the same shown WebGL choice", async () => {
    let finishFirst: ((probe: { windowMs: number; callbackCount: number; frames: [] }) => void) | undefined;
    gpuProbe.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
    gpuProbe.mockImplementationOnce(() => new Promise(() => {}));
    const page = await openPage(MASKED);
    window.sessionStorage.setItem(SAVED_ANIMATION_KEY, "threefold-veil");
    page.show();
    expect(gpuProbe, "first probe").toHaveBeenCalledOnce();
    const canvas = document.querySelector(".welcome canvas");
    finishFirst?.({ windowMs: 1500, callbackCount: 0, frames: [] });
    await page.settle();
    await page.settle();
    expect(page.shown().id, "same choice remains shown").toBe("threefold-veil");
    expect(gpuProbe, "same choice is retried").toHaveBeenCalledTimes(2);
    expect(gpuProbe.mock.calls[1]?.[0], "shown canvas is retried").toBe(canvas);
  });
});
