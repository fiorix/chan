import { afterEach, describe, expect, test, vi } from "vitest";
import SpiralFountain from "./SpiralFountain.svelte";
import {
  buildSpiralFountainDiscs,
  SPIRAL_FOUNTAIN_DISC_COUNT,
  SPIRAL_FOUNTAIN_PERIOD,
  type SpiralFountainFrame,
} from "./spiralFountain";
import { recordingWebgl2, startAnimation, stopAnimations, uniformsSet } from "../__tests__/canvas";

const renderer = vi.hoisted(() => ({
  resetSurface: vi.fn(),
  draw: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./spiralFountain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./spiralFountain")>()),
  createSpiralFountainRenderer: () => renderer,
}));

afterEach(() => {
  stopAnimations();
  renderer.resetSurface.mockClear();
  renderer.draw.mockClear();
});

function frames(): SpiralFountainFrame[] {
  return renderer.draw.mock.calls.map(([frame]) => frame as SpiralFountainFrame);
}

function discs(time: number, reach: number): number[][] {
  const out = new Float32Array(SPIRAL_FOUNTAIN_DISC_COUNT * 3);
  const count = buildSpiralFountainDiscs(time, reach, out);
  return Array.from({ length: count }, (_, index) =>
    Array.from(out.subarray(index * 3, index * 3 + 3)),
  );
}

describe("buildSpiralFountainDiscs", () => {
  test("releases three discs a source frame, each flying three units a frame", () => {
    // One frame in, disc 0 is three units out, past this reach; discs 1 and
    // 2 follow it and disc 3 is still on the center.
    const early = discs(1, 2.5);
    expect(early.map(([x, y]) => Math.hypot(x!, y!))).toEqual([
      expect.closeTo(2, 5),
      expect.closeTo(1, 5),
      expect.closeTo(0, 5),
    ]);

    // Ten frames in, disc 0 is 30 units out along the angle the sketch
    // gives index 0, which is zero.
    const [x, y] = discs(10, 30)[0]!;
    expect(x).toBeCloseTo(30, 4);
    expect(y).toBeCloseTo(0, 4);
  });

  test("sends disc c along c squared over 9000 plus c thirds of a turn", () => {
    // Disc 3 leaves at frame 1; at frame 11 it is 30 units out.
    const angle = 9 / 9000 + Math.PI * 2;
    const disc = discs(11, 30.5).find(
      ([x, y]) => Math.abs(Math.hypot(x!, y!) - 30) < 1e-3,
    )!;

    expect(disc[0]).toBeCloseTo(30 * Math.cos(angle), 3);
    expect(disc[1]).toBeCloseTo(30 * Math.sin(angle), 3);
  });

  test("fills each disc with the sketch's grey as a share of its outline's", () => {
    // 40 + 30 sin(0 / 90) over the outline's 90.
    expect(discs(10, 30)[0]![2]).toBeCloseTo(40 / 90, 6);
    const levels = discs(0, 1e9).map(([, , level]) => level!);
    expect(Math.min(...levels)).toBeGreaterThan(10 / 90 - 1e-3);
    expect(Math.max(...levels)).toBeLessThan(70 / 90 + 1e-3);
  });

  test("leaves out the discs beyond its reach and keeps the sketch's order", () => {
    const out = new Float32Array(SPIRAL_FOUNTAIN_DISC_COUNT * 3);

    // Thirty units of reach is ten frames of flight: thirty-one discs.
    expect(buildSpiralFountainDiscs(100, 30, out)).toBe(31);
    // Index order: the first written is the oldest and so the farthest.
    expect(Math.hypot(out[0]!, out[1]!)).toBeCloseTo(30, 4);
    expect(Math.hypot(out[90]!, out[91]!)).toBeCloseTo(0, 4);
  });

  test("starts over when the last disc has left, so it never runs dry", () => {
    expect(SPIRAL_FOUNTAIN_PERIOD).toBe(2000);
    expect(discs(10 + SPIRAL_FOUNTAIN_PERIOD, 30)).toEqual(discs(10, 30));
    // Mid-stream from the first frame: the reach is full at time zero.
    expect(discs(0, 300)).toHaveLength(301);
  });
});

