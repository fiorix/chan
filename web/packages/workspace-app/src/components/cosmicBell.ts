import { linkProgram, uniformLocation } from "./webglProgram";

// A procedural interpretation of hal's expanding, ringed particle shell:
// https://x.com/HAL09999/status/1895514600478818527
// Positions stay on the GPU; only the camera clock and theme change per frame.
export const COSMIC_BELL_SHELL_GRAINS = 160_000;
export const COSMIC_BELL_CORE_GRAINS = 48_000;
export const COSMIC_BELL_RIM_GRAINS = 16_000;
export const COSMIC_BELL_GRAIN_COUNT =
  COSMIC_BELL_SHELL_GRAINS + COSMIC_BELL_CORE_GRAINS + COSMIC_BELL_RIM_GRAINS;
export const COSMIC_BELL_PERIOD_SECONDS = 12;
const FLOATS_PER_GRAIN = 4;

/// A 450-degree turn followed by the same arc in reverse, easing to rest at
/// each end. Kept unwrapped so the extra revolution is part of the motion.
export function cosmicBellTurn(seconds: number): number {
  const phase = (seconds % COSMIC_BELL_PERIOD_SECONDS) / COSMIC_BELL_PERIOD_SECONDS;
  return (1 - Math.cos(phase * Math.PI * 2)) * Math.PI * 1.25;
}

/// Cylindrical coordinates (radius, angle, depth) and band position.
/// The fixed seed keeps resize, reduced motion and context restoration from
/// replacing the particle field. Grain density follows surface area.
export function buildCosmicBellGrains(): Float32Array {
  const grains = new Float32Array(COSMIC_BELL_GRAIN_COUNT * FLOATS_PER_GRAIN);
  let state = 19;
  function random(): number {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  }

  for (let index = 0; index < COSMIC_BELL_GRAIN_COUNT; index += 1) {
    let radius: number;
    let depth: number;
    let bandPosition: number;
    if (index < COSMIC_BELL_SHELL_GRAINS) {
      const height = random();
      radius = Math.sqrt(1 - height * height);
      depth = 0.12 - 0.72 * height;
      bandPosition = 0;
    } else if (index < COSMIC_BELL_SHELL_GRAINS + COSMIC_BELL_CORE_GRAINS) {
      // Most grains collect into narrow rings; a sparse veil joins them.
      const ring = Math.floor(random() * 24);
      const along = index % 4 === 0 ? random() : (ring + random() * 0.12) / 24;
      radius = 0.022 + 0.31 * (1 - Math.exp(-3 * along));
      depth = -0.18 + 0.72 * along;
      radius += (random() - 0.5) * 0.006;
      bandPosition = along;
    } else {
      const band = Math.floor(random() * 3);
      radius = 1 + band * 0.012 + (random() - 0.5) * 0.004;
      depth = 0.12 + band * 0.025;
      bandPosition = band;
    }
    grains.set([radius, random() * Math.PI * 2, depth, bandPosition], index * FLOATS_PER_GRAIN);
  }
  return grains;
}

