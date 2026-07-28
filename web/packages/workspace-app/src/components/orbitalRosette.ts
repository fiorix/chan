const TAU = Math.PI * 2;

// Geometry adapted from Hisadan's Processing sketch:
// https://x.com/hisadan/status/2063631027063726297
export const ORBITAL_RING_COUNT = 6;

export interface OrbitalCircle {
  ring: number;
  x: number;
  y: number;
  radius: number;
}

export function buildOrbitalCircles(
  phase: number,
  scale: number,
): OrbitalCircle[] {
  const circles: OrbitalCircle[] = [];
  const circleRadius = (Math.abs(99 * Math.cos(phase)) * scale) / 2;
  let count = 1;

  for (let ring = 1; ring <= ORBITAL_RING_COUNT; ring += 1) {
    count *= 2;
    const orbitRadius =
      (40 * ring * Math.sin(phase) + (2000 / count) * Math.cos(phase)) *
      scale;

    for (let index = 0; index < count; index += 1) {
      const angle = (index * TAU) / count + phase;
      circles.push({
        ring,
        x: orbitRadius * Math.sin(angle),
        y: orbitRadius * Math.cos(angle),
        radius: circleRadius,
      });
    }
  }

  return circles;
}
