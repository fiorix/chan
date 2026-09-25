import { afterEach, describe, expect, test, vi } from "vitest";
import ThreefoldVeil from "./ThreefoldVeil.svelte";
import {
  buildThreefoldVeilPoints,
  fitThreefoldVeil,
  THREEFOLD_VEIL_POINT_COUNT,
} from "./threefoldVeil";
import {
  recordingContext2d,
  startAnimation,
  stopAnimations,
} from "../__tests__/canvas";

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./threefoldVeil", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./threefoldVeil")>();
  return { ...actual, buildThreefoldVeilPoints: vi.fn(actual.buildThreefoldVeilPoints) };
});

afterEach(stopAnimations);

describe("Threefold Veil", () => {
  test("advances pi radians per second of animation time", () => {
    const { callbacks } = startAnimation(ThreefoldVeil, recordingContext2d().ctx);
    callbacks.resize(800, 800, false, 0);
    const build = vi.mocked(buildThreefoldVeilPoints);
    build.mockClear();
    callbacks.frame(1000);
    callbacks.frame(3000);

    expect(build.mock.calls.map(([phase]) => phase)).toEqual([
      expect.closeTo(Math.PI, 9),
      expect.closeTo(3 * Math.PI, 9),
    ]);
  });

  test("builds the source sketch's 10,000 points", () => {
    const points = buildThreefoldVeilPoints(0);

    expect(points).toHaveLength(THREEFOLD_VEIL_POINT_COUNT * 2);
    expect(points.every(Number.isFinite)).toBe(true);
  });

  test("preserves the three interleaved phase offsets", () => {
    const points = buildThreefoldVeilPoints(0, 3);

    expect(points[0]).toBeCloseTo(82.05225, 4);
    expect(points[1]).toBeCloseTo(288.70142, 4);
    expect(points[2]).toBeCloseTo(343.55653, 4);
    expect(points[3]).toBeCloseTo(206.18337, 4);
    expect(points[4]).toBeCloseTo(186.77179, 4);
    expect(points[5]).toBeCloseTo(59.33509, 4);
  });

  test("fits the square source canvas into rectangular panes", () => {
    const transform = fitThreefoldVeil(1400, 900);

    expect(transform.centerX).toBe(700);
    expect(transform.centerY).toBe(450);
    expect(transform.sourceCenterX).toBe(200);
    expect(transform.sourceCenterY).toBe(200);
    expect(transform.scale).toBeGreaterThan(4);
  });
});
