import { latticeNoise, latticeNoiseTable } from "./latticeNoise";
import {
  ROUND_POINT_FLOATS,
  ROUND_POINT_FRAGMENT_SHADER,
  ROUND_POINT_VERTEX_SHADER,
} from "./roundPoints";
import { FULLSCREEN_TRIANGLE, linkProgram, uniformLocation } from "./webglProgram";

// Geometry and motion adapted from Hau_kun's p5.js sketch:
// https://x.com/Hau_kun/status/1944754296501022726
// The sketch draws on a 720 pixel square canvas, so one source unit is one
// pixel there.
export const NINEFOLD_LOTUS_SOURCE_SIZE = 720;

const RING_STEP = 30;
const OUTER_RADIUS = 360;
const PETALS = 9;
const TAU = Math.PI * 2;
// p5.js seeds its noise at random on every load, so no one table is the
// sketch's. This one is fixed, and the petals are the same on every mount.
const NOISE_SEED = 1;
// A dot the sketch draws fainter than this adds nothing to an 8-bit canvas.
const FAINTEST_ALPHA = 1 / 510;

/// What the sketch fades its canvas by before every frame.
export const NINEFOLD_LOTUS_FADE = 0.03;
/// How far, in source units, the sketch's blur spreads the canvas each
/// frame: the standard deviation of p5.js's blur filter at the strength it
/// runs at when a sketch names none.
export const NINEFOLD_LOTUS_BLUR_SIGMA = 3.154;
/// The glow is kept at a quarter of the canvas's resolution each way. It is
/// all blur, so it loses nothing, and fading and blurring it costs a
/// sixteenth of the pixels.
export const NINEFOLD_LOTUS_GLOW_DOWNSCALE = 4;
const MAX_BLUR_REACH = 12;

const FLOATS_PER_SITE = 3;

/// The places the sketch puts a dot, three numbers each: the radius of its
/// ring, its angle around the ring, and the noise the sketch reads there.
/// Eleven rings, 30 units apart from the outside in, each with a dot every
/// two units of arc.
function layoutSites(): Float32Array {
  const table = latticeNoiseTable(NOISE_SEED);
  const sites: number[] = [];
  for (
    let ring = OUTER_RADIUS - RING_STEP;
    ring > 0;
    ring -= RING_STEP
  ) {
    for (let angle = 0; angle < TAU; angle += 2 / ring) {
      sites.push(ring, angle, latticeNoise(table, angle * 99, ring));
    }
  }
  return Float32Array.from(sites);
}

const SITES = layoutSites();

export const NINEFOLD_LOTUS_DOT_COUNT = SITES.length / FLOATS_PER_SITE;

/// Writes the dots the sketch draws on source frame `frame` into `out` as
/// round points, and returns how many: the x and y from the center, y
/// growing downward, the radius of the sketch's two unit circle, and the
/// dot's opacity. The sketch gives each ring a hue; here they share one
/// tone. A ring swells by the squared tangent of a clock that runs
/// 30 units of radius behind the ring outside it: at rest it is a circle,
/// and as the tangent climbs its nine waves grow into petals, fly apart and
/// fade. Dots too faint to see are left out.
export function buildNinefoldLotusDots(
  frame: number,
  out = new Float32Array(NINEFOLD_LOTUS_DOT_COUNT * ROUND_POINT_FLOATS),
): number {
  let count = 0;
  for (let site = 0; site < SITES.length; site += FLOATS_PER_SITE) {
    const ring = SITES[site]!;
    const angle = SITES[site + 1]!;
    const swell = Math.tan(ring / 199 - frame / 99) ** 2;
    const alpha = Math.min(1, 1 / swell);
    if (!(alpha >= FAINTEST_ALPHA)) continue;

    const distance =
      ring +
      Math.sin(
        angle * PETALS + ((frame / 9) * ring) / NINEFOLD_LOTUS_SOURCE_SIZE,
      ) *
        (ring / 4) *
        SITES[site + 2]! *
        swell;
    const offset = count * ROUND_POINT_FLOATS;
    out[offset] = Math.cos(angle - Math.PI / 2) * distance;
    out[offset + 1] = Math.sin(angle - Math.PI / 2) * distance;
    out[offset + 2] = 1;
    out[offset + 3] = alpha;
    count += 1;
  }
  return count;
}

/// The weights of one direction of a blur that spreads by `sigma` pixels:
/// the weight of the center tap, then of each tap further out, mirrored on
/// both sides. They sum to one across the whole kernel. A spread under a
/// pixel is three taps weighted to that exact variance; a wider one is a
/// Gaussian cut off at two and a half deviations.
export function ninefoldLotusBlurWeights(sigma: number): number[] {
  if (!(sigma > 0)) return [1];
  if (sigma < 0.7) {
    const side = (sigma * sigma) / 2;
    return [1 - 2 * side, side];
  }
  const reach = Math.min(MAX_BLUR_REACH, Math.ceil(2.5 * sigma));
  const weights: number[] = [];
  let total = 0;
  for (let tap = 0; tap <= reach; tap += 1) {
    const weight = Math.exp((-tap * tap) / (2 * sigma * sigma));
    weights.push(weight);
    total += tap === 0 ? weight : 2 * weight;
  }
  return weights.map((weight) => weight / total);
}

