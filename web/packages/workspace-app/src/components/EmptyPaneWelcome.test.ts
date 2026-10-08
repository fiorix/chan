// @vitest-environment jsdom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import { recordingContext2d, type CanvasOp } from "../__tests__/canvas";
import EmptyPaneWelcome from "./EmptyPaneWelcome.svelte";
import type { EmptyPaneAnimationId } from "./emptyPaneAnimations";

const START_DELAY_MS = 2000;
const SAVED_ANIMATION_KEY = "chan.empty-pane-animation";

let mounted: Record<string, unknown> | null = null;

afterEach(() => {
  if (mounted) unmount(mounted);
  mounted = null;
  document.body.innerHTML = "";
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("EmptyPaneWelcome animation names", () => {
  test("handles animation keys only on its focused empty-pane surface", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const target = document.createElement("div");
    document.body.append(target);
    mounted = mount(EmptyPaneWelcome, {
      target,
      props: { animation: "sixfold-vortex" },
    });
    await tick();

    const welcome = target.querySelector<HTMLElement>(".welcome");
    expect(welcome).not.toBeNull();
    expect(document.activeElement).toBe(welcome);
    vi.advanceTimersByTime(START_DELAY_MS);
    flushSync();

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        cancelable: true,
      }),
    );
    await tick();
    expect(target.querySelector(".animation-name-flash")).toBeNull();
    expect(window.sessionStorage.getItem("chan.empty-pane-animation")).toBeNull();

    welcome?.focus();
    const appShortcut = new KeyboardEvent("keydown", {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    welcome?.dispatchEvent(appShortcut);
    expect(appShortcut.defaultPrevented).toBe(false);

    const markBeforeSwitch = target.querySelector(".welcome-mark");
    expect(markBeforeSwitch).not.toBeNull();
    welcome?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      }),
    );
    await tick();

    const flash = target.querySelector<HTMLElement>(
      ".animation-name-flash",
    );
    expect(flash?.textContent?.trim()).toBe("Radial Ribbons");
    expect(window.sessionStorage.getItem("chan.empty-pane-animation")).toBe(
      "radial-ribbons",
    );
    const markAfterSwitch = target.querySelector(".welcome-mark");
    expect(markAfterSwitch).not.toBeNull();
    expect(markAfterSwitch).not.toBe(markBeforeSwitch);

    welcome?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowUp",
        bubbles: true,
        cancelable: true,
      }),
    );
    await tick();
    expect(
      target
        .querySelector<HTMLElement>(".animation-name-flash")
        ?.textContent?.trim(),
    ).toBe("Speed 1.4x");
    expect(welcome?.getAttribute("style")).toContain(
      "--canvas-animation-speed: 1.4",
    );
    expect(window.sessionStorage.getItem("chan.empty-pane-animation")).toBe(
      "radial-ribbons",
    );

    const end = new Event("animationend") as AnimationEvent;
    Object.defineProperty(end, "animationName", {
      configurable: true,
      value: "svelte-test-empty-pane-animation-name-flash",
    });
    flash?.dispatchEvent(end);
    await tick();

    expect(target.querySelector(".animation-name-flash")).toBeNull();
  });
});

interface Stage {
  target: HTMLElement;
  ops: CanvasOp[];
  getContext: ReturnType<typeof vi.spyOn>;
  requestFrame: ReturnType<typeof vi.fn>;
  cancelFrame: ReturnType<typeof vi.fn>;
  intersect(isIntersecting: boolean): void;
  setHidden(hidden: boolean): void;
}

// A page the real runner can draw on: a controlled clock for timers, a
// recorded 2D context, and frame, intersection and visibility under the
// test's hand. No WebGL context exists here.
function stage(): Stage {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { ctx, ops } = recordingContext2d();
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(((kind: string) =>
      kind === "2d" ? ctx : null) as never);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  let onIntersection: (entries: { isIntersecting: boolean }[]) => void =
    () => {};
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: typeof onIntersection) {
        onIntersection = callback;
      }
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  let frameId = 0;
  const requestFrame = vi.fn(() => ++frameId);
  const cancelFrame = vi.fn();
  vi.stubGlobal("requestAnimationFrame", requestFrame);
  vi.stubGlobal("cancelAnimationFrame", cancelFrame);
  const setHidden = (hidden: boolean): void => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: hidden,
    });
  };
  setHidden(false);
  const target = document.createElement("div");
  document.body.append(target);
  return {
    target,
    ops,
    getContext,
    requestFrame,
    cancelFrame,
    intersect: (isIntersecting) => onIntersection([{ isIntersecting }]),
    setHidden,
  };
}

function show(target: HTMLElement, animation?: EmptyPaneAnimationId): void {
  mounted = mount(EmptyPaneWelcome, {
    target,
    props: animation ? { animation } : {},
  });
  flushSync();
}

