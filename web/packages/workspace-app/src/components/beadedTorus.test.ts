import { afterEach, describe, expect, test, vi } from "vitest";
import BeadedTorus from "./BeadedTorus.svelte";
import {
  BEADED_TORUS_BEAD_COUNT,
  BEADED_TORUS_COLUMNS,
  BEADED_TORUS_ROWS,
  buildBeadedTorusBeads,
} from "./beadedTorus";
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
vi.mock("./beadedTorus", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./beadedTorus")>();
  return { ...actual, buildBeadedTorusBeads: vi.fn(actual.buildBeadedTorusBeads) };
});

afterEach(() => {
  stopAnimations();
  renderer.draw.mockClear();
});

function bead(beads: Float32Array, column: number, row: number): number[] {
  const offset = (row * BEADED_TORUS_COLUMNS + column) * 4;
  return Array.from(beads.subarray(offset, offset + 3));
}

function lastFrame(): RoundPointFrame {
  return renderer.draw.mock.calls.at(-1)![0] as RoundPointFrame;
}

function phases(): number[] {
  return vi.mocked(buildBeadedTorusBeads).mock.calls.map(([phase]) => phase);
}

describe("buildBeadedTorusBeads", () => {
  test("lays out the sketch's 80 by 40 grid of beads", () => {
    expect(BEADED_TORUS_BEAD_COUNT).toBe(3200);
    expect(buildBeadedTorusBeads(0)).toHaveLength(3200 * 4);
  });

  // Expected values come from the sketch's transform written out as
  // matrices: rotateX(0.5) of rotateY(-0.5) of the torus point, seen from
  // p5's default eye for a 600 pixel canvas.
  test("places a bead where the sketch's tilt and perspective put it", () => {
    const beads = buildBeadedTorusBeads(0);

    const [x, y, radius] = bead(beads, 0, 0);
    expect(x).toBeCloseTo(159.2775, 3);
    expect(y).toBeCloseTo(-109.923, 3);
    expect(radius).toBeCloseTo(1.8034, 3);

    const [farX, farY, farRadius] = bead(beads, 20, 10);
    expect(farX).toBeCloseTo(0, 3);
    expect(farY).toBeCloseTo(315.5581, 3);
    expect(farRadius).toBeCloseTo(0.3995, 3);
  });

  test("streams along the ring and the tube at once", () => {
    const [x, y, radius] = bead(buildBeadedTorusBeads(0.5), 60, 25);

    expect(x).toBeCloseTo(26.8701, 3);
    expect(y).toBeCloseTo(-62.6045, 3);
    expect(radius).toBeCloseTo(0.2947, 3);
  });

  test("repeats after one whole phase, each bead on its neighbour's place", () => {
    const start = buildBeadedTorusBeads(0);
    const next = buildBeadedTorusBeads(1);

    for (const [column, row] of [[0, 0], [17, 5], [79, 39]]) {
      const moved = bead(next, column, row);
      const neighbour = bead(
        start,
        (column + 1) % BEADED_TORUS_COLUMNS,
        (row + 1) % BEADED_TORUS_ROWS,
      );
      for (let index = 0; index < 3; index += 1) {
        expect(moved[index]).toBeCloseTo(neighbour[index]!, 3);
      }
    }
  });

  test("fills the buffer it is handed, every bead fully opaque", () => {
    const out = new Float32Array(BEADED_TORUS_BEAD_COUNT * 4);

    expect(buildBeadedTorusBeads(0.25, out)).toBe(out);
    expect(out.filter((_, index) => index % 4 === 3).every((alpha) => alpha === 1)).toBe(true);
  });
});

describe("Beaded Torus", () => {
  test("draws every bead as a round point through the WebGL2 runner, at the display's density", () => {
    const { run, callbacks } = startAnimation(BeadedTorus, {});
    callbacks.resize(800, 600, false, 0);

    expect(run.runner).toBe("webgl2");
    expect(run.options).toMatchObject({ maxDpr: 2 });
    expect(lastFrame()).toMatchObject({ pointCount: 3200, sourceSize: 600 });
    expect(lastFrame().points).toHaveLength(3200 * 4);
  });

  test("advances 0.6 of a bead spacing per second of animation time", () => {
    const { callbacks } = startAnimation(BeadedTorus, {});
    callbacks.resize(800, 600, false, 0);
    vi.mocked(buildBeadedTorusBeads).mockClear();
    callbacks.frame(1000);
    callbacks.frame(5000);

    expect(phases()).toEqual([expect.closeTo(0.6, 9), expect.closeTo(3, 9)]);
  });

  test("holds one still frame at the start of the loop under reduced motion", () => {
    const { callbacks } = startAnimation(BeadedTorus, {});
    vi.mocked(buildBeadedTorusBeads).mockClear();
    callbacks.resize(800, 600, true, 4000);
    callbacks.reducedMotion();

    expect(phases()).toEqual([0, 0]);
  });

  test("draws with the field its theme tokens name", () => {
    const { run, callbacks } = startAnimation(BeadedTorus, {});
    const host = run.canvas.parentElement!;
    host.style.setProperty("--beaded-torus-field-scale", "2");
    host.style.setProperty("--beaded-torus-tone", "0.5");
    host.style.setProperty("--beaded-torus-opacity", "0.25");
    callbacks.resize(800, 600, false, 0);

    expect(lastFrame()).toMatchObject({ fieldScale: 2, tone: 0.5, opacity: 0.25 });
  });
});
