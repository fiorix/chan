import { describe, expect, test } from "vitest";
import {
  advancePolarDriftParticles,
  createPolarDriftParticles,
  fitPolarDrift,
  POLAR_DRIFT_HALF_SIZE,
  POLAR_DRIFT_PARTICLE_COUNT,
  POLAR_DRIFT_POINT_VERTEX_SHADER,
  POLAR_DRIFT_SURFACE_FRAGMENT_SHADER,
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

  test("renders through WebGL2 with ping-pong trail surfaces", async () => {
    // The 2D path collected 9,999 ctx.rect() calls into one fill per frame,
    // which Linux software-rasterizes. Losing any of these puts it back.
    const renderer = (await import("./PolarDrift.svelte?raw"))
      .default as string;
    const motion = (await import("./polarDrift.ts?raw")).default as string;

    expect(renderer).toContain("runWebgl2Animation");
    expect(renderer).not.toContain("ctx.rect(");
    expect(motion).toContain("framebufferTexture2D");
    expect(motion).toContain("gl.DYNAMIC_DRAW");
    expect(POLAR_DRIFT_SURFACE_FRAGMENT_SHADER).toContain(
      "mix(previous, uBackgroundColor, uFade)",
    );
    expect(POLAR_DRIFT_POINT_VERTEX_SHADER).toContain("gl_PointSize = 1.0;");
  });

  test("stretches the field to the pane on both axes", () => {
    // Its siblings fit on min(width, height); this one has always filled the
    // pane, so a square-fit regression would be a visual change, not a tidy-up.
    const transform = fitPolarDrift(1600, 400);

    expect(transform.centerX).toBe(800);
    expect(transform.centerY).toBe(200);
    expect(transform.scaleX).toBe(1600 / (POLAR_DRIFT_HALF_SIZE * 2));
    expect(transform.scaleY).toBe(400 / (POLAR_DRIFT_HALF_SIZE * 2));
    expect(transform.scaleX).not.toBe(transform.scaleY);
  });

  test("fades once per frame, not once per simulation sub-step", async () => {
    // A slow frame runs several sub-steps onto one surface. The 2D version
    // faded once and then drew each sub-step over it; fading per sub-step
    // would decay the trails by frameScale times as much on exactly the
    // frames that are already struggling.
    const renderer = (await import("./PolarDrift.svelte?raw"))
      .default as string;
    const drawBody = renderer.match(
      /function draw\(phase: number, frameScale: number\): void \{([\s\S]*?)\n {6}\}/,
    )?.[1];

    expect(drawBody).toBeDefined();
    expect(drawBody).toContain("step === 0 ? fade : 0");
  });
});
