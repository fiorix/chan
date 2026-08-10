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
  SIXFOLD_VORTEX_POINT_VERTEX_SHADER,
  SIXFOLD_VORTEX_SURFACE_FRAGMENT_SHADER,
} from "./sixfoldVortex";

let mounted: Record<string, unknown> | null = null;

afterEach(() => {
  if (mounted) unmount(mounted);
  mounted = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface FakeDrawCall {
  mode: number;
  first: number;
  count: number;
}

function createFakeWebgl2(): {
  gl: WebGL2RenderingContext;
  draws: FakeDrawCall[];
  pointsMode: number;
} {
  const draws: FakeDrawCall[] = [];
  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
    POINTS: 0x0000,
    TRIANGLES: 0x0004,
    BLEND: 0x0be2,
    DEPTH_TEST: 0x0b71,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    FRAMEBUFFER: 0x8d40,
    COLOR_ATTACHMENT0: 0x8ce0,
    COLOR_BUFFER_BIT: 0x4000,
    drawingBufferWidth: 1,
    drawingBufferHeight: 1,
    createShader: vi.fn(() => ({})),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => ""),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({})),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(() => ""),
    deleteProgram: vi.fn(),
    getAttribLocation: vi.fn(() => 0),
    getUniformLocation: vi.fn(() => ({})),
    createBuffer: vi.fn(() => ({})),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    deleteBuffer: vi.fn(),
    useProgram: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    uniform1f: vi.fn(),
    uniform2f: vi.fn(),
    uniform3f: vi.fn(),
    uniform1i: vi.fn(),
    drawArrays: vi.fn((mode: number, first: number, count: number) => {
      draws.push({ mode, first, count });
    }),
    enable: vi.fn(),
    disable: vi.fn(),
    blendFunc: vi.fn(),
    viewport: vi.fn(),
    clearColor: vi.fn(),
    clear: vi.fn(),
    createTexture: vi.fn(() => ({})),
    bindTexture: vi.fn(),
    texImage2D: vi.fn(),
    texParameteri: vi.fn(),
    deleteTexture: vi.fn(),
    createFramebuffer: vi.fn(() => ({})),
    bindFramebuffer: vi.fn(),
    framebufferTexture2D: vi.fn(),
    deleteFramebuffer: vi.fn(),
    activeTexture: vi.fn(),
  };
  return {
    gl: gl as unknown as WebGL2RenderingContext,
    draws,
    pointsMode: gl.POINTS,
  };
}

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

  test("renders through WebGL2 with ping-pong trail surfaces", async () => {
    const renderer = (await import("./SixfoldVortex.svelte?raw"))
      .default as string;
    const motion = (await import("./sixfoldVortex.ts?raw"))
      .default as string;

    expect(renderer).toContain("runWebgl2Animation");
    expect(motion).toContain("framebufferTexture2D");
    expect(motion).toContain("gl.DYNAMIC_DRAW");
    expect(SIXFOLD_VORTEX_SURFACE_FRAGMENT_SHADER).toContain(
      "mix(previous, uBackgroundColor, uFade)",
    );
    expect(SIXFOLD_VORTEX_POINT_VERTEX_SHADER).toContain(
      "gl_PointSize = 1.0;",
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

  test("never traces escaped startup particles into the point upload", async () => {
    const { gl, draws, pointsMode } = createFakeWebgl2();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      gl,
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

    const firstFramePoints = draws.filter(
      (draw) => draw.mode === pointsMode,
    );
    expect(firstFramePoints).toHaveLength(1);
    expect(firstFramePoints[0].count).toBe(SIXFOLD_VORTEX_PARTICLE_COUNT);
    draws.length = 0;

    expect(frames).toHaveLength(1);
    frames.shift()?.(performance.now() + 100);

    expect(
      draws.filter((draw) => draw.mode === pointsMode),
    ).toHaveLength(0);
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
