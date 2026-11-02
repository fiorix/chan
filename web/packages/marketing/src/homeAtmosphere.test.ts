import { expect, test } from "vitest";
import { buildBeadedTorusBeads } from "../../workspace-app/src/components/beadedTorus";
import { buildHomeAtmosphereFrame, HOME_POINT_COUNT, sectionScrollProgress } from "./homeAtmosphere";

test("scroll progress reaches the wave as the first section enters, and reverses", () => {
  expect(sectionScrollProgress(0, 1000, 1000)).toBe(0);
  expect(sectionScrollProgress(300, 1000, 1000)).toBe(0);
  expect(sectionScrollProgress(600, 1000, 1000)).toBe(0.5);
  expect(sectionScrollProgress(900, 1000, 1000)).toBe(1);
  expect(sectionScrollProgress(5000, 1000, 1000)).toBe(1);
  expect(sectionScrollProgress(300, 1000, 1000)).toBe(0);
  expect(sectionScrollProgress(-50, 600, 800)).toBe(0);
  expect(sectionScrollProgress(0, 0, 0)).toBe(0);
});

test("the hero starts with the existing beaded torus geometry", () => {
  const torus = buildBeadedTorusBeads(0);
  const points = buildHomeAtmosphereFrame(1200, 800, 0, 0);
  for (let offset = 0; offset < points.length; offset += 4) {
    for (let axis = 0; axis < 3; axis += 1) expect(points[offset + axis]).toBeCloseTo(torus[offset + axis] * 1.55, 3);
    expect(points[offset + 3]).toBe(1);
  }
});

test("the morph keeps every bead finite through phone and desktop dimensions without allocating a new buffer", () => {
  const buffer = new Float32Array(HOME_POINT_COUNT * 4);
  for (const [width, height] of [[320, 844], [1440, 1000], [844, 390]]) {
    for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
      const points = buildHomeAtmosphereFrame(width, height, 2500, progress, buffer);
      expect(points).toBe(buffer);
      expect(points.every(Number.isFinite)).toBe(true);
      const invalidRadius = points.findIndex((value, index) => index % 4 === 2 && value < 0);
      const invalidAlpha = points.findIndex((value, index) => index % 4 === 3 && (value <= 0 || value > 1));
      const frame = `${width}x${height} at ${progress}`;
      expect(invalidRadius, `radius in ${frame}`).toBe(-1);
      expect(invalidAlpha, `alpha in ${frame}`).toBe(-1);
    }
  }
});

test("the midpoint moves beads between both shapes and clamps overscroll", () => {
  const torus = buildHomeAtmosphereFrame(1200, 800, 1000, 0);
  const wave = buildHomeAtmosphereFrame(1200, 800, 1000, 1);
  const middle = buildHomeAtmosphereFrame(1200, 800, 1000, 0.5);
  expect(middle[0]).toBeCloseTo((torus[0] + wave[0]) / 2, 3);
  expect(middle[1]).toBeCloseTo((torus[1] + wave[1]) / 2, 3);
  expect(wave).not.toEqual(torus);
  expect(buildHomeAtmosphereFrame(1200, 800, 1000, -1)).toEqual(torus);
  expect(buildHomeAtmosphereFrame(1200, 800, 1000, 2)).toEqual(wave);
});
