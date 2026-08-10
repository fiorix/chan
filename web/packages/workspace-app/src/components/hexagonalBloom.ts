// Geometry and motion adapted from @yuruyurau's Processing sketch:
// https://x.com/yuruyurau/status/1973029806314004916
export const HEXAGONAL_BLOOM_BASE_POINT_COUNT = 20_000 - 7;

export function buildHexagonalBloomBasePoints(
  phase: number,
  target?: Float32Array,
): Float32Array {
  const points =
    target && target.length >= HEXAGONAL_BLOOM_BASE_POINT_COUNT * 2
      ? target
      : new Float32Array(HEXAGONAL_BLOOM_BASE_POINT_COUNT * 2);
  let offset = 0;

  for (let index = 19_999; index > 6; index -= 1) {
    const horizontal = (index % 25) - 12;
    const vertical = index / 800;
    const distance =
      7 *
      Math.cos(Math.hypot(horizontal, vertical) / 3 + phase / 2);

    points[offset] =
      horizontal * 4 +
      distance *
        horizontal *
        Math.sin(distance + vertical / 9 + phase) +
      200;
    points[offset + 1] =
      vertical * 2 -
      distance * 9 -
      distance * 9 * Math.cos(distance + phase) +
      200;
    offset += 2;
  }

  return points;
}
