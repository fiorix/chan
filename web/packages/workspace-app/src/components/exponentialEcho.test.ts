import { afterEach, describe, expect, test, vi } from "vitest";
import ExponentialEcho from "./ExponentialEcho.svelte";
import {
  buildExponentialEchoPoints,
  exponentialEchoTrailFade,
  EXPONENTIAL_ECHO_PHASE_PERIOD,
  EXPONENTIAL_ECHO_SOURCE_FADE_ALPHA,
  EXPONENTIAL_ECHO_VERTEX_COUNT,
  fitExponentialEcho,
  wrapExponentialEchoPhase,
} from "./exponentialEcho";
import {
  recordingContext2d,
  startAnimation,
  stopAnimations,
} from "../__tests__/canvas";

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);

afterEach(stopAnimations);

describe("Exponential Echo", () => {
  test("fades the last frame out under the next one instead of clearing it", () => {
    const { ctx, ops } = recordingContext2d();
    const { callbacks } = startAnimation(ExponentialEcho, ctx);
    callbacks.resize(400, 300, false, 0);
    expect(ops.map(({ op }) => op)).toContain("clearRect");

    ops.length = 0;
    callbacks.frame(50);
    const fade = ops.findIndex(
      ({ op, args }) =>
        op === "set globalCompositeOperation" && args[0] === "destination-out",
    );
    expect(fade).toBeGreaterThanOrEqual(0);
    expect(ops.slice(fade)).toContainEqual({ op: "fillRect", args: [0, 0, 400, 300] });
    expect(ops.map(({ op }) => op)).not.toContain("clearRect");
  });

  test("runs at thirty frames a second", () => {
    const { run } = startAnimation(ExponentialEcho, recordingContext2d().ctx);

    expect(run.options.frameRate).toBe(30);
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
