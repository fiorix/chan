const TAU = Math.PI * 2;

// Geometry adapted from Hisadan's Processing sketch:
// https://x.com/hisadan/status/1945386079974301805
export const SPIRAL_SPOKES_REFERENCE_SIZE = 800;
export const SPIRAL_SPOKES_RADIUS = SPIRAL_SPOKES_REFERENCE_SIZE / 2;
export const SPIRAL_SPOKES_DENSITY_RATE = 0.5;
export const SPIRAL_SPOKES_PHASE_RATE = 0.05;

export interface Point {
  x: number;
  y: number;
}

export interface SpiralSpoke {
  start: Point;
  end: Point;
}

export interface SpiralSpokesTransform {
  centerX: number;
  centerY: number;
  scale: number;
}

export function fitSpiralSpokes(
  width: number,
  height: number,
): SpiralSpokesTransform {
  return {
    centerX: width / 2,
    centerY: height / 2,
    scale: Math.min(width, height) / SPIRAL_SPOKES_REFERENCE_SIZE,
  };
}

export function spiralSpokesPhase(sourceStep: number): number {
  return Math.max(0, sourceStep) * SPIRAL_SPOKES_PHASE_RATE;
}

export function spiralSpokesOpacity(sourceStep: number): number {
  return Math.max(
    0,
    Math.min(1, (256 - spiralSpokesPhase(sourceStep) * 3) / 255),
  );
}

export function buildSpiralSpokes(sourceStep: number): SpiralSpoke[] {
  const step = Math.max(0, sourceStep);
  const density = 1 + step * SPIRAL_SPOKES_DENSITY_RATE;
  const phase = spiralSpokesPhase(step);
  const outerRadius = SPIRAL_SPOKES_RADIUS - density;
  const spokeCount = Math.ceil(density * 2);
  const spokes: SpiralSpoke[] = [];

  for (let index = 0; index < spokeCount; index += 1) {
    const angle = (index * TAU) / (density * 2);
    spokes.push({
      start: {
        x: density * Math.sin(angle * phase),
        y: density * Math.cos(angle * phase),
      },
      end: {
        x: outerRadius * Math.sin(angle),
        y: outerRadius * Math.cos(angle),
      },
    });
  }

  return spokes;
}
