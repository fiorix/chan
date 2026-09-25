import { afterEach, describe, expect, test, vi } from "vitest";
import LorenzConstellation from "./LorenzConstellation.svelte";
import {
  buildLorenzConstellationPoints,
  LORENZ_CONSTELLATION_POINT_COUNT,
} from "./lorenzConstellation";
import { startAnimation, stopAnimations } from "../__tests__/canvas";

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./yuruyurauPointCloud", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./yuruyurauPointCloud")>()),
  createYuruyurauPointCloudRenderer: () => ({ draw: () => {}, destroy: () => {} }),
}));
vi.mock("./lorenzConstellation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lorenzConstellation")>();
  return { ...actual, buildLorenzConstellationPoints: vi.fn(actual.buildLorenzConstellationPoints) };
});

afterEach(stopAnimations);

describe("Lorenz Constellation", () => {
  test("steps the source sketch 30 frames per second, half its own 60", () => {
    const { callbacks } = startAnimation(LorenzConstellation, {});
    callbacks.resize(800, 800, false, 0);
    const build = vi.mocked(buildLorenzConstellationPoints);
    build.mockClear();
    callbacks.frame(1000);
    callbacks.frame(3000);

    expect(build.mock.calls.map(([sourceTime]) => sourceTime)).toEqual([
      expect.closeTo(30, 9),
      expect.closeTo(90, 9),
    ]);
  });

  test("builds the source sketch's 30,000 projected Lorenz points", () => {
    const points = buildLorenzConstellationPoints(0);

    expect(points).toHaveLength(LORENZ_CONSTELLATION_POINT_COUNT * 2);
    expect(points.every(Number.isFinite)).toBe(true);
    expect(points[0]).toBeCloseTo(101.20698, 4);
    expect(points[1]).toBeCloseTo(235.13727, 4);
  });
});
