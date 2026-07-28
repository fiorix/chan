import { describe, expect, test } from "vitest";
import {
  advancePolarDriftParticles,
  createPolarDriftParticles,
  POLAR_DRIFT_PARTICLE_COUNT,
} from "./polarDrift";

describe("Polar Drift", () => {
  test("keeps the source timing and attribution", async () => {
    const renderer = (await import("./PolarDrift.svelte?raw"))
      .default as string;
    const motion = (await import("./polarDrift.ts?raw"))
      .default as string;

    expect(renderer).toMatch(/const PHASE_SPEED = 0\.06;/);
    expect(motion).toContain(
      "https://x.com/hisadan/status/1997466751832059960",
    );
  });

  test("creates the source sketch's 9,999 particles", () => {
    const particles = createPolarDriftParticles(
      POLAR_DRIFT_PARTICLE_COUNT,
      () => 0.25,
    );

    expect(particles).toHaveLength(POLAR_DRIFT_PARTICLE_COUNT * 2);
    expect([...particles.slice(0, 4)]).toEqual([200, 200, 200, 200]);
  });

  test("advances by the doubled polar angle", () => {
    const particles = new Float32Array([100, 0, 0, 100]);

    advancePolarDriftParticles(particles, Math.PI / 2, 1);

    expect(particles[0]).toBeCloseTo(99);
    expect(particles[1]).toBeCloseTo(0);
    expect(particles[2]).toBeCloseTo(1);
    expect(particles[3]).toBeCloseTo(100);
  });

  test("reseeds particles outside the source annulus", () => {
    const particles = new Float32Array([10, 0]);

    advancePolarDriftParticles(particles, 0, 1, () => 0.25);

    expect([...particles]).toEqual([200, 200]);
  });
});
