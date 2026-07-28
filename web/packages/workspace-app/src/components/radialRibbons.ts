const TAU = Math.PI * 2;

// Geometry adapted from Hisadan's Processing sketch:
// https://x.com/hisadan/status/1993339904181567873
export const RADIAL_RIBBON_REFERENCE_SIZE = 800;
export const RADIAL_RIBBON_COUNT = 20;
export const RADIAL_RIBBON_ANGLE_STEP = Math.PI / 10;
export const RADIAL_RIBBON_EDGE_OFFSET = Math.PI / 20;
export const RADIAL_RIBBON_RADII = [50, 100, 200, 400] as const;

export interface Point {
  x: number;
  y: number;
}

export interface RadialRibbonsTransform {
  centerX: number;
  centerY: number;
  scale: number;
}

export function fitRadialRibbons(
  width: number,
  height: number,
): RadialRibbonsTransform {
  return {
    centerX: width / 2,
    centerY: height / 2,
    scale: Math.min(width, height) / RADIAL_RIBBON_REFERENCE_SIZE,
  };
}

export function buildRadialRibbons(phase: number): Point[][] {
  const ribbons: Point[][] = [];

  for (
    let baseAngle = 0;
    baseAngle < TAU;
    baseAngle += RADIAL_RIBBON_ANGLE_STEP
  ) {
    const points: Point[] = [];

    for (const radius of RADIAL_RIBBON_RADII) {
      const angle = baseAngle + (phase * radius) / 99;
      points.push({
        x: radius * Math.cos(angle),
        y: radius * Math.sin(angle),
      });
    }

    for (const radius of [...RADIAL_RIBBON_RADII].reverse()) {
      const angle =
        baseAngle +
        (phase * radius) / 99 +
        RADIAL_RIBBON_EDGE_OFFSET;
      points.push({
        x: radius * Math.cos(angle),
        y: radius * Math.sin(angle),
      });
    }

    ribbons.push(points);
  }

  return ribbons;
}
