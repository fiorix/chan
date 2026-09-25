import { afterEach, describe, expect, test, vi } from "vitest";
import MutualForceStarburst from "./MutualForceStarburst.svelte";
import {
  advanceMutualForceParticles,
  createMutualForceParticles,
  createMutualForceStaticSnapshot,
  fitMutualForceStarburst,
  MUTUAL_FORCE_PARTICLE_COUNT,
} from "./mutualForceStarburst";
import {
  recordingContext2d,
  startAnimation,
  stopAnimations,
} from "../__tests__/canvas";

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./mutualForceStarburst", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mutualForceStarburst")>();
  return {
    ...actual,
    advanceMutualForceParticles: vi.fn(actual.advanceMutualForceParticles),
  };
});

afterEach(stopAnimations);

describe("Mutual Force Starburst", () => {
  test("steps the source simulation 60 times per second of animation time", () => {
    const { callbacks } = startAnimation(MutualForceStarburst, recordingContext2d().ctx);
    callbacks.resize(800, 800, false, 0);
    callbacks.frame(1000);
    const advance = vi.mocked(advanceMutualForceParticles);
    advance.mockClear();
    for (let timeMs = 1050; timeMs <= 2000; timeMs += 50) callbacks.frame(timeMs);

    expect(advance).toHaveBeenCalledTimes(60);
  });

  test("catches up at most four source steps after a stall", () => {
    const { callbacks } = startAnimation(MutualForceStarburst, recordingContext2d().ctx);
    callbacks.resize(800, 800, false, 0);
    callbacks.frame(1000);
    const advance = vi.mocked(advanceMutualForceParticles);
    advance.mockClear();
    callbacks.frame(6000);

    expect(advance).toHaveBeenCalledTimes(4);
  });

  test("fades each source step by 9/255 of the background its theme token names", () => {
    const { ctx, ops } = recordingContext2d();
    const { run, callbacks } = startAnimation(MutualForceStarburst, ctx);
    const host = run.canvas.parentElement!;
    host.style.setProperty("--mutual-force-starburst-background-rgb", "1, 2, 3");
    host.style.setProperty("--mutual-force-starburst-point-rgb", "4, 5, 6");
    host.style.setProperty("--mutual-force-starburst-point-alpha", "0.5");
    callbacks.resize(800, 800, false, 0);
    ops.length = 0;
    callbacks.frame(1000);

    const fade = ops.findIndex(
      ({ op, args }) => op === "set globalAlpha" && args[0] === 9 / 255,
    );
    expect(fade).toBeGreaterThanOrEqual(0);
    expect(ops.slice(fade, fade + 3)).toEqual([
      { op: "set globalAlpha", args: [9 / 255] },
      { op: "set fillStyle", args: ["rgb(1, 2, 3)"] },
      { op: "fillRect", args: [0, 0, 800, 800] },
    ]);
    expect(ops).toContainEqual({ op: "set strokeStyle", args: ["rgb(4, 5, 6)"] });
    expect(ops).toContainEqual({ op: "set globalAlpha", args: [0.5] });
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

  test("reflects at supplied rectangular pane bounds", () => {
    const particles = new Float32Array([
      500, -299, 2, -2,
    ]);

    advanceMutualForceParticles(particles, 600, 300);

    expect([...particles]).toEqual([502, -297, 2, 2]);
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
