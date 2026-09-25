import { afterEach, describe, expect, test, vi } from "vitest";
import RippledDuet from "./RippledDuet.svelte";
import {
  buildRippledDuetPoints,
  RIPPLED_DUET_POINT_COUNT,
} from "./rippledDuet";
import { startAnimation, stopAnimations } from "../__tests__/canvas";

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./yuruyurauPointCloud", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./yuruyurauPointCloud")>()),
  createYuruyurauPointCloudRenderer: () => ({ draw: () => {}, destroy: () => {} }),
}));
vi.mock("./rippledDuet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./rippledDuet")>();
  return { ...actual, buildRippledDuetPoints: vi.fn(actual.buildRippledDuetPoints) };
});

afterEach(stopAnimations);

describe("Rippled Duet", () => {
  test("advances the source 4 pi / 3 radians per second", () => {
    const { callbacks } = startAnimation(RippledDuet, {});
    callbacks.resize(800, 800, false, 0);
    const build = vi.mocked(buildRippledDuetPoints);
    build.mockClear();
    callbacks.frame(1000);
    callbacks.frame(3000);

    expect(build.mock.calls.map(([sourceTime]) => sourceTime)).toEqual([
      expect.closeTo((4 * Math.PI) / 3, 9),
      expect.closeTo(4 * Math.PI, 9),
    ]);
  });

  test("builds the source sketch's 20,000 interleaved points", () => {
    const points = buildRippledDuetPoints(0);

    expect(points).toHaveLength(RIPPLED_DUET_POINT_COUNT * 2);
    expect(points.every(Number.isFinite)).toBe(true);
    expect(points[0]).toBeCloseTo(290.21122, 4);
    expect(points[1]).toBeCloseTo(135.76975, 4);
    expect(points[2]).toBeCloseTo(110.8144, 4);
    expect(points[3]).toBeCloseTo(231.71367, 4);
  });
});
