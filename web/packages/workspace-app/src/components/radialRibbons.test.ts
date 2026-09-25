import { afterEach, describe, expect, test, vi } from "vitest";
import RadialRibbons from "./RadialRibbons.svelte";
import {
  buildRadialRibbons,
  fitRadialRibbons,
  RADIAL_RIBBON_COUNT,
} from "./radialRibbons";
import {
  recordingContext2d,
  startAnimation,
  stopAnimations,
} from "../__tests__/canvas";

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./radialRibbons", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./radialRibbons")>();
  return { ...actual, buildRadialRibbons: vi.fn(actual.buildRadialRibbons) };
});

afterEach(stopAnimations);

describe("Radial Ribbons", () => {
  test("turns 0.0576 radians per second of animation time", () => {
    const { callbacks } = startAnimation(RadialRibbons, recordingContext2d().ctx);
    callbacks.resize(800, 800, false, 0);
    const build = vi.mocked(buildRadialRibbons);
    build.mockClear();
    callbacks.frame(1000);
    callbacks.frame(3000);

    expect(build.mock.calls.map(([phase]) => phase)).toEqual([
      expect.closeTo(0.0576, 9),
      expect.closeTo(0.1728, 9),
    ]);
  });

  test("builds the source sketch's 20 eight-point ribbons", () => {
    const ribbons = buildRadialRibbons(0);

    expect(ribbons).toHaveLength(RADIAL_RIBBON_COUNT);
    expect(ribbons.every((ribbon) => ribbon.length === 8)).toBe(true);
  });

  test("walks out through four radii and returns on the offset edge", () => {
    const ribbon = buildRadialRibbons(0)[0];
    const radii = ribbon.map((point) => Math.hypot(point.x, point.y));

    expect(radii).toEqual([50, 100, 200, 400, 400, 200, 100, 50]);
    expect(ribbon[0]).toEqual({ x: 50, y: 0 });
    expect(Math.atan2(ribbon[7].y, ribbon[7].x)).toBeCloseTo(
      Math.PI / 20,
    );
  });

  test("fits rectangular panes with a uniform circular scale", () => {
    expect(fitRadialRibbons(1400, 900)).toEqual({
      centerX: 700,
      centerY: 450,
      scale: 1.125,
    });
  });
});
