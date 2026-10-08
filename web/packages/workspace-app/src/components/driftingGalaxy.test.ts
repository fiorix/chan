import { afterEach, describe, expect, test, vi } from "vitest";
import DriftingGalaxy from "./DriftingGalaxy.svelte";
import {
  buildDriftingGalaxyGrains,
  DRIFTING_GALAXY_GRAIN_COUNT,
  DRIFTING_GALAXY_VERTEX_SHADER,
} from "./driftingGalaxy";
import { LATTICE_NOISE_GLSL, latticeNoiseTable } from "./latticeNoise";
import { ROUND_POINT_FRAGMENT_SHADER } from "./roundPoints";
import { recordingWebgl2, shaderSources, startAnimation, stopAnimations, uniformsSet } from "../__tests__/canvas";

const renderer = vi.hoisted(() => ({ draw: vi.fn(), destroy: vi.fn() }));

vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./driftingGalaxy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./driftingGalaxy")>()),
  createDriftingGalaxyRenderer: () => renderer,
}));

afterEach(() => {
  stopAnimations();
  renderer.draw.mockClear();
});

describe("buildDriftingGalaxyGrains", () => {
  test("lays out the sketch's twelve arms of 6,000 grains", () => {
    expect(DRIFTING_GALAXY_GRAIN_COUNT).toBe(72000);
    expect(buildDriftingGalaxyGrains()).toHaveLength(72000 * 6);
  });

  // Expected values come from the sketch's expressions over p5.js's own
  // noise(), run after noiseSeed(1), for the sixth arm's grain halfway in.
  test("works out once what the sketch never changes about a grain", () => {
    const grains = buildDriftingGalaxyGrains(latticeNoiseTable(1));
    const offset = (5 * 6000 + 3000) * 6;
    const [swingX, swingY, scatterX, scatterY, angle, depth] = Array.from(
      grains.subarray(offset, offset + 6),
    );

    expect(swingX).toBeCloseTo(7.109087, 4);
    expect(swingY).toBeCloseTo(6.751139, 4);
    expect(scatterX).toBeCloseTo(11.57638, 3);
    expect(scatterY).toBeCloseTo(17.36457, 3);
    expect(angle).toBeCloseTo((5 * Math.PI) / 3, 5);
    expect(depth).toBeCloseTo(150, 4);
  });

  test("scatters nothing at the rim, where the sketch's scatter scales to zero", () => {
    const grains = buildDriftingGalaxyGrains();

    for (let arm = 0; arm < 12; arm += 1) {
      const offset = arm * 6000 * 6;
      expect(grains[offset + 2]).toBeCloseTo(0, 12);
      expect(grains[offset + 3]).toBeCloseTo(0, 12);
      expect(grains[offset + 5]).toBe(0);
    }
  });
});

describe("Drifting Galaxy", () => {
  test("renders through the WebGL2 runner at the display's density", () => {
    const { run, callbacks } = startAnimation(DriftingGalaxy, {});
    callbacks.resize(800, 600, false, 0);

    expect(run.runner).toBe("webgl2");
    expect(run.options).toMatchObject({ maxDpr: 2 });
    expect(renderer.draw).toHaveBeenCalled();
  });

  test("moves the grains in the vertex shader, over the noise table and the round point fragment shader", async () => {
    const { createDriftingGalaxyRenderer } =
      await vi.importActual<typeof import("./driftingGalaxy")>("./driftingGalaxy");
    const { gl, calls } = recordingWebgl2();

    createDriftingGalaxyRenderer(gl).draw(-2, 1.5, 0.5, 0.25);

    expect(shaderSources(calls)).toEqual([
      DRIFTING_GALAXY_VERTEX_SHADER,
      ROUND_POINT_FRAGMENT_SHADER,
    ]);
    expect(DRIFTING_GALAXY_VERTEX_SHADER).toContain(LATTICE_NOISE_GLSL);
    expect(DRIFTING_GALAXY_VERTEX_SHADER).toContain(
      "latticeNoise(vec3(angle, depth, uClock))",
    );
    expect(DRIFTING_GALAXY_VERTEX_SHADER).toContain(
      "latticeNoise(vec3(distance, uClock, 0.0))",
    );

    // The grains go up once, and so does the table, as a 64 by 64 texture
    // of single floats.
    const uploads = calls.filter(({ op }) => op === "bufferData");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.args[1]).toHaveLength(72000 * 6);
    expect(uploads[0]!.args[2]).toBe("STATIC_DRAW");
    const textures = calls.filter(({ op }) => op === "texImage2D");
    expect(textures).toHaveLength(1);
    expect(textures[0]!.args.slice(2, 8)).toEqual(["R32F", 64, 64, 0, "RED", "FLOAT"]);
    expect(textures[0]!.args[8]).toEqual(latticeNoiseTable(1));

    // The recording context's drawing buffer is 100 by 100, a quarter of
    // the sketch's 400 pixel canvas.
    expect(uniformsSet(calls, "uClock")).toEqual([[-2]]);
    const [[scale]] = uniformsSet(calls, "uScale") as number[][];
    expect(scale).toBeCloseTo(0.375, 9);
    expect(uniformsSet(calls, "uTone")).toEqual([[0.5]]);
    expect(uniformsSet(calls, "uOpacity")).toEqual([[0.25]]);
    expect(
      calls.filter(({ op }) => op === "drawArrays").map(({ args }) => args),
    ).toEqual([["POINTS", 0, 72000]]);
  });

  test("frees its texture, buffer and program", async () => {
    const { createDriftingGalaxyRenderer } =
      await vi.importActual<typeof import("./driftingGalaxy")>("./driftingGalaxy");
    const { gl, calls } = recordingWebgl2();

    createDriftingGalaxyRenderer(gl).destroy();

    expect(calls.map(({ op }) => op)).toEqual(
      expect.arrayContaining(["deleteTexture", "deleteBuffer", "deleteProgram"]),
    );
  });

  test("runs the sketch's clock backward, 0.09 a second of animation time", () => {
    const { callbacks } = startAnimation(DriftingGalaxy, {});
    callbacks.resize(800, 600, false, 0);
    renderer.draw.mockClear();
    callbacks.frame(1000);
    callbacks.frame(10000);

    expect(renderer.draw.mock.calls.map(([clock]) => clock)).toEqual([
      expect.closeTo(-0.09, 9),
      expect.closeTo(-0.9, 9),
    ]);
  });

  test("holds one still frame at the start of the clock under reduced motion", () => {
    const { callbacks } = startAnimation(DriftingGalaxy, {});
    renderer.draw.mockClear();
    callbacks.resize(800, 600, true, 4000);
    callbacks.reducedMotion();

    expect(renderer.draw.mock.calls.map(([clock]) => clock)).toEqual([0, 0]);
  });

  test("draws with the field its theme tokens name", () => {
    const { run, callbacks } = startAnimation(DriftingGalaxy, {});
    const host = run.canvas.parentElement!;
    host.style.setProperty("--drifting-galaxy-field-scale", "2");
    host.style.setProperty("--drifting-galaxy-tone", "0.5");
    host.style.setProperty("--drifting-galaxy-opacity", "0.25");
    renderer.draw.mockClear();
    callbacks.resize(800, 600, false, 0);

    expect(renderer.draw).toHaveBeenLastCalledWith(
      expect.closeTo(0, 12),
      2,
      0.5,
      0.25,
    );
  });
});
