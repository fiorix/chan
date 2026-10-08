import { FULLSCREEN_TRIANGLE, linkProgram, uniformLocation } from "./webglProgram";

// Geometry and motion adapted from WGG_SH's p5.js sketch:
// https://x.com/WGG_SH/status/1225446291645157376
export const SPIRAL_FOUNTAIN_DISC_COUNT = 6000;
// The sketch draws on a 999 pixel square canvas, so one source unit is one
// pixel there.
export const SPIRAL_FOUNTAIN_SOURCE_SIZE = 999;
export const SPIRAL_FOUNTAIN_DISC_RADIUS = 15;
/// The source frames between one disc leaving the center and its next
/// departure. The sketch releases three discs a frame and stops after the
/// last; here the sequence starts over, so the fountain never runs dry.
export const SPIRAL_FOUNTAIN_PERIOD = SPIRAL_FOUNTAIN_DISC_COUNT / 3;

const SOURCE_SPEED = 3;
const ARM_TURN = (Math.PI / 3) * 2;

const FLOATS_PER_DISC = 3;

/// Writes the discs within `reach` source units of the center at source
/// frame `time` into `out`, three numbers each, and returns how many: the x
/// and y from the center, y growing downward, and the disc's fill level from
/// 0 to 1 of its outline's. Discs are written in the sketch's order, which is
/// the order they paint over one another.
export function buildSpiralFountainDiscs(
  time: number,
  reach: number,
  out: Float32Array,
): number {
  let count = 0;

  for (let index = 0; index < SPIRAL_FOUNTAIN_DISC_COUNT; index += 1) {
    const sinceRelease = (time - index / 3) % SPIRAL_FOUNTAIN_PERIOD;
    const age =
      sinceRelease < 0 ? sinceRelease + SPIRAL_FOUNTAIN_PERIOD : sinceRelease;
    const distance = age * SOURCE_SPEED;
    if (distance > reach) continue;

    const angle = (index * index) / 9000 + ARM_TURN * index;
    const offset = count * FLOATS_PER_DISC;
    out[offset] = Math.cos(angle) * distance;
    out[offset + 1] = Math.sin(angle) * distance;
    // The sketch fills with a grey of 40 + 30 sin(index / 90) and outlines
    // with a grey of 90.
    out[offset + 2] = (40 + 30 * Math.sin(index / 90)) / 90;
    count += 1;
  }

  return count;
}

export const SPIRAL_FOUNTAIN_DISC_VERTEX_SHADER = `#version 300 es
in vec3 aDisc;

uniform vec2 uResolution;
uniform float uScale;
uniform float uRadius;
out float vLevel;

void main() {
  vec2 clip = aDisc.xy * uScale * 2.0 / uResolution;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vLevel = aDisc.z;
  // The outline straddles the rim, and a pixel of margin on each side holds
  // its antialiased edge.
  gl_PointSize = 2.0 * uRadius + max(1.0, uScale) + 2.0;
}
`;

export const SPIRAL_FOUNTAIN_DISC_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in float vLevel;
uniform float uScale;
uniform float uRadius;
uniform vec3 uBackgroundColor;
uniform float uTone;
uniform float uOpacity;
out vec4 o;

void main() {
  float outline = max(1.0, uScale);
  float size = 2.0 * uRadius + outline + 2.0;
  float distance = length(gl_PointCoord - 0.5) * size;
  float rim = clamp(distance - (uRadius - outline * 0.5) + 0.5, 0.0, 1.0);
  float level = mix(vLevel, 1.0, rim) * uOpacity;
  float coverage =
    clamp(uRadius + outline * 0.5 - distance + 0.5, 0.0, 1.0);
  o = vec4(mix(uBackgroundColor, vec3(uTone), level), coverage);
}
`;

const FULLSCREEN_TRIANGLE_VERTEX_SHADER = `#version 300 es
in vec2 aPosition;

void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

// Trail surface pass: samples the previous frame and moves it toward the
// background colour by uFade of the way, as the sketch's translucent
// background() does. A fading channel moves at least one 8-bit level, so a
// trail reaches the background instead of stalling a few levels short of it,
// where rounding would hold it. With uFade 0 the pass is a plain blit.
export const SPIRAL_FOUNTAIN_SURFACE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uPrevious;
uniform vec2 uResolution;
uniform vec3 uBackgroundColor;
uniform float uFade;
out vec4 o;

