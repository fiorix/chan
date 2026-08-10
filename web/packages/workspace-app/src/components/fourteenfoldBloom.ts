// Geometry and motion adapted from @yuruyurau's Processing sketch:
// https://x.com/yuruyurau/status/1974495782792507630
export const FOURTEENFOLD_BLOOM_BASE_POINT_COUNT = 20_000 - 15;

export function buildFourteenfoldBloomBasePoints(
  phase: number,
  target?: Float32Array,
): Float32Array {
  const points =
    target && target.length >= FOURTEENFOLD_BLOOM_BASE_POINT_COUNT * 2
      ? target
      : new Float32Array(FOURTEENFOLD_BLOOM_BASE_POINT_COUNT * 2);
  let offset = 0;

  for (let index = 19_999; index > 14; index -= 1) {
    const horizontal = (index % 50) - 25;
    const vertical = index / 1_100;
    const distance =
      5 *
      Math.cos(
        Math.hypot(horizontal, vertical) - phase + (index % 2),
      );

    points[offset] =
      horizontal +
      (horizontal * distance) / 6 *
        Math.sin(distance + vertical / 3 + phase) +
      200;
    points[offset + 1] =
      90 +
      vertical * distance -
      (vertical / distance) * 2 * Math.cos(distance + phase) +
      200;
    offset += 2;
  }

  return points;
}
