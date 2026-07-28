// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  canvasCssNumber,
  canvasCssValue,
  runCanvasAnimation,
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
});
