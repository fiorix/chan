import { describe, expect, test } from "vitest";
import {
  buildRecursiveArcBloom,
  fitRecursiveArcBloom,
  normalizeRecursiveArcSweep,
  recursiveArcBloomNoise,
  RECURSIVE_ARC_BLOOM_ARM_COUNT,
  RECURSIVE_ARC_BLOOM_SEGMENT_COUNT,
} from "./recursiveArcBloom";

describe("Recursive Arc Bloom", () => {
  test("keeps the source timing and attribution", async () => {
    const renderer = (await import("./RecursiveArcBloom.svelte?raw"))
      .default as string;
    const geometry = (await import("./recursiveArcBloom.ts?raw"))
      .default as string;

    expect(renderer).toMatch(/const NOISE_PHASE_SPEED = 1 \/ 18;/);
    expect(geometry).toContain(
      "https://x.com/Hau_kun/status/1931711978235683306",
    );
  });

  test("builds 16 radial chains with 19 shrinking arcs each", () => {
    const arcs = buildRecursiveArcBloom(0);

    expect(arcs).toHaveLength(
      RECURSIVE_ARC_BLOOM_ARM_COUNT *
        RECURSIVE_ARC_BLOOM_SEGMENT_COUNT,
    );
    for (let arm = 0; arm < RECURSIVE_ARC_BLOOM_ARM_COUNT; arm += 1) {
      const chain = arcs.filter((arc) => arc.arm === arm);
      expect(chain).toHaveLength(RECURSIVE_ARC_BLOOM_SEGMENT_COUNT);
      expect(chain.map((arc) => arc.diameter)).toEqual([
        57, 54, 51, 48, 45, 42, 39, 36, 33, 30, 27, 24, 21, 18, 15,
        12, 9, 6, 3,
      ]);
    }
  });

  test("alternates the recursive turn while accumulating each center", () => {
    const chain = buildRecursiveArcBloom(0).slice(
      0,
      RECURSIVE_ARC_BLOOM_SEGMENT_COUNT,
    );

    expect(chain[0].direction).toBe(-1);
    expect(chain[1].direction).toBe(1);
    expect(chain[0].x).toBeCloseTo(Math.cos(-1) * 57);
    expect(chain[0].y).toBeCloseTo(Math.sin(-1) * 57);
    expect(chain[1].x - chain[0].x).toBeCloseTo(Math.cos(1) * 54);
    expect(chain[1].y - chain[0].y).toBeCloseTo(Math.sin(1) * 54);
  });

  test("rotates the same chain through each radial arm", () => {
    const arcs = buildRecursiveArcBloom(1.25);
    const first = arcs[0];
    const second = arcs[RECURSIVE_ARC_BLOOM_SEGMENT_COUNT];
    const step = Math.PI / 8;

    expect(Math.hypot(second.x, second.y)).toBeCloseTo(
      Math.hypot(first.x, first.y),
    );
    expect(Math.atan2(second.y, second.x)).toBeCloseTo(
      Math.atan2(first.y, first.x) + step,
    );
    expect(second.startAngle - first.startAngle).toBeCloseTo(step);
    expect(second.endAngle - first.endAngle).toBeCloseTo(step);
  });

  test("uses deterministic smooth noise and clockwise normalized sweeps", () => {
    const sample = recursiveArcBloomNoise(2.125);

    expect(sample).toBeCloseTo(0.6330951963725824);
    expect(recursiveArcBloomNoise(2.125)).toBe(sample);
    expect(Math.abs(recursiveArcBloomNoise(2.126) - sample)).toBeLessThan(
      0.01,
    );
    expect(normalizeRecursiveArcSweep(Math.PI * 5)).toBeCloseTo(Math.PI);
    expect(normalizeRecursiveArcSweep(Math.PI * 4)).toBeCloseTo(
      Math.PI * 2,
    );
  });

  test("fits rectangular panes with one centered circular scale", () => {
    expect(fitRecursiveArcBloom(1440, 900)).toEqual({
      centerX: 720,
      centerY: 450,
      scale: 1.25,
    });
  });
});
