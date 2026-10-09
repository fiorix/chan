import { afterEach, describe, expect, test, vi } from "vitest";
import SegmentedTorus from "./SegmentedTorus.svelte";
import {
  buildSegmentedTorusMesh,
  buildSegmentedTorusGrains,
  SEGMENTED_TORUS_GRAIN_COUNT,
  SEGMENTED_TORUS_GRAIN_FLOATS,
  SEGMENTED_TORUS_GAP,
} from "./segmentedTorus";
import { recordingWebgl2, startAnimation, stopAnimations, uniformsSet } from "../__tests__/canvas";

const renderer = vi.hoisted(() => ({ draw: vi.fn(), destroy: vi.fn() }));
vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./segmentedTorus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./segmentedTorus")>()),
  createSegmentedTorusRenderer: () => renderer,
}));
afterEach(() => {
  stopAnimations();
  vi.clearAllMocks();
});

describe("Segmented Torus geometry", () => {
  test.each([0, 7.5, 30, 60])("keeps twelve chambers watertight at %s seconds", (seconds) => {
    const { faces, edges } = buildSegmentedTorusMesh(seconds);
    const counts = new Map<string, number>();
    const orientations = new Map<string, number>();
    const neighbours = new Map<string, Set<string>>();
    let volume = 0;
    for (let offset = 0; offset < faces.length; offset += 9) {
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = faces.subarray(offset, offset + 9);
      volume += ax! * (by! * cz! - bz! * cy!) + ay! * (bz! * cx! - bx! * cz!) + az! * (bx! * cy! - by! * cx!);
      const vertices = [0, 3, 6].map((start) => Array.from(faces.subarray(offset + start, offset + start + 3)).join(","));
      for (let side = 0; side < 3; side += 1) {
        const a = vertices[side]!;
        const b = vertices[(side + 1) % 3]!;
        const edge = [a, b].sort().join(";");
        counts.set(edge, (counts.get(edge) ?? 0) + 1);
        orientations.set(edge, (orientations.get(edge) ?? 0) + (a < b ? 1 : -1));
        if (!neighbours.has(a)) neighbours.set(a, new Set());
        neighbours.get(a)!.add(b);
      }
    }
    expect([...counts.values()].every((count) => count === 2)).toBe(true);
    expect([...orientations.values()].every((sum) => sum === 0)).toBe(true);
    expect(volume).toBeGreaterThan(0);
    const visited = new Set<string>();
    let components = 0;
    for (const vertex of neighbours.keys()) {
      if (visited.has(vertex)) continue;
      components += 1;
      const pending = [vertex];
      while (pending.length) {
        const current = pending.pop()!;
        if (visited.has(current)) continue;
        visited.add(current);
        pending.push(...neighbours.get(current)!);
      }
    }
    expect(components).toBe(12);
    for (let offset = 0; offset < edges.length; offset += 3) {
      const vertex = Array.from(edges.subarray(offset, offset + 3)).join(",");
      expect(neighbours.has(vertex)).toBe(true);
    }
  });

  test("follows the n=10, t=1.5 parametric surface with rounded square corners", () => {
    const { faces } = buildSegmentedTorusMesh();
    let invalid = 0;
    for (let offset = 0; offset < faces.length; offset += 3) {
      const [x, y, z] = faces.subarray(offset, offset + 3);
      const u = Math.atan2(y!, x!);
      const radial = Math.hypot(x!, y!) - 0.8;
      const a = (radial * Math.cos(1.5 * u) + z! * Math.sin(1.5 * u)) / 0.2;
      const b = (-radial * Math.sin(1.5 * u) + z! * Math.cos(1.5 * u)) / 0.2;
      const power = a ** 10 + b ** 10;
      if (Math.abs(power - 1) > 0.0001 && power > 0.0001) invalid += 1;
    }
    expect(invalid).toBe(0);
    const u = SEGMENTED_TORUS_GAP / 2;
    const v = Math.PI / 4;
    const r = 0.2 * (Math.cos(v) ** 10 + Math.sin(v) ** 10) ** -0.1;
    expect(Array.from(faces.subarray(0, 3))).toEqual([
      expect.closeTo((0.8 + r * Math.cos(v + 1.5 * u)) * Math.cos(u), 6),
      expect.closeTo((0.8 + r * Math.cos(v + 1.5 * u)) * Math.sin(u), 6),
      expect.closeTo(r * Math.sin(v + 1.5 * u), 6),
    ]);
  });

  test("winds a material point through 540 degrees per circuit and returns after two", () => {
    const initial = buildSegmentedTorusMesh();
    const next = buildSegmentedTorusMesh(30);
    const full = buildSegmentedTorusMesh(60);
    for (let offset = 0; offset < initial.edges.length; offset += 3) {
      const [x, y, z] = initial.edges.subarray(offset, offset + 3);
      const [nx, ny, nz] = next.edges.subarray(offset, offset + 3);
      expect(Math.hypot(nx!, ny!) - 0.8).toBeCloseTo(-(Math.hypot(x!, y!) - 0.8), 6);
      expect(nz).toBeCloseTo(-z!, 6);
    }
    expect(full.faces).toEqual(initial.faces);
    expect(full.edges).toEqual(initial.edges);
    expect(buildSegmentedTorusMesh(3, next)).toBe(next);
  });

  test.each([30, 60])("does not snap at the %s second orbit boundary", (seconds) => {
    for (const build of [
      (time: number) => buildSegmentedTorusMesh(time).edges,
      (time: number) => buildSegmentedTorusGrains(time),
    ]) {
      const before = build(seconds - 0.000001);
      const after = build(seconds + 0.000001);
      expect(after.every((value, index) => Math.abs(value - before[index]!) < 0.0001)).toBe(true);
    }
  });

  test("fills the superellipse interior with moving grains and keeps every gap empty", () => {
    const buffer = new Float32Array(SEGMENTED_TORUS_GRAIN_COUNT * SEGMENTED_TORUS_GRAIN_FLOATS);
    for (const seconds of [0, 3, 23, 10000]) {
      buffer.fill(NaN);
      expect(buildSegmentedTorusGrains(seconds, buffer)).toBe(buffer);
      expect(buffer.every(Number.isFinite)).toBe(true);
      let invalid = 0;
      let deep = 0;
      for (let offset = 0; offset < buffer.length; offset += SEGMENTED_TORUS_GRAIN_FLOATS) {
        const [x, y, z, nx, ny, nz, radius, opacity, selector] = buffer.subarray(offset, offset + SEGMENTED_TORUS_GRAIN_FLOATS);
        const distance = Math.hypot(x!, y!);
        const angle = (Math.atan2(y!, x!) + 2 * Math.PI) % (2 * Math.PI);
        const cellAngle = ((angle - seconds * 2 * Math.PI / 30) % (Math.PI / 6) + Math.PI / 6) % (Math.PI / 6);
        const twist = angle * 1.5;
        const radial = distance - 0.8;
        const localR = radial * Math.cos(twist) + z! * Math.sin(twist);
        const localZ = -radial * Math.sin(twist) + z! * Math.cos(twist);
        const fill = ((localR / 0.2) ** 10 + (localZ / 0.2) ** 10) ** 0.1;
        if (fill < 0.6) deep += 1;
        // Differentiate the twisted surface along the ring independently
        // of the renderer and check that its normal is perpendicular.
        const dr = -z! * 1.5;
        const dx = dr * Math.cos(angle) - distance * Math.sin(angle);
        const dy = dr * Math.sin(angle) + distance * Math.cos(angle);
        const dz = radial * 1.5;
        const dot = nx! * dx + ny! * dy + nz! * dz;
        if (fill <= 0 || fill >= 0.99 || Math.abs(dot) > 0.000001 ||
          cellAngle < SEGMENTED_TORUS_GAP / 2 - 0.000001 || cellAngle > Math.PI / 6 - SEGMENTED_TORUS_GAP / 2 + 0.000001 ||
          Math.abs(Math.hypot(nx!, ny!, nz!) - 1) > 0.000001 || radius! <= 0 || opacity! < 0 || opacity! > 1 || selector! < 0 || selector! > 1) invalid += 1;
      }
      expect(invalid).toBe(0);
      expect(deep).toBeGreaterThan(SEGMENTED_TORUS_GRAIN_COUNT / 4);
    }
    expect(buildSegmentedTorusGrains(0)).not.toEqual(buildSegmentedTorusGrains(3));
  });

  test("fades a grain at both sides of its wrap instead of jumping across a gap", () => {
    const [x, y] = buildSegmentedTorusGrains(0);
    const fraction = (Math.atan2(y!, x!) - SEGMENTED_TORUS_GAP / 2) / (Math.PI / 6 - SEGMENTED_TORUS_GAP);
    const crossing = (1 - fraction) / 0.045;
    expect(buildSegmentedTorusGrains(crossing - 0.001)[7]).toBeLessThan(0.001);
    expect(buildSegmentedTorusGrains(crossing + 0.001)[7]).toBeLessThan(0.001);
  });
});

