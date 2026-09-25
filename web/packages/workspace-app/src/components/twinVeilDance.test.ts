import { afterEach, describe, expect, test, vi } from "vitest";
import TwinVeilDance from "./TwinVeilDance.svelte";
import {
  buildTwinVeilDancePoints,
  TWIN_VEIL_DANCE_POINT_COUNT,
} from "./twinVeilDance";
import { startAnimation, stopAnimations } from "../__tests__/canvas";

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./yuruyurauPointCloud", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./yuruyurauPointCloud")>()),
  createYuruyurauPointCloudRenderer: () => ({ draw: () => {}, destroy: () => {} }),
}));
vi.mock("./twinVeilDance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./twinVeilDance")>();
  return { ...actual, buildTwinVeilDancePoints: vi.fn(actual.buildTwinVeilDancePoints) };
});

afterEach(stopAnimations);

describe("Twin Veil Dance", () => {
  test("advances the source 4 pi / 3 radians per second", () => {
    const { callbacks } = startAnimation(TwinVeilDance, {});
    callbacks.resize(800, 800, false, 0);
    const build = vi.mocked(buildTwinVeilDancePoints);
    build.mockClear();
    callbacks.frame(1000);
    callbacks.frame(3000);

    expect(build.mock.calls.map(([sourceTime]) => sourceTime)).toEqual([
      expect.closeTo((4 * Math.PI) / 3, 9),
      expect.closeTo(4 * Math.PI, 9),
    ]);
  });

  test("builds the source sketch's 20,000 interleaved points", () => {
    const points = buildTwinVeilDancePoints(0);

    expect(points).toHaveLength(TWIN_VEIL_DANCE_POINT_COUNT * 2);
    expect(points.every(Number.isFinite)).toBe(true);
    expect(points[0]).toBeCloseTo(269.8125, 4);
    expect(points[1]).toBeCloseTo(180.12452, 4);
    expect(points[2]).toBeCloseTo(143.87201, 4);
    expect(points[3]).toBeCloseTo(172.23804, 4);
  });
});
