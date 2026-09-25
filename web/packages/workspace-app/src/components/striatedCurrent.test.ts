import { afterEach, describe, expect, test, vi } from "vitest";
import StriatedCurrent from "./StriatedCurrent.svelte";
import {
  buildStriatedCurrentPoints,
  STRIATED_CURRENT_POINT_COUNT,
} from "./striatedCurrent";
import { startAnimation, stopAnimations } from "../__tests__/canvas";

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./yuruyurauPointCloud", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./yuruyurauPointCloud")>()),
  createYuruyurauPointCloudRenderer: () => ({ draw: () => {}, destroy: () => {} }),
}));
vi.mock("./striatedCurrent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./striatedCurrent")>();
  return { ...actual, buildStriatedCurrentPoints: vi.fn(actual.buildStriatedCurrentPoints) };
});

afterEach(stopAnimations);

describe("Striated Current", () => {
  test("advances the source 3 pi / 4 radians per second", () => {
    const { callbacks } = startAnimation(StriatedCurrent, {});
    callbacks.resize(800, 800, false, 0);
    const build = vi.mocked(buildStriatedCurrentPoints);
    build.mockClear();
    callbacks.frame(1000);
    callbacks.frame(3000);

    expect(build.mock.calls.map(([sourceTime]) => sourceTime)).toEqual([
      expect.closeTo((3 * Math.PI) / 4, 9),
      expect.closeTo((9 * Math.PI) / 4, 9),
    ]);
  });

  test("builds the source sketch's 10,000 points", () => {
    const points = buildStriatedCurrentPoints(0);

    expect(points).toHaveLength(STRIATED_CURRENT_POINT_COUNT * 2);
    expect(points.every(Number.isFinite)).toBe(true);
    expect(points[0]).toBeCloseTo(152.71606, 4);
    expect(points[1]).toBeCloseTo(138.63249, 4);
  });
});
