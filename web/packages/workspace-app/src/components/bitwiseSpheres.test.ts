import { afterEach, expect, test, vi } from "vitest";
import BitwiseSpheres from "./BitwiseSpheres.svelte";
import { BITWISE_SPHERES_SOURCE, BITWISE_SPHERES_RADII, buildBitwiseSphere, createBitwiseSpheresRenderer } from "./bitwiseSpheres";
import { recordingWebgl2, startAnimation, stopAnimations, uniformsSet } from "../__tests__/canvas";
vi.mock("./canvasAnimation", async (importOriginal) => (await import("../__tests__/canvas")).recordedRunners(await importOriginal()));
afterEach(stopAnimations);

test("preserves the original sketch verbatim", () => {
  expect(BITWISE_SPHERES_SOURCE).toBe("N=256\ndef setup():size(N*2,N*2,P3D);noStroke()\ndef draw():clear();translate(N,N);[2*i%N&(i/N*2+frameCount)or circle(i%N*2-N,i/N*2-N,3)for i in range(N*N)];rotateX(2);e=get();clear();[s.setTexture(e)or shape(s)for s in[createShape(40,-~i*30)for i in range(6)]]");
});

test("builds a unit sphere with local UV triangles at the texture seam", () => {
  const vertices = buildBitwiseSphere();
  expect(vertices).toHaveLength(30 * 30 * 6 * 5);
  for (let i = 0; i < vertices.length; i += 5) {
    expect(Math.hypot(...vertices.slice(i, i + 3))).toBeCloseTo(1, 6);
    expect(vertices[i + 3]).toBeGreaterThanOrEqual(0);
    expect(vertices[i + 3]).toBeLessThanOrEqual(1);
    expect(vertices[i + 4]).toBeGreaterThanOrEqual(0);
    expect(vertices[i + 4]).toBeLessThanOrEqual(1);
  }
  for (let i = 0; i < vertices.length; i += 15) {
    const u = [vertices[i + 3], vertices[i + 8], vertices[i + 13]];
    expect(Math.max(...u) - Math.min(...u)).toBeLessThan(1 / 30 + 0.000001);
  }
});

test("draws six shells from the inside outward without texture uploads", () => {
  const { gl, calls } = recordingWebgl2();
  const renderer = createBitwiseSpheresRenderer(gl);
  renderer.draw(257, 1, 0.7, 0.45);
  expect(BITWISE_SPHERES_RADII).toEqual([30, 60, 90, 120, 150, 180]);
  expect(uniformsSet(calls, "uRadius")).toEqual([[30], [60], [90], [120], [150], [180]]);
  expect(uniformsSet(calls, "uFrame")).toEqual([[1]]);
  expect(calls.filter(({ op }) => op === "drawArrays")).toHaveLength(6);
  expect(calls.filter(({ op }) => op === "texImage2D" || op === "readPixels")).toHaveLength(0);
  renderer.destroy();
  expect(calls.filter(({ op }) => op === "deleteBuffer")).toHaveLength(1);
  expect(calls.filter(({ op }) => op === "deleteProgram")).toHaveLength(1);
});

test("runs at half the source speed and holds the pattern under reduced motion", () => {
  const { gl, calls } = recordingWebgl2();
  const { run, callbacks } = startAnimation(BitwiseSpheres, gl);
  expect(run.runner).toBe("webgl2");
  expect(run.options.contextAttributes).toMatchObject({ depth: true });
  callbacks.resize(800, 600, false, 0);
  callbacks.frame(2000);
  expect(uniformsSet(calls, "uFrame")).toEqual([[1], [61]]);
  calls.length = 0;
  callbacks.resize(800, 600, true, 8000);
  callbacks.reducedMotion();
  expect(uniformsSet(calls, "uFrame")).toEqual([[31], [31]]);
});
