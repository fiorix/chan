import { FRAGMENT_SHADER, VERTEX_SHADER } from "./plasmaShader";

export const DEFAULT_WAVE_SPEED = 0.5;

// Native state is seeded before the launcher loads. Ordinary browser pages
// have no native handoff and can start as soon as they are visible.
declare global {
  interface Window {
    __chanLauncherSettled?: boolean;
    __chanLauncherGpuAvailable?: boolean;
  }
}

export function hasBackgroundGpu(): boolean {
  if (window.__chanLauncherGpuAvailable === false) return false;
  let gl: WebGLRenderingContext | null = null;
  try {
    gl = document.createElement("canvas").getContext("webgl");
    if (!gl) return false;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    return !/swiftshader|llvmpipe|softpipe|lavapipe|software|basic render driver/i.test(name);
  } catch {
    return false;
  } finally {
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

// One low-resolution shader pass, composited behind the live launcher.
export function createPlasmaBackground(canvas: HTMLCanvasElement, speed: () => number) {
  const gl = canvas.getContext("webgl", { alpha: true, antialias: false, depth: false, stencil: false });
  if (!gl) return undefined;
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  let resolution: WebGLUniformLocation | null = null;
  let time: WebGLUniformLocation | null = null;
  let tint: WebGLUniformLocation | null = null;
  let phase = 0;
  let previous = 0;
  let raf = 0;
  let running = false;
  let wanted = false;
  let lost = false;

  function release() {
    if (buffer) gl!.deleteBuffer(buffer);
    if (program) gl!.deleteProgram(program);
    buffer = null;
    program = null;
  }
  function compile(type: number, source: string) {
    const shader = gl!.createShader(type);
    if (!shader) throw new Error("Shader allocation failed");
    gl!.shaderSource(shader, source);
    gl!.compileShader(shader);
    if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) {
      gl!.deleteShader(shader);
      throw new Error("Shader compilation failed");
    }
    return shader;
  }
  function initialize() {
    let vertex: WebGLShader | null = null;
    let fragment: WebGLShader | null = null;
    try {
      vertex = compile(gl!.VERTEX_SHADER, VERTEX_SHADER);
      fragment = compile(gl!.FRAGMENT_SHADER, FRAGMENT_SHADER);
      program = gl!.createProgram();
      if (!program) throw new Error("Program allocation failed");
      gl!.attachShader(program, vertex);
      gl!.attachShader(program, fragment);
      gl!.linkProgram(program);
      if (!gl!.getProgramParameter(program, gl!.LINK_STATUS)) throw new Error("Program link failed");
      gl!.useProgram(program);
      buffer = gl!.createBuffer();
      if (!buffer) throw new Error("Buffer allocation failed");
      gl!.bindBuffer(gl!.ARRAY_BUFFER, buffer);
      gl!.bufferData(gl!.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl!.STATIC_DRAW);
      const position = gl!.getAttribLocation(program, "position");
      gl!.enableVertexAttribArray(position);
      gl!.vertexAttribPointer(position, 2, gl!.FLOAT, false, 0, 0);
      resolution = gl!.getUniformLocation(program, "resolution");
      time = gl!.getUniformLocation(program, "time");
      tint = gl!.getUniformLocation(program, "tint");
      gl!.clearColor(0, 0, 0, 0);
      return true;
    } catch {
      release();
      return false;
    } finally {
      if (vertex) gl!.deleteShader(vertex);
      if (fragment) gl!.deleteShader(fragment);
    }
  }
  if (!initialize()) {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return undefined;
  }

  function clear() { if (!lost) gl!.clear(gl!.COLOR_BUFFER_BIT); }
  function draw() {
    if (!program || lost || canvas.width === 0 || canvas.height === 0) return;
    // Native panels follow their own host's pane colour, including remote
    // libraries. Browser launchers have no host pane and use the theme brand.
    const styles = getComputedStyle(canvas);
    const color = (styles.getPropertyValue("--launcher-focus-color") || styles.getPropertyValue("--brand")).trim();
    const rgb = /^#[0-9a-f]{6}$/i.test(color) ? Number.parseInt(color.slice(1), 16) : 0xe58c4d;
    gl!.uniform3f(tint, (rgb >> 16) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255);
    gl!.uniform2f(resolution, canvas.width, canvas.height);
    gl!.uniform1f(time, phase);
    gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
  }
  function resize() {
    const { width, height } = canvas.getBoundingClientRect();
    // A decorative glow does not need retina rasterization. Bound both the
    // longest edge and total shaded pixels on large and ultrawide displays.
    const scale = Math.min(1, 960 / Math.max(width, height, 1), Math.sqrt(360_000 / Math.max(width * height, 1)));
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    gl!.viewport(0, 0, canvas.width, canvas.height);
    if (running) draw();
  }
  function frame(now: number) {
    if (!running) return;
    if (now - previous >= 1000 / 30) {
      phase += Math.min(now - previous, 100) * 0.001 * Math.max(0, speed());
      previous = now;
      draw();
    }
    raf = requestAnimationFrame(frame);
  }
  function pause() {
    running = false;
    cancelAnimationFrame(raf);
    raf = 0;
  }
  function start() {
    wanted = true;
    if (running || lost || !program) return;
    running = true;
    previous = performance.now();
    resize();
    raf = requestAnimationFrame(frame);
  }
  function onLost(event: Event) {
    event.preventDefault();
    lost = true;
    pause();
  }
  function onRestored() {
    lost = false;
    // Context restoration invalidates every old GL object.
    program = null;
    buffer = null;
    if (initialize() && wanted) start();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  return {
    start,
    stop() { wanted = false; pause(); },
    clear,
    destroy() {
      wanted = false;
      pause();
      observer.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      clear();
      release();
      gl!.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
