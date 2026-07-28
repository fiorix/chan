import { describe, expect, test } from "vitest";
import {
  buildRadialRibbons,
  fitRadialRibbons,
  RADIAL_RIBBON_COUNT,
} from "./radialRibbons";

describe("Radial Ribbons", () => {
  test("keeps the source timing and attribution", async () => {
    const renderer = (await import("./RadialRibbons.svelte?raw"))
      .default as string;
    const geometry = (await import("./radialRibbons.ts?raw"))
      .default as string;

    expect(renderer).toMatch(/const PHASE_SPEED = 0\.0576;/);
    expect(geometry).toContain(
      "https://x.com/hisadan/status/1993339904181567873",
    );
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
