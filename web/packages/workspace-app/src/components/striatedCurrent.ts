import type { PointCloudBounds } from "./pointCloudCover";

// Geometry and motion adapted from @yuruyurau's Processing sketch:
// https://x.com/yuruyurau/status/2082474544644985022
export const STRIATED_CURRENT_POINT_COUNT = 10_000;
export const STRIATED_CURRENT_BOUNDS: PointCloudBounds = {
  minX: 4,
  maxX: 396,
  minY: 122,
  maxY: 400,
};

export function buildStriatedCurrentPoints(
  phase: number,
  pointCount = STRIATED_CURRENT_POINT_COUNT,
): Float32Array {
  const points = new Float32Array(Math.max(0, pointCount) * 2);

  for (let index = 0; index < pointCount; index += 1) {
    const cursor = index / 353;
    const horizontal =
      ((cursor < 9 ? 9 : 5) + Math.cos(cursor * 31 - phase)) *
      Math.cos(index / 44);
    const vertical = cursor / 9 - 14;
    const distance = Math.hypot(horizontal, vertical) / 1.6;
    const angle = distance - phase / 2;
    const offset = index * 2;

    points[offset] =
      (distance * 9 + horizontal * horizontal) * Math.cos(angle) + 200;
    points[offset + 1] =
      (55 + distance * 9) * Math.sin(angle / 3) +
      4 * Math.sin(horizontal * 2) +
      (cursor / 29) *
        horizontal *
        (vertical +
          3 * Math.sin(vertical * 4 - distance * 4 + phase * 3)) +
      200;
  }

  return points;
}
