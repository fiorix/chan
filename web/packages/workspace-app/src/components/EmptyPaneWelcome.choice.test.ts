// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import type { AnimationRun } from "../__tests__/canvas";
import {
  EMPTY_PANE_ANIMATIONS,
  type EmptyPaneAnimationId,
} from "./emptyPaneAnimations";

// The runner each mounted animation asked for, oldest first. Kept here and
// not in the shared canvas fixture: each page below loads the modules again,
// and a recorder inside a reloaded module would not be the one read here.
const asked = vi.hoisted(() => [] as AnimationRun["runner"][]);

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
  };
});

const START_DELAY_MS = 2000;
const SAVED_ANIMATION_KEY = "chan.empty-pane-animation";
const UNMASKED_RENDERER_WEBGL = 0x9246;

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
  document.body.innerHTML = "";
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function webgl2Reporting(renderer: string): unknown {
  return {
    RENDERER: 0x1f01,
    getExtension: (name: string) =>
      name === "WEBGL_debug_renderer_info"
        ? { UNMASKED_RENDERER_WEBGL }
        : name === "WEBGL_lose_context"
          ? { loseContext: () => {} }
          : null,
    getParameter: (name: number) =>
      name === UNMASKED_RENDERER_WEBGL ? renderer : "WebKit WebGL",
  };
}

// A new page: the modules are loaded again, since the page's renderer is
// read once and kept, and a `webgl2` request answers with a context that
// reports `renderer`, or with none for null.
async function openPage(renderer: string | null): Promise<Page> {
  vi.resetModules();
  const svelte = await import("svelte");
  const EmptyPaneWelcome = (await import("./EmptyPaneWelcome.svelte")).default;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(((kind: string) =>
      kind === "webgl2" && renderer !== null
        ? webgl2Reporting(renderer)
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
  const shown = (): Shown => ({
    id: window.sessionStorage.getItem(SAVED_ANIMATION_KEY),
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
  return { getContext, show, wait, close, shown, press, runnerOf };
}

function probes(page: Page): unknown[][] {
  const calls: unknown[][] = page.getContext.mock.calls;
  return calls.filter((call) => call[0] === "webgl2");
}

describe("EmptyPaneWelcome choice on a software WebGL context", () => {
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
    const back = await page.press("ArrowLeft");
    expect(back.runner, "arrow walk backward").toBe("2d");
    expect(back.id, "arrow walk backward").toBe(walked.at(-2));
    page.close();

    // A caller may show an animation outside the choices by name. A step
    // from it lands on its 2D neighbor in catalog order, each way.
    for (const [key, neighbor] of [
      ["ArrowRight", "concentric-pulse"],
      ["ArrowLeft", "radial-ribbons"],
    ] as const) {
      page.show("polar-drift");
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
    expect(page.shown().id, "first choice at 0.999").toBe("eightfold-coil");
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