const VERTEX_SHADER = `#version 300 es
precision highp float;

in vec4 aGrain;
uniform vec2 uResolution;
uniform float uScale;
uniform float uPhase;
uniform float uTurn;
uniform float uGlow;
out float vAlpha;

void main() {
  bool core = gl_VertexID >= ${COSMIC_BELL_SHELL_GRAINS}
    && gl_VertexID < ${COSMIC_BELL_SHELL_GRAINS + COSMIC_BELL_CORE_GRAINS};
  bool rim = gl_VertexID >= ${COSMIC_BELL_SHELL_GRAINS + COSMIC_BELL_CORE_GRAINS};
  float along = aGrain.w;
  float radius = aGrain.x;
  float angle = aGrain.y + 0.06 * sin(uPhase + aGrain.z * 3.0);
  if (core) radius *= 1.0 + 0.025 * sin(uPhase * 2.0 - along * 12.0);
  vec3 p = vec3(radius * cos(angle), radius * sin(angle), aGrain.z);
  float turn = uTurn;
  p.xz = mat2(cos(turn), -sin(turn), sin(turn), cos(turn)) * p.xz;
  float tilt = 0.08 * sin(uPhase * 2.0);
  p.yz = mat2(cos(tilt), -sin(tilt), sin(tilt), cos(tilt)) * p.yz;
  float perspective = 4.5 / (4.5 - p.z);
  vec2 clip = p.xy * perspective * uScale * 2.0 / uResolution;
  gl_Position = vec4(clip, 0.0, 1.0);
  float pointSize = clamp(uScale / 220.0 + 0.4, 1.3, 2.5);
  gl_PointSize = pointSize * mix(1.0, 7.0, uGlow);

  if (core) {
    vAlpha = 0.45;
  } else if (rim) {
    vAlpha = along < 1.0 ? 0.2 : 0.035;
  } else {
    vAlpha = 0.18;
  }
  vAlpha *= mix(1.0, 0.06, uGlow);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in float vAlpha;
uniform float uTone;
uniform float uOpacity;
out vec4 o;

void main() {
  float coverage = 1.0 - smoothstep(0.2, 0.5, length(gl_PointCoord - 0.5));
  float alpha = coverage * vAlpha * uOpacity;
  o = vec4(vec3(uTone) * alpha, alpha);
}
`;

export interface CosmicBellRenderer {
  draw(seconds: number, fieldScale: number, tone: number, opacity: number): void;
  destroy(): void;
}

export function createCosmicBellRenderer(gl: WebGL2RenderingContext): CosmicBellRenderer {
  const program = linkProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
  const buffer = gl.createBuffer();
  function release(): void {
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
  }
  if (!buffer) {
    release();
    throw new Error("could not allocate particle buffer");
  }

  const grain = gl.getAttribLocation(program, "aGrain");
  let resolution: WebGLUniformLocation;
  let scale: WebGLUniformLocation;
  let phase: WebGLUniformLocation;
  let turn: WebGLUniformLocation;
  let glow: WebGLUniformLocation;
  let tone: WebGLUniformLocation;
  let opacity: WebGLUniformLocation;
  try {
    if (grain < 0) throw new Error("missing shader attribute aGrain");
    resolution = uniformLocation(gl, program, "uResolution");
    scale = uniformLocation(gl, program, "uScale");
    phase = uniformLocation(gl, program, "uPhase");
    turn = uniformLocation(gl, program, "uTurn");
    glow = uniformLocation(gl, program, "uGlow");
    tone = uniformLocation(gl, program, "uTone");
    opacity = uniformLocation(gl, program, "uOpacity");
  } catch (error) {
    release();
    throw error;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, buildCosmicBellGrains(), gl.STATIC_DRAW);
  gl.disable(gl.DEPTH_TEST);

  return {
    draw(seconds, fieldScale, toneValue, opacityValue) {
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      if (width <= 0 || height <= 0) return;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(grain);
      gl.vertexAttribPointer(grain, FLOATS_PER_GRAIN, gl.FLOAT, false, 0, 0);
      gl.uniform2f(resolution, width, height);
      gl.uniform1f(scale, Math.min(width, height) * 0.43 * fieldScale);
      gl.uniform1f(phase, (seconds % COSMIC_BELL_PERIOD_SECONDS) * Math.PI * 2 / COSMIC_BELL_PERIOD_SECONDS);
      gl.uniform1f(turn, cosmicBellTurn(seconds));
      gl.uniform1f(tone, toneValue);
      gl.uniform1f(opacity, opacityValue);
      // The compact core gets a soft halo without a full-canvas blur pass.
      gl.uniform1f(glow, 1);
      gl.drawArrays(gl.POINTS, COSMIC_BELL_SHELL_GRAINS, COSMIC_BELL_CORE_GRAINS);
      gl.uniform1f(glow, 0);
      gl.drawArrays(gl.POINTS, 0, COSMIC_BELL_GRAIN_COUNT);
    },
    destroy: release,
  };
}
