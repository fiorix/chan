import { ROUND_POINT_FLOATS } from "./roundPoints";

// Geometry and motion adapted from nagayama's p5.js sketch:
// https://x.com/nagayama/status/1447033075049779201
export const BEADED_TORUS_COLUMNS = 80;
export const BEADED_TORUS_ROWS = 40;
export const BEADED_TORUS_BEAD_COUNT =
  BEADED_TORUS_COLUMNS * BEADED_TORUS_ROWS;
// The sketch draws on a 600 pixel square canvas, so one source unit is one
// pixel there at the depth of the torus's center.
export const BEADED_TORUS_SOURCE_SIZE = 600;

// One step around the ring; a step around the tube is twice as long, so
// forty rows close the tube as eighty columns close the ring.
const STEP = Math.PI / 40;
const TUBE_RADIUS = 90;
const RING_RADIUS = 2 * TUBE_RADIUS;
const TILT_X = 0.5;
const TILT_Y = -0.5;
// The eye distance p5 gives a 600 pixel canvas: half its height over the
// tangent of half its 60 degree field of view.
const EYE_DISTANCE = BEADED_TORUS_SOURCE_SIZE / 2 / Math.tan(Math.PI / 6);

/// The beads at `phase` as round points: the projected x and y in source
/// units from the center of the canvas, y growing downward, the projected
/// radius, and an opacity of 1. Bead `row * BEADED_TORUS_COLUMNS + column` sits `column + phase`
/// steps around the ring and `row + phase` steps around the tube, so a whole
/// phase moves every bead onto its neighbour and the picture repeats.
export function buildBeadedTorusBeads(
  phase: number,
  out = new Float32Array(BEADED_TORUS_BEAD_COUNT * ROUND_POINT_FLOATS),
): Float32Array {
  const cosX = Math.cos(TILT_X);
  const sinX = Math.sin(TILT_X);
  const cosY = Math.cos(TILT_Y);
  const sinY = Math.sin(TILT_Y);
  let offset = 0;

  for (let row = 0; row < BEADED_TORUS_ROWS; row += 1) {
    const tube = (row + phase) * STEP * 2;
    const cosTube = Math.cos(tube);
    const ringDistance = RING_RADIUS + Math.sin(tube) * TUBE_RADIUS;
    const z = cosTube * TUBE_RADIUS;
    // The sketch hands sphere() a radius that goes negative on the far side
    // of the tube, where p5 draws the sphere inside out at the same size.
    const radius = Math.abs(cosTube + 0.3);

    for (let column = 0; column < BEADED_TORUS_COLUMNS; column += 1) {
      const ring = (column + phase) * STEP;
      const x = ringDistance * Math.cos(ring);
      const y = ringDistance * Math.sin(ring);

      const turnedX = x * cosY + z * sinY;
      const turnedZ = z * cosY - x * sinY;
      const tiltedY = y * cosX - turnedZ * sinX;
      const tiltedZ = y * sinX + turnedZ * cosX;
      const perspective = EYE_DISTANCE / (EYE_DISTANCE - tiltedZ);

      out[offset] = turnedX * perspective;
      out[offset + 1] = tiltedY * perspective;
      out[offset + 2] = radius * perspective;
      out[offset + 3] = 1;
      offset += ROUND_POINT_FLOATS;
    }
  }

  return out;
}
