// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import FourteenfoldBloom from "./FourteenfoldBloom.svelte";
import YuruyurauRotationalField from "./YuruyurauRotationalField.svelte";
import {
  YURUYURAU_ROTATIONAL_FADE_FRAGMENT_SHADER,
  YURUYURAU_ROTATIONAL_POINT_VERTEX_SHADER,
  YURUYURAU_ROTATIONAL_SOURCE_SIZE,
} from "./yuruyurauRotationalField";
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
  test("keeps the source space size and rotational WebGL2 rendering", () => {
    const { run } = startAnimation(FourteenfoldBloom, recordingWebgl2().gl);

    expect(run.runner).toBe("webgl2");
    expect(YURUYURAU_ROTATIONAL_SOURCE_SIZE).toBe(400);
    expect(YURUYURAU_ROTATIONAL_POINT_VERTEX_SHADER).toContain("uRotation");
    expect(YURUYURAU_ROTATIONAL_POINT_VERTEX_SHADER).toContain(
      "uCoverScale",
    );
    expect(YURUYURAU_ROTATIONAL_POINT_VERTEX_SHADER).toContain(
      "gl_PointSize = 1.0;",
    );
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
    expect(YURUYURAU_ROTATIONAL_FADE_FRAGMENT_SHADER).toContain("0.192");
    expect(YURUYURAU_ROTATIONAL_FADE_FRAGMENT_SHADER).toContain("0.164");
    expect(YURUYURAU_ROTATIONAL_FADE_FRAGMENT_SHADER).toContain("0.55");
    expect(YURUYURAU_ROTATIONAL_FADE_FRAGMENT_SHADER).toContain("clamp(");
    expect(YURUYURAU_ROTATIONAL_FADE_FRAGMENT_SHADER).toContain(
      "uFadeInnerRadius",
    );
    expect(YURUYURAU_ROTATIONAL_FADE_FRAGMENT_SHADER).toContain(
      "uFadeOuterRadius",
    );
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
