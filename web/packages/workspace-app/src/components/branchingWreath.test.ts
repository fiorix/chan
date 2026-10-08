import { afterEach, describe, expect, test, vi } from "vitest";
import BranchingWreath from "./BranchingWreath.svelte";
import {
  BRANCHING_WREATH_SEGMENT_COUNT,
  buildBranchingWreathSegments,
} from "./branchingWreath";
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
vi.mock("./branchingWreath", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./branchingWreath")>();
  return {
    ...actual,
    buildBranchingWreathSegments: vi.fn(actual.buildBranchingWreathSegments),
  };
});

afterEach(() => {
  stopAnimations();
  renderer.draw.mockClear();
});

function segment(segments: Float32Array, index: number): number[] {
  return Array.from(segments.subarray(index * 4, index * 4 + 4));
}

function lastFrame(): LineSegmentFrame {
  return renderer.draw.mock.calls.at(-1)![0] as LineSegmentFrame;
}

function times(): number[] {
  return vi.mocked(buildBranchingWreathSegments).mock.calls.map(([time]) => time);
}

describe("buildBranchingWreathSegments", () => {
  test("grows ten trees of 2,047 branches each", () => {
    expect(BRANCHING_WREATH_SEGMENT_COUNT).toBe(20470);
    expect(buildBranchingWreathSegments(0)).toHaveLength(20470 * 4);
  });

  // Expected values come from running the sketch's recursion literally, in
  // its order, with its clock at 0.75.
  test("places each branch where the sketch's recursion draws it", () => {
    const segments = buildBranchingWreathSegments(0.75);

    for (const [index, ...expected] of [
      // The first trunk, its near child and that child's near child.
      [0, 0, 0, 126, 0],
      [1, 126, 0, 166.041, 78.587],
      [2, 166.041, 78.587, 135.437, 132.209],
      // The first trunk's far child mirrors the near one.
      [1024, 126, 0, 166.041, -78.587],
      // The second trunk, a tenth of a turn on.
      [2047, 0, 0, 101.936, 74.061],
      // The last twig of the last tree.
      [20469, 77.1, -243.19, 77.097, -246.749],
    ]) {
      const actual = segment(segments, index!);
      for (let part = 0; part < 4; part += 1) {
        expect(actual[part]).toBeCloseTo(expected[part]!, 2);
      }
    }
  });

  test("repeats when its clock has gone once around", () => {
    const start = buildBranchingWreathSegments(0.4);
    const next = buildBranchingWreathSegments(0.4 + Math.PI * 2);

    for (const index of [5, 1500, 20469]) {
      for (let part = 0; part < 4; part += 1) {
        expect(segment(next, index)[part]).toBeCloseTo(
          segment(start, index)[part]!,
          2,
        );
      }
    }
  });

  test("fills the buffer it is handed instead of allocating", () => {
    const out = new Float32Array(BRANCHING_WREATH_SEGMENT_COUNT * 4);

    expect(buildBranchingWreathSegments(0.25, out)).toBe(out);
    expect(segment(out, 0)).toEqual([0, 0, 126, 0]);
  });
});

describe("Branching Wreath", () => {
  test("draws every branch as a line through the WebGL2 runner, on a multisampled canvas", () => {
    const { run, callbacks } = startAnimation(BranchingWreath, {});
    callbacks.resize(800, 600, false, 0);

    expect(run.runner).toBe("webgl2");
    expect(run.options).toMatchObject({
      contextAttributes: { antialias: true },
    });
    expect(lastFrame()).toMatchObject({ segmentCount: 20470, sourceSize: 720 });
    expect(lastFrame().segments).toHaveLength(20470 * 4);
  });

  test("advances its clock 0.09 radians per second of animation time", () => {
    const { callbacks } = startAnimation(BranchingWreath, {});
    callbacks.resize(800, 600, false, 0);
    vi.mocked(buildBranchingWreathSegments).mockClear();
    callbacks.frame(1000);
    callbacks.frame(10000);

    expect(times()).toEqual([expect.closeTo(0.09, 9), expect.closeTo(0.9, 9)]);
  });

  test("holds one still frame at the start of the loop under reduced motion", () => {
    const { callbacks } = startAnimation(BranchingWreath, {});
    vi.mocked(buildBranchingWreathSegments).mockClear();
    callbacks.resize(800, 600, true, 4000);
    callbacks.reducedMotion();

    expect(times()).toEqual([0, 0]);
  });

  test("draws with the field its theme tokens name", () => {
    const { run, callbacks } = startAnimation(BranchingWreath, {});
    const host = run.canvas.parentElement!;
    host.style.setProperty("--branching-wreath-field-scale", "2");
    host.style.setProperty("--branching-wreath-tone", "0.5");
    host.style.setProperty("--branching-wreath-opacity", "0.25");
    callbacks.resize(800, 600, false, 0);

    expect(lastFrame()).toMatchObject({ fieldScale: 2, tone: 0.5, opacity: 0.25 });
  });
});
