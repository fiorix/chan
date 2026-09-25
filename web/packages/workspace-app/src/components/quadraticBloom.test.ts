import { afterEach, describe, expect, test, vi } from "vitest";
import QuadraticBloom from "./QuadraticBloom.svelte";
import {
  buildQuadraticBloomPoints,
  fitQuadraticBloom,
  QUADRATIC_BLOOM_GUTTER,
  QUADRATIC_BLOOM_ITERATIONS,
} from "./quadraticBloom";
import {
  recordingContext2d,
  startAnimation,
  stopAnimations,
} from "../__tests__/canvas";

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./quadraticBloom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./quadraticBloom")>();
  return { ...actual, buildQuadraticBloomPoints: vi.fn(actual.buildQuadraticBloomPoints) };
});

afterEach(stopAnimations);

describe("buildQuadraticBloomPoints", () => {
  test("advances 60 pi / 1000 radians per second of animation time", () => {
    const { callbacks } = startAnimation(QuadraticBloom, recordingContext2d().ctx);
    callbacks.resize(800, 800, false, 0);
    const build = vi.mocked(buildQuadraticBloomPoints);
    build.mockClear();
    callbacks.frame(1000);
    callbacks.frame(3000);

    expect(build.mock.calls.map(([phase]) => phase)).toEqual([
      expect.closeTo((Math.PI * 60) / 1000, 9),
      expect.closeTo((Math.PI * 180) / 1000, 9),
    ]);
  });

  test("paints its points in the colour and opacity its theme tokens name", () => {
    const { ctx, ops } = recordingContext2d();
    const { run, callbacks } = startAnimation(QuadraticBloom, ctx);
    const host = run.canvas.parentElement!;
    host.style.setProperty("--quadratic-bloom-point-rgb", "1, 2, 3");
    host.style.setProperty("--quadratic-bloom-point-alpha", "0.5");
    callbacks.resize(800, 800, false, 0);

    expect(ops).toContainEqual({ op: "set fillStyle", args: ["rgb(1, 2, 3)"] });
    expect(ops).toContainEqual({ op: "set globalAlpha", args: [0.5] });
  });

  test("preserves the source sketch's quadratic recurrence", () => {
    const points = buildQuadraticBloomPoints(0, 2);

    expect(Array.from(points)).toEqual([
      expect.closeTo(0.186, 6),
      expect.closeTo(0.01, 6),
      expect.closeTo(0.3441, 6),
      expect.closeTo(0.041596, 6),
    ]);
  });

  test("emits the full stable attractor trace", () => {
    const points = buildQuadraticBloomPoints(1, QUADRATIC_BLOOM_ITERATIONS);

    expect(points).toHaveLength(QUADRATIC_BLOOM_ITERATIONS * 2);
    expect(points.every(Number.isFinite)).toBe(true);
  });

  test("stops a diverging trace before invalid coordinates reach canvas", () => {
    const points = buildQuadraticBloomPoints(0);

    expect(points.length).toBeGreaterThan(0);
    expect(points.length).toBeLessThan(QUADRATIC_BLOOM_ITERATIONS * 2);
    expect(points.every((coordinate) => Math.abs(coordinate) <= 8)).toBe(true);
  });

  test("fits the full attractor below the pane bar and near its side edges", () => {
    const width = 1400;
    const height = 800;
    const transform = fitQuadraticBloom(width, height);

    expect(transform.centerX + -1.84 * transform.scaleX).toBeCloseTo(
      QUADRATIC_BLOOM_GUTTER,
    );
    expect(transform.centerX + 1.84 * transform.scaleX).toBeCloseTo(
      width - QUADRATIC_BLOOM_GUTTER,
    );
    expect(transform.centerY + -1.43 * transform.scaleY).toBeCloseTo(
      QUADRATIC_BLOOM_GUTTER,
    );
    expect(transform.centerY + 3.38 * transform.scaleY).toBeCloseTo(
      height - QUADRATIC_BLOOM_GUTTER,
    );
    expect(transform.scaleX).toBeGreaterThan(transform.scaleY);
  });
});
