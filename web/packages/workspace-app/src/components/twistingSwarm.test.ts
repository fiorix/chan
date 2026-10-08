import { afterEach, describe, expect, test, vi } from "vitest";
import TwistingSwarm from "./TwistingSwarm.svelte";
import {
  buildTwistingSwarmDots,
  TWISTING_SWARM_DOT_COUNT,
  TWISTING_SWARM_PHASE_PER_FRAME,
} from "./twistingSwarm";
import { startAnimation, stopAnimations } from "../__tests__/canvas";
import type { RoundPointFrame } from "./roundPoints";

const renderer = vi.hoisted(() => ({ draw: vi.fn(), destroy: vi.fn() }));

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./roundPoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./roundPoints")>()),
  createRoundPointRenderer: () => renderer,
}));
vi.mock("./twistingSwarm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./twistingSwarm")>();
  return { ...actual, buildTwistingSwarmDots: vi.fn(actual.buildTwistingSwarmDots) };
});

afterEach(() => {
  stopAnimations();
  renderer.draw.mockClear();
});

function dot(dots: Float32Array, index: number): number[] {
  return Array.from(dots.subarray(index * 4, index * 4 + 4));
}

function lastFrame(): RoundPointFrame {
  return renderer.draw.mock.calls.at(-1)![0] as RoundPointFrame;
}

function phases(): number[] {
  return vi.mocked(buildTwistingSwarmDots).mock.calls.map(([phase]) => phase);
}

describe("buildTwistingSwarmDots", () => {
  test("keeps the 5,013 grid cells inside the circle the sketch's canvas encloses", () => {
    expect(TWISTING_SWARM_DOT_COUNT).toBe(5013);
    expect(buildTwistingSwarmDots(0)).toHaveLength(5013 * 4);
  });

  // Expected values come from running the sketch's loop literally: one
  // matrix product per grid cell, hidden cells included, in its order.
  test("places a dot where the sketch's accumulated turns put it", () => {
    const dots = buildTwistingSwarmDots(0);

    for (const [index, x, y, radius, alpha] of [
      [0, 16.989, 396.613, 0.0235, 0.0047],
      [1000, 434.862, 130.314, 1.375, 0.275],
      [4999, 311.531, 236.367, 0.0851, 0.01702],
    ] as const) {
      const [dotX, dotY, dotRadius, dotAlpha] = dot(dots, index);
      expect(dotX).toBeCloseTo(x, 2);
      expect(dotY).toBeCloseTo(y, 2);
      expect(dotRadius).toBeCloseTo(radius, 3);
      expect(dotAlpha).toBeCloseTo(alpha, 4);
    }
  });

  test("sways each dot along its own turned axis as the clock runs", () => {
    const [x, y, radius, alpha] = dot(buildTwistingSwarmDots(1.25), 2500);

    expect(x).toBeCloseTo(-0.466, 2);
    expect(y).toBeCloseTo(-0.272, 2);
    expect(radius).toBeCloseTo(4.25, 3);
    expect(alpha).toBeCloseTo(0.85, 4);
  });

  test("repeats after one turn of the clock", () => {
    const start = buildTwistingSwarmDots(0.4);
    const next = buildTwistingSwarmDots(0.4 + Math.PI * 2);

    for (const index of [0, 1234, 5012]) {
      for (let part = 0; part < 4; part += 1) {
        expect(dot(next, index)[part]).toBeCloseTo(dot(start, index)[part]!, 2);
      }
    }
  });

  test("runs its clock forward, by the sketch's corner cell", () => {
    expect(TWISTING_SWARM_PHASE_PER_FRAME).toBeCloseTo(0.0378858, 6);
  });
});

describe("Twisting Swarm", () => {
  test("draws every dot as a round point through the WebGL2 runner, at the display's density", () => {
    const { run, callbacks } = startAnimation(TwistingSwarm, {});
    callbacks.resize(800, 600, false, 0);

    expect(run.runner).toBe("webgl2");
    expect(run.options).toMatchObject({ maxDpr: 2 });
    expect(lastFrame()).toMatchObject({ pointCount: 5013, sourceSize: 800 });
    expect(lastFrame().points).toHaveLength(5013 * 4);
  });

  test("runs the sketch's clock at 7.5 source frames a second", () => {
    const { callbacks } = startAnimation(TwistingSwarm, {});
    callbacks.resize(800, 600, false, 0);
    vi.mocked(buildTwistingSwarmDots).mockClear();
    callbacks.frame(1000);

    expect(phases()).toEqual([expect.closeTo(7.5 * 0.0378858223, 6)]);
  });

  test("holds one still frame at the start of the loop under reduced motion", () => {
    const { callbacks } = startAnimation(TwistingSwarm, {});
    vi.mocked(buildTwistingSwarmDots).mockClear();
    callbacks.resize(800, 600, true, 4000);
    callbacks.reducedMotion();

    expect(phases()).toEqual([0, 0]);
  });

  test("draws with the field its theme tokens name", () => {
    const { run, callbacks } = startAnimation(TwistingSwarm, {});
    const host = run.canvas.parentElement!;
    host.style.setProperty("--twisting-swarm-field-scale", "2");
    host.style.setProperty("--twisting-swarm-tone", "0.5");
    host.style.setProperty("--twisting-swarm-opacity", "0.25");
    callbacks.resize(800, 600, false, 0);

    expect(lastFrame()).toMatchObject({ fieldScale: 2, tone: 0.5, opacity: 0.25 });
  });
});
