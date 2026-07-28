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
