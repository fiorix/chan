// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import LorenzConstellation from "./LorenzConstellation.svelte";
import { LORENZ_CONSTELLATION_POINT_COUNT } from "./lorenzConstellation";
import {
  YURUYURAU_POINT_CLOUD_FRAGMENT_SHADER,
  YURUYURAU_POINT_CLOUD_VERTEX_SHADER,
} from "./yuruyurauPointCloud";

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

function createFakeWebgl2(
  overrides: Partial<Record<string, unknown>> = {},
): {
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
    ZERO: 0x0000,
    ONE: 0x0001,
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
    drawArrays: vi.fn((mode: number, first: number, count: number) => {
      draws.push({ mode, first, count });
    }),
    enable: vi.fn(),
    disable: vi.fn(),
    blendFunc: vi.fn(),
    blendFuncSeparate: vi.fn(),
    viewport: vi.fn(),
    clearColor: vi.fn(),
    clear: vi.fn(),
    ...overrides,
  };
  return {
    gl: gl as unknown as WebGL2RenderingContext,
    draws,
    pointsMode: gl.POINTS,
  };
}

function stubAnimationHost(gl: WebGL2RenderingContext): void {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(gl);
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
}

describe("Yuruyurau point cloud", () => {
  test("places and sizes points on the GPU", async () => {
    const renderer = (await import("./YuruyurauPointCloud.svelte?raw"))
      .default as string;

    expect(renderer).toContain("runWebgl2Animation");
    expect(renderer).not.toContain("runCanvasAnimation");
    expect(YURUYURAU_POINT_CLOUD_VERTEX_SHADER).toContain("uCenter");
    expect(YURUYURAU_POINT_CLOUD_VERTEX_SHADER).toContain("uSourceCenter");
    expect(YURUYURAU_POINT_CLOUD_VERTEX_SHADER).toContain("uScale");
    expect(YURUYURAU_POINT_CLOUD_VERTEX_SHADER).toContain(
      "gl_PointSize = uPointSize;",
    );
    expect(YURUYURAU_POINT_CLOUD_FRAGMENT_SHADER).toContain("uPointAlpha");
  });

  test("draws the whole cloud in a single pass", async () => {
    const { gl, draws, pointsMode } = createFakeWebgl2();
    stubAnimationHost(gl);

    const target = document.createElement("div");
    document.body.append(target);
    mounted = mount(LorenzConstellation, { target });
    await tick();

    const pointDraws = draws.filter((draw) => draw.mode === pointsMode);
    expect(pointDraws).toHaveLength(1);
    expect(pointDraws[0].first).toBe(0);
    expect(pointDraws[0].count).toBeGreaterThan(0);
    expect(pointDraws[0].count).toBeLessThanOrEqual(
      LORENZ_CONSTELLATION_POINT_COUNT,
    );
  });

  test("stays quiet and draws nothing when the renderer cannot be built", async () => {
    const { gl, draws } = createFakeWebgl2({
      createProgram: vi.fn(() => null),
    });
    stubAnimationHost(gl);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const target = document.createElement("div");
    document.body.append(target);
    mounted = mount(LorenzConstellation, { target });
    await tick();

    expect(draws).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      "[chan] Yuruyurau point cloud WebGL renderer unavailable:",
      expect.any(Error),
    );
  });
});
