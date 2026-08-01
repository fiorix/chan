import type { PointCloudBounds } from "./pointCloudCover";

// Geometry and motion adapted from @yuruyurau's Processing sketch:
// https://x.com/yuruyurau/status/2053149494439800895
export const LORENZ_CONSTELLATION_POINT_COUNT = 30_000;
export const LORENZ_CONSTELLATION_BOUNDS: PointCloudBounds = {
  minX: 76,
  maxX: 324,
  minY: 32,
  maxY: 368,
};

const LORENZ_STEP = 5e-4;

export function buildLorenzConstellationPoints(
  sourceFrame: number,
  pointCount = LORENZ_CONSTELLATION_POINT_COUNT,
): Float32Array {
  const count = Math.max(0, pointCount);
  const points = new Float32Array(count * 2);
  let x = 9;
  let y = 9;
  let z = 9;
  let offset = 0;

  for (let index = count - 1; index >= 0; index -= 1) {
    const nextX = x + 9 * (y - x) * LORENZ_STEP;
    const nextY = y + (x * (28 - z) - y) * LORENZ_STEP;
    const nextZ = z + (x * y - z - z) * LORENZ_STEP;
    x = nextX;
    y = nextY;
    z = nextZ;

    const orbit = index % 9;
    const modulation =
      Math.sin(
        (sourceFrame * Math.PI) / 20 - x * x / 99 + orbit,
      ) + 1;
    const radius = x * modulation + 89;
    const angle =
      z / 59 -
      modulation / 29 +
      (sourceFrame * Math.PI) / 480 +
      orbit * 8;

    points[offset] = radius * Math.cos(angle) + 200;
    points[offset + 1] =
      200 -
      (radius + 60 * Math.cos(angle / 2)) * Math.sin(angle);
    offset += 2;
  }

  return points;
}
