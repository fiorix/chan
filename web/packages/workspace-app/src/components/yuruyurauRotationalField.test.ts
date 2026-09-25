// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import FourteenfoldBloom from "./FourteenfoldBloom.svelte";
import YuruyurauRotationalField from "./YuruyurauRotationalField.svelte";
import { YURUYURAU_ROTATIONAL_SOURCE_SIZE } from "./yuruyurauRotationalField";
import {
  recordingWebgl2,
  startAnimation,
  stopAnimations,
  type CanvasOp,
} from "../__tests__/canvas";

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);

afterEach(stopAnimations);

/// Every value `uniform` was set to in `calls`.
function uniformValues(calls: CanvasOp[], uniform: string): unknown[] {
  return calls
    .filter(
      ({ op, args }) =>
        op === "uniform1f" && (args[0] as { uniform: string }).uniform === uniform,
    )
    .map(({ args }) => args[1]);
}

/// The shared renderer on its own, with a trace of four points.
function fieldProps(centerFadeRadius: number) {
  return {
    buildBasePoints: vi.fn(
      (_sourceTime: number, _into?: Float32Array) =>
        new Float32Array([0, 0, 1, 1, 2, 2, 3, 3]),
    ),
    rotationCount: 3,
    sourceTimePerMs: 0.001,
    centerFadeRadius,
  };
}

describe("Yuruyurau rotational field", () => {
  test("draws its trace once per rotation, each turned by an equal share of a full turn", () => {
    const { gl, calls } = recordingWebgl2();
    const { run, callbacks } = startAnimation(YuruyurauRotationalField, gl, fieldProps(140));
    callbacks.resize(800, 800, false, 0);

    expect(run.runner).toBe("webgl2");
    expect(uniformValues(calls, "uRotation")).toEqual([
      0,
      expect.closeTo((2 * Math.PI) / 3, 9),
      expect.closeTo((4 * Math.PI) / 3, 9),
    ]);
    expect(calls.filter(({ op, args }) => op === "drawArrays" && args[0] === "POINTS")).toHaveLength(3);
  });

  test("scales its 400-unit source space to cover the drawing buffer", () => {
    const { gl, calls } = recordingWebgl2();
    startAnimation(YuruyurauRotationalField, gl, fieldProps(140)).callbacks.resize(800, 800, false, 0);

    // The recording context's drawing buffer is 100 by 100.
    expect(YURUYURAU_ROTATIONAL_SOURCE_SIZE).toBe(400);
    expect(uniformValues(calls, "uCoverScale")).toEqual([100 / 400]);
  });

  test("draws its points at the opacity the theme token names", () => {
    const { gl, calls } = recordingWebgl2();
    const { run, callbacks } = startAnimation(FourteenfoldBloom, gl);
    run.canvas.parentElement!.style.setProperty(
      "--yuruyurau-rotational-point-alpha",
      "0.5",
    );
    callbacks.resize(800, 800, false, 0);

    expect(uniformValues(calls, "uPointAlpha")).toContain(0.5);
  });

  test("fades the center from 55% of its radius, capped at 76 px", () => {
    const wide = recordingWebgl2();
    startAnimation(YuruyurauRotationalField, wide.gl, fieldProps(140)).callbacks.resize(
      800,
      800,
      false,
      0,
    );
    const narrow = recordingWebgl2();
    startAnimation(YuruyurauRotationalField, narrow.gl, fieldProps(100)).callbacks.resize(
      800,
      800,
      false,
      0,
    );

    expect(uniformValues(wide.calls, "uFadeInnerRadius")).toEqual([76]);
    expect(uniformValues(wide.calls, "uFadeOuterRadius")).toEqual([140]);
    expect(uniformValues(narrow.calls, "uFadeInnerRadius")).toEqual([expect.closeTo(55, 9)]);
    expect(uniformValues(narrow.calls, "uFadeOuterRadius")).toEqual([100]);
  });

  test("holds the trace at source time 0 under reduced motion", () => {
    const props = fieldProps(140);
    const { callbacks } = startAnimation(
      YuruyurauRotationalField,
      recordingWebgl2().gl,
      props,
    );
    callbacks.resize(800, 800, true, 5000);
    callbacks.reducedMotion();

    expect(props.buildBasePoints.mock.calls.map(([sourceTime]) => sourceTime)).toEqual([
      0, 0,
    ]);
  });

  test("replays the captured trace once per rotation plus one fade pass", () => {
    const { gl, calls } = recordingWebgl2();
    const { callbacks } = startAnimation(FourteenfoldBloom, gl);
    callbacks.resize(800, 800, false, 0);

    const draws = calls.filter(({ op }) => op === "drawArrays").map(({ args }) => args);
    const pointDraws = draws.filter(([mode]) => mode === "POINTS");
    expect(pointDraws).toHaveLength(14);
    for (const [, , count] of pointDraws) {
      expect(count).toBe(pointDraws[0]![2]);
      expect(count).toBeGreaterThan(0);
    }
    expect(draws.filter(([mode]) => mode === "TRIANGLES")).toEqual([["TRIANGLES", 0, 3]]);
  });
});
