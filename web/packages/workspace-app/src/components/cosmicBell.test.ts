import { afterEach, describe, expect, test, vi } from "vitest";
import CosmicBell from "./CosmicBell.svelte";
import {
  buildCosmicBellGrains,
  cosmicBellTurn,
  COSMIC_BELL_SHELL_GRAINS,
  COSMIC_BELL_CORE_GRAINS,
  COSMIC_BELL_GRAIN_COUNT,
} from "./cosmicBell";
import {
  recordingWebgl2,
  startAnimation,
  stopAnimations,
  uniformsSet,
} from "../__tests__/canvas";

const renderer = vi.hoisted(() => ({ draw: vi.fn(), destroy: vi.fn() }));
vi.mock("./canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("./cosmicBell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cosmicBell")>()),
  createCosmicBellRenderer: () => renderer,
}));

afterEach(() => {
  stopAnimations();
  vi.clearAllMocks();
});

describe("Cosmic Bell geometry", () => {
  test("recreates the same finite particle field on every mount", () => {
    const first = buildCosmicBellGrains();
    const second = buildCosmicBellGrains();
    expect(first.length).toBe(COSMIC_BELL_GRAIN_COUNT * 4);
    expect(first.every((value, index) => Number.isFinite(value) && value === second[index])).toBe(true);
  });

  test("places the wide shell behind a narrow ringed core and closes its outer rim", () => {
    const grains = buildCosmicBellGrains();
    let shellError = 0;
    let shellRadius = 0;
    let coreRadius = 0;
    let coreRings = 0;
    let rimError = 0;
    for (let index = 0; index < COSMIC_BELL_GRAIN_COUNT; index += 1) {
      const [radius, angle, depth, bandPosition] = grains.subarray(index * 4, index * 4 + 4);
      if (index < COSMIC_BELL_SHELL_GRAINS) {
        // A hemispherical shell, flattened along its axis.
        shellError = Math.max(shellError, Math.abs(radius! ** 2 + ((0.12 - depth!) / 0.72) ** 2 - 1));
        shellRadius = Math.max(shellRadius, radius!);
      } else if (index < COSMIC_BELL_SHELL_GRAINS + COSMIC_BELL_CORE_GRAINS) {
        coreRadius = Math.max(coreRadius, radius!);
        if ((bandPosition! * 24) % 1 < 0.121) coreRings += 1;
      } else {
        rimError = Math.max(rimError, Math.abs(radius! - 1));
      }
      if (angle! < 0 || angle! > Math.PI * 2) throw new Error("invalid grain angle");
    }
    expect(shellError).toBeLessThan(0.000001);
    expect(shellRadius).toBeGreaterThan(0.99);
    expect(coreRadius).toBeGreaterThan(0.3);
    expect(coreRadius).toBeLessThan(0.34);
    expect(coreRings / COSMIC_BELL_CORE_GRAINS).toBeGreaterThan(0.75);
    expect(rimError).toBeLessThan(0.027);
  });
});

describe("Cosmic Bell turn", () => {
  test("turns a full revolution plus a quarter before reversing through the same arc", () => {
    const degrees = (seconds: number) => cosmicBellTurn(seconds) * 180 / Math.PI;
    expect(degrees(0)).toBeCloseTo(0, 9);
    expect(degrees(3)).toBeCloseTo(225, 9);
    expect(degrees(6)).toBeCloseTo(450, 9);
    expect(degrees(9)).toBeCloseTo(225, 9);
    expect(degrees(12)).toBeCloseTo(0, 9);
    // Sample both legs so a wrapped angle cannot pass on just the endpoints.
    let previous = degrees(0);
    for (let step = 1; step <= 120; step += 1) {
      const next = degrees(step / 10);
      if (step <= 60) expect(next).toBeGreaterThan(previous);
      else expect(next).toBeLessThan(previous);
      previous = next;
    }
    expect(degrees(18)).toBeCloseTo(450, 9);
  });

  test("eases to rest without jumping at either reversal", () => {
    for (const end of [6, 12]) {
      expect(cosmicBellTurn(end - 0.001)).toBeCloseTo(cosmicBellTurn(end + 0.001), 9);
      expect(Math.abs(cosmicBellTurn(end) - cosmicBellTurn(end - 0.001))).toBeLessThan(0.000002);
    }
  });
});

