// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import LorenzConstellation from "./LorenzConstellation.svelte";
import { LORENZ_CONSTELLATION_BOUNDS, LORENZ_CONSTELLATION_POINT_COUNT } from "./lorenzConstellation";
import { fitPointCloudCover } from "./pointCloudCover";
import {
  mountAnimation,
  recordingWebgl2,
  startAnimation,
  stopAnimations,
  uniformsSet,
} from "../__tests__/canvas";

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);

afterEach(() => {
  stopAnimations();
  vi.restoreAllMocks();
});

describe("Yuruyurau point cloud", () => {
  test("places its points on the GPU by the cover fit of its bounds, at about a pixel", () => {
    const { gl, calls } = recordingWebgl2();
    const { run, callbacks } = startAnimation(LorenzConstellation, gl);
    run.canvas.parentElement!.style.setProperty("--yuruyurau-point-alpha", "0.5");
    callbacks.resize(800, 800, false, 0);

    // The recording context's drawing buffer is 100 by 100.
    const fit = fitPointCloudCover(100, 100, LORENZ_CONSTELLATION_BOUNDS);
    expect(run.runner).toBe("webgl2");
    expect(uniformsSet(calls, "uCenter")).toEqual([[fit.centerX, fit.centerY]]);
    expect(uniformsSet(calls, "uSourceCenter")).toEqual([[fit.sourceCenterX, fit.sourceCenterY]]);
    expect(uniformsSet(calls, "uScale")).toEqual([[fit.scale]]);
    const [[size]] = uniformsSet(calls, "uPointSize") as number[][];
    expect(size).toBeGreaterThanOrEqual(0.75);
    expect(size).toBeLessThanOrEqual(1.25);
    expect(uniformsSet(calls, "uPointAlpha")).toEqual([[0.5]]);
  });

  test("draws the whole cloud in a single pass", () => {
    const { gl, calls } = recordingWebgl2();
    const { callbacks } = startAnimation(LorenzConstellation, gl);
    callbacks.resize(800, 800, false, 0);

    const pointDraws = calls
      .filter(({ op, args }) => op === "drawArrays" && args[0] === "POINTS")
      .map(({ args }) => args);
    expect(pointDraws).toHaveLength(1);
    const [, first, count] = pointDraws[0]! as [string, number, number];
    expect(first).toBe(0);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(LORENZ_CONSTELLATION_POINT_COUNT);
  });

  test("stays quiet and draws nothing when the renderer cannot be built", () => {
    const { gl, calls } = recordingWebgl2({ createProgram: () => null });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const run = mountAnimation(LorenzConstellation);

    expect(run.create(gl as never)).toBeNull();
    expect(calls.map(({ op }) => op)).not.toContain("drawArrays");
    expect(warn).toHaveBeenCalledWith(
      "[chan] Yuruyurau point cloud WebGL renderer unavailable:",
      expect.any(Error),
    );
  });
});
