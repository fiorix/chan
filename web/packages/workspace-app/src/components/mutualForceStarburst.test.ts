import { describe, expect, test } from "vitest";
import {
  advanceMutualForceParticles,
  createMutualForceParticles,
  createMutualForceStaticSnapshot,
  fitMutualForceStarburst,
  MUTUAL_FORCE_PARTICLE_COUNT,
} from "./mutualForceStarburst";

describe("Mutual Force Starburst", () => {
  test("keeps the source simulation rate, styling, and attribution", async () => {
    const renderer = (await import("./MutualForceStarburst.svelte?raw"))
      .default as string;
    const motion = (await import("./mutualForceStarburst.ts?raw"))
      .default as string;

    expect(renderer).toMatch(
      /const SOURCE_FRAMES_PER_SECOND = 60;/,
    );
    expect(renderer).toMatch(/const SOURCE_FADE_ALPHA = 9 \/ 255;/);
    expect(renderer).toContain(
      "--mutual-force-starburst-point-alpha: 0.24;",
    );
    expect(renderer).toContain(
      "--mutual-force-starburst-point-alpha: 0.38;",
    );
    expect(motion).toContain(
      "https://x.com/hisadan/status/1937852453929783400",
    );
    expect(motion).toContain(
      "https://x.com/hisadan/status/1937852456584814776",
    );
  });

  test("creates the source sketch's 300 centered particles", () => {
    const values = [0, 0.25, 0.5, 0.75];
    let cursor = 0;
    const particles = createMutualForceParticles(
      MUTUAL_FORCE_PARTICLE_COUNT,
      () => values[cursor++ % values.length],
    );

    expect(particles).toHaveLength(MUTUAL_FORCE_PARTICLE_COUNT * 4);
    expect([...particles.slice(0, 8)]).toEqual([
      0, 0, 1, 0.5, 0, 0, 0, -0.5,
    ]);
  });

  test("repels near neighbors and attracts distant neighbors", () => {
    const near = new Float32Array([
      0, 0, 0, 0,
      10, 0, 0, 0,
    ]);
    const far = new Float32Array([
      0, 0, 0, 0,
      100, 0, 0, 0,
    ]);

    advanceMutualForceParticles(near);
    advanceMutualForceParticles(far);

    expect(near[0]).toBeCloseTo(-1);
    expect(near[4]).toBeCloseTo(11);
    expect(far[0]).toBeCloseTo(0.01);
    expect(far[4]).toBeCloseTo(99.99, 4);
  });

  test("reflects source velocities before crossing the canvas edge", () => {
    const particles = new Float32Array([
      399, -399, 2, -2,
    ]);

    advanceMutualForceParticles(particles);

    expect([...particles]).toEqual([397, -397, -2, 2]);
  });

  test("builds a quiet starburst snapshot without mutating motion", () => {
    const particles = new Float32Array([
      12, -8, 0.5, -0.25,
    ]);

    const snapshot = createMutualForceStaticSnapshot(particles, 100);

    expect([...snapshot]).toEqual([50, -25, 0.5, -0.25]);
    expect([...particles]).toEqual([12, -8, 0.5, -0.25]);
  });

  test("fits rectangular panes without distorting the field", () => {
    expect(fitMutualForceStarburst(1400, 900)).toEqual({
      centerX: 700,
      centerY: 450,
      scale: 1.125,
    });
  });
});
