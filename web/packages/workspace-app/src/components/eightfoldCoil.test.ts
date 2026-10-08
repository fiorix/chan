import { afterEach, describe, expect, test, vi } from "vitest";
import EightfoldCoil from "./EightfoldCoil.svelte";
import {
  buildEightfoldCoilSpokes,
  createEightfoldCoilSegments,
  EIGHTFOLD_COIL_PERIOD_SECONDS,
  EIGHTFOLD_COIL_RUNS,
  EIGHTFOLD_COIL_SEGMENT_COUNT,
  eightfoldCoilTwist,
} from "./eightfoldCoil";
import { startAnimation, stopAnimations } from "../__tests__/canvas";
import type { LineSegmentFrame } from "./lineSegments";

const renderer = vi.hoisted(() => ({ draw: vi.fn(), destroy: vi.fn() }));

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./lineSegments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lineSegments")>()),
  createLineSegmentRenderer: () => renderer,
}));
vi.mock("./eightfoldCoil", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./eightfoldCoil")>();
  return {
    ...actual,
    buildEightfoldCoilSpokes: vi.fn(actual.buildEightfoldCoilSpokes),
  };
});

afterEach(() => {
  stopAnimations();
  renderer.draw.mockClear();
});

// Spokes are numbered clockwise on screen from the one pointing right.
const RIGHT = 0;
const LOWER_RIGHT = 1;
const DOWN = 2;
const LOWER_LEFT = 3;
const LEFT = 4;
const UPPER_LEFT = 5;
const UP = 6;
const UPPER_RIGHT = 7;

const SPOKE_SEGMENTS = 2400;

function degrees(spoke: number, seconds: number): number {
  return (eightfoldCoilTwist(spoke, seconds) * 180) / Math.PI;
}

function segment(segments: Float32Array, index: number): number[] {
  return Array.from(segments.subarray(index * 4, index * 4 + 4));
}

function lastFrame(): LineSegmentFrame {
  return renderer.draw.mock.calls.at(-1)![0] as LineSegmentFrame;
}

function seconds(): number[] {
  return vi.mocked(buildEightfoldCoilSpokes).mock.calls.map(([time]) => time);
}

describe("eightfoldCoilTwist", () => {
  // Expected values are the twist, in degrees, fitted to frames of the
  // video the animation follows, which runs at 30 frames a second.
  test("winds and unwinds each spoke as the video does", () => {
    for (const [frame, twist] of [
      [5, 9.5],
      [30, 297.4],
      [60, 1031.1],
      [120, 2865.2],
      [170, 3642.8],
      [235, 1843.4],
      [280, 235.9],
      [295, 16.3],
      [300, 0],
      [340, 0],
    ] as const) {
      expect(Math.abs(degrees(LEFT, frame / 30) - twist)).toBeLessThan(2.5);
    }
  });

  test("moves the spokes in pairs, half a second apart, a quarter turn clockwise each time", () => {
    // Frame 60 of the video: the four pairs at four stages.
    for (const [pair, twist] of [
      [[LEFT, LOWER_LEFT], 1031.1],
      [[UP, UPPER_LEFT], 624.3],
      [[RIGHT, UPPER_RIGHT], 297.4],
      [[DOWN, LOWER_RIGHT], 79.4],
    ] as const) {
      for (const spoke of pair) {
        expect(Math.abs(degrees(spoke, 2) - twist)).toBeLessThan(2.5);
      }
    }
  });

  test("repeats every eleven and a half seconds, each spoke resting before its next turn", () => {
    expect(EIGHTFOLD_COIL_PERIOD_SECONDS).toBeCloseTo(11.5, 12);
    expect(eightfoldCoilTwist(DOWN, 0.75)).toBe(0);
    expect(eightfoldCoilTwist(DOWN, 2 + 11.5)).toBeCloseTo(
      eightfoldCoilTwist(DOWN, 2),
      9,
    );
    expect(eightfoldCoilTwist(LEFT, -1)).toBe(0);
  });
});