function wait(ms: number): void {
  vi.advanceTimersByTime(ms);
  flushSync();
}

describe("EmptyPaneWelcome start delay", () => {
  test("draws nothing before the start delay and starts after it", () => {
    const page = stage();
    show(page.target, "radial-ribbons");

    for (const elapsed of [0, START_DELAY_MS - 1]) {
      if (elapsed > 0) wait(elapsed);
      expect(
        page.target.querySelector("canvas"),
        `canvas at ${elapsed} ms`,
      ).toBeNull();
      expect(
        page.target.querySelector(".welcome-mark"),
        `mark at ${elapsed} ms`,
      ).toBeNull();
      expect(page.getContext, `context at ${elapsed} ms`).not.toHaveBeenCalled();
      expect(page.requestFrame, `frame at ${elapsed} ms`).not.toHaveBeenCalled();
      expect(page.ops.length, `drawing at ${elapsed} ms`).toBe(0);
    }
    expect(
      page.target.querySelector(".welcome"),
      "the surface before the start",
    ).not.toBeNull();

    wait(1);

    expect(
      page.target.querySelector("canvas"),
      "canvas at the start",
    ).not.toBeNull();
    expect(
      page.target.querySelector(".welcome-mark"),
      "mark at the start",
    ).not.toBeNull();
    expect(page.getContext, "context at the start").toHaveBeenCalledWith("2d");
    expect(page.ops.length, "drawing at the start").toBeGreaterThan(0);
    expect(page.requestFrame, "frame at the start").toHaveBeenCalledTimes(1);
  });

  test("chooses and saves no animation before the start delay", () => {
    const page = stage();
    vi.spyOn(Math, "random").mockReturnValue(0);
    show(page.target);

    wait(START_DELAY_MS - 1);
    expect(
      window.sessionStorage.getItem(SAVED_ANIMATION_KEY),
      "saved choice before the start",
    ).toBeNull();
    expect(page.getContext, "context before the start").not.toHaveBeenCalled();

    wait(1);
    expect(
      window.sessionStorage.getItem(SAVED_ANIMATION_KEY),
      "saved choice at the start",
    ).not.toBeNull();
    expect(
      page.target.querySelector("canvas"),
      "canvas at the start",
    ).not.toBeNull();
  });

  test("a welcome removed within the start delay never draws", () => {
    const page = stage();
    show(page.target, "radial-ribbons");
    wait(START_DELAY_MS / 2);

    if (mounted) unmount(mounted);
    mounted = null;
    flushSync();
    wait(START_DELAY_MS * 5);

    expect(page.getContext, "context after removal").not.toHaveBeenCalled();
    expect(page.requestFrame, "frame after removal").not.toHaveBeenCalled();
    expect(page.ops.length, "drawing after removal").toBe(0);
    expect(vi.getTimerCount(), "timers left after removal").toBe(0);
  });

  test("resumes at once after being out of view or hidden", () => {
    const page = stage();
    show(page.target, "radial-ribbons");
    wait(START_DELAY_MS);
    expect(page.requestFrame, "frame at the start").toHaveBeenCalledTimes(1);

    page.intersect(false);
    expect(page.cancelFrame, "stop out of view").toHaveBeenCalledTimes(1);
    page.intersect(true);
    expect(page.requestFrame, "resume in view").toHaveBeenCalledTimes(2);

    page.setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(page.cancelFrame, "stop while hidden").toHaveBeenCalledTimes(2);
    page.setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(page.requestFrame, "resume when shown").toHaveBeenCalledTimes(3);

    expect(vi.getTimerCount(), "timers pending after the start").toBe(0);
  });

  test("under reduced motion the one still frame also waits for the start delay", () => {
    const page = stage();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    show(page.target, "radial-ribbons");

    wait(START_DELAY_MS - 1);
    expect(page.ops.length, "still frame before the start").toBe(0);

    wait(1);
    expect(page.ops.length, "still frame at the start").toBeGreaterThan(0);
    expect(
      page.requestFrame,
      "frame loop under reduced motion",
    ).not.toHaveBeenCalled();
  });

  test("the animation keys do nothing before the start", async () => {
    const page = stage();
    show(page.target, "sixfold-vortex");
    const welcome = page.target.querySelector<HTMLElement>(".welcome");
    welcome?.focus();
    const press = async (): Promise<void> => {
      welcome?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }),
      );
      await tick();
    };

    await press();
    expect(
      page.target.querySelector(".animation-name-flash"),
      "name flash before the start",
    ).toBeNull();
    expect(
      window.sessionStorage.getItem(SAVED_ANIMATION_KEY),
      "saved choice before the start",
    ).toBeNull();

    wait(START_DELAY_MS);
    await press();
    expect(
      page.target
        .querySelector<HTMLElement>(".animation-name-flash")
        ?.textContent?.trim(),
      "name flash after the start",
    ).toBe("Radial Ribbons");
  });
});
