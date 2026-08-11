// Motion adapted from Hisadan's Processing sketch and continuation:
// https://x.com/hisadan/status/1997466751832059960
export const POLAR_DRIFT_PARTICLE_COUNT = 9_999;
export const POLAR_DRIFT_HALF_SIZE = 400;
export const POLAR_DRIFT_INNER_RADIUS = 10;

export type RandomSource = () => number;

export function createPolarDriftParticles(
  count = POLAR_DRIFT_PARTICLE_COUNT,
  random: RandomSource = Math.random,
): Float32Array {
  const particles = new Float32Array(Math.max(0, count) * 2);

  for (let index = 0; index < particles.length; index += 1) {
    particles[index] =
      POLAR_DRIFT_HALF_SIZE -
      random() * POLAR_DRIFT_HALF_SIZE * 2;
  }

  return particles;
}

export function advancePolarDriftParticles(
  particles: Float32Array,
  phase: number,
  distance = 1,
  random: RandomSource = Math.random,
): void {
  const turn = 2 * Math.sin(phase);

  for (let index = 0; index < particles.length; index += 2) {
    const x = particles[index];
    const y = particles[index + 1];
    const angle = Math.atan2(y, x) * turn;
    const nextX = x - Math.cos(angle) * distance;
    const nextY = y - Math.sin(angle) * distance;
    const radius = Math.hypot(nextX, nextY);

    if (
      radius < POLAR_DRIFT_INNER_RADIUS ||
      radius > POLAR_DRIFT_HALF_SIZE
    ) {
      particles[index] =
        POLAR_DRIFT_HALF_SIZE -
        random() * POLAR_DRIFT_HALF_SIZE * 2;
      particles[index + 1] =
        POLAR_DRIFT_HALF_SIZE -
        random() * POLAR_DRIFT_HALF_SIZE * 2;
    } else {
      particles[index] = nextX;
      particles[index + 1] = nextY;
    }
  }
}

// ---------------------------------------------------------------------------
// WebGL2 paint path
//
// WHY: the 2D canvas version collected one `ctx.rect()` per particle into a
// single path and filled it every frame, which the browser GPU-accelerates on
// macOS and software-rasterizes on Linux. At 9,999 particles, and up to four
// simulation sub-steps on a slow frame, that is ~40k rects per frame on the CPU
// on the platform chan is developed on. The simulation above is untouched: this
// changes how pixels are produced, not what is computed.
//
// Structure follows `sixfoldVortex.ts`, the other animation in the family with
// persistent trails: points draw as `gl.POINTS` over a ping-pong framebuffer
// pair that reproduces the alpha-`fillRect` trail fade, 8-bit quantization
// included. Each module keeps its own shader helpers, which is how every other
// WebGL2 animation here is built.

export interface PolarDriftTransform {
  centerX: number;
  centerY: number;
  scaleX: number;
  scaleY: number;
}

/// Map source space onto the canvas. The scale is per-axis, not the uniform
/// `min(width, height)` its siblings use: this animation has always stretched
/// its field to fill the pane, and that is part of its identity.
export function fitPolarDrift(
  width: number,
  height: number,
): PolarDriftTransform {
  return {
    centerX: width / 2,
    centerY: height / 2,
    scaleX: width / (POLAR_DRIFT_HALF_SIZE * 2),
    scaleY: height / (POLAR_DRIFT_HALF_SIZE * 2),
  };
}

export const POLAR_DRIFT_POINT_VERTEX_SHADER = `#version 300 es
in vec2 aPosition;
uniform vec2 uScale;
uniform vec2 uOffset;

void main() {
  gl_Position = vec4(aPosition * uScale + uOffset, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;

export const POLAR_DRIFT_POINT_FRAGMENT_SHADER = `#version 300 es
precision mediump float;

uniform vec3 uPointColor;
uniform float uPointAlpha;
out vec4 o;

void main() {
  o = vec4(uPointColor, uPointAlpha);
}
`;

const FULLSCREEN_TRIANGLE_VERTEX_SHADER = `#version 300 es
in vec2 aPosition;

void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

