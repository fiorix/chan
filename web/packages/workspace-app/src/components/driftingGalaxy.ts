import {
  LATTICE_NOISE_GLSL,
  LATTICE_NOISE_TEXTURE_SIDE,
  latticeNoise,
  latticeNoiseTable,
} from "./latticeNoise";
import { ROUND_POINT_FRAGMENT_SHADER } from "./roundPoints";
import { linkProgram, uniformLocation } from "./webglProgram";

// Geometry and motion adapted from Koma Tebe's p5.js sketch:
// https://x.com/KomaTebe/status/1936401797758730669
export const DRIFTING_GALAXY_ARM_COUNT = 12;
export const DRIFTING_GALAXY_GRAINS_PER_ARM = 6000;
export const DRIFTING_GALAXY_GRAIN_COUNT =
  DRIFTING_GALAXY_ARM_COUNT * DRIFTING_GALAXY_GRAINS_PER_ARM;
// The sketch draws on a 400 pixel square canvas, so one source unit is one
// pixel there. Its arms reach 300 units to either side, past the canvas.
export const DRIFTING_GALAXY_SOURCE_SIZE = 400;

const ARM_STEP = Math.PI / 3;
const DEPTH_STEP = 0.05;
const REACH = 300;
// p5.js seeds its noise at random on every load, so no one table is the
// sketch's. This one is fixed, and the galaxy is the same on every mount.
const NOISE_SEED = 1;

const FLOATS_PER_GRAIN = 6;

/// What the sketch never changes about its grains, six numbers each. Grain
/// `arm * DRIFTING_GALAXY_GRAINS_PER_ARM + step` sits `depth = step * 0.05`
/// in from the rim, so `300 - depth` from the center, and carries:
///
/// - the angle its x swings by, before the clock is added
/// - the angle its y swings by, before the clock and its moving noise
/// - how far the sketch scatters it sideways and downward
/// - its arm's angle and its depth, which the moving noise is read at
export function buildDriftingGalaxyGrains(
  table = latticeNoiseTable(NOISE_SEED),
): Float32Array {
  const grains = new Float32Array(
    DRIFTING_GALAXY_GRAIN_COUNT * FLOATS_PER_GRAIN,
  );
  let offset = 0;

  for (let arm = 0; arm < DRIFTING_GALAXY_ARM_COUNT; arm += 1) {
    const angle = arm * ARM_STEP;
    for (let step = 0; step < DRIFTING_GALAXY_GRAINS_PER_ARM; step += 1) {
      const depth = step * DEPTH_STEP;
      const distance = REACH - depth;
      const winding = angle + distance / 99;

      grains[offset] = winding + latticeNoise(table, angle, distance);
      grains[offset + 1] = winding;
      grains[offset + 2] =
        ((latticeNoise(table, distance, angle) - 0.5) * depth) / 3;
      grains[offset + 3] =
        ((latticeNoise(table, depth, angle) - 0.5) * depth) / 2;
      grains[offset + 4] = angle;
      grains[offset + 5] = depth;
      offset += FLOATS_PER_GRAIN;
    }
  }

  return grains;
}

// The sketch's per-frame work. Its clock runs backward from zero and the
// noise reads its absolute value, so the grains turn one way while the
// noise drifts on without repeating. A grain is a circle up to three units
// across, white at an opacity that climbs from nothing at the rim to 100 in
// 255 at the center.
export const DRIFTING_GALAXY_VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;

in vec4 aOrbit;
in vec2 aCell;

uniform vec2 uResolution;
uniform float uScale;
uniform float uClock;
out float vRadius;
out float vAlpha;
${LATTICE_NOISE_GLSL}
void main() {
  float angle = aCell.x;
  float depth = aCell.y;
  float distance = ${REACH}.0 - depth;
  vec2 grain = vec2(
    sin(aOrbit.x + uClock) * distance + aOrbit.z,
    cos(
      aOrbit.y + latticeNoise(vec3(angle, depth, uClock)) + uClock
    ) * distance * 0.5 + aOrbit.w
  );
  vec2 clip = grain * uScale * 2.0 / uResolution;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vRadius = 1.5 * latticeNoise(vec3(distance, uClock, 0.0)) * uScale;
  vAlpha = depth / 3.0 / 255.0;
  // A pixel of margin on each side holds the antialiased rim.
  gl_PointSize = 2.0 * vRadius + 2.0;
}
`;

export interface DriftingGalaxyRenderer {
  draw(
    clock: number,
    fieldScale: number,
    tone: number,
    opacity: number,
  ): void;
  destroy(): void;
}

export function createDriftingGalaxyRenderer(
  gl: WebGL2RenderingContext,
): DriftingGalaxyRenderer {
  const program = linkProgram(
    gl,
    DRIFTING_GALAXY_VERTEX_SHADER,
    ROUND_POINT_FRAGMENT_SHADER,
  );
  const buffer = gl.createBuffer();
  const texture = gl.createTexture();

  function release(): void {
    gl.deleteTexture(texture);
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
  }

  let orbit: number;
  let cell: number;
  let resolution: WebGLUniformLocation;
  let scale: WebGLUniformLocation;
  let clock: WebGLUniformLocation;
  let noiseTable: WebGLUniformLocation;
  let tone: WebGLUniformLocation;
  let opacity: WebGLUniformLocation;
  try {
    if (!buffer || !texture) {
      throw new Error("could not allocate grain buffer or noise texture");
    }
    orbit = gl.getAttribLocation(program, "aOrbit");
    cell = gl.getAttribLocation(program, "aCell");
    if (orbit < 0 || cell < 0) throw new Error("missing shader attribute");
    resolution = uniformLocation(gl, program, "uResolution");
    scale = uniformLocation(gl, program, "uScale");
    clock = uniformLocation(gl, program, "uClock");
    noiseTable = uniformLocation(gl, program, "uNoiseTable");
    tone = uniformLocation(gl, program, "uTone");
    opacity = uniformLocation(gl, program, "uOpacity");
  } catch (error) {
    release();
    throw error;
  }

  const table = latticeNoiseTable(NOISE_SEED);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    buildDriftingGalaxyGrains(table),
    gl.STATIC_DRAW,
  );
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R32F,
    LATTICE_NOISE_TEXTURE_SIDE,
    LATTICE_NOISE_TEXTURE_SIDE,
    0,
    gl.RED,
    gl.FLOAT,
    table,
  );
  gl.disable(gl.DEPTH_TEST);

  const stride = FLOATS_PER_GRAIN * Float32Array.BYTES_PER_ELEMENT;

  return {
    draw(nextClock, fieldScale, nextTone, nextOpacity) {
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      if (width <= 0 || height <= 0) return;

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      // The shader writes premultiplied colour over a transparent canvas,
      // so overlapping grains build up and the pane shows through the rest.
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(orbit);
      gl.vertexAttribPointer(orbit, 4, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(cell);
      gl.vertexAttribPointer(
        cell,
        2,
        gl.FLOAT,
        false,
        stride,
        4 * Float32Array.BYTES_PER_ELEMENT,
      );
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(noiseTable, 0);
      gl.uniform2f(resolution, width, height);
      gl.uniform1f(
        scale,
        (Math.min(width, height) / DRIFTING_GALAXY_SOURCE_SIZE) * fieldScale,
      );
      gl.uniform1f(clock, nextClock);
      gl.uniform1f(tone, nextTone);
      gl.uniform1f(opacity, nextOpacity);
      gl.drawArrays(gl.POINTS, 0, DRIFTING_GALAXY_GRAIN_COUNT);
    },
    destroy: release,
  };
}