describe("Segmented Torus renderer", () => {
  test("masks hidden surfaces before drawing edges and moving grains", async () => {
    const { createSegmentedTorusRenderer } = await vi.importActual<typeof import("./segmentedTorus")>("./segmentedTorus");
    const { gl, calls } = recordingWebgl2();
    const actual = createSegmentedTorusRenderer(gl);
    actual.draw(7.5, 1, 0.6, 0.4);
    const drawing = calls.filter(({ op }) => ["colorMask", "depthMask", "drawArrays"].includes(op));
    expect(drawing.map(({ op, args }) => [op, ...args])).toEqual([
      ["colorMask", true, true, true, true],
      ["depthMask", true],
      ["colorMask", false, false, false, false],
      ["drawArrays", "TRIANGLES", 0, expect.any(Number)],
      ["colorMask", true, true, true, true],
      ["depthMask", false],
      ["drawArrays", "TRIANGLES", 0, expect.any(Number)],
      ["drawArrays", "LINES", 0, expect.any(Number)],
      ["depthMask", true],
      ["colorMask", false, false, false, false],
      ["drawArrays", "TRIANGLES", 0, expect.any(Number)],
      ["colorMask", true, true, true, true],
      ["depthMask", false],
      ["drawArrays", "POINTS", 0, SEGMENTED_TORUS_GRAIN_COUNT],
    ]);
    expect(calls.filter(({ op }) => op === "cullFace").map(({ args }) => args)).toEqual([["FRONT"], ["FRONT"]]);
    expect(uniformsSet(calls, "uTone")).toEqual([[0.6], [0.6]]);
    actual.draw(8, 1, 0.6, 0.4);
    expect(calls.filter(({ op }) => op === "bufferData")).toHaveLength(3);
    expect(calls.filter(({ op }) => op === "bufferSubData")).toHaveLength(6);
    actual.destroy();
    expect(calls.filter(({ op }) => op === "deleteBuffer")).toHaveLength(3);
    expect(calls.filter(({ op }) => op === "deleteProgram")).toHaveLength(2);
  });

  test("frees earlier programs and buffers if an allocation fails", async () => {
    const { createSegmentedTorusRenderer } = await vi.importActual<typeof import("./segmentedTorus")>("./segmentedTorus");
    let allocated = 0;
    const { gl, calls } = recordingWebgl2({ createBuffer: () => ++allocated === 2 ? null : {} });
    expect(() => createSegmentedTorusRenderer(gl)).toThrow("could not allocate torus buffer");
    expect(calls.filter(({ op }) => op === "deleteBuffer")).toHaveLength(1);
    expect(calls.filter(({ op }) => op === "deleteProgram")).toHaveLength(2);
  });
});

describe("Segmented Torus component", () => {
  test("requests depth and antialiasing and keeps its clock through resize", () => {
    const { run, callbacks } = startAnimation(SegmentedTorus, {});
    expect(run.runner).toBe("webgl2");
    expect(run.options.contextAttributes).toMatchObject({ depth: true, antialias: true });
    callbacks.frame(6000);
    callbacks.resize(600, 400, false, 6000);
    expect(renderer.draw.mock.calls.map(([seconds]) => seconds)).toEqual([3, 3]);
  });

  test("holds a deterministic still and reads live theme tokens", () => {
    const { run, callbacks } = startAnimation(SegmentedTorus, {});
    const host = run.canvas.parentElement!;
    host.style.setProperty("--segmented-torus-field-scale", "1.5");
    host.style.setProperty("--segmented-torus-tone", "0");
    host.style.setProperty("--segmented-torus-opacity", "0.4");
    callbacks.resize(600, 400, true, 18000);
    callbacks.reducedMotion();
    expect(renderer.draw.mock.calls).toEqual([[0, 1.5, 0, 0.4], [0, 1.5, 0, 0.4]]);
    callbacks.destroy?.();
    expect(renderer.destroy).toHaveBeenCalledOnce();
  });
});
