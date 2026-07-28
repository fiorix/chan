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
