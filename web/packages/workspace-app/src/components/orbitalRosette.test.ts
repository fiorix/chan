import { describe, expect, test } from "vitest";
import {
  buildOrbitalCircles,
  ORBITAL_RING_COUNT,
} from "./orbitalRosette";

describe("buildOrbitalCircles", () => {
  test("keeps the named renderer tuning and source attribution", async () => {
    const renderer = (await import("./OrbitalRosette.svelte?raw"))
      .default as string;
    const geometry = (await import("./orbitalRosette.ts?raw"))
      .default as string;

    expect(renderer).toMatch(/const PHASE_SPEED = -0\.3;/);
    expect(renderer).toMatch(
      /--orbital-rosette-alpha-base: 0\.055;[\s\S]*--orbital-rosette-alpha-range: 0\.14;/,
    );
    expect(renderer).toMatch(/--orbital-rosette-size-scale: 1\.35;/);
    expect(geometry).toContain(
      "https://x.com/hisadan/status/2063631027063726297",
    );
  });

  test("doubles each ring from 2 through 64 circles", () => {
    const circles = buildOrbitalCircles(0, 1);

    expect(circles).toHaveLength(126);
    for (let ring = 1; ring <= ORBITAL_RING_COUNT; ring += 1) {
      expect(circles.filter((circle) => circle.ring === ring)).toHaveLength(
        2 ** ring,
      );
    }
  });

  test("preserves the shared breathing and rotation phase", () => {
    const phaseZero = buildOrbitalCircles(0, 1);
    expect(phaseZero[0]).toMatchObject({
      ring: 1,
      x: 0,
      y: 1000,
      radius: 49.5,
    });

    const quarterTurn = buildOrbitalCircles(Math.PI / 2, 1);
    expect(quarterTurn[0].radius).toBeCloseTo(0);
    expect(Math.hypot(quarterTurn[0].x, quarterTurn[0].y)).toBeCloseTo(40);
    expect(
      Math.hypot(
        quarterTurn[quarterTurn.length - 1].x,
        quarterTurn[quarterTurn.length - 1].y,
      ),
    ).toBeCloseTo(240);
  });

  test("scales the geometry as one responsive unit", () => {
    const full = buildOrbitalCircles(0.7, 1);
    const half = buildOrbitalCircles(0.7, 0.5);

    expect(half[20].x).toBeCloseTo(full[20].x / 2);
    expect(half[20].y).toBeCloseTo(full[20].y / 2);
    expect(half[20].radius).toBeCloseTo(full[20].radius / 2);
  });
});