describe("Spiral Fountain", () => {
  test("renders through the WebGL2 runner onto a surface cleared to its background", () => {
    const { run, callbacks } = startAnimation(SpiralFountain, {});
    run.canvas.parentElement!.style.setProperty(
      "--spiral-fountain-background-rgb",
      "255, 0, 51",
    );
    callbacks.resize(800, 600, false, 0);

    expect(run.runner).toBe("webgl2");
    expect(renderer.resetSurface).toHaveBeenLastCalledWith([1, 0, 0.2]);
    expect(frames().at(-1)?.backgroundColor).toEqual([1, 0, 0.2]);
  });

  test("runs the sketch at 15 source frames a second, stamping each one in between", () => {
    const { callbacks } = startAnimation(SpiralFountain, {});
    callbacks.resize(800, 600, false, 0);
    renderer.draw.mockClear();
    callbacks.frame(200);

    const [frame] = frames();
    expect(frame!.times).toEqual([
      expect.closeTo(1, 9),
      expect.closeTo(2, 9),
      expect.closeTo(3, 9),
    ]);
    // Three frames of the sketch's 9 in 255 background.
    expect(frame!.fade).toBeCloseTo(1 - (1 - 9 / 255) ** 3, 9);
  });

  test("stamps at most eight frames after a stall, ending on the present", () => {
    const { callbacks } = startAnimation(SpiralFountain, {});
    callbacks.resize(800, 600, false, 0);
    renderer.draw.mockClear();
    callbacks.frame(2000);

    const [frame] = frames();
    expect(frame!.times).toHaveLength(8);
    expect(frame!.times[0]).toBeCloseTo(23, 9);
    expect(frame!.times.at(-1)).toBeCloseTo(30, 9);
  });

  test("does not fade or smear the first paint after it resumes", () => {
    const { callbacks } = startAnimation(SpiralFountain, {});
    callbacks.resize(800, 600, false, 0);
    callbacks.frame(100);
    callbacks.start!();
    renderer.draw.mockClear();
    callbacks.frame(9000);

    const [frame] = frames();
    expect(frame!.times).toEqual([expect.closeTo(135, 9)]);
    expect(frame!.fade).toBe(0);
  });

  test("clears its trails when the pane's background changes", () => {
    const { run, callbacks } = startAnimation(SpiralFountain, {});
    callbacks.resize(800, 600, false, 0);
    renderer.resetSurface.mockClear();
    callbacks.frame(100);
    expect(renderer.resetSurface).not.toHaveBeenCalled();

    run.canvas.parentElement!.style.setProperty(
      "--spiral-fountain-background-rgb",
      "255, 255, 255",
    );
    callbacks.frame(200);
    expect(renderer.resetSurface).toHaveBeenCalledExactlyOnceWith([1, 1, 1]);
  });

  test("holds one still with its trails under reduced motion", () => {
    const { callbacks } = startAnimation(SpiralFountain, {});
    renderer.draw.mockClear();
    callbacks.reducedMotion();

    const times = frames().map((frame) => frame.times);
    expect(times).toHaveLength(48);
    expect(times[0]).toEqual([606]);
    expect(times.at(-1)).toEqual([700]);

    // The same still at any animation time.
    renderer.draw.mockClear();
    callbacks.resize(800, 600, true, 4000);
    expect(frames().at(-1)?.times).toEqual([700]);
  });

  test("draws with the field its theme tokens name", () => {
    const { run, callbacks } = startAnimation(SpiralFountain, {});
    const host = run.canvas.parentElement!;
    host.style.setProperty("--spiral-fountain-field-scale", "2");
    host.style.setProperty("--spiral-fountain-tone", "0.5");
    host.style.setProperty("--spiral-fountain-opacity", "0.25");
    callbacks.resize(800, 600, false, 0);

    expect(frames().at(-1)).toMatchObject({
      fieldScale: 2,
      tone: 0.5,
      opacity: 0.25,
    });
  });

  test("fades the kept surface once, stamps every time onto it, and presents it", async () => {
    const { createSpiralFountainRenderer } =
      await vi.importActual<typeof import("./spiralFountain")>("./spiralFountain");
    const { gl, calls } = recordingWebgl2();

    createSpiralFountainRenderer(gl).draw({
      times: [10, 11],
      fade: 0.1,
      fieldScale: 2,
      backgroundColor: [0, 0, 0],
      tone: 0.5,
      opacity: 0.25,
    });

    // The recording context's drawing buffer is 100 by 100.
    const draws = calls
      .filter(({ op }) => op === "drawArrays")
      .map(({ args }) => args[0]);
    expect(draws).toEqual(["TRIANGLES", "POINTS", "POINTS", "TRIANGLES"]);
    expect(uniformsSet(calls, "uFade")).toEqual([[0.1], [0]]);
    const [[scale]] = uniformsSet(calls, "uScale") as number[][];
    expect(scale).toBeCloseTo(200 / 999, 9);
    const [[radius]] = uniformsSet(calls, "uRadius") as number[][];
    expect(radius).toBeCloseTo((15 * 200) / 999, 9);
    expect(uniformsSet(calls, "uTone")).toEqual([[0.5]]);
    expect(uniformsSet(calls, "uOpacity")).toEqual([[0.25]]);
    // Two trail surfaces, made once.
    expect(calls.filter(({ op }) => op === "createFramebuffer")).toHaveLength(2);
  });
});
