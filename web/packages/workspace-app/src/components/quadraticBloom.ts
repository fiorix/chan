// Geometry adapted from Hisadan's Processing sketch:
// https://x.com/hisadan/status/2046584749175832639
export const QUADRATIC_BLOOM_ITERATIONS = 60_000;
export const QUADRATIC_BLOOM_GUTTER = 24;

const A = 1.86;
const B_RANGE = 0.7;
const START_X = 0.1;
const MAX_COORDINATE = 8;
const SOURCE_MIN_X = -1.84;
const SOURCE_MAX_X = 1.84;
const SOURCE_MIN_Y = -1.43;
const SOURCE_MAX_Y = 3.38;

export interface QuadraticBloomTransform {
  centerX: number;
  centerY: number;
  scaleX: number;
  scaleY: number;
}

export function fitQuadraticBloom(
  width: number,
  height: number,
  gutter = QUADRATIC_BLOOM_GUTTER,
): QuadraticBloomTransform {
  const horizontalSpace = Math.max(1, width - gutter * 2);
  const verticalSpace = Math.max(1, height - gutter * 2);
  const scaleX = horizontalSpace / (SOURCE_MAX_X - SOURCE_MIN_X);
  const scaleY = verticalSpace / (SOURCE_MAX_Y - SOURCE_MIN_Y);

  return {
    centerX: gutter - SOURCE_MIN_X * scaleX,
    centerY: gutter - SOURCE_MIN_Y * scaleY,
    scaleX,
    scaleY,
  };
}

export function buildQuadraticBloomPoints(
  phase: number,
  iterations = QUADRATIC_BLOOM_ITERATIONS,
): Float32Array {
  const points = new Float32Array(Math.max(0, iterations) * 2);
  const b = B_RANGE * Math.cos(phase);
  let x = START_X;
  let y = 0;
  let length = 0;

  for (let index = 0; index < iterations; index += 1) {
    const nextX = A * x - x * y;
    const nextY = b * y + x * x;
    if (
      !Number.isFinite(nextX) ||
      !Number.isFinite(nextY) ||
      Math.abs(nextX) > MAX_COORDINATE ||
      Math.abs(nextY) > MAX_COORDINATE
    ) {
      break;
    }

    points[length] = nextX;
    points[length + 1] = nextY;
    length += 2;
    x = nextX;
    y = nextY;
  }

  return points.subarray(0, length);
}
