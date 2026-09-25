import { afterEach, describe, expect, test, vi } from "vitest";
import HexagonalBloom from "./HexagonalBloom.svelte";
import {
  buildHexagonalBloomBasePoints,
  HEXAGONAL_BLOOM_BASE_POINT_COUNT,
} from "./hexagonalBloom";
import { startAnimation, stopAnimations } from "../__tests__/canvas";

const renderer = vi.hoisted(() => ({ draw: vi.fn(), destroy: vi.fn() }));

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./yuruyurauRotationalField", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./yuruyurauRotationalField")>()),
  createYuruyurauRotationalRenderer: () => renderer,
}));
vi.mock("./hexagonalBloom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hexagonalBloom")>();
  return { ...actual, buildHexagonalBloomBasePoints: vi.fn(actual.buildHexagonalBloomBasePoints) };
});

afterEach(() => {
  stopAnimations();
  renderer.draw.mockClear();
});

describe("Hexagonal Bloom", () => {
  test("advances the source trace pi / 4 radians per second", () => {
    const { callbacks } = startAnimation(HexagonalBloom, {});
    callbacks.resize(800, 800, false, 0);
    const build = vi.mocked(buildHexagonalBloomBasePoints);
    build.mockClear();
    callbacks.frame(1000);
    callbacks.frame(3000);

    expect(build.mock.calls.map(([sourceTime]) => sourceTime)).toEqual([
      expect.closeTo(Math.PI / 4, 9),
      expect.closeTo((3 * Math.PI) / 4, 9),
    ]);
  });

  test("draws six rotated copies of the trace, faded out 140 px from the centre", () => {
    const { callbacks } = startAnimation(HexagonalBloom, {});
    callbacks.resize(800, 800, false, 0);

    expect(renderer.draw).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rotationCount: 6,
        fadeOuterRadius: 140,
      }),
    );
  });

  test("builds the source trace captured before six rotations", () => {
    const points = buildHexagonalBloomBasePoints(0);

    expect(points).toHaveLength(HEXAGONAL_BLOOM_BASE_POINT_COUNT * 2);
    expect(points[0]).toBeCloseTo(180.04782, 4);
    expect(points[1]).toBeCloseTo(363.04138, 4);
  });

  test("reuses a caller-provided buffer without changing the trace", () => {
    const target = new Float32Array(HEXAGONAL_BLOOM_BASE_POINT_COUNT * 2);
    const points = buildHexagonalBloomBasePoints(0.5, target);

    expect(points).toBe(target);
    expect([...points]).toEqual([...buildHexagonalBloomBasePoints(0.5)]);
  });
});
