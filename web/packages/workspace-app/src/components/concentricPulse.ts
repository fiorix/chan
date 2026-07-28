const TAU = Math.PI * 2;

// Geometry adapted from Hisadan's Processing sketch:
// https://x.com/hisadan/status/2003482480490520895
export const CONCENTRIC_PULSE_REFERENCE_SIZE = 800;
export const CONCENTRIC_PULSE_MAX_RADIUS = 570;
export const CONCENTRIC_PULSE_START_RADIUS = 10;
export const CONCENTRIC_PULSE_VERTEX_STEP = 20;

export interface Point {
  x: number;
  y: number;
}

export interface ConcentricRing {
  radius: number;
  vertices: Point[];
}

export function concentricPulseGap(phase: number): number {
  return 50 + 49 * Math.cos(phase);
}

export function buildConcentricPulseRings(
  phase: number,
  maxRadius = CONCENTRIC_PULSE_MAX_RADIUS,
): ConcentricRing[] {
  const rings: ConcentricRing[] = [];
  const gap = concentricPulseGap(phase);

  for (
    let radius = CONCENTRIC_PULSE_START_RADIUS;
    radius < maxRadius;
    radius += gap
  ) {
    const vertices: Point[] = [];

    for (
      let cursor = 0;
      cursor < radius;
      cursor += CONCENTRIC_PULSE_VERTEX_STEP
    ) {
      const angle = (cursor / radius) * TAU;
      vertices.push({
        x: radius * Math.cos(angle),
        y: radius * Math.sin(angle),
      });
    }

    rings.push({ radius, vertices });
  }

  return rings;
}