/// The opacity that makes a round point of `radius` pixels leave its true
/// area of ink. The point shader's antialiasing adds a soft rim, which is a
/// rounding error on the canvas but a large share of a dot that is a
/// fraction of a glow pixel across; uncorrected, the glow would come out
/// brighter the smaller it is kept.
export function ninefoldLotusStampOpacity(radius: number): number {
  if (!(radius > 0)) return 0;
  const drawn =
    radius <= 0.5
      ? ((Math.PI * (radius + 0.5) ** 3) / 3) * 2 * radius
      : Math.PI * (radius * radius + 1 / 12);
  return (Math.PI * radius * radius) / drawn;
}

const FULLSCREEN_TRIANGLE_VERTEX_SHADER = `#version 300 es
in vec2 aPosition;

void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

// One direction of the glow's blur, with the sketch's fade folded in. The
// glow is one number a pixel: how much of the tone covers it. On a surface
// that cannot hold fractions of an 8-bit level, uLeast keeps a fading pixel
// moving until it is empty.
export const NINEFOLD_LOTUS_BLUR_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uGlow;
uniform ivec2 uDirection;
uniform int uReach;
uniform float uWeights[${MAX_BLUR_REACH + 1}];
uniform float uFade;
uniform float uLeast;
out vec4 o;

void main() {
  ivec2 here = ivec2(gl_FragCoord.xy);
  ivec2 last = textureSize(uGlow, 0) - 1;
  float glow = uWeights[0] * texelFetch(uGlow, here, 0).r;
  for (int tap = 1; tap <= uReach; tap += 1) {
    ivec2 step = tap * uDirection;
    glow += uWeights[tap] * (
      texelFetch(uGlow, clamp(here + step, ivec2(0), last), 0).r +
      texelFetch(uGlow, clamp(here - step, ivec2(0), last), 0).r
    );
  }
  float least = uFade > 0.0 ? uLeast : 0.0;
  o = vec4(max(0.0, glow - max(glow * uFade, least)), 0.0, 0.0, 1.0);
}
`;

// Lays the glow under the dots: stretched to the canvas, in the dots' tone,
// premultiplied like them.
export const NINEFOLD_LOTUS_GLOW_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uGlow;
uniform vec2 uResolution;
uniform float uTone;
uniform float uOpacity;
out vec4 o;

