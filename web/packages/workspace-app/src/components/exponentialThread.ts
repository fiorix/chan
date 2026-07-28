// Geometry adapted from Hisadan's Processing sketch:
// https://x.com/hisadan/status/2039716286528450634
export const EXPONENTIAL_THREAD_VERTEX_COUNT = 500;
export const EXPONENTIAL_THREAD_GUTTER = 24;

const START_RADIUS = 3;
const GROWTH_RATE = 0.1;
const PARAMETER_STEP = 0.1;
const PARAMETER_LIMIT = 50;
const MAX_RADIUS = START_RADIUS * Math.exp(GROWTH_RATE * PARAMETER_LIMIT);
const HORIZONTAL_STRETCH = 1.3;

export function buildExponentialThreadPoints(phase: number): Float32Array {
  const points = new Float32Array(EXPONENTIAL_THREAD_VERTEX_COUNT * 2);
  const horizontalFrequency = 2 * Math.sin(phase);

  for (let index = 0; index < EXPONENTIAL_THREAD_VERTEX_COUNT; index += 1) {
    const parameter = index * PARAMETER_STEP;
    const radius = START_RADIUS * Math.exp(GROWTH_RATE * parameter);
    points[index * 2] =
      radius * Math.sin(parameter * horizontalFrequency);
    points[index * 2 + 1] = radius * Math.cos(parameter);
  }

  return points;
}

export function fitExponentialThread(
  width: number,
  height: number,
  gutter = EXPONENTIAL_THREAD_GUTTER,
): { centerX: number; centerY: number; scaleX: number; scaleY: number } {
  const available = Math.max(1, Math.min(width, height) - gutter * 2);
  const scaleY = available / (MAX_RADIUS * 2);
  const maximumScaleX =
    Math.max(1, width - gutter * 2) / (MAX_RADIUS * 2);

  return {
    centerX: width / 2,
    centerY: height / 2,
    scaleX: Math.min(scaleY * HORIZONTAL_STRETCH, maximumScaleX),
    scaleY,
  };
}
