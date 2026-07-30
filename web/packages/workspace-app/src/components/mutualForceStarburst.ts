// Motion adapted from Hisadan's Processing sketch and continuation:
// https://x.com/hisadan/status/1937852453929783400
// https://x.com/hisadan/status/1937852456584814776
export const MUTUAL_FORCE_PARTICLE_COUNT = 300;
export const MUTUAL_FORCE_HALF_SIZE = 400;
export const MUTUAL_FORCE_MIN_DISTANCE = 5;
export const MUTUAL_FORCE_REPULSION_RADIUS = 50;

const PARTICLE_STRIDE = 4;
const MIN_DISTANCE_SQUARED =
  MUTUAL_FORCE_MIN_DISTANCE * MUTUAL_FORCE_MIN_DISTANCE;
const REPULSION_RADIUS_SQUARED =
  MUTUAL_FORCE_REPULSION_RADIUS *
  MUTUAL_FORCE_REPULSION_RADIUS;

export type RandomSource = () => number;

export interface MutualForceTransform {
  centerX: number;
  centerY: number;
  scale: number;
}

export function fitMutualForceStarburst(
  width: number,
  height: number,
): MutualForceTransform {
  return {
    centerX: width / 2,
    centerY: height / 2,
    scale:
      Math.min(width, height) /
      (MUTUAL_FORCE_HALF_SIZE * 2),
  };
}

export function createMutualForceParticles(
  count = MUTUAL_FORCE_PARTICLE_COUNT,
  random: RandomSource = Math.random,
): Float32Array {
  const particles = new Float32Array(
    Math.max(0, count) * PARTICLE_STRIDE,
  );

  for (
    let offset = 0;
    offset < particles.length;
    offset += PARTICLE_STRIDE
  ) {
    particles[offset + 2] = 1 - random() * 2;
    particles[offset + 3] = 1 - random() * 2;
  }

  return particles;
}

// The reflecting walls default to the source sketch's square but take
// per-axis bounds so the field can fill a rectangular pane completely.
export function advanceMutualForceParticles(
  particles: Float32Array,
  halfWidth = MUTUAL_FORCE_HALF_SIZE,
  halfHeight = MUTUAL_FORCE_HALF_SIZE,
): void {
  const count = Math.floor(particles.length / PARTICLE_STRIDE);

  for (let particle = 0; particle < count; particle += 1) {
    const offset = particle * PARTICLE_STRIDE;
    const x = particles[offset];
    const y = particles[offset + 1];
    let forceX = 0;
    let forceY = 0;

    for (let neighbor = 0; neighbor < count; neighbor += 1) {
      if (neighbor === particle) continue;
      const neighborOffset = neighbor * PARTICLE_STRIDE;
      const deltaX = particles[neighborOffset] - x;
      const deltaY = particles[neighborOffset + 1] - y;
      const distanceSquared =
        deltaX * deltaX + deltaY * deltaY;
      if (distanceSquared <= MIN_DISTANCE_SQUARED) continue;

      const inverseDistance = 1 / Math.sqrt(distanceSquared);
      const directionX = deltaX * inverseDistance;
      const directionY = deltaY * inverseDistance;
      if (distanceSquared < REPULSION_RADIUS_SQUARED) {
        forceX -= directionX;
        forceY -= directionY;
      } else {
        forceX += directionX * inverseDistance;
        forceY += directionY * inverseDistance;
      }
    }

    let velocityX = particles[offset + 2];
    let velocityY = particles[offset + 3];
    if (Math.abs(x + velocityX) > halfWidth) {
      velocityX *= -1;
      particles[offset + 2] = velocityX;
    }
    if (Math.abs(y + velocityY) > halfHeight) {
      velocityY *= -1;
      particles[offset + 3] = velocityY;
    }

    particles[offset] = x + velocityX + forceX;
    particles[offset + 1] = y + velocityY + forceY;
  }
}

export function createMutualForceStaticSnapshot(
  particles: Float32Array,
  distance = 165,
): Float32Array {
  const snapshot = particles.slice();

  for (
    let offset = 0;
    offset < snapshot.length;
    offset += PARTICLE_STRIDE
  ) {
    snapshot[offset] = snapshot[offset + 2] * distance;
    snapshot[offset + 1] = snapshot[offset + 3] * distance;
  }

  return snapshot;
}
