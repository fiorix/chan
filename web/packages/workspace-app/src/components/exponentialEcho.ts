// Geometry adapted from Hisadan's Processing sketch:
// https://x.com/hisadan/status/2039722375625986239
export const EXPONENTIAL_ECHO_REFERENCE_SIZE = 800;
export const EXPONENTIAL_ECHO_VERTEX_COUNT = 500;
export const EXPONENTIAL_ECHO_SOURCE_FRAME_RATE = 60;
export const EXPONENTIAL_ECHO_SOURCE_PHASE_STEP = 0.001;
export const EXPONENTIAL_ECHO_PHASE_PER_SECOND =
  EXPONENTIAL_ECHO_SOURCE_FRAME_RATE *
  EXPONENTIAL_ECHO_SOURCE_PHASE_STEP;
export const EXPONENTIAL_ECHO_SOURCE_FADE_ALPHA = 5 / 255;
export const EXPONENTIAL_ECHO_PHASE_PERIOD = Math.PI * 20;

const START_RADIUS = 3;
const GROWTH_RATE = 0.1;
const PARAMETER_STEP = 0.1;

export interface ExponentialEchoTransform {
  centerX: number;
  centerY: number;
  scale: number;
}

export function buildExponentialEchoPoints(
  phase: number,
): Float32Array {
  const points = new Float32Array(EXPONENTIAL_ECHO_VERTEX_COUNT * 2);

  for (let index = 0; index < EXPONENTIAL_ECHO_VERTEX_COUNT; index += 1) {
    const parameter = index * PARAMETER_STEP;
    const radius = START_RADIUS * Math.exp(GROWTH_RATE * parameter);
    points[index * 2] = radius * Math.sin(parameter * phase);
    points[index * 2 + 1] = radius * Math.cos(parameter);
  }

  return points;
}

export function fitExponentialEcho(
  width: number,
  height: number,
): ExponentialEchoTransform {
  return {
    centerX: width / 2,
    centerY: height / 2,
    scale:
      Math.min(width, height) / EXPONENTIAL_ECHO_REFERENCE_SIZE,
  };
}

export function exponentialEchoTrailFade(
  elapsedSeconds: number,
): number {
  const elapsedSourceFrames =
    Math.max(0, elapsedSeconds) * EXPONENTIAL_ECHO_SOURCE_FRAME_RATE;
  return (
    1 -
    Math.pow(
      1 - EXPONENTIAL_ECHO_SOURCE_FADE_ALPHA,
      elapsedSourceFrames,
    )
  );
}

export function wrapExponentialEchoPhase(phase: number): number {
  return (
    ((phase % EXPONENTIAL_ECHO_PHASE_PERIOD) +
      EXPONENTIAL_ECHO_PHASE_PERIOD) %
    EXPONENTIAL_ECHO_PHASE_PERIOD
  );
}
