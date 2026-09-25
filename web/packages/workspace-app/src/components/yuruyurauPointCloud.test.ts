// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import LorenzConstellation from "./LorenzConstellation.svelte";
import { LORENZ_CONSTELLATION_POINT_COUNT } from "./lorenzConstellation";
import {
  YURUYURAU_POINT_CLOUD_FRAGMENT_SHADER,
  YURUYURAU_POINT_CLOUD_VERTEX_SHADER,
} from "./yuruyurauPointCloud";
import {
  mountAnimation,
  recordingWebgl2,
  startAnimation,
  stopAnimations,
} from "../__tests__/canvas";

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);

afterEach(() => {
  stopAnimations();
  vi.restoreAllMocks();
});

describe("Yuruyurau point cloud", () => {
  test("places and sizes points on the GPU", () => {
    const { run } = startAnimation(LorenzConstellation, recordingWebgl2().gl);

    expect(run.runner).toBe("webgl2");
    expect(YURUYURAU_POINT_CLOUD_VERTEX_SHADER).toContain("uCenter");
    expect(YURUYURAU_POINT_CLOUD_VERTEX_SHADER).toContain("uSourceCenter");
    expect(YURUYURAU_POINT_CLOUD_VERTEX_SHADER).toContain("uScale");
    expect(YURUYURAU_POINT_CLOUD_VERTEX_SHADER).toContain(
      "gl_PointSize = uPointSize;",
    );
    expect(YURUYURAU_POINT_CLOUD_FRAGMENT_SHADER).toContain("uPointAlpha");
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