describe("Cosmic Bell renderer", () => {
  test("uploads the cloud once and repeats the camera path without accumulating geometry", async () => {
    const { createCosmicBellRenderer } = await vi.importActual<typeof import("./cosmicBell")>("./cosmicBell");
    const { gl, calls } = recordingWebgl2();
    const actual = createCosmicBellRenderer(gl);
    actual.draw(3, 1.5, 0.4, 0.7);
    actual.draw(15, 1.5, 0.4, 0.7);
    const uploads = calls.filter(({ op }) => op === "bufferData");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.args[1]).toHaveLength(COSMIC_BELL_GRAIN_COUNT * 4);
    expect(uploads[0]!.args[2]).toBe("STATIC_DRAW");
    expect(uniformsSet(calls, "uPhase")).toEqual([[Math.PI / 2], [Math.PI / 2]]);
    for (const [angle] of uniformsSet(calls, "uTurn") as number[][]) {
      expect(angle).toBeCloseTo(225 * Math.PI / 180, 9);
    }
    expect(uniformsSet(calls, "uTone")).toEqual([[0.4], [0.4]]);
    expect(uniformsSet(calls, "uOpacity")).toEqual([[0.7], [0.7]]);
    expect(calls.filter(({ op }) => op === "drawArrays").map(({ args }) => args)).toEqual([
      ["POINTS", COSMIC_BELL_SHELL_GRAINS, COSMIC_BELL_CORE_GRAINS],
      ["POINTS", 0, COSMIC_BELL_GRAIN_COUNT],
      ["POINTS", COSMIC_BELL_SHELL_GRAINS, COSMIC_BELL_CORE_GRAINS],
      ["POINTS", 0, COSMIC_BELL_GRAIN_COUNT],
    ]);
    actual.destroy();
    expect(calls.filter(({ op }) => op === "deleteBuffer")).toHaveLength(1);
    expect(calls.filter(({ op }) => op === "deleteProgram")).toHaveLength(1);
  });

  test("releases GPU allocations when a required uniform is unavailable", async () => {
    const { createCosmicBellRenderer } = await vi.importActual<typeof import("./cosmicBell")>("./cosmicBell");
    const { gl, calls } = recordingWebgl2({ getUniformLocation: () => null });
    expect(() => createCosmicBellRenderer(gl)).toThrow("missing shader uniform");
    expect(calls.filter(({ op }) => op === "deleteBuffer")).toHaveLength(1);
    expect(calls.filter(({ op }) => op === "deleteProgram")).toHaveLength(1);
    expect(calls.some(({ op }) => op === "drawArrays")).toBe(false);
  });
});

describe("Cosmic Bell component", () => {
  test("runs at half the reference pace and preserves time through resize", () => {
    const { run, callbacks } = startAnimation(CosmicBell, {});
    expect(run.runner).toBe("webgl2");
    callbacks.frame(6000);
    callbacks.resize(600, 400, false, 6000);
    expect(renderer.draw.mock.calls.map(([seconds]) => seconds)).toEqual([3, 3]);
  });

  test("holds the same oblique view through reduced-motion redraws and resize", () => {
    const { callbacks } = startAnimation(CosmicBell, {});
    callbacks.resize(600, 400, true, 18000);
    callbacks.reducedMotion();
    callbacks.resize(400, 600, true, 36000);
    expect(renderer.draw.mock.calls.map(([seconds]) => seconds)).toEqual([1.4, 1.4, 1.4]);
  });

  test("reads live theme tokens and releases its renderer", () => {
    const { run, callbacks } = startAnimation(CosmicBell, {});
    const host = run.canvas.parentElement!;
    host.style.setProperty("--cosmic-bell-field-scale", "1.5");
    host.style.setProperty("--cosmic-bell-tone", "0");
    host.style.setProperty("--cosmic-bell-opacity", "0.4");
    callbacks.frame(2000);
    expect(renderer.draw).toHaveBeenLastCalledWith(1, 1.5, 0, 0.4);
    callbacks.destroy?.();
    expect(renderer.destroy).toHaveBeenCalledOnce();
  });
});
