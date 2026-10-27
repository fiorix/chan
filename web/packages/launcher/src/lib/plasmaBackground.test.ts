import { afterEach, expect, it, vi } from "vitest";
import { createPlasmaBackground, hasBackgroundGpu } from "./plasmaBackground";

afterEach(() => {
  document.querySelectorAll("canvas").forEach((canvas) => canvas.remove());
  delete window.__chanLauncherGpuAvailable;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("respects the native GPU absence without probing WebGL", () => {
  window.__chanLauncherGpuAvailable = false;
  const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
  expect(hasBackgroundGpu()).toBe(false);
  expect(context).not.toHaveBeenCalled();
});

it.each([null, "SwiftShader", "llvmpipe", "Microsoft Basic Render Driver", "Apple GPU"])(
  "handles renderer %s and releases the probe context", (renderer) => {
    const loseContext = vi.fn();
    const context = renderer === null ? null : {
      getExtension: (name: string) => name === "WEBGL_lose_context" ? { loseContext } : null,
      getParameter: () => renderer,
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as never);
    expect(hasBackgroundGpu()).toBe(renderer === "Apple GPU");
    if (renderer !== null) expect(loseContext).toHaveBeenCalledOnce();
  },
);

function mockGL() {
  return {
    createShader: vi.fn(() => ({})), shaderSource: vi.fn(), compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true), deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({})), attachShader: vi.fn(), linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true), useProgram: vi.fn(), deleteProgram: vi.fn(),
    createBuffer: vi.fn(() => ({})), bindBuffer: vi.fn(), bufferData: vi.fn(), deleteBuffer: vi.fn(),
    getAttribLocation: vi.fn(() => 0), enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(),
    getUniformLocation: vi.fn(() => ({})), uniform1f: vi.fn(), uniform2f: vi.fn(), uniform3f: vi.fn(),
    clearColor: vi.fn(), clear: vi.fn(), viewport: vi.fn(), drawArrays: vi.fn(),
    getExtension: vi.fn(() => null),
  };
}

it("keeps one bounded loop and restores a lost context only while visible", () => {
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ width: 3840, height: 2160 } as DOMRect);
  const gl = mockGL();
  vi.spyOn(canvas, "getContext").mockReturnValue(gl as never);
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect = disconnect; });
  let nextFrame: FrameRequestCallback = () => {};
  const request = vi.fn((fn) => { nextFrame = fn; return 42; });
  const cancel = vi.fn();
  vi.stubGlobal("requestAnimationFrame", request);
  vi.stubGlobal("cancelAnimationFrame", cancel);
  vi.spyOn(performance, "now").mockReturnValue(0);
  const wave = createPlasmaBackground(canvas, () => 0.5)!;
  canvas.style.setProperty("--launcher-focus-color", "#22c55e");
  wave.start();
  expect(gl.uniform3f).toHaveBeenLastCalledWith(expect.anything(), 0x22 / 255, 0xc5 / 255, 0x5e / 255);
  wave.start();
  expect(canvas.width * canvas.height).toBeLessThanOrEqual(361_000);
  expect(canvas.width).toBeLessThanOrEqual(960);
  expect(request).toHaveBeenCalledOnce();
  gl.drawArrays.mockClear();
  nextFrame(16);
  expect(gl.drawArrays).not.toHaveBeenCalled();
  canvas.style.setProperty("--launcher-focus-color", "#ff5fb7");
  nextFrame(34);
  expect(gl.uniform3f).toHaveBeenLastCalledWith(expect.anything(), 1, 0x5f / 255, 0xb7 / 255);
  expect(gl.createProgram).toHaveBeenCalledOnce();
  expect(gl.drawArrays).toHaveBeenCalledOnce();
  canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
  expect(cancel).toHaveBeenCalledWith(42);
  wave.stop();
  const calls = request.mock.calls.length;
  canvas.dispatchEvent(new Event("webglcontextrestored"));
  nextFrame(1000);
  expect(request).toHaveBeenCalledTimes(calls);
  wave.start();
  expect(request).toHaveBeenCalledTimes(calls + 1);
  wave.destroy();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(gl.deleteProgram).toHaveBeenCalledOnce();
  expect(gl.deleteBuffer).toHaveBeenCalledOnce();
});

it.each(["compile", "link"])("cleans up after a %s failure and leaves the background flat", (failure) => {
  const canvas = document.createElement("canvas");
  const gl = mockGL();
  if (failure === "compile") gl.getShaderParameter.mockReturnValueOnce(true).mockReturnValueOnce(false);
  else gl.getProgramParameter.mockReturnValue(false);
  vi.spyOn(canvas, "getContext").mockReturnValue(gl as never);
  expect(createPlasmaBackground(canvas, () => 0.5)).toBeUndefined();
  expect(gl.deleteShader).toHaveBeenCalledTimes(2);
  if (failure === "link") expect(gl.deleteProgram).toHaveBeenCalledOnce();
  expect(gl.drawArrays).not.toHaveBeenCalled();
});
