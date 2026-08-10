// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  canvasCssNumber,
  canvasCssRgb,
  canvasCssValue,
  runCanvasAnimation,
  runWebgl2Animation,
  runWebglAnimation,
} from "./canvasAnimation";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("canvas animation lifecycle", () => {
  test("sizes once, schedules frames, and releases browser resources", () => {
    const host = document.createElement("div");
    host.style.setProperty("--test-value", " 1.25 ");
    const canvas = document.createElement("canvas");
    host.append(canvas);
    document.body.append(host);
    Object.defineProperties(canvas, {
      clientWidth: { configurable: true, value: 320 },
      clientHeight: { configurable: true, value: 180 },
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 3,
    });

    const setTransform = vi.fn();
    vi.spyOn(canvas, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      setTransform,
    } as unknown as CanvasRenderingContext2D);
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = observe;
        disconnect = disconnect;
      },
    );
    const requestFrame = vi.fn(() => 17);
    const cancelFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);

    const resize = vi.fn();
    const frame = vi.fn();
    const cleanup = runCanvasAnimation(canvas, () => ({
      resize,
      frame,
      reducedMotion: vi.fn(),
    }));

    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(360);
    expect(setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
    expect(resize).toHaveBeenCalledWith(
      320,
      180,
      false,
      expect.any(Number),
    );
    expect(observe).toHaveBeenCalledWith(canvas);
    expect(requestFrame).toHaveBeenCalledOnce();
    expect(canvasCssValue(canvas, "--test-value", "0")).toBe("1.25");
    expect(canvasCssNumber(canvas, "--test-value", 0)).toBe(1.25);

    cleanup?.();

    expect(cancelFrame).toHaveBeenCalledWith(17);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  test("scales the frame clock by the host speed variable", () => {
    const host = document.createElement("div");
    host.style.setProperty("--canvas-animation-speed", "4");
    const canvas = document.createElement("canvas");
    host.append(canvas);
    document.body.append(host);
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    vi.spyOn(canvas, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    const rafQueue: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => rafQueue.push(callback)),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const frame = vi.fn();
    const cleanup = runCanvasAnimation(canvas, () => ({
      resize: vi.fn(),
      frame,
      reducedMotion: vi.fn(),
    }));

    rafQueue.shift()?.(1000);
    expect(frame).toHaveBeenLastCalledWith(expect.closeTo((1000 / 24) * 4, 3));
    rafQueue.shift()?.(1100);
    expect(frame).toHaveBeenLastCalledWith(
      expect.closeTo((1000 / 24) * 4 + 400, 3),
    );

    cleanup?.();
  });

  test("retries a transiently null 2d context instead of staying blank", () => {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    const realContext = {
      clearRect: vi.fn(),
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    const getContext = vi
      .spyOn(canvas, "getContext")
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValue(realContext);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    const rafQueue: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => rafQueue.push(callback)),
    );
    const cancelFrame = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);

    const resize = vi.fn();
    const cleanup = runCanvasAnimation(canvas, () => ({
      resize,
      frame: vi.fn(),
      reducedMotion: vi.fn(),
    }));

    expect(getContext).toHaveBeenCalledTimes(1);
    expect(resize).not.toHaveBeenCalled();

    rafQueue.shift()?.(0);
    expect(resize).not.toHaveBeenCalled();

    rafQueue.shift()?.(0);
    expect(getContext).toHaveBeenCalledTimes(3);
    expect(resize).toHaveBeenCalledOnce();

    cleanup?.();
  });

  test("gives up a pending context retry on cleanup", () => {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    vi.spyOn(canvas, "getContext").mockReturnValue(null);
    const rafIds: number[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => {
        rafIds.push(rafIds.length + 1);
        return rafIds.length;
      }),
    );
    const cancelFrame = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);

    const cleanup = runCanvasAnimation(canvas, () => ({
      resize: vi.fn(),
      frame: vi.fn(),
      reducedMotion: vi.fn(),
    }));
    cleanup?.();

    expect(cancelFrame).toHaveBeenCalledWith(1);
  });

  test("stops frames while the canvas is off screen and resumes in view", () => {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    vi.spyOn(canvas, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    let intersect: (entries: { isIntersecting: boolean }[]) => void = () => {};
    const ioObserve = vi.fn();
    const ioDisconnect = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: typeof intersect) {
          intersect = callback;
        }
        observe = ioObserve;
        disconnect = ioDisconnect;
      },
    );
    let frameId = 0;
    const requestFrame = vi.fn(() => ++frameId);
    const cancelFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);

    const start = vi.fn();
    const cleanup = runCanvasAnimation(canvas, () => ({
      resize: vi.fn(),
      frame: vi.fn(),
      reducedMotion: vi.fn(),
      start,
    }));

    expect(ioObserve).toHaveBeenCalledWith(canvas);
    expect(requestFrame).toHaveBeenCalledTimes(1);

    intersect([{ isIntersecting: false }]);
    expect(cancelFrame).toHaveBeenCalledWith(1);

    intersect([{ isIntersecting: true }]);
    expect(requestFrame).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(2);

    cleanup?.();
    expect(ioDisconnect).toHaveBeenCalledOnce();
  });

  test("caps WebGL pixels and destroys renderer resources", () => {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    Object.defineProperties(canvas, {
      clientWidth: { configurable: true, value: 400 },
      clientHeight: { configurable: true, value: 400 },
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 2,
    });

    const viewport = vi.fn();
    vi.spyOn(canvas, "getContext").mockReturnValue({
      createShader: vi.fn(),
      viewport,
    } as unknown as WebGLRenderingContext);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 23));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const destroy = vi.fn();
    const cleanup = runWebglAnimation(
      canvas,
      () => ({
        resize: vi.fn(),
        frame: vi.fn(),
        reducedMotion: vi.fn(),
        destroy,
      }),
      { maxDpr: 2, maxPixels: 160_000 },
    );

    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(400);
    expect(viewport).toHaveBeenCalledWith(0, 0, 400, 400);

    cleanup();
    expect(destroy).toHaveBeenCalledOnce();
  });

  test("requests WebGL2 for GLSL ES 3 shaders", () => {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const getContext = vi.spyOn(canvas, "getContext").mockReturnValue(null);
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 31));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const cleanup = runWebgl2Animation(canvas, () => null);

    expect(getContext).toHaveBeenCalledWith("webgl2", expect.any(Object));
    cleanup();
  });

  test("reads rgb theme variables as normalized WebGL channels", () => {
    const host = document.createElement("div");
    host.style.setProperty("--test-rgb", " 218, 218, 218 ");
    const canvas = document.createElement("canvas");
    host.append(canvas);
    document.body.append(host);

    expect(canvasCssRgb(canvas, "--test-rgb", "0, 0, 0")).toEqual([
      218 / 255,
      218 / 255,
      218 / 255,
    ]);
    expect(canvasCssRgb(canvas, "--missing-rgb", "28, 28, 30")).toEqual([
      28 / 255,
      28 / 255,
      30 / 255,
    ]);
  });
});