void main() {
  vec3 previous = texture(uPrevious, gl_FragCoord.xy / uResolution).rgb;
  vec3 gap = uBackgroundColor - previous;
  float least = uFade > 0.0 ? 1.0 / 255.0 : 0.0;
  vec3 move = min(abs(gap), max(abs(gap) * uFade, vec3(least)));
  o = vec4(previous + sign(gap) * move, 1.0);
}
`;

export interface SpiralFountainFrame {
  /// The source frames to stamp the discs at, oldest first. More than one
  /// fills in the trail between two paints.
  times: readonly number[];
  /// How far the surface fades toward the background before the stamps.
  fade: number;
  fieldScale: number;
  backgroundColor: readonly [number, number, number];
  tone: number;
  opacity: number;
}

export interface SpiralFountainRenderer {
  resetSurface(backgroundColor: readonly [number, number, number]): void;
  draw(frame: SpiralFountainFrame): void;
  destroy(): void;
}

interface TrailTarget {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
}

function createTrailTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): TrailTarget {
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

export function createSpiralFountainRenderer(
  gl: WebGL2RenderingContext,
): SpiralFountainRenderer {
  let discProgram: WebGLProgram | null = null;
  let surfaceProgram: WebGLProgram | null = null;
  let discBuffer: WebGLBuffer | null = null;
  let triangleBuffer: WebGLBuffer | null = null;

  function deletePrograms(): void {
    if (discProgram) gl.deleteProgram(discProgram);
    if (surfaceProgram) gl.deleteProgram(surfaceProgram);
    if (discBuffer) gl.deleteBuffer(discBuffer);
    if (triangleBuffer) gl.deleteBuffer(triangleBuffer);
  }

  let discPosition: number;
  let surfacePosition: number;
  let discResolution: WebGLUniformLocation;
  let discScale: WebGLUniformLocation;
  let discRadius: WebGLUniformLocation;
  let discBackground: WebGLUniformLocation;
  let discTone: WebGLUniformLocation;
  let discOpacity: WebGLUniformLocation;
  let surfacePrevious: WebGLUniformLocation;
  let surfaceResolution: WebGLUniformLocation;
  let surfaceBackground: WebGLUniformLocation;
  let surfaceFade: WebGLUniformLocation;
  try {
    discProgram = linkProgram(
      gl,
      SPIRAL_FOUNTAIN_DISC_VERTEX_SHADER,
      SPIRAL_FOUNTAIN_DISC_FRAGMENT_SHADER,
    );
    surfaceProgram = linkProgram(
      gl,
      FULLSCREEN_TRIANGLE_VERTEX_SHADER,
      SPIRAL_FOUNTAIN_SURFACE_FRAGMENT_SHADER,
    );
    discBuffer = gl.createBuffer();
    triangleBuffer = gl.createBuffer();
    if (!discBuffer || !triangleBuffer) {
      throw new Error("could not allocate vertex buffers");
    }
    discPosition = gl.getAttribLocation(discProgram, "aDisc");
    surfacePosition = gl.getAttribLocation(surfaceProgram, "aPosition");
    if (discPosition < 0 || surfacePosition < 0) {
      throw new Error("missing shader attribute");
    }
    discResolution = uniformLocation(gl, discProgram, "uResolution");
    discScale = uniformLocation(gl, discProgram, "uScale");
    discRadius = uniformLocation(gl, discProgram, "uRadius");
    discBackground = uniformLocation(gl, discProgram, "uBackgroundColor");
    discTone = uniformLocation(gl, discProgram, "uTone");
    discOpacity = uniformLocation(gl, discProgram, "uOpacity");
    surfacePrevious = uniformLocation(gl, surfaceProgram, "uPrevious");
    surfaceResolution = uniformLocation(gl, surfaceProgram, "uResolution");
    surfaceBackground = uniformLocation(
      gl,
      surfaceProgram,
      "uBackgroundColor",
    );
    surfaceFade = uniformLocation(gl, surfaceProgram, "uFade");
  } catch (error) {
    deletePrograms();
    throw error;
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, triangleBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array(FULLSCREEN_TRIANGLE),
    gl.STATIC_DRAW,
  );
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);

  // Ping-pong trail surfaces hold the picture between paints, the way the
  // sketch's canvas does: each paint fades the last one and stamps onto it.
  let targetWidth = 0;
  let targetHeight = 0;
  let read: TrailTarget | null = null;
  let write: TrailTarget | null = null;
  const discs = new Float32Array(
    SPIRAL_FOUNTAIN_DISC_COUNT * FLOATS_PER_DISC,
  );

  function deleteTarget(target: TrailTarget | null): void {
    if (!target) return;
    gl.deleteTexture(target.texture);
    gl.deleteFramebuffer(target.framebuffer);
  }

  function clearTargets(
    backgroundColor: readonly [number, number, number],
  ): void {
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
  }

  /// Fresh surfaces start as the background, never as the transparent black
  /// a new texture holds.
  function ensureTargets(
    width: number,
    height: number,
    backgroundColor: readonly [number, number, number],
  ): void {
    if (width === targetWidth && height === targetHeight && read && write) {
      return;
    }
    deleteTarget(read);
    deleteTarget(write);
    targetWidth = width;
    targetHeight = height;
    read = createTrailTarget(gl, width, height);
    write = createTrailTarget(gl, width, height);
    clearTargets(backgroundColor);
  }

  function drawSurfacePass(
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
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  return {
    resetSurface(backgroundColor) {
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      if (width <= 0 || height <= 0) return;
      ensureTargets(width, height, backgroundColor);
      clearTargets(backgroundColor);
    },
    draw(frame) {
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      if (width <= 0 || height <= 0) return;
      ensureTargets(width, height, frame.backgroundColor);
      if (!read || !write) return;

      gl.disable(gl.BLEND);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, write.framebuffer);
      gl.bindTexture(gl.TEXTURE_2D, read.texture);
      drawSurfacePass(frame.backgroundColor, frame.fade);

      const scale =
        (Math.min(width, height) / SPIRAL_FOUNTAIN_SOURCE_SIZE) *
        frame.fieldScale;
      // A disc is drawn until its outline has left the farthest corner.
      const reach =
        Math.hypot(width, height) / 2 / scale +
        SPIRAL_FOUNTAIN_DISC_RADIUS +
        1;

      gl.enable(gl.BLEND);
      // Blend colour only, so the surface stays opaque under the
      // antialiased rims.
      gl.blendFuncSeparate(
        gl.SRC_ALPHA,
        gl.ONE_MINUS_SRC_ALPHA,
        gl.ZERO,
        gl.ONE,
      );
      gl.useProgram(discProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, discBuffer);
      gl.enableVertexAttribArray(discPosition);
      gl.vertexAttribPointer(
        discPosition,
        FLOATS_PER_DISC,
        gl.FLOAT,
        false,
        0,
        0,
      );
      gl.uniform2f(discResolution, width, height);
      gl.uniform1f(discScale, scale);
      gl.uniform1f(discRadius, SPIRAL_FOUNTAIN_DISC_RADIUS * scale);
      gl.uniform3f(
        discBackground,
        frame.backgroundColor[0],
        frame.backgroundColor[1],
        frame.backgroundColor[2],
      );
      gl.uniform1f(discTone, frame.tone);
      gl.uniform1f(discOpacity, frame.opacity);
      for (const time of frame.times) {
        const count = buildSpiralFountainDiscs(time, reach, discs);
        if (count === 0) continue;
        gl.bufferData(
          gl.ARRAY_BUFFER,
          discs.subarray(0, count * FLOATS_PER_DISC),
          gl.DYNAMIC_DRAW,
        );
        gl.drawArrays(gl.POINTS, 0, count);
      }
      gl.disable(gl.BLEND);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, write.texture);
      drawSurfacePass(frame.backgroundColor, 0);

      const previous = read;
      read = write;
      write = previous;
    },
    destroy() {
      deleteTarget(read);
      deleteTarget(write);
      deletePrograms();
    },
  };
}
