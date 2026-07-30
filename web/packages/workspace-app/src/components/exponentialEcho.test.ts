import { describe, expect, test } from "vitest";
import {
  buildExponentialEchoPoints,
  exponentialEchoTrailFade,
  EXPONENTIAL_ECHO_PHASE_PERIOD,
  EXPONENTIAL_ECHO_SOURCE_FADE_ALPHA,
  EXPONENTIAL_ECHO_VERTEX_COUNT,
  fitExponentialEcho,
  wrapExponentialEchoPhase,
} from "./exponentialEcho";

describe("Exponential Echo", () => {
  test("keeps the source trail behavior, cadence, and attribution", async () => {
    const renderer = (await import("./ExponentialEcho.svelte?raw"))
      .default as string;
    const geometry = (await import("./exponentialEcho.ts?raw"))
      .default as string;

    expect(renderer).toContain(
      'ctx.globalCompositeOperation = "destination-out";',
    );
    expect(renderer).toContain("{ frameRate: 30 }");
    expect(geometry).toContain(
      "https://x.com/hisadan/status/2039722375625986239",
    );
  });

  test("preserves the source sketch's growing-frequency curve", () => {
    const collapsed = buildExponentialEchoPoints(0);
    const expanded = buildExponentialEchoPoints(0.5);

    expect(collapsed).toHaveLength(
      EXPONENTIAL_ECHO_VERTEX_COUNT * 2,
    );
    expect(collapsed[0]).toBe(0);
    expect(collapsed[1]).toBe(3);
    expect(collapsed.every((value, index) => index % 2 === 1 || value === 0))
      .toBe(true);
    expect(expanded[200]).not.toBeCloseTo(collapsed[200]);
    expect(expanded[201]).toBeCloseTo(collapsed[201]);
  });

  test("converts the source fade to elapsed-time-independent alpha", () => {
    expect(exponentialEchoTrailFade(1 / 60)).toBeCloseTo(
      EXPONENTIAL_ECHO_SOURCE_FADE_ALPHA,
    );
    expect(exponentialEchoTrailFade(1 / 30)).toBeGreaterThan(
      EXPONENTIAL_ECHO_SOURCE_FADE_ALPHA,
    );
  });

  test("fits the source square to the pane's long axis", () => {
    expect(fitExponentialEcho(1400, 800)).toEqual({
      centerX: 700,
      centerY: 400,
      scale: 1.75,
    });
    expect(fitExponentialEcho(600, 900).scale).toBeCloseTo(1.125);
  });

  test("wraps only at the curve's exact sampled phase period", () => {
    expect(
      wrapExponentialEchoPhase(EXPONENTIAL_ECHO_PHASE_PERIOD + 0.5),
    ).toBeCloseTo(0.5);
    expect(wrapExponentialEchoPhase(-0.5)).toBeCloseTo(
      EXPONENTIAL_ECHO_PHASE_PERIOD - 0.5,
    );
  });
});
