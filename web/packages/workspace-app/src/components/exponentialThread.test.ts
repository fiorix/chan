import { afterEach, describe, expect, test, vi } from "vitest";
import ExponentialThread from "./ExponentialThread.svelte";
import {
  buildExponentialThreadPoints,
  EXPONENTIAL_THREAD_GUTTER,
  EXPONENTIAL_THREAD_VERTEX_COUNT,
  fitExponentialThread,
} from "./exponentialThread";
import {
  recordingContext2d,
  startAnimation,
  stopAnimations,
} from "../__tests__/canvas";

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./exponentialThread", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./exponentialThread")>();
  return {
    ...actual,
    buildExponentialThreadPoints: vi.fn(actual.buildExponentialThreadPoints),
  };
});

afterEach(stopAnimations);

describe("buildExponentialThreadPoints", () => {
  test("advances 0.018 radians per second of animation time", () => {
    const { callbacks } = startAnimation(ExponentialThread, recordingContext2d().ctx);
    callbacks.resize(1400, 800, false, 0);
    const build = vi.mocked(buildExponentialThreadPoints);
    build.mockClear();
    callbacks.frame(1000);
    callbacks.frame(3000);

    expect(build.mock.calls.map(([phase]) => phase)).toEqual([
      expect.closeTo(0.018, 9),
      expect.closeTo(0.054, 9),
    ]);
  });

  test("shades the thread from its centre token to its edge token", () => {
    const { ctx, ops } = recordingContext2d();
    const { run, callbacks } = startAnimation(ExponentialThread, ctx);
    const host = run.canvas.parentElement!;
    host.style.setProperty("--exponential-thread-center-rgb", "1, 2, 3");
    host.style.setProperty("--exponential-thread-edge-rgb", "4, 5, 6");
    host.style.setProperty("--exponential-thread-line-alpha", "0.5");
    callbacks.resize(1400, 800, false, 0);

    const gradient = ops.find(({ op }) => op === "createRadialGradient");
    expect(gradient?.args.slice(0, 3)).toEqual([700, 400, 0]);
    expect(ops).toContainEqual({ op: "addColorStop", args: [0, "rgb(1, 2, 3)"] });
    expect(ops).toContainEqual({ op: "addColorStop", args: [1, "rgb(4, 5, 6)"] });
    expect(ops).toContainEqual({ op: "set globalAlpha", args: [0.5] });
  });

  test("preserves the source sketch's exponential curve", () => {
    const points = buildExponentialThreadPoints(0);

    expect(points).toHaveLength(EXPONENTIAL_THREAD_VERTEX_COUNT * 2);
    expect(points[0]).toBeCloseTo(0);
    expect(points[1]).toBeCloseTo(3);
    for (let index = 0; index < points.length; index += 2) {
      expect(points[index]).toBeCloseTo(0);
    }
  });

  test("changes horizontal frequency with the animation phase", () => {
    const collapsed = buildExponentialThreadPoints(0);
    const expanded = buildExponentialThreadPoints(Math.PI / 2);

    expect(expanded[200]).not.toBeCloseTo(collapsed[200]);
    expect(expanded[201]).toBeCloseTo(collapsed[201]);
  });

  test("fits the outer radius inside the pane bar gutter", () => {
    const transform = fitExponentialThread(1400, 800);
    const radius = transform.centerY - EXPONENTIAL_THREAD_GUTTER;

    expect(transform.centerX).toBe(700);
    expect(transform.centerY).toBe(400);
    expect(radius).toBeCloseTo(376);
    expect(transform.scaleX / transform.scaleY).toBeCloseTo(1.3);
  });

  test("caps the horizontal stretch inside narrow panes", () => {
    const transform = fitExponentialThread(500, 800);

    expect(transform.scaleX).toBeCloseTo(transform.scaleY);
  });
});
