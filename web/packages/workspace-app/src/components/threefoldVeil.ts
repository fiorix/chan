import {
  fitPointCloudCover,
  type PointCloudBounds,
  type PointCloudCoverTransform,
} from "./pointCloudCover";

// Geometry and motion adapted from @yuruyurau's Processing sketch:
// https://x.com/yuruyurau/status/2083185617345921400
export const THREEFOLD_VEIL_POINT_COUNT = 10_000;
export const THREEFOLD_VEIL_REFERENCE_SIZE = 400;
export const THREEFOLD_VEIL_BOUNDS: PointCloudBounds = {
  minX: 48,
  maxX: 352,
  minY: 18,
  maxY: 382,
};

const SOURCE_CENTER = THREEFOLD_VEIL_REFERENCE_SIZE / 2;

export function fitThreefoldVeil(
  width: number,
  height: number,
): PointCloudCoverTransform {
  return fitPointCloudCover(width, height, THREEFOLD_VEIL_BOUNDS);
}

export function buildThreefoldVeilPoints(
  phase: number,
  pointCount = THREEFOLD_VEIL_POINT_COUNT,
): Float32Array {
  const points = new Float32Array(Math.max(0, pointCount) * 2);

  for (let index = 0; index < pointCount; index += 1) {
    const armPhase = (index % 3) * 4;
    const horizontalWave = 9 * Math.cos(index / 81);
    const verticalCursor = index / 461 - 11;
    const distance =
      Math.hypot(horizontalWave, verticalCursor) ** 4 / 40_000 +
      1.5 +
      Math.sin(phase / 2 + armPhase) / 4;
    const radialWave = Math.sin(
      distance * 9 + verticalCursor / 9 - phase,
    );
    const radius =
      89 -
      verticalCursor * Math.sin(horizontalWave) +
      horizontalWave * (4 + 2 * radialWave);
    const angle =
      distance +
      Math.sin(phase - distance * 4) / 9 -
      phase / 9 +
      armPhase;
    const offset = index * 2;

    points[offset] = radius * Math.cos(angle) + SOURCE_CENTER;
    points[offset + 1] =
      (radius + 30) * Math.sin(angle) + SOURCE_CENTER;
  }

  return points;
}