void main() {
  float alpha = texture(uGlow, gl_FragCoord.xy / uResolution).r * uOpacity;
  o = vec4(vec3(uTone) * alpha, alpha);
}
`;

export interface NinefoldLotusFrame {
  /// The source frames to run, oldest first, at least one. The glow fades
  /// and blurs before each, as the sketch's canvas does, and takes on each
  /// frame's dots after it. The last frame's dots are the ones drawn sharp.
  frames: readonly number[];
  fieldScale: number;
  tone: number;
  opacity: number;
}

export interface NinefoldLotusRenderer {
  /// Empties the glow.
  reset(): void;
  draw(frame: NinefoldLotusFrame): void;
  destroy(): void;
}

interface GlowTarget {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
}

export function createNinefoldLotusRenderer(
  gl: WebGL2RenderingContext,
): NinefoldLotusRenderer {
  let dotProgram: WebGLProgram | null = null;
  let blurProgram: WebGLProgram | null = null;
  let glowProgram: WebGLProgram | null = null;
  let dotBuffer: WebGLBuffer | null = null;
  let triangleBuffer: WebGLBuffer | null = null;

  function deletePrograms(): void {
    if (dotProgram) gl.deleteProgram(dotProgram);
    if (blurProgram) gl.deleteProgram(blurProgram);
    if (glowProgram) gl.deleteProgram(glowProgram);
    if (dotBuffer) gl.deleteBuffer(dotBuffer);
    if (triangleBuffer) gl.deleteBuffer(triangleBuffer);
  }

  let dotPoint: number;
  let blurPosition: number;
  let glowPosition: number;
  let dotResolution: WebGLUniformLocation;
  let dotScale: WebGLUniformLocation;
  let dotTone: WebGLUniformLocation;
  let dotOpacity: WebGLUniformLocation;
  let blurGlow: WebGLUniformLocation;
  let blurDirection: WebGLUniformLocation;
  let blurReach: WebGLUniformLocation;
  let blurWeights: WebGLUniformLocation;
  let blurFade: WebGLUniformLocation;
  let blurLeast: WebGLUniformLocation;
  let glowGlow: WebGLUniformLocation;
  let glowResolution: WebGLUniformLocation;
  let glowTone: WebGLUniformLocation;
  let glowOpacity: WebGLUniformLocation;
  try {
    dotProgram = linkProgram(
      gl,
      ROUND_POINT_VERTEX_SHADER,
      ROUND_POINT_FRAGMENT_SHADER,
    );
    blurProgram = linkProgram(
      gl,
      FULLSCREEN_TRIANGLE_VERTEX_SHADER,
      NINEFOLD_LOTUS_BLUR_FRAGMENT_SHADER,
    );
    glowProgram = linkProgram(
      gl,
      FULLSCREEN_TRIANGLE_VERTEX_SHADER,
      NINEFOLD_LOTUS_GLOW_FRAGMENT_SHADER,
    );
    dotBuffer = gl.createBuffer();
    triangleBuffer = gl.createBuffer();
    if (!dotBuffer || !triangleBuffer) {
      throw new Error("could not allocate vertex buffers");
    }
    dotPoint = gl.getAttribLocation(dotProgram, "aPoint");
    blurPosition = gl.getAttribLocation(blurProgram, "aPosition");
    glowPosition = gl.getAttribLocation(glowProgram, "aPosition");
    if (dotPoint < 0 || blurPosition < 0 || glowPosition < 0) {
      throw new Error("missing shader attribute");
    }
    dotResolution = uniformLocation(gl, dotProgram, "uResolution");
    dotScale = uniformLocation(gl, dotProgram, "uScale");
    dotTone = uniformLocation(gl, dotProgram, "uTone");
    dotOpacity = uniformLocation(gl, dotProgram, "uOpacity");
    blurGlow = uniformLocation(gl, blurProgram, "uGlow");
    blurDirection = uniformLocation(gl, blurProgram, "uDirection");
    blurReach = uniformLocation(gl, blurProgram, "uReach");
    blurWeights = uniformLocation(gl, blurProgram, "uWeights");
    blurFade = uniformLocation(gl, blurProgram, "uFade");
    blurLeast = uniformLocation(gl, blurProgram, "uLeast");
    glowGlow = uniformLocation(gl, glowProgram, "uGlow");
    glowResolution = uniformLocation(gl, glowProgram, "uResolution");
    glowTone = uniformLocation(gl, glowProgram, "uTone");
    glowOpacity = uniformLocation(gl, glowProgram, "uOpacity");
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
  gl.disable(gl.DEPTH_TEST);

  // A glow that fades by 3% a frame spends most of its life within a few
  // 8-bit levels of nothing, where an 8-bit surface rounds the fade away.
  // Half-float surfaces hold it; without them the fade is kept moving a
  // level at a time, which trims the faint outer glow.
  const halfFloat =
    gl.getExtension("EXT_color_buffer_float") !== null ||
    gl.getExtension("EXT_color_buffer_half_float") !== null;

  // The glow, and a scratch surface for the blur's first direction.
  let glowWidth = 0;
  let glowHeight = 0;
  let glow: GlowTarget | null = null;
  let scratch: GlowTarget | null = null;
  const dots = new Float32Array(NINEFOLD_LOTUS_DOT_COUNT * ROUND_POINT_FLOATS);
  const weights = new Float32Array(MAX_BLUR_REACH + 1);

  function createTarget(width: number, height: number): GlowTarget {
    const texture = gl.createTexture();
    if (!texture) throw new Error("could not allocate glow texture");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      halfFloat ? gl.R16F : gl.R8,
      width,
      height,
      0,
      gl.RED,
      halfFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
      null,
    );

    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) {
      gl.deleteTexture(texture);
      throw new Error("could not allocate glow framebuffer");
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

  function deleteTarget(target: GlowTarget | null): void {
    if (!target) return;
    gl.deleteTexture(target.texture);
    gl.deleteFramebuffer(target.framebuffer);
  }

  function emptyGlow(): void {
    if (!glow) return;
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, glow.framebuffer);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function ensureTargets(width: number, height: number): void {
    const nextWidth = Math.ceil(width / NINEFOLD_LOTUS_GLOW_DOWNSCALE);
    const nextHeight = Math.ceil(height / NINEFOLD_LOTUS_GLOW_DOWNSCALE);
    if (
      nextWidth === glowWidth &&
      nextHeight === glowHeight &&
      glow &&
      scratch
    ) {
      return;
    }
    deleteTarget(glow);
    deleteTarget(scratch);
    glowWidth = nextWidth;
    glowHeight = nextHeight;
    glow = createTarget(nextWidth, nextHeight);
    scratch = createTarget(nextWidth, nextHeight);
    emptyGlow();
  }

  function bindTriangle(position: number): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, triangleBuffer);
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  }

  return {
    reset() {
      emptyGlow();
    },
    draw(frame) {
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      if (width <= 0 || height <= 0 || frame.frames.length === 0) return;
      ensureTargets(width, height);
      if (!glow || !scratch) return;
      const glowTarget = glow;
      const scratchTarget = scratch;

      const scale =
        (Math.min(width, height) / NINEFOLD_LOTUS_SOURCE_SIZE) *
        frame.fieldScale;
      const glowScale = scale / NINEFOLD_LOTUS_GLOW_DOWNSCALE;
      // A dot is one source unit in radius.
      const stamp = ninefoldLotusStampOpacity(glowScale);
      const kernel = ninefoldLotusBlurWeights(
        NINEFOLD_LOTUS_BLUR_SIGMA * glowScale,
      );
      weights.fill(0);
      weights.set(kernel);

      function blurPass(
        from: GlowTarget,
        to: GlowTarget,
        directionX: number,
        directionY: number,
        fade: number,
      ): void {
        gl.bindFramebuffer(gl.FRAMEBUFFER, to.framebuffer);
        gl.bindTexture(gl.TEXTURE_2D, from.texture);
        gl.uniform2i(blurDirection, directionX, directionY);
        gl.uniform1f(blurFade, fade);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }

      function fadeAndBlur(): void {
        gl.viewport(0, 0, glowWidth, glowHeight);
        gl.disable(gl.BLEND);
        gl.useProgram(blurProgram);
        gl.uniform1i(blurGlow, 0);
        gl.uniform1i(blurReach, kernel.length - 1);
        gl.uniform1fv(blurWeights, weights);
        gl.uniform1f(blurLeast, halfFloat ? 0 : 1 / 255);
        bindTriangle(blurPosition);
        blurPass(glowTarget, scratchTarget, 1, 0, NINEFOLD_LOTUS_FADE);
        blurPass(scratchTarget, glowTarget, 0, 1, 0);
      }

      /// The dots of one source frame, onto the glow at its resolution or
      /// onto the canvas at full size. The shader writes premultiplied
      /// colour, so a tone of one leaves a dot's own coverage in the glow's
      /// single channel.
      function drawDots(
        count: number,
        onto: GlowTarget | null,
        tone: number,
        opacity: number,
      ): void {
        if (count === 0) return;
        const shrink = onto ? NINEFOLD_LOTUS_GLOW_DOWNSCALE : 1;
        gl.bindFramebuffer(gl.FRAMEBUFFER, onto?.framebuffer ?? null);
        gl.viewport(
          0,
          0,
          onto ? glowWidth : width,
          onto ? glowHeight : height,
        );
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(dotProgram);
        gl.bindBuffer(gl.ARRAY_BUFFER, dotBuffer);
        gl.enableVertexAttribArray(dotPoint);
        gl.vertexAttribPointer(
          dotPoint,
          ROUND_POINT_FLOATS,
          gl.FLOAT,
          false,
          0,
          0,
        );
        gl.uniform2f(dotResolution, width / shrink, height / shrink);
        gl.uniform1f(dotScale, scale / shrink);
        gl.uniform1f(dotTone, tone);
        gl.uniform1f(dotOpacity, opacity);
        gl.drawArrays(gl.POINTS, 0, count);
      }

      function uploadDots(sourceFrame: number): number {
        const count = buildNinefoldLotusDots(sourceFrame, dots);
        gl.bindBuffer(gl.ARRAY_BUFFER, dotBuffer);
        gl.bufferData(
          gl.ARRAY_BUFFER,
          dots.subarray(0, count * ROUND_POINT_FLOATS),
          gl.DYNAMIC_DRAW,
        );
        return count;
      }

      gl.activeTexture(gl.TEXTURE0);
      let count = 0;
      frame.frames.forEach((sourceFrame, index) => {
        // The frame before leaves its dots in the glow before this one
        // fades and blurs it.
        if (index > 0) drawDots(count, glowTarget, 1, stamp);
        fadeAndBlur();
        count = uploadDots(sourceFrame);
      });

      // The canvas: the glow of every frame before the last, then the
      // last frame's dots, sharp, on top.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(glowProgram);
      gl.bindTexture(gl.TEXTURE_2D, glowTarget.texture);
      gl.uniform1i(glowGlow, 0);
      gl.uniform2f(glowResolution, width, height);
      gl.uniform1f(glowTone, frame.tone);
      gl.uniform1f(glowOpacity, frame.opacity);
      bindTriangle(glowPosition);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      drawDots(count, null, frame.tone, frame.opacity);

      // The last frame's dots join the glow for the next paint.
      drawDots(count, glowTarget, 1, stamp);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.disable(gl.BLEND);
    },
    destroy() {
      deleteTarget(glow);
      deleteTarget(scratch);
      deletePrograms();
    },
  };
}
