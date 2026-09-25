import { afterEach, describe, expect, test, vi } from "vitest";
import PolarDrift from "./PolarDrift.svelte";
import {
  advancePolarDriftParticles,
  createPolarDriftParticles,
  fitPolarDrift,
  POLAR_DRIFT_HALF_SIZE,
  POLAR_DRIFT_PARTICLE_COUNT,
  POLAR_DRIFT_POINT_VERTEX_SHADER,
  POLAR_DRIFT_SURFACE_FRAGMENT_SHADER,
} from "./polarDrift";
import { recordingWebgl2, startAnimation, stopAnimations } from "../__tests__/canvas";

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./polarDrift", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./polarDrift")>();
  return {
    ...actual,
    advancePolarDriftParticles: vi.fn(actual.advancePolarDriftParticles),
  };
});

afterEach(stopAnimations);

describe("Polar Drift", () => {
  test("turns its drift 0.06 radians per second of animation time", () => {
    const { callbacks } = startAnimation(PolarDrift, recordingWebgl2().gl);
    callbacks.resize(800, 800, false, 0);
    const advance = vi.mocked(advancePolarDriftParticles);
    advance.mockClear();
    callbacks.frame(1000);
    callbacks.frame(3000);

    const phases = advance.mock.calls.map(([, phase]) => phase);
    expect(phases[0]).toBeCloseTo(0.06, 9);
    expect(phases.at(-1)).toBeCloseTo(0.18, 9);
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

  test("renders through WebGL2, trailing into an off-screen surface", () => {
    // The 2D path collected 9,999 ctx.rect() calls into one fill per frame,
    // which Linux software-rasterizes.
    const { gl, calls } = recordingWebgl2();
    const { run, callbacks } = startAnimation(PolarDrift, gl);
    expect(run.runner).toBe("webgl2");
    callbacks.resize(800, 800, false, 0);

    expect(calls.map(({ op }) => op)).toContain("framebufferTexture2D");
    expect(calls).toContainEqual({
      op: "bufferData",
      args: ["ARRAY_BUFFER", expect.any(Float32Array), "DYNAMIC_DRAW"],
    });
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

  test("fades once per frame, not once per simulation sub-step", () => {
    // A slow frame runs several sub-steps onto one surface. The 2D version
    // faded once and then drew each sub-step over it; fading per sub-step
    // would decay the trails by frameScale times as much on exactly the
    // frames that are already struggling.
    const { gl, calls } = recordingWebgl2();
    const { callbacks } = startAnimation(PolarDrift, gl);
    callbacks.resize(800, 800, false, 0);
    callbacks.frame(1000);
    calls.length = 0;
    // 50 ms is three source frames at 60 per second.
    callbacks.frame(1050);

    const fades = calls
      .filter(
        ({ op, args }) =>
          op === "uniform1f" && (args[0] as { uniform: string }).uniform === "uFade",
      )
      .map(({ args }) => args[1]);
    expect(fades.filter((fade) => fade !== 0)).toEqual([
      expect.closeTo(1 - (1 - 5 / 255) ** 3, 9),
    ]);
  });
});
