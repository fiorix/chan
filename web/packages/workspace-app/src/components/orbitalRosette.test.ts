import { afterEach, describe, expect, test, vi } from "vitest";
import OrbitalRosette from "./OrbitalRosette.svelte";
import {
  buildOrbitalCircles,
  ORBITAL_RING_COUNT,
} from "./orbitalRosette";
import {
  recordingContext2d,
  startAnimation,
  stopAnimations,
} from "../__tests__/canvas";

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./orbitalRosette", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./orbitalRosette")>();
  return { ...actual, buildOrbitalCircles: vi.fn(actual.buildOrbitalCircles) };
});

afterEach(stopAnimations);

describe("buildOrbitalCircles", () => {
  test("turns -0.3 radians per second of animation time", () => {
    const { callbacks } = startAnimation(OrbitalRosette, recordingContext2d().ctx);
    callbacks.resize(800, 800, false, 0);
    const build = vi.mocked(buildOrbitalCircles);
    build.mockClear();
    callbacks.frame(1000);
    callbacks.frame(3000);

    expect(build.mock.calls.map(([phase]) => phase)).toEqual([
      expect.closeTo(-0.3, 9),
      expect.closeTo(-0.9, 9),
    ]);
  });

  test("strokes its rings in the colour, opacity and size its theme tokens name", () => {
    const { ctx, ops } = recordingContext2d();
    const { run, callbacks } = startAnimation(OrbitalRosette, ctx);
    const host = run.canvas.parentElement!;
    host.style.setProperty("--orbital-rosette-stroke-rgb", "1, 2, 3");
    host.style.setProperty("--orbital-rosette-alpha-base", "0.1");
    host.style.setProperty("--orbital-rosette-alpha-range", "0");
    host.style.setProperty("--orbital-rosette-size-scale", "2");
    const build = vi.mocked(buildOrbitalCircles);
    build.mockClear();
    callbacks.resize(800, 800, false, 0);

    expect(ops).toContainEqual({ op: "set strokeStyle", args: ["rgb(1, 2, 3)"] });
    expect(ops).toContainEqual({ op: "set globalAlpha", args: [0.1] });
    // 800 px is the reference size, so the scale is the token itself.
    expect(build.mock.calls.at(-1)?.[1]).toBe(2);
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