// Trail surface pass: samples the previous frame and mixes it toward the
// background color, matching the 2D canvas fillRect(bg, alpha=fade) fade.
// With uFade 0 it is a plain blit, which is what a simulation sub-step needs:
// the fade belongs to the frame, not to each sub-step.
export const POLAR_DRIFT_SURFACE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uPrevious;
uniform vec2 uResolution;
uniform vec3 uBackgroundColor;
uniform float uFade;
out vec4 o;

void main() {
  vec3 previous = texture(uPrevious, gl_FragCoord.xy / uResolution).rgb;
  o = vec4(mix(previous, uBackgroundColor, uFade), 1.0);
}
`;

export interface PolarDriftFrame {
  points: Float32Array;
  pointCount: number;
  centerX: number;
  centerY: number;
  scaleX: number;
  scaleY: number;
  backgroundColor: readonly [number, number, number];
  pointColor: readonly [number, number, number];
  pointAlpha: number;
  fade: number;
}

export interface PolarDriftRenderer {
  resetSurface(backgroundColor: readonly [number, number, number]): void;
  draw(frame: PolarDriftFrame): void;
  destroy(): void;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("could not allocate shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const detail = gl.getShaderInfoLog(shader) || "unknown compile error";
    gl.deleteShader(shader);
    throw new Error(detail);
  }
  return shader;
}

function linkProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  let fragmentShader: WebGLShader;
  try {
    fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  } catch (error) {
    gl.deleteShader(vertexShader);
    throw error;
  }

  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    throw new Error("could not allocate shader program");
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const detail = gl.getProgramInfoLog(program) || "unknown link error";
    gl.deleteProgram(program);
    throw new Error(detail);
  }
  return program;
}

function uniformLocation(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);
  if (location === null) throw new Error(`missing shader uniform ${name}`);
  return location;
}

interface PolarDriftTrailTarget {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
}

function createTrailTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): PolarDriftTrailTarget {
  const texture = gl.createTexture();
  if (!texture) throw new Error("could not allocate trail texture");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    width,
    height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null,
  );

  const framebuffer = gl.createFramebuffer();
  if (!framebuffer) {
    gl.deleteTexture(texture);
    throw new Error("could not allocate trail framebuffer");
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture,
    0,
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { texture, framebuffer };
}

export function createPolarDriftRenderer(
  gl: WebGL2RenderingContext,
): PolarDriftRenderer {
  let pointProgram: WebGLProgram | null = null;
  let surfaceProgram: WebGLProgram | null = null;
  let pointBuffer: WebGLBuffer | null = null;
  let triangleBuffer: WebGLBuffer | null = null;

  try {
    pointProgram = linkProgram(
      gl,
      POLAR_DRIFT_POINT_VERTEX_SHADER,
      POLAR_DRIFT_POINT_FRAGMENT_SHADER,
    );
    surfaceProgram = linkProgram(
      gl,
      FULLSCREEN_TRIANGLE_VERTEX_SHADER,
      POLAR_DRIFT_SURFACE_FRAGMENT_SHADER,
    );
    pointBuffer = gl.createBuffer();
    triangleBuffer = gl.createBuffer();
    if (!pointBuffer || !triangleBuffer) {
      throw new Error("could not allocate vertex buffers");
    }
  } catch (error) {
    if (pointProgram) gl.deleteProgram(pointProgram);
    if (surfaceProgram) gl.deleteProgram(surfaceProgram);
    if (pointBuffer) gl.deleteBuffer(pointBuffer);
    if (triangleBuffer) gl.deleteBuffer(triangleBuffer);
    throw error;
  }

  const pointPosition = gl.getAttribLocation(pointProgram, "aPosition");
  const surfacePosition = gl.getAttribLocation(surfaceProgram, "aPosition");
  if (pointPosition < 0 || surfacePosition < 0) {
    gl.deleteProgram(pointProgram);
    gl.deleteProgram(surfaceProgram);
    gl.deleteBuffer(pointBuffer);
    gl.deleteBuffer(triangleBuffer);
    throw new Error("missing shader attribute aPosition");
  }

  const pointScale = uniformLocation(gl, pointProgram, "uScale");
  const pointOffset = uniformLocation(gl, pointProgram, "uOffset");
  const pointColor = uniformLocation(gl, pointProgram, "uPointColor");
  const pointAlpha = uniformLocation(gl, pointProgram, "uPointAlpha");
  const surfacePrevious = uniformLocation(gl, surfaceProgram, "uPrevious");
  const surfaceResolution = uniformLocation(gl, surfaceProgram, "uResolution");
  const surfaceBackground = uniformLocation(
    gl,
    surfaceProgram,
    "uBackgroundColor",
  );
  const surfaceFade = uniformLocation(gl, surfaceProgram, "uFade");

  gl.bindBuffer(gl.ARRAY_BUFFER, triangleBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  );
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);

  // Ping-pong trail surfaces hold the persistent trails the 2D canvas kept in
  // its backing store. RGBA8 matches the 8-bit fade quantization exactly.
  let targetWidth = 0;
  let targetHeight = 0;
  let read: PolarDriftTrailTarget | null = null;
  let write: PolarDriftTrailTarget | null = null;

  function deleteTarget(target: PolarDriftTrailTarget | null): void {
    if (!target) return;
    gl.deleteTexture(target.texture);
    gl.deleteFramebuffer(target.framebuffer);
  }

  function ensureTargets(width: number, height: number): void {
    if (width === targetWidth && height === targetHeight && read && write) {
      return;
    }
    deleteTarget(read);
    deleteTarget(write);
    targetWidth = width;
    targetHeight = height;
    read = createTrailTarget(gl, width, height);
    write = createTrailTarget(gl, width, height);
  }

  function bindSurfacePass(
    backgroundColor: readonly [number, number, number],
    fade: number,
  ): void {
    gl.useProgram(surfaceProgram);
    gl.uniform1i(surfacePrevious, 0);
    gl.uniform2f(surfaceResolution, targetWidth, targetHeight);
    gl.uniform3f(
      surfaceBackground,
      backgroundColor[0],
      backgroundColor[1],
      backgroundColor[2],
    );
    gl.uniform1f(surfaceFade, fade);
    gl.bindBuffer(gl.ARRAY_BUFFER, triangleBuffer);
    gl.enableVertexAttribArray(surfacePosition);
    gl.vertexAttribPointer(surfacePosition, 2, gl.FLOAT, false, 0, 0);
  }

  return {
    resetSurface(backgroundColor) {
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      if (width <= 0 || height <= 0) return;
      ensureTargets(width, height);

      gl.disable(gl.BLEND);
      gl.clearColor(
        backgroundColor[0],
        backgroundColor[1],
        backgroundColor[2],
        1,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, read?.framebuffer ?? null);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, write?.framebuffer ?? null);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },
    draw(frame) {
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      if (width <= 0 || height <= 0) return;
      ensureTargets(width, height);
      if (!read || !write) return;

      gl.bindBuffer(gl.ARRAY_BUFFER, pointBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        frame.points.subarray(0, frame.pointCount * 2),
        gl.DYNAMIC_DRAW,
      );

      gl.disable(gl.BLEND);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, write.framebuffer);
      gl.bindTexture(gl.TEXTURE_2D, read.texture);
      bindSurfacePass(frame.backgroundColor, frame.fade);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      if (frame.pointCount > 0) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(pointProgram);
        gl.bindBuffer(gl.ARRAY_BUFFER, pointBuffer);
        gl.enableVertexAttribArray(pointPosition);
        gl.vertexAttribPointer(pointPosition, 2, gl.FLOAT, false, 0, 0);
        gl.uniform2f(
          pointScale,
          (2 * frame.scaleX) / width,
          (-2 * frame.scaleY) / height,
        );
        gl.uniform2f(
          pointOffset,
          (2 * frame.centerX) / width - 1,
          1 - (2 * frame.centerY) / height,
        );
        gl.uniform3f(
          pointColor,
          frame.pointColor[0],
          frame.pointColor[1],
          frame.pointColor[2],
        );
        gl.uniform1f(pointAlpha, frame.pointAlpha);
        gl.drawArrays(gl.POINTS, 0, frame.pointCount);
        gl.disable(gl.BLEND);
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, write.texture);
      bindSurfacePass(frame.backgroundColor, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      const previous = read;
      read = write;
      write = previous;
    },
    destroy() {
      deleteTarget(read);
      deleteTarget(write);
      gl.deleteBuffer(pointBuffer);
      gl.deleteBuffer(triangleBuffer);
      gl.deleteProgram(pointProgram);
      gl.deleteProgram(surfaceProgram);
    },
  };
}