describe("buildEightfoldCoilSpokes", () => {
  test("starts as eight straight spokes from the center through each node to the outer circle", () => {
    const segments = buildEightfoldCoilSpokes(0, createEightfoldCoilSegments());

    // The spoke pointing right: its first segment leaves the center, its
    // middle one arrives at the node a unit out, its last ends two out.
    expect(segment(segments, 0).slice(0, 2)).toEqual([0, 0]);
    const node = segment(segments, 1199);
    expect(node[2]).toBeCloseTo(1, 6);
    expect(node[3]).toBeCloseTo(0, 6);
    const end = segment(segments, 2399);
    expect(end[2]).toBeCloseTo(2, 6);
    expect(end[3]).toBeCloseTo(0, 6);

    // The spoke pointing down the screen.
    const down = segment(segments, DOWN * SPOKE_SEGMENTS + 2399);
    expect(down[2]).toBeCloseTo(0, 6);
    expect(down[3]).toBeCloseTo(2, 6);
  });

  test("turns a spoke about its node, keeping the node and both ends where they were", () => {
    const segments = buildEightfoldCoilSpokes(2, createEightfoldCoilSegments());
    const first = LEFT * SPOKE_SEGMENTS;

    expect(segment(segments, first).slice(0, 2)).toEqual([0, 0]);
    const node = segment(segments, first + 1199);
    expect(node[2]).toBeCloseTo(-1, 6);
    expect(node[3]).toBeCloseTo(0, 6);
    const end = segment(segments, first + 2399);
    expect(end[2]).toBeCloseTo(-2, 6);
    expect(end[3]).toBeCloseTo(0, 6);

    // Halfway from the node to the outer end: half a unit from the node,
    // turned by half the twist, clockwise on screen from pointing left.
    const turn = Math.PI + eightfoldCoilTwist(LEFT, 2) / 2;
    const halfway = segment(segments, first + 1799);
    expect(halfway[2]).toBeCloseTo(-1 + 0.5 * Math.cos(turn), 5);
    expect(halfway[3]).toBeCloseTo(0.5 * Math.sin(turn), 5);
  });

  test("joins each spoke's segments end to end", () => {
    const segments = buildEightfoldCoilSpokes(3, createEightfoldCoilSegments());

    for (const index of [1, 1200, 2399, LEFT * SPOKE_SEGMENTS + 700]) {
      expect(segment(segments, index).slice(0, 2)).toEqual(
        segment(segments, index - 1).slice(2),
      );
    }
  });

  test("leaves the still strokes after the spokes alone: the circles and the node markers", () => {
    const segments = createEightfoldCoilSegments();
    const still = Array.from(segments.subarray(8 * SPOKE_SEGMENTS * 4));
    buildEightfoldCoilSpokes(4, segments);

    expect(Array.from(segments.subarray(8 * SPOKE_SEGMENTS * 4))).toEqual(still);
    // The outer circle comes first, two units out.
    const [x, y] = segment(segments, 8 * SPOKE_SEGMENTS);
    expect(Math.hypot(x!, y!)).toBeCloseTo(2, 6);
    // Every still stroke is a short chord, none left at the origin.
    for (let index = 8 * SPOKE_SEGMENTS; index < EIGHTFOLD_COIL_SEGMENT_COUNT; index += 1) {
      const [fromX, fromY, toX, toY] = segment(segments, index);
      const length = Math.hypot(toX! - fromX!, toY! - fromY!);
      expect(length).toBeGreaterThan(0);
      expect(length).toBeLessThan(0.06);
    }
  });

  test("weights its strokes in runs that cover every segment", () => {
    expect(
      EIGHTFOLD_COIL_RUNS.reduce((sum, run) => sum + run.segmentCount, 0),
    ).toBe(EIGHTFOLD_COIL_SEGMENT_COUNT);
    expect(EIGHTFOLD_COIL_RUNS.map((run) => run.weight)).toEqual([1, 0.45, 0.6, 0.35]);
  });
});

describe("Eightfold Coil", () => {
  test("draws its strokes as weighted lines through the WebGL2 runner, on a multisampled canvas", () => {
    const { run, callbacks } = startAnimation(EightfoldCoil, {});
    callbacks.resize(800, 600, false, 0);

    expect(run.runner).toBe("webgl2");
    expect(run.options).toMatchObject({
      contextAttributes: { antialias: true },
    });
    expect(lastFrame()).toMatchObject({
      segmentCount: EIGHTFOLD_COIL_SEGMENT_COUNT,
      runs: EIGHTFOLD_COIL_RUNS,
      sourceSize: 3.538,
    });
    expect(lastFrame().segments).toHaveLength(EIGHTFOLD_COIL_SEGMENT_COUNT * 4);
  });

  test("runs the loop at half the video's pace", () => {
    const { callbacks } = startAnimation(EightfoldCoil, {});
    callbacks.resize(800, 600, false, 0);
    vi.mocked(buildEightfoldCoilSpokes).mockClear();
    callbacks.frame(1000);
    callbacks.frame(10000);

    expect(seconds()).toEqual([expect.closeTo(0.5, 9), expect.closeTo(5, 9)]);
  });

  test("holds one still, two seconds into the loop, under reduced motion", () => {
    const { callbacks } = startAnimation(EightfoldCoil, {});
    vi.mocked(buildEightfoldCoilSpokes).mockClear();
    callbacks.resize(800, 600, true, 4000);
    callbacks.reducedMotion();

    expect(seconds()).toEqual([2, 2]);
  });

  test("draws with the field its theme tokens name", () => {
    const { run, callbacks } = startAnimation(EightfoldCoil, {});
    const host = run.canvas.parentElement!;
    host.style.setProperty("--eightfold-coil-field-scale", "2");
    host.style.setProperty("--eightfold-coil-tone", "0.5");
    host.style.setProperty("--eightfold-coil-opacity", "0.25");
    callbacks.resize(800, 600, false, 0);

    expect(lastFrame()).toMatchObject({ fieldScale: 2, tone: 0.5, opacity: 0.25 });
  });
});
