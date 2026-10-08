import { describe, expect, test } from "vitest";
import {
  LATTICE_NOISE_GLSL,
  LATTICE_NOISE_TABLE_SIZE,
  LATTICE_NOISE_TEXTURE_SIDE,
  latticeNoise,
  latticeNoiseTable,
} from "./latticeNoise";

const table = latticeNoiseTable(1);

describe("latticeNoise", () => {
  test("fills a table of 4,096 values from 0 to 1 that depends only on the seed", () => {
    expect(table).toHaveLength(4096);
    expect(table.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(latticeNoiseTable(1)).toEqual(table);
    expect(latticeNoiseTable(2)).not.toEqual(table);
    // The first step of the generator from a seed of 1.
    expect(table[0]).toBeCloseTo((1664525 + 1013904223) / 4294967296, 7);
  });

  // Expected values come from p5.js's own noise(), run after noiseSeed(1).
  test("returns what p5.js's noise() returns in one, two and three dimensions", () => {
    expect(latticeNoise(table, 0.3)).toBeCloseTo(0.296378, 5);
    expect(latticeNoise(table, 1.7, 2.4)).toBeCloseTo(0.379883, 5);
    expect(latticeNoise(table, 3.2, 150.35, 0.9)).toBeCloseTo(0.507663, 5);
    expect(latticeNoise(table, 299.95, 11.5)).toBeCloseTo(0.474963, 5);
  });

  test("reads the absolute value of each coordinate", () => {
    expect(latticeNoise(table, -5.5, 7.25, -2.125)).toBeCloseTo(0.476153, 5);
    expect(latticeNoise(table, -5.5, 7.25, -2.125)).toBe(
      latticeNoise(table, 5.5, -7.25, 2.125),
    );
  });

  test("is continuous across a lattice cell's edge", () => {
    expect(latticeNoise(table, 4 - 1e-9, 2.5)).toBeCloseTo(
      latticeNoise(table, 4 + 1e-9, 2.5),
      6,
    );
  });

  test("lays the table out in the shader as the square texture it is uploaded as", () => {
    expect(LATTICE_NOISE_TEXTURE_SIDE ** 2).toBe(LATTICE_NOISE_TABLE_SIZE);
    expect(LATTICE_NOISE_GLSL).toContain("int wrapped = index & 4095;");
    expect(LATTICE_NOISE_GLSL).toContain("wrapped % 64");
    expect(LATTICE_NOISE_GLSL).toContain("wrapped / 64");
    expect(LATTICE_NOISE_GLSL).toContain("octave < 4;");
  });
});
