const TAU = Math.PI * 2;

// Motion adapted from Hisadan's Processing sketch and continuation:
// https://x.com/hisadan/status/1974838123864756613
export const SIXFOLD_VORTEX_PARTICLE_COUNT = 30_000;
export const SIXFOLD_VORTEX_HALF_SIZE = 400;
export const SIXFOLD_VORTEX_DEVIATION = 99;
export const SIXFOLD_VORTEX_COUNT = 6;

export type RandomSource = () => number;
export type GaussianSource = () => number;

export interface SixfoldVortexTransform {
  centerX: number;
  centerY: number;
  scale: number;
}

export function fitSixfoldVortex(
  width: number,
  height: number,
): SixfoldVortexTransform {
  return {
    centerX: width / 2,
    centerY: height / 2,
    scale:
      Math.min(width, height) /
      (SIXFOLD_VORTEX_HALF_SIZE * 2),
  };
}

export function isSixfoldVortexPointDrawable(
  pointX: number,
  pointY: number,
  width: number,
  height: number,
): boolean {
  return (
    Number.isFinite(pointX) &&
    Number.isFinite(pointY) &&
    pointX >= -1 &&
    pointX <= width &&
    pointY >= -1 &&
    pointY <= height
  );
}

export function randomGaussian(
  random: RandomSource = Math.random,
): number {
  let first = 0;
  let second = 0;

  while (first === 0) first = random();
  while (second === 0) second = random();

  return (
    Math.sqrt(-2 * Math.log(first)) *
    Math.cos(TAU * second)
  );
}

export function createSixfoldVortexParticles(
  count = SIXFOLD_VORTEX_PARTICLE_COUNT,
  random: RandomSource = Math.random,
  gaussian: GaussianSource = () => randomGaussian(random),
): Float32Array {
  const particles = new Float32Array(Math.max(0, count) * 2);

  for (let index = 0; index < particles.length; index += 2) {
    const distance = SIXFOLD_VORTEX_DEVIATION * gaussian();
    const angle = random() * TAU;
    particles[index] = distance * Math.sin(angle);
    particles[index + 1] = distance * Math.cos(angle);
  }

  return particles;
}

function tangentScale(
  deltaX: number,
  deltaY: number,
  strength: number,
): number {
  const distanceSquared = Math.max(
    1e-6,
    deltaX * deltaX + deltaY * deltaY,
  );
  return strength / (distanceSquared * Math.sqrt(distanceSquared));
}

export function advanceSixfoldVortexParticles(
  particles: Float32Array,
  sourceTime: number,
  distance = 1,
): void {
  for (let index = 0; index < particles.length; index += 2) {
    let x = particles[index];
    let y = particles[index + 1];

    const centralScale = tangentScale(x, y, 9_999) * distance;
    const centralX = x;
    const centralY = y;
    x -= centralY * centralScale;
    y += centralX * centralScale;

    for (
      let vortex = 0;
      vortex < SIXFOLD_VORTEX_COUNT;
      vortex += 1
    ) {
      const angle = (vortex * TAU) / SIXFOLD_VORTEX_COUNT;
      const vortexX = sourceTime * Math.sin(angle);
      const vortexY = sourceTime * Math.cos(angle);
      const deltaX = x - vortexX;
      const deltaY = y - vortexY;
      const satelliteScale =
        tangentScale(deltaX, deltaY, 999) * distance;
      x += deltaY * satelliteScale;
      y -= deltaX * satelliteScale;
    }

    particles[index] = x;
    particles[index + 1] = y;
  }
}

export const SIXFOLD_VORTEX_POINT_VERTEX_SHADER = `#version 300 es
in vec2 aPosition;

uniform vec2 uScale;
uniform vec2 uOffset;

void main() {
  gl_Position = vec4(aPosition * uScale + uOffset, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;

export const SIXFOLD_VORTEX_POINT_FRAGMENT_SHADER = `#version 300 es
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
// With uFade 0 it is a plain blit used to present the trail surface.
export const SIXFOLD_VORTEX_SURFACE_FRAGMENT_SHADER = `#version 300 es
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

export interface SixfoldVortexFrame {
  points: Float32Array;
  pointCount: number;
  centerX: number;
  centerY: number;
  scale: number;
  backgroundColor: readonly [number, number, number];
  pointColor: readonly [number, number, number];
  pointAlpha: number;
  fade: number;
}

export interface SixfoldVortexRenderer {
  resetSurface(backgroundColor: readonly [number, number, number]): void;
  draw(frame: SixfoldVortexFrame): void;
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

interface SixfoldVortexTrailTarget {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
}

function createTrailTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): SixfoldVortexTrailTarget {
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

export function createSixfoldVortexRenderer(
  gl: WebGL2RenderingContext,
): SixfoldVortexRenderer {
  let pointProgram: WebGLProgram | null = null;
  let surfaceProgram: WebGLProgram | null = null;
  let pointBuffer: WebGLBuffer | null = null;
  let triangleBuffer: WebGLBuffer | null = null;

  try {
    pointProgram = linkProgram(
      gl,
      SIXFOLD_VORTEX_POINT_VERTEX_SHADER,
      SIXFOLD_VORTEX_POINT_FRAGMENT_SHADER,
    );
    surfaceProgram = linkProgram(
      gl,
      FULLSCREEN_TRIANGLE_VERTEX_SHADER,
      SIXFOLD_VORTEX_SURFACE_FRAGMENT_SHADER,
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

  if (!pointProgram || !surfaceProgram || !pointBuffer || !triangleBuffer) {
    throw new Error("could not allocate renderer resources");
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
  const surfaceResolution = uniformLocation(
    gl,
    surfaceProgram,
    "uResolution",
  );
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

  // Ping-pong trail surfaces hold the persistent motion trails the 2D
  // canvas kept in its backing store. RGBA8 matches the 8-bit fade
  // quantization of the 2D version exactly.
  let targetWidth = 0;
  let targetHeight = 0;
  let read: SixfoldVortexTrailTarget | null = null;
  let write: SixfoldVortexTrailTarget | null = null;

  function deleteTarget(target: SixfoldVortexTrailTarget | null): void {
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
          (2 * frame.scale) / width,
          (-2 * frame.scale) / height,
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
