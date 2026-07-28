import { describe, expect, test } from "vitest";
import {
  buildExponentialThreadPoints,
  EXPONENTIAL_THREAD_GUTTER,
  EXPONENTIAL_THREAD_VERTEX_COUNT,
  fitExponentialThread,
} from "./exponentialThread";

describe("buildExponentialThreadPoints", () => {
  test("keeps the dim renderer tuning and source attribution", async () => {
    const renderer = (await import("./ExponentialThread.svelte?raw"))
      .default as string;
    const geometry = (await import("./exponentialThread.ts?raw"))
      .default as string;

    expect(renderer).toMatch(/const PHASE_SPEED = 0\.018;/);
    expect(renderer).toMatch(/--exponential-thread-line-alpha: 0\.045;/);
    expect(geometry).toContain(
      "https://x.com/hisadan/status/2039716286528450634",
    );
  });

  test("preserves the source sketch's exponential curve", () => {
    const points = buildExponentialThreadPoints(0);

    expect(points).toHaveLength(EXPONENTIAL_THREAD_VERTEX_COUNT * 2);
    expect(points[0]).toBeCloseTo(0);
    expect(points[1]).toBeCloseTo(3);
    for (let index = 0; index < points.length; index += 2) {
      expect(points[index]).toBeCloseTo(0);
    }
  });

  test("changes horizontal frequency with the animation phase", () => {
    const collapsed = buildExponentialThreadPoints(0);
    const expanded = buildExponentialThreadPoints(Math.PI / 2);

    expect(expanded[200]).not.toBeCloseTo(collapsed[200]);
    expect(expanded[201]).toBeCloseTo(collapsed[201]);
  });

  test("fits the outer radius inside the pane bar gutter", () => {
    const transform = fitExponentialThread(1400, 800);
    const radius = transform.centerY - EXPONENTIAL_THREAD_GUTTER;

    expect(transform.centerX).toBe(700);
    expect(transform.centerY).toBe(400);
    expect(radius).toBeCloseTo(376);
    expect(transform.scaleX / transform.scaleY).toBeCloseTo(1.3);
  });

  test("caps the horizontal stretch inside narrow panes", () => {
    const transform = fitExponentialThread(500, 800);

    expect(transform.scaleX).toBeCloseTo(transform.scaleY);
  });
});
