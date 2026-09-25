import { afterEach, describe, expect, test, vi } from "vitest";
import ChaoticHalo from "./ChaoticHalo.svelte";
import {
  buildChaoticHaloPoints,
  CHAOTIC_HALO_INNER_STEP,
  CHAOTIC_HALO_PARTICLE_COUNT,
  CHAOTIC_HALO_REFERENCE_SIZE,
  createChaoticHaloState,
  fitChaoticHalo,
} from "./chaoticHalo";
import {
  recordingContext2d,
  startAnimation,
  stopAnimations,
} from "../__tests__/canvas";

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./chaoticHalo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chaoticHalo")>();
  return {
    ...actual,
    buildChaoticHaloPoints: vi.fn(actual.buildChaoticHaloPoints),
  };
});

afterEach(stopAnimations);

/// The phase of every draw from here on.
function drawnPhases(): () => number[] {
  const build = vi.mocked(buildChaoticHaloPoints);
  build.mockClear();
  return () => build.mock.calls.map(([phase]) => phase);
}

describe("Chaotic Halo", () => {
  test("keeps the source sketch's density", () => {
    expect(CHAOTIC_HALO_PARTICLE_COUNT).toBe(200);
    expect(CHAOTIC_HALO_INNER_STEP).toBe(1);
  });

  test("advances the source phase 0.003 per second of animation time", () => {
    const { callbacks } = startAnimation(ChaoticHalo, recordingContext2d().ctx);
    callbacks.resize(400, 400, false, 0);
    const phases = drawnPhases();
    for (let timeMs = 100; timeMs <= 1100; timeMs += 50) callbacks.frame(timeMs);

    const drawn = phases();
    expect(drawn.at(-1)! - drawn[0]!).toBeCloseTo(0.003, 9);
  });

  test("steps at most a fifteenth of a second after a stall", () => {
    const { callbacks } = startAnimation(ChaoticHalo, recordingContext2d().ctx);
    callbacks.resize(400, 400, false, 0);
    callbacks.frame(100);
    const phases = drawnPhases();
    callbacks.frame(150);
    callbacks.frame(5150);

    const [before, after] = phases();
    expect(after! - before!).toBeCloseTo((1 / 15) * 0.003, 9);
  });

  test("paints its points in the colour and opacity its theme tokens name", () => {
    const { ctx, ops } = recordingContext2d();
    const { run, callbacks } = startAnimation(ChaoticHalo, ctx);
    run.canvas.parentElement!.style.setProperty("--chaotic-halo-point-rgb", "1, 2, 3");
    run.canvas.parentElement!.style.setProperty("--chaotic-halo-point-alpha", "0.5");
    callbacks.resize(400, 400, false, 0);

    expect(ops).toContainEqual({ op: "set fillStyle", args: ["rgb(1, 2, 3)"] });
    expect(ops).toContainEqual({ op: "set globalAlpha", args: [0.5] });
  });

  test("preserves the source sketch's coupled sine recurrence", () => {
    const state = createChaoticHaloState();
    const points = buildChaoticHaloPoints(0, state, 2, 1, 1);

    expect(Array.from(points)).toEqual([
      200,
      200,
      expect.closeTo(283.30563, 4),
      expect.closeTo(352.48993, 4),
    ]);
    expect(state.x).toBeCloseTo(Math.sin(1));
    expect(state.u).toBeCloseTo(Math.sin(1));
    expect(state.v).toBeCloseTo(Math.cos(1) + 1);
  });

  test("builds a finite circular field inside the source canvas", () => {
    const points = buildChaoticHaloPoints(0.04);

    expect(points.length).toBeGreaterThan(CHAOTIC_HALO_PARTICLE_COUNT);
    expect(points.every(Number.isFinite)).toBe(true);
    expect(
      points.every(
        (coordinate) =>
          coordinate >= 0 &&
          coordinate <= CHAOTIC_HALO_REFERENCE_SIZE,
      ),
    ).toBe(true);
  });

  test("fits rectangular panes with a uniform circular scale", () => {
    expect(fitChaoticHalo(1200, 800)).toEqual({
      centerX: 600,
      centerY: 400,
      scale: 2,
    });
  });
});
