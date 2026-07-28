import { describe, expect, test } from "vitest";
import {
  buildConcentricPulseRings,
  concentricPulseGap,
} from "./concentricPulse";

describe("Concentric Pulse", () => {
  test("keeps the source timing and attribution", async () => {
    const renderer = (await import("./ConcentricPulse.svelte?raw"))
      .default as string;
    const geometry = (await import("./concentricPulse.ts?raw"))
      .default as string;

    expect(renderer).toMatch(/const PHASE_SPEED = 0\.1885;/);
    expect(geometry).toContain(
      "https://x.com/hisadan/status/2003482480490520895",
    );
  });

  test("breathes between the source sketch's sparse and dense gaps", () => {
    expect(concentricPulseGap(0)).toBe(99);
    expect(concentricPulseGap(Math.PI)).toBe(1);
    expect(buildConcentricPulseRings(0)).toHaveLength(6);
    expect(buildConcentricPulseRings(Math.PI)).toHaveLength(560);
  });

  test("uses the source sketch's radius-dependent polygon vertices", () => {
    const rings = buildConcentricPulseRings(0);

    expect(rings[0]).toEqual({
      radius: 10,
      vertices: [{ x: 10, y: 0 }],
    });
    expect(rings[1].radius).toBe(109);
    expect(rings[1].vertices).toHaveLength(6);
  });
});
