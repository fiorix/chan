import type { PointCloudBounds } from "./pointCloudCover";

// Geometry and motion adapted from @yuruyurau's Processing sketch:
// https://x.com/yuruyurau/status/2051676013902639591
export const TWIN_VEIL_DANCE_POINT_COUNT = 20_000;
export const TWIN_VEIL_DANCE_BOUNDS: PointCloudBounds = {
  minX: 60,
  maxX: 340,
  minY: 10,
  maxY: 390,
};

export function buildTwinVeilDancePoints(
  phase: number,
  pointCount = TWIN_VEIL_DANCE_POINT_COUNT,
): Float32Array {
  const points = new Float32Array(Math.max(0, pointCount) * 2);

  for (let index = 0; index < pointCount; index += 1) {
    const armPhase = (index % 2) * 9;
    const horizontal = 9 * Math.cos(index / 81);
    const vertical = index / 765 - 13;
    const distance = Math.hypot(horizontal, vertical) / 4;
    const branchWave = Math.sin(
      horizontal * horizontal < 19
        ? phase * 3 + distance * 4
        : distance / 2 + 4,
    );
    const radius =
      79 -
      2 * Math.sin(horizontal * 3) +
      (branchWave / 2) *
        horizontal *
        (9 +
          5 *
            Math.sin(
              distance * distance - vertical / 6 - phase + armPhase,
            ));
    const angle = distance * distance / 9 - phase / 16 + armPhase;
    const offset = index * 2;

    points[offset] = radius * Math.sin(angle) + 200;
    points[offset + 1] = (radius + 50) * Math.cos(angle) + 200;
  }

  return points;
}
