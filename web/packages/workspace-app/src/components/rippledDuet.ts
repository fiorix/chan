import type { PointCloudBounds } from "./pointCloudCover";

// Geometry and motion adapted from @yuruyurau's Processing sketch:
// https://x.com/yuruyurau/status/2031366569448886284
export const RIPPLED_DUET_POINT_COUNT = 20_000;
export const RIPPLED_DUET_BOUNDS: PointCloudBounds = {
  minX: 70,
  maxX: 330,
  minY: 30,
  maxY: 370,
};

export function buildRippledDuetPoints(
  phase: number,
  pointCount = RIPPLED_DUET_POINT_COUNT,
): Float32Array {
  const points = new Float32Array(Math.max(0, pointCount) * 2);

  for (let index = 0; index < pointCount; index += 1) {
    const armPhase = (index % 2) * 3;
    const horizontal = 9 * Math.cos(index / 61);
    const vertical = index / 652 - 13;
    const distance =
      Math.hypot(horizontal, vertical) ** 2 / 89 + 1;
    const radius =
      79 -
      (vertical / 2) * Math.sin(horizontal) +
      (horizontal / distance) *
        (6 +
          5 *
            Math.sin(
              Math.sin(
                distance * distance + vertical / 9 - phase + armPhase,
              ),
            ));
    const angle =
      distance / 1.9 +
      Math.cos(phase - distance * 3 + armPhase) / 11 -
      phase / 16 +
      armPhase;
    const offset = index * 2;

    points[offset] = radius * Math.sin(angle) + 200;
    points[offset + 1] = (radius + 40) * Math.cos(angle) + 200;
  }

  return points;
}
