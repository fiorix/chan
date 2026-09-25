import { afterEach, describe, expect, test, vi } from "vitest";
import FourteenfoldBloom from "./FourteenfoldBloom.svelte";
import {
  buildFourteenfoldBloomBasePoints,
  FOURTEENFOLD_BLOOM_BASE_POINT_COUNT,
} from "./fourteenfoldBloom";
import { startAnimation, stopAnimations } from "../__tests__/canvas";

const renderer = vi.hoisted(() => ({ draw: vi.fn(), destroy: vi.fn() }));

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./yuruyurauRotationalField", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./yuruyurauRotationalField")>()),
  createYuruyurauRotationalRenderer: () => renderer,
}));
vi.mock("./fourteenfoldBloom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fourteenfoldBloom")>();
  return { ...actual, buildFourteenfoldBloomBasePoints: vi.fn(actual.buildFourteenfoldBloomBasePoints) };
});

afterEach(() => {
  stopAnimations();
  renderer.draw.mockClear();
});

describe("Fourteenfold Bloom", () => {
  test("advances the source trace pi / 4 radians per second", () => {
    const { callbacks } = startAnimation(FourteenfoldBloom, {});
    callbacks.resize(800, 800, false, 0);
    const build = vi.mocked(buildFourteenfoldBloomBasePoints);
    build.mockClear();
    callbacks.frame(1000);
    callbacks.frame(3000);

    expect(build.mock.calls.map(([sourceTime]) => sourceTime)).toEqual([
      expect.closeTo(Math.PI / 4, 9),
      expect.closeTo((3 * Math.PI) / 4, 9),
    ]);
  });

  test("draws fourteen rotated copies of the trace, faded out 140 px from the centre", () => {
    const { callbacks } = startAnimation(FourteenfoldBloom, {});
    callbacks.resize(800, 800, false, 0);

    expect(renderer.draw).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rotationCount: 14,
        fadeOuterRadius: 140,
      }),
    );
  });

  test("builds the source trace captured before fourteen rotations", () => {
    const points = buildFourteenfoldBloomBasePoints(0);

    expect(points).toHaveLength(FOURTEENFOLD_BLOOM_BASE_POINT_COUNT * 2);
    expect(points[0]).toBeCloseTo(205.20724, 4);
    expect(points[1]).toBeCloseTo(376.24322, 4);
  });

  test("reuses a caller-provided buffer without changing the trace", () => {
    const target = new Float32Array(
      FOURTEENFOLD_BLOOM_BASE_POINT_COUNT * 2,
    );
    const points = buildFourteenfoldBloomBasePoints(0.5, target);

    expect(points).toBe(target);
    expect([...points]).toEqual([...buildFourteenfoldBloomBasePoints(0.5)]);
  });
});
