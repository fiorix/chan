// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import * as canvasAnimation from "./canvasAnimation";
import { judgeGpuProbe } from "./emptyPaneAnimations";
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
  vi.useRealTimers();
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

describe("GPU frame probe", () => {
  type Probe = {
    windowMs: number;
    callbackCount: number;
    frames: Array<{ timestampMs: number; costMs: number }>;
  };
  const probeCandidate = (canvasAnimation as Record<string, unknown>)[
    "probeGpuFrames"
  ];
  const probeGpuFrames = probeCandidate as (
    canvas: HTMLCanvasElement,
    windowMs: number,
  ) => Promise<Probe>;

  function frameClock(finishCostMs: number) {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    Object.defineProperties(canvas, {
      clientWidth: { configurable: true, value: 320 },
      clientHeight: { configurable: true, value: 180 },
    });
    Object.defineProperty(document, "hidden", {
      configurable: true, value: false,
    });
    let nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const finish = vi.fn(() => { nowMs += finishCostMs; });
    vi.spyOn(canvas, "getContext").mockReturnValue({
      createShader: vi.fn(),
      viewport: vi.fn(),
      finish,
    } as unknown as WebGL2RenderingContext);
    const pending = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      pending.set(++nextId, callback);
      return nextId;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => pending.delete(id)));
    const cleanup = runWebgl2Animation(canvas, () => ({
      resize: vi.fn(),
      frame: vi.fn(),
      reducedMotion: vi.fn(),
    }));
    const draw = (elapsedMs: number): void => {
      nowMs += elapsedMs;
      const next = pending.entries().next().value;
      expect(next, "scheduled frame").toBeDefined();
      const [id, callback] = next!;
      pending.delete(id);
      callback(nowMs);
    };
    return { canvas, draw, finish, cleanup };
  }

  test("drops the first draw, records costs, and stops finishing at the window", async () => {
    expect(probeCandidate, "GPU probe is exported").toBeTypeOf("function");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { canvas, draw, finish, cleanup } = frameClock(25);
    const reading = probeGpuFrames(canvas, 150);
    draw(50);
    draw(50);
    draw(50);
    expect(finish).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(149);
    let settled = false;
    void reading.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled, "probe before its window ends").toBe(false);
    vi.advanceTimersByTime(1);
    expect(await reading).toEqual({
      windowMs: 150,
      callbackCount: 2,
      frames: [
        { timestampMs: 125, costMs: 25 },
        { timestampMs: 200, costMs: 25 },
      ],
    });
    draw(50);
    expect(finish, "unarmed loop").toHaveBeenCalledTimes(3);
    cleanup();
  });

  test("slow finish advances the frame clock and lowers the drawn rate", async () => {
    expect(probeCandidate, "GPU probe is exported").toBeTypeOf("function");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { canvas, draw, cleanup } = frameClock(180);
    const reading = probeGpuFrames(canvas, 1000);
    draw(50);
    for (let frame = 0; frame < 5; frame += 1) draw(16);
    vi.advanceTimersByTime(1000);
    const probe = await reading;
    expect(probe.frames.length, "draws after warmup").toBeGreaterThan(0);
    expect(probe.frames.length / (probe.windowMs / 1000)).toBeLessThan(16);
    expect(probe.callbackCount / (probe.windowMs / 1000)).toBeLessThan(16);
    expect(probe.frames[1].timestampMs - probe.frames[0].timestampMs).toBeGreaterThanOrEqual(180);
    cleanup();
  });

  test("a probe waits for its first draw", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { canvas, draw, finish, cleanup } = frameClock(1);
    const reading = probeGpuFrames(canvas, 1500);
    let settled = false;
    void reading.then(() => { settled = true; });
    vi.advanceTimersByTime(10000);
    await Promise.resolve();
    expect(settled, "undrawn probe after ten seconds").toBe(false);
    draw(50);
    draw(50);
    vi.advanceTimersByTime(1500);
    expect(await reading).toEqual({
      windowMs: 1500,
      callbackCount: 1,
      frames: [{ timestampMs: 101, costMs: 1 }],
    });
    expect(finish).toHaveBeenCalledTimes(2);
    cleanup();
  });

  test("teardown before a draw ends the probe empty", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { canvas, finish, cleanup } = frameClock(1);
    const reading = probeGpuFrames(canvas, 1500);
    let result: Probe | undefined;
    void reading.then((probe) => { result = probe; });
    cleanup();
    await Promise.resolve();
    expect(result, "runner cleanup resolves an undrawn probe").toEqual({
      windowMs: 1500,
      callbackCount: 0,
      frames: [],
    });
    expect(finish).not.toHaveBeenCalled();
  });

  test.each([30, 50, 60])("%i Hz cheap callbacks keep a 24 fps WebGL choice", async (hz) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { canvas, draw, cleanup } = frameClock(1);
    const reading = probeGpuFrames(canvas, 1500);
    for (let tick = 0; tick < hz * 3; tick += 1) {
      vi.advanceTimersByTime(1000 / hz);
      draw(1000 / hz);
    }
    const probe = await reading;
    expect(judgeGpuProbe(probe), `${hz} Hz cadence`).toBe("keep");
    expect(probe.callbackCount / (probe.windowMs / 1000), "callback rate").toBeGreaterThanOrEqual(16);
    cleanup();
  });

  function cadenceClock(hz: number, finishCostMs = 1) {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    Object.defineProperties(canvas, {
      clientWidth: { configurable: true, value: 320 },
      clientHeight: { configurable: true, value: 180 },
    });
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    let nowMs = 0;
    let timerClockMs = 0;
    let tick = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const finish = vi.fn(() => { nowMs += finishCostMs; });
    vi.spyOn(canvas, "getContext").mockReturnValue({
      createShader: vi.fn(), viewport: vi.fn(), finish,
    } as unknown as WebGL2RenderingContext);
    const pending = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      pending.set(++nextId, callback);
      return nextId;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => pending.delete(id)));
    const cleanup = runWebgl2Animation(canvas, () => ({
      resize: vi.fn(), frame: vi.fn(), reducedMotion: vi.fn(),
    }));
    const vsync = (): void => {
      tick += 1;
      nowMs = Math.max(nowMs, Math.round((tick * 1000) / hz * 10) / 10);
      vi.advanceTimersByTime(nowMs - timerClockMs);
      timerClockMs = nowMs;
      const next = pending.entries().next().value;
      if (!next) return;
      const [id, callback] = next;
      pending.delete(id);
      callback(nowMs);
    };
    const hide = (): void => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    const loseContext = (): void => {
      canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    };
    return { canvas, vsync, cleanup, hide, loseContext, pendingCount: () => pending.size };
  }

  test("teardown of a measured window resolves empty", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { canvas, vsync, cleanup } = cadenceClock(60);
    const reading = probeGpuFrames(canvas, 1500);
    for (let index = 0; index < 18; index += 1) vsync();
    cleanup();
    expect(await reading, "teardown at 300 ms").toEqual({
      windowMs: 1500, callbackCount: 0, frames: [],
    });
  });

  test("a hidden page ends a measured window empty", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { canvas, vsync, cleanup, hide, pendingCount } = cadenceClock(60);
    const reading = probeGpuFrames(canvas, 1500);
    for (let index = 0; index < 18; index += 1) vsync();
    hide();
    expect(pendingCount(), "hidden loop has no callback").toBe(0);
    vi.advanceTimersByTime(3000);
    expect(await reading, "hidden at 300 ms").toEqual({
      windowMs: 1500, callbackCount: 0, frames: [],
    });
    cleanup();
  });

  test("context loss ends a measured window empty", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { canvas, vsync, cleanup, loseContext } = cadenceClock(60);
    const reading = probeGpuFrames(canvas, 1500);
    for (let index = 0; index < 18; index += 1) vsync();
    loseContext();
    vi.advanceTimersByTime(3000);
    expect(await reading, "context lost at 300 ms").toEqual({
      windowMs: 1500, callbackCount: 0, frames: [],
    });
    cleanup();
  });

  test("a waiting probe stays pending while hidden", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { canvas, cleanup, hide } = cadenceClock(60);
    const reading = probeGpuFrames(canvas, 1500);
    let settled = false;
    void reading.then(() => { settled = true; });
    hide();
    vi.advanceTimersByTime(3000);
    await Promise.resolve();
    expect(settled, "hidden before the first draw").toBe(false);
    cleanup();
    expect(await reading).toEqual({ windowMs: 1500, callbackCount: 0, frames: [] });
  });

  test("callbacks and finish beyond the window are excluded while its timer waits", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { canvas, draw, finish, cleanup } = frameClock(1);
    const reading = probeGpuFrames(canvas, 150);
    draw(50);
    draw(50);
    draw(50);
    draw(200);
    vi.advanceTimersByTime(150);
    const probe = await reading;
    expect(probe.callbackCount, "callbacks inside the window").toBe(2);
    expect(probe.frames).toHaveLength(2);
    expect(finish, "finish inside the window").toHaveBeenCalledTimes(3);
    cleanup();
  });

  test("a complete slow window still swaps", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { canvas, vsync, cleanup } = cadenceClock(60, 180);
    const reading = probeGpuFrames(canvas, 1500);
    for (let index = 0; index < 40; index += 1) vsync();
    expect(judgeGpuProbe(await reading), "complete slow window").toBe("swap");
    cleanup();
  });
});
