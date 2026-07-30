import { describe, expect, test } from "vitest";
import {
  buildSpiralSpokes,
  fitSpiralSpokes,
  spiralSpokesOpacity,
  spiralSpokesPhase,
} from "./spiralSpokes";

describe("Spiral Spokes", () => {
  test("keeps the quadrupled cadence and attribution", async () => {
    const renderer = (await import("./SpiralSpokes.svelte?raw"))
      .default as string;
    const geometry = (await import("./spiralSpokes.ts?raw"))
      .default as string;

    expect(renderer).toMatch(/const STEPS_PER_SECOND = 4;/);
    expect(geometry).toContain(
      "https://x.com/hisadan/status/1945386079974301805",
    );
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
