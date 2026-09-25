// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import SixfoldVortex from "./SixfoldVortex.svelte";
import {
  advanceSixfoldVortexParticles,
  createSixfoldVortexParticles,
  fitSixfoldVortex,
  isSixfoldVortexPointDrawable,
  SIXFOLD_VORTEX_PARTICLE_COUNT,
  SIXFOLD_VORTEX_POINT_VERTEX_SHADER,
  SIXFOLD_VORTEX_SURFACE_FRAGMENT_SHADER,
} from "./sixfoldVortex";
import {
  recordingWebgl2,
  startAnimation,
  stopAnimations,
  type CanvasOp,
} from "../__tests__/canvas";

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./sixfoldVortex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sixfoldVortex")>();
  return {
    ...actual,
    advanceSixfoldVortexParticles: vi.fn(actual.advanceSixfoldVortexParticles),
  };
});

afterEach(() => {
  stopAnimations();
  vi.restoreAllMocks();
});

/// The source time of every simulation step from here on.
function steppedTimes(): () => number[] {
  const advance = vi.mocked(advanceSixfoldVortexParticles);
  advance.mockClear();
  return () => advance.mock.calls.map(([, sourceTime]) => sourceTime);
}

/// The point counts of the particle draws in `calls`.
function pointDraws(calls: CanvasOp[]): number[] {
  return calls
    .filter(({ op, args }) => op === "drawArrays" && args[0] === "POINTS")
    .map(({ args }) => args[2] as number);
}

describe("Sixfold Vortex", () => {
  test("runs the source simulation 60 steps per second of animation time", () => {
    const { callbacks } = startAnimation(SixfoldVortex, recordingWebgl2().gl);
    callbacks.resize(800, 800, false, 0);
    callbacks.frame(1000);
    const times = steppedTimes();
    for (let timeMs = 1050; timeMs <= 2050; timeMs += 50) callbacks.frame(timeMs);

    const stepped = times();
    expect(stepped.at(-1)! - stepped[0]!).toBeCloseTo(60, 9);
  });

  test("catches up at most four source steps after a stall", () => {
    const { callbacks } = startAnimation(SixfoldVortex, recordingWebgl2().gl);
    callbacks.resize(800, 800, false, 0);
    callbacks.frame(1000);
    const times = steppedTimes();
    callbacks.frame(1050);
    callbacks.frame(6050);
    callbacks.frame(6100);

    const [, stalled, after] = times();
    expect(after! - stalled!).toBeCloseTo(4, 9);
  });

  test("a resize keeps the simulation where it was", () => {
    // A pane resize arrives as a burst of resizes; restarting the field or
    // its clock on each one would visibly reset the vortex while dragging.
    const { callbacks } = startAnimation(SixfoldVortex, recordingWebgl2().gl);
    callbacks.resize(800, 800, false, 0);
    callbacks.frame(1000);
    callbacks.frame(1050);
    const advance = vi.mocked(advanceSixfoldVortexParticles);
    const [particles, before] = advance.mock.calls.at(-1)!;
    callbacks.resize(600, 600, false, 1100);

    const [resizedParticles, resized] = advance.mock.calls.at(-1)!;
    expect(resizedParticles).toBe(particles);
    expect(resized).toBeGreaterThan(before);
  });

  test("a clock that steps back does not run the simulation backwards", () => {
    const { callbacks } = startAnimation(SixfoldVortex, recordingWebgl2().gl);
    callbacks.resize(800, 800, false, 0);
    callbacks.frame(2000);
    const times = steppedTimes();
    callbacks.frame(1500);
    callbacks.frame(1550);

    const [back, next] = times();
    expect(next).toBe(back);
  });

  test("renders through WebGL2, trailing into an off-screen surface", () => {
    const { gl, calls } = recordingWebgl2();
    const { run, callbacks } = startAnimation(SixfoldVortex, gl);
    expect(run.runner).toBe("webgl2");
    callbacks.resize(800, 800, false, 0);

    expect(calls.map(({ op }) => op)).toContain("framebufferTexture2D");
    expect(calls).toContainEqual({
      op: "bufferData",
      args: ["ARRAY_BUFFER", expect.any(Float32Array), "DYNAMIC_DRAW"],
    });
    expect(SIXFOLD_VORTEX_SURFACE_FRAGMENT_SHADER).toContain(
      "mix(previous, uBackgroundColor, uFade)",
    );
    expect(SIXFOLD_VORTEX_POINT_VERTEX_SHADER).toContain(
      "gl_PointSize = 1.0;",
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

  test("tells an escaped startup particle from a drawable one", () => {
    const particles = new Float32Array([0.01, 0.01]);

    advanceSixfoldVortexParticles(particles, 0);

    expect(Math.max(...particles.map(Math.abs))).toBeGreaterThan(1_000_000);
    expect(
      isSixfoldVortexPointDrawable(particles[0], particles[1], 800, 800),
    ).toBe(false);
    expect(isSixfoldVortexPointDrawable(400, 400, 800, 800)).toBe(true);
    expect(isSixfoldVortexPointDrawable(Number.NaN, 400, 800, 800)).toBe(
      false,
    );
  });

  test("never traces escaped startup particles into the point upload", () => {
    const randomValues = [0.5, 0.2499863, 0.25];
    let randomIndex = 0;
    vi.spyOn(Math, "random").mockImplementation(() => {
      const value = randomValues[randomIndex % randomValues.length];
      randomIndex += 1;
      return value;
    });
    const { gl, calls } = recordingWebgl2();
    const { callbacks } = startAnimation(SixfoldVortex, gl);
    callbacks.resize(800, 800, false, 0);

    expect(pointDraws(calls)).toEqual([SIXFOLD_VORTEX_PARTICLE_COUNT]);
    calls.length = 0;
    callbacks.frame(100);

    expect(pointDraws(calls)).toEqual([]);
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
