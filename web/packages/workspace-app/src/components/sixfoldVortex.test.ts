// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import SixfoldVortex from "./SixfoldVortex.svelte";
import {
  advanceSixfoldVortexParticles,
  createSixfoldVortexParticles,
  fitSixfoldVortex,
  isSixfoldVortexPointDrawable,
  SIXFOLD_VORTEX_PARTICLE_COUNT,
} from "./sixfoldVortex";

let mounted: Record<string, unknown> | null = null;

afterEach(() => {
  if (mounted) unmount(mounted);
  mounted = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Sixfold Vortex", () => {
  test("keeps the source simulation rate and attribution", async () => {
    const renderer = (await import("./SixfoldVortex.svelte?raw"))
      .default as string;
    const motion = (await import("./sixfoldVortex.ts?raw"))
      .default as string;

    expect(renderer).toMatch(/const SOURCE_TIME_SPEED = 60;/);
    expect(renderer).toContain(
      "--sixfold-vortex-point-alpha: 0.066;",
    );
    expect(renderer).toContain(
      "--sixfold-vortex-point-alpha: 0.088;",
    );
    expect(motion).toContain(
      "https://x.com/hisadan/status/1974838123864756613",
    );
  });

  test("preserves simulation state across resize bursts", async () => {
    const renderer = (await import("./SixfoldVortex.svelte?raw"))
      .default as string;
    const resizeBody = renderer.match(
      /resize\(nextWidth, nextHeight, reducedMotion, timeMs\) \{([\s\S]*?)\n\s*\},/,
    )?.[1];

    expect(resizeBody).toBeDefined();
    expect(resizeBody).not.toContain(
      "particles = createSixfoldVortexParticles()",
    );
    expect(resizeBody).not.toContain("sourceTime = 0");
    expect(renderer).toContain(
      ": Math.max(0, timeMs - lastSimulationMs);",
    );
  });

  test("creates the source sketch's 30,000 Gaussian particles", () => {
    const particles = createSixfoldVortexParticles(
      SIXFOLD_VORTEX_PARTICLE_COUNT,
      () => 0,
      () => 1,
    );

    expect(particles).toHaveLength(SIXFOLD_VORTEX_PARTICLE_COUNT * 2);
    expect([...particles.slice(0, 4)]).toEqual([0, 99, 0, 99]);
  });

  test("advances finite particles through all seven vortices", () => {
    const particles = new Float32Array([100, 50, -80, 120]);

    advanceSixfoldVortexParticles(particles, 25);

    expect([...particles].every(Number.isFinite)).toBe(true);
    expect([...particles]).not.toEqual([100, 50, -80, 120]);
  });

  test("keeps escaped startup particles out of the canvas path", async () => {
    const renderer = (await import("./SixfoldVortex.svelte?raw"))
      .default as string;
    const particles = new Float32Array([0.01, 0.01]);

    advanceSixfoldVortexParticles(particles, 0);

    expect(Math.max(...particles.map(Math.abs))).toBeGreaterThan(1_000_000);
    expect(
      isSixfoldVortexPointDrawable(particles[0], particles[1], 800, 800),
    ).toBe(false);
    expect(isSixfoldVortexPointDrawable(400, 400, 800, 800)).toBe(true);
    expect(isSixfoldVortexPointDrawable(Number.NaN, 400, 800, 800)).toBe(
      false,
    );
    expect(renderer).toMatch(
      /if \([\s\S]{0,80}!isSixfoldVortexPointDrawable\(pointX, pointY, width, height\)[\s\S]{0,80}continue;/,
    );
  });

  test("never traces escaped startup particles into the canvas path", async () => {
    const rect = vi.fn();
    const context = {
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      fill: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: "",
      globalAlpha: 1,
      rect,
      restore: vi.fn(),
      save: vi.fn(),
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context,
    );
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });

    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const randomValues = [0.5, 0.2499863, 0.25];
    let randomIndex = 0;
    vi.spyOn(Math, "random").mockImplementation(() => {
      const value = randomValues[randomIndex % randomValues.length];
      randomIndex += 1;
      return value;
    });

    const target = document.createElement("div");
    document.body.append(target);
    mounted = mount(SixfoldVortex, { target });
    await tick();

    expect(rect).toHaveBeenCalledTimes(SIXFOLD_VORTEX_PARTICLE_COUNT);
    rect.mockClear();
    expect(frames).toHaveLength(1);
    frames.shift()?.(performance.now() + 100);

    expect(rect).not.toHaveBeenCalled();
  });

  test("fits rectangular panes without distorting the center", () => {
    const transform = fitSixfoldVortex(1400, 900);

    expect(transform).toEqual({
      centerX: 700,
      centerY: 450,
      scale: 1.125,
    });
  });
});
