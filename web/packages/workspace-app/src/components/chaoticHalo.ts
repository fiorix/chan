const TAU = Math.PI * 2;

// Motion adapted from Koma Tebe's p5.js sketch:
// https://x.com/KomaTebe/status/1929902081554497573
export const CHAOTIC_HALO_REFERENCE_SIZE = 400;
export const CHAOTIC_HALO_PARTICLE_COUNT = 200;
export const CHAOTIC_HALO_INNER_LIMIT = 55;
export const CHAOTIC_HALO_INNER_STEP = 1;
export const CHAOTIC_HALO_RADIUS = 99;

export interface ChaoticHaloState {
  x: number;
  u: number;
  v: number;
}

export interface ChaoticHaloTransform {
  centerX: number;
  centerY: number;
  scale: number;
}

export function createChaoticHaloState(): ChaoticHaloState {
  return { x: 0, u: 0, v: 0 };
}

export function fitChaoticHalo(
  width: number,
  height: number,
): ChaoticHaloTransform {
  return {
    centerX: width / 2,
    centerY: height / 2,
    scale: Math.min(width, height) / CHAOTIC_HALO_REFERENCE_SIZE,
  };
}

export function buildChaoticHaloPoints(
  phase: number,
  state = createChaoticHaloState(),
  particleCount = CHAOTIC_HALO_PARTICLE_COUNT,
  innerLimit = CHAOTIC_HALO_INNER_LIMIT,
  innerStep = CHAOTIC_HALO_INNER_STEP,
): Float32Array {
  const count = Math.max(0, Math.floor(particleCount));
  const step = Math.max(Number.EPSILON, innerStep);
  const innerCount = Math.max(0, Math.ceil(innerLimit / step));
  const points = new Float32Array(count * innerCount * 2);
  const angleStep = count === 0 ? 0 : TAU / count;
  let offset = 0;

  for (let particle = 0; particle < count; particle += 1) {
    for (
      let innerIndex = 0;
      innerIndex < innerCount;
      innerIndex += 1
    ) {
      const sharedAngle = particle + state.v + phase;
      const radialAngle =
        angleStep * particle + state.x - 99 * phase;
      state.u =
        Math.sin(sharedAngle) - Math.sin(radialAngle);
      state.v =
        Math.cos(sharedAngle) - Math.cos(radialAngle);
      state.x = state.u + phase;

      points[offset] =
        CHAOTIC_HALO_REFERENCE_SIZE / 2 +
        CHAOTIC_HALO_RADIUS * state.u;
      points[offset + 1] =
        CHAOTIC_HALO_REFERENCE_SIZE / 2 +
        CHAOTIC_HALO_RADIUS * state.v;
      offset += 2;
    }
  }

  return points;
}
