import { afterEach, describe, expect, test, vi } from "vitest";
import SpiralSpokes from "./SpiralSpokes.svelte";
import {
  buildSpiralSpokes,
  fitSpiralSpokes,
  spiralSpokesOpacity,
  spiralSpokesPhase,
} from "./spiralSpokes";
import {
  recordingContext2d,
  startAnimation,
  stopAnimations,
} from "../__tests__/canvas";

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./spiralSpokes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./spiralSpokes")>();
  return { ...actual, spiralSpokesOpacity: vi.fn(actual.spiralSpokesOpacity) };
});

afterEach(stopAnimations);

describe("Spiral Spokes", () => {
  test("steps the source sketch four times per second of animation time", () => {
    const { callbacks } = startAnimation(SpiralSpokes, recordingContext2d().ctx);
    callbacks.resize(800, 800, false, 0);
    callbacks.frame(1000);
    const opacity = vi.mocked(spiralSpokesOpacity);
    opacity.mockClear();
    callbacks.frame(2000);
    callbacks.frame(2500);

    const [first, second] = opacity.mock.calls.map(([step]) => step);
    expect(second! - first!).toBeCloseTo(2, 9);
  });

  test("grows from two spokes at the source rates", () => {
    expect(buildSpiralSpokes(0)).toHaveLength(2);
    expect(buildSpiralSpokes(15)).toHaveLength(17);
    expect(buildSpiralSpokes(30)).toHaveLength(32);
    expect(spiralSpokesPhase(30)).toBe(1.5);
  });

  test("preserves the source sketch's coupled endpoints", () => {
    const spokes = buildSpiralSpokes(2);

    expect(spokes).toHaveLength(4);
    expect(spokes[0]).toEqual({
      start: { x: 0, y: 2 },
      end: { x: 0, y: 398 },
    });
    expect(spokes[1].start.x).toBeCloseTo(2 * Math.sin(Math.PI * 0.05));
    expect(spokes[1].start.y).toBeCloseTo(2 * Math.cos(Math.PI * 0.05));
    expect(spokes[1].end.x).toBeCloseTo(398);
    expect(spokes[1].end.y).toBeCloseTo(0);
  });

  test("fades with the source alpha expression", () => {
    expect(spiralSpokesOpacity(0)).toBe(1);
    expect(spiralSpokesOpacity(30)).toBeCloseTo(251.5 / 255);
    expect(spiralSpokesOpacity(2000)).toBe(0);
  });

  test("fits rectangular panes with a uniform circular scale", () => {
    expect(fitSpiralSpokes(1400, 900)).toEqual({
      centerX: 700,
      centerY: 450,
      scale: 1.125,
    });
  });
});
