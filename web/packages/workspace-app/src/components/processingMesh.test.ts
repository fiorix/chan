import { expect, test } from "vitest";
import { buildProcessingBox, buildProcessingSurface, createProcessingMeshRenderer, meshIdentity, meshMultiply, meshRotation, meshTranslation } from "./processingMesh";
import { recordingWebgl2 } from "../__tests__/canvas";

test("builds six flat box faces and twelve edges without diagonals", () => {
  const mesh = buildProcessingBox();
  expect(mesh.vertices).toHaveLength(36 * 6);
  expect(mesh.edges).toHaveLength(24 * 6);
  for (let i = 0; i < mesh.vertices.length; i += 6) {
    expect(Math.hypot(...mesh.vertices.slice(i + 3, i + 6))).toBe(1);
    expect(Math.max(...mesh.vertices.slice(i, i + 3).map(Math.abs))).toBe(0.5);
  }
  for (let i = 0; i < mesh.edges.length; i += 12) {
    const differences = [0, 1, 2].map(axis => Math.abs(mesh.edges[i + axis] - mesh.edges[i + 6 + axis]));
    expect(differences.sort()).toEqual([0, 0, 1]);
  }
});

test("matches the source surface subdivisions and high-detail stroke suppression", () => {
  const ring = buildProcessingSurface("torus", 4, 2);
  expect(ring.vertices).toHaveLength(4 * 2 * 6 * 6);
  expect(ring.edges.length).toBeGreaterThan(0);
  for (const kind of ["sphere", "torus"] as const) {
    const mesh = buildProcessingSurface(kind, 400, 16);
    expect(mesh.vertices).toHaveLength(400 * 16 * 6 * 6);
    expect(mesh.edges).toHaveLength(0);
    expect(mesh.vertices.every(Number.isFinite)).toBe(true);
    for (let i = 0; i < mesh.vertices.length; i += 6) expect(Math.hypot(...mesh.vertices.slice(i + 3, i + 6))).toBeCloseTo(1, 6);
  }
});

test("postmultiplies transforms in the sketch's order", () => {
  const m = meshMultiply(meshTranslation(10, 20, 30), meshRotation("x", Math.PI / 2));
  expect(m[4] + m[12]).toBeCloseTo(10);
  expect(m[5] + m[13]).toBeCloseTo(20);
  expect(m[6] + m[14]).toBeCloseTo(31);
  expect(meshMultiply(m, meshIdentity())).toEqual(m);
  expect(meshMultiply(meshIdentity(), m)).toEqual(m);
});

test("uploads static geometry once and releases both buffers and its program", () => {
  const { gl, calls } = recordingWebgl2();
  const renderer = createProcessingMeshRenderer(gl);
  const shape = { mesh: buildProcessingBox(), model: meshIdentity(), size: [2, 3, 4] as [number, number, number], alpha: 1, light: 1 as const, edgeAlpha: 0.5 };
  renderer.begin(1, 0.7, 0.5);
  renderer.draw(shape); renderer.draw(shape);
  expect(calls.filter(({ op }) => op === "bufferData")).toHaveLength(2);
  expect(calls.filter(({ op }) => op === "drawArrays").map(({ args }) => args)).toEqual([
    ["TRIANGLES", 0, 36], ["LINES", 0, 24], ["TRIANGLES", 0, 36], ["LINES", 0, 24],
  ]);
  renderer.destroy();
  expect(calls.filter(({ op }) => op === "deleteBuffer")).toHaveLength(2);
  expect(calls.filter(({ op }) => op === "deleteProgram")).toHaveLength(1);
});
