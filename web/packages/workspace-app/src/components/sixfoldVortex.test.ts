import { describe, expect, test } from "vitest";
import {
  advanceSixfoldVortexParticles,
  createSixfoldVortexParticles,
  fitSixfoldVortex,
  SIXFOLD_VORTEX_PARTICLE_COUNT,
} from "./sixfoldVortex";

describe("Sixfold Vortex", () => {
  test("keeps the source simulation rate and attribution", async () => {
    const renderer = (await import("./SixfoldVortex.svelte?raw"))
      .default as string;
    const motion = (await import("./sixfoldVortex.ts?raw"))
      .default as string;

    expect(renderer).toMatch(/const SOURCE_TIME_SPEED = 60;/);
    expect(renderer).toContain(
      "--sixfold-vortex-point-alpha: 0.066;",
    );
    expect(renderer).toContain(
      "--sixfold-vortex-point-alpha: 0.088;",
    );
    expect(motion).toContain(
      "https://x.com/hisadan/status/1974838123864756613",
    );
  });

  test("creates the source sketch's 30,000 Gaussian particles", () => {
    const particles = createSixfoldVortexParticles(
      SIXFOLD_VORTEX_PARTICLE_COUNT,
      () => 0,
      () => 1,
    );

    expect(particles).toHaveLength(SIXFOLD_VORTEX_PARTICLE_COUNT * 2);
    expect([...particles.slice(0, 4)]).toEqual([0, 99, 0, 99]);
  });

  test("advances finite particles through all seven vortices", () => {
    const particles = new Float32Array([100, 50, -80, 120]);

    advanceSixfoldVortexParticles(particles, 25);

    expect([...particles].every(Number.isFinite)).toBe(true);
    expect([...particles]).not.toEqual([100, 50, -80, 120]);
  });

  test("fits rectangular panes without distorting the center", () => {
    const transform = fitSixfoldVortex(1400, 900);

    expect(transform).toEqual({
      centerX: 700,
      centerY: 450,
      scale: 1.125,
    });
  });
});
