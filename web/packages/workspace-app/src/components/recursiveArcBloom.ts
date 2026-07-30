const TAU = Math.PI * 2;
const PERLIN_SIZE = 4095;
const PERLIN_OCTAVES = 4;
const PERLIN_FALLOFF = 0.5;
const PERLIN_SEED = 1931711978;

// Geometry adapted from Hau_kun's p5 sketch and attached video:
// https://x.com/Hau_kun/status/1931711978235683306
export const RECURSIVE_ARC_BLOOM_REFERENCE_SIZE = 720;
export const RECURSIVE_ARC_BLOOM_ARM_COUNT = 16;
export const RECURSIVE_ARC_BLOOM_SEGMENT_COUNT = 19;
export const RECURSIVE_ARC_BLOOM_ANGLE_STEP = Math.PI / 8;

export interface RecursiveArcSegment {
  arm: number;
  segment: number;
  x: number;
  y: number;
  diameter: number;
  direction: -1 | 1;
  startAngle: number;
  endAngle: number;
}

export interface RecursiveArcBloomTransform {
  centerX: number;
  centerY: number;
  scale: number;
}

function buildPerlinTable(): Float64Array {
  const values = new Float64Array(PERLIN_SIZE + 1);
  let state = PERLIN_SEED >>> 0;

  for (let index = 0; index < values.length; index += 1) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    values[index] = state / 4294967296;
  }

  return values;
}

const PERLIN = buildPerlinTable();

function scaledCosine(value: number): number {
  return 0.5 * (1 - Math.cos(value * Math.PI));
}

export function recursiveArcBloomNoise(position: number): number {
  const x = Math.abs(position);
  let lattice = Math.floor(x);
  let fraction = x - lattice;
  let amplitude = 0.5;
  let result = 0;

  for (let octave = 0; octave < PERLIN_OCTAVES; octave += 1) {
    const blend = scaledCosine(fraction);
    const first = PERLIN[lattice & PERLIN_SIZE];
    const second = PERLIN[(lattice + 1) & PERLIN_SIZE];
    result += (first + blend * (second - first)) * amplitude;

    amplitude *= PERLIN_FALLOFF;
    lattice <<= 1;
    fraction *= 2;
    if (fraction >= 1) {
      lattice += 1;
      fraction -= 1;
    }
  }

  return result;
}

export function normalizeRecursiveArcSweep(sweep: number): number {
  const normalized = ((sweep % TAU) + TAU) % TAU;
  return normalized < 1e-10 ? TAU : normalized;
}

export function fitRecursiveArcBloom(
  width: number,
  height: number,
): RecursiveArcBloomTransform {
  return {
    centerX: width / 2,
    centerY: height / 2,
    scale:
      Math.min(width, height) / RECURSIVE_ARC_BLOOM_REFERENCE_SIZE,
  };
}

// innerRadius starts every chain that far from the origin, leaving a
// central void: each recursive step walks outward (its radial component
// stays positive while the discs shrink), so no leaf reaches back in.
export function buildRecursiveArcBloom(
  noisePhase: number,
  innerRadius = 0,
): RecursiveArcSegment[] {
  const arcs: RecursiveArcSegment[] = [];

  for (
    let arm = 0;
    arm < RECURSIVE_ARC_BLOOM_ARM_COUNT;
    arm += 1
  ) {
    const baseAngle = arm * RECURSIVE_ARC_BLOOM_ANGLE_STEP;
    let x = Math.cos(baseAngle) * innerRadius;
    let y = Math.sin(baseAngle) * innerRadius;
    let direction: -1 | 1 = 1;

    for (
      let sourceDepth = RECURSIVE_ARC_BLOOM_SEGMENT_COUNT;
      sourceDepth >= 1;
      sourceDepth -= 1
    ) {
      direction = direction === 1 ? -1 : 1;
      const diameter = sourceDepth * 3;
      x += Math.cos(baseAngle + direction) * diameter;
      y += Math.sin(baseAngle + direction) * diameter;

      const noise = recursiveArcBloomNoise(
        noisePhase + sourceDepth / 99,
      );
      const arcPhase = noise * Math.PI * 9;
      const startAngle =
        baseAngle - arcPhase * direction + noise * 99;
      const sweep = normalizeRecursiveArcSweep(arcPhase * 2);
      const segment =
        RECURSIVE_ARC_BLOOM_SEGMENT_COUNT - sourceDepth;

      arcs.push({
        arm,
        segment,
        x,
        y,
        diameter,
        direction,
        startAngle,
        endAngle: startAngle + sweep,
      });
    }
  }

  return arcs;
}
