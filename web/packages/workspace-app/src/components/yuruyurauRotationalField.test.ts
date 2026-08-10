// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import FourteenfoldBloom from "./FourteenfoldBloom.svelte";
import {
  YURUYURAU_ROTATIONAL_FADE_FRAGMENT_SHADER,
  YURUYURAU_ROTATIONAL_POINT_VERTEX_SHADER,
  YURUYURAU_ROTATIONAL_SOURCE_SIZE,
} from "./yuruyurauRotationalField";

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
  trianglesMode: number;
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
    viewport: vi.fn(),
    clearColor: vi.fn(),
    clear: vi.fn(),
  };
  return {
    gl: gl as unknown as WebGL2RenderingContext,
    draws,
    pointsMode: gl.POINTS,
    trianglesMode: gl.TRIANGLES,
  };
}

describe("Yuruyurau rotational field", () => {
  test("keeps the source space size and rotational WebGL2 rendering", async () => {
    const renderer = (await import("./YuruyurauRotationalField.svelte?raw"))
      .default as string;

    expect(YURUYURAU_ROTATIONAL_SOURCE_SIZE).toBe(400);
    expect(renderer).toContain("runWebgl2Animation");
    expect(renderer).toContain("46 / 255");
    expect(YURUYURAU_ROTATIONAL_POINT_VERTEX_SHADER).toContain("uRotation");
    expect(YURUYURAU_ROTATIONAL_POINT_VERTEX_SHADER).toContain(
      "uCoverScale",
    );
    expect(YURUYURAU_ROTATIONAL_POINT_VERTEX_SHADER).toContain(
      "gl_PointSize = 1.0;",
    );
  });

  test("fades the center behind the chan mark with the gradient stops", async () => {
    const renderer = (await import("./YuruyurauRotationalField.svelte?raw"))
      .default as string;

    expect(renderer).toContain("Math.min(76, centerFadeRadius * 0.55)");
    expect(renderer).toMatch(/reducedMotion: \(\) => draw\(0\)/);
    expect(YURUYURAU_ROTATIONAL_FADE_FRAGMENT_SHADER).toContain("0.192");
    expect(YURUYURAU_ROTATIONAL_FADE_FRAGMENT_SHADER).toContain("0.164");
    expect(YURUYURAU_ROTATIONAL_FADE_FRAGMENT_SHADER).toContain("0.55");
    expect(YURUYURAU_ROTATIONAL_FADE_FRAGMENT_SHADER).toContain("clamp(");
    expect(YURUYURAU_ROTATIONAL_FADE_FRAGMENT_SHADER).toContain(
      "uFadeInnerRadius",
    );
    expect(YURUYURAU_ROTATIONAL_FADE_FRAGMENT_SHADER).toContain(
      "uFadeOuterRadius",
    );
  });

  test("replays the captured trace once per rotation plus one fade pass", async () => {
    const { gl, draws, pointsMode, trianglesMode } = createFakeWebgl2();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      gl,
    );
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const target = document.createElement("div");
    document.body.append(target);
    mounted = mount(FourteenfoldBloom, { target });
    await tick();

    const pointDraws = draws.filter((draw) => draw.mode === pointsMode);
    expect(pointDraws).toHaveLength(14);
    for (const draw of pointDraws) {
      expect(draw.count).toBe(pointDraws[0].count);
      expect(draw.count).toBeGreaterThan(0);
    }

    const fadeDraws = draws.filter(
      (draw) => draw.mode === trianglesMode,
    );
    expect(fadeDraws).toHaveLength(1);
    expect(fadeDraws[0]).toMatchObject({ first: 0, count: 3 });
  });
});
