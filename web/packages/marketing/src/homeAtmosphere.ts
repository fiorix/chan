import {
  BEADED_TORUS_BEAD_COUNT,
  BEADED_TORUS_COLUMNS,
  BEADED_TORUS_ROWS,
  BEADED_TORUS_SOURCE_SIZE,
  buildBeadedTorusBeads,
} from "../../workspace-app/src/components/beadedTorus";
import { ROUND_POINT_FLOATS } from "../../workspace-app/src/components/roundPoints";

export const HOME_POINT_COUNT = BEADED_TORUS_BEAD_COUNT;
export const HOME_SOURCE_SIZE = BEADED_TORUS_SOURCE_SIZE;
const TORUS_SCALE = 1.55;

/** Scrub as the first section enters, independent of the rest of the page's length. */
export function sectionScrollProgress(scrollY: number, sectionTop: number, viewportHeight: number): number {
  const start = Math.max(0, sectionTop - viewportHeight * 0.7);
  const end = Math.max(start + 1, sectionTop - viewportHeight * 0.1);
  return Math.max(0, Math.min(1, (scrollY - start) / (end - start)));
}

/** Move the same beads from Chan's torus into a perspective wave grid, in a reusable buffer. */
export function buildHomeAtmosphereFrame(
  width: number,
  height: number,
  timeMs: number,
  progress: number,
  points = new Float32Array(HOME_POINT_COUNT * ROUND_POINT_FLOATS),
): Float32Array {
  buildBeadedTorusBeads(timeMs * 0.001 * 0.6, points);
  const p = Math.max(0, Math.min(1, progress));
  const blend = p * p * (3 - 2 * p);
  const scale = Math.max(1, Math.min(width, height)) / HOME_SOURCE_SIZE;
  const phase = timeMs * 0.001 * 1.45;

  // Wave motion follows Chan's DottedSurface, adapted from efferd's sketch:
  // https://21st.dev/@efferd/components/dotted-surface
  // Keep all rows in front of the camera so every torus bead has a finite destination.
  for (let row = 0; row < BEADED_TORUS_ROWS; row += 1) {
    const perspective = (height * 0.9) / (500 + row * 150);
    for (let column = 0; column < BEADED_TORUS_COLUMNS; column += 1) {
      const offset = (row * BEADED_TORUS_COLUMNS + column) * ROUND_POINT_FLOATS;
      const waveHeight = Math.sin(column * 0.3 + phase) * 40 + Math.sin(row * 0.5 + phase) * 45;
      const x = ((column - (BEADED_TORUS_COLUMNS - 1) / 2) * 95 * perspective) / scale;
      const y = (height * 0.46 + (290 - waveHeight) * perspective - height / 2) / scale;
      const radius = Math.max(0.8, Math.min(3.2, 3.2 * perspective)) / scale;
      const alpha = 0.85 - (row / (BEADED_TORUS_ROWS - 1)) * 0.5;
      points[offset] = points[offset] * TORUS_SCALE * (1 - blend) + x * blend;
      points[offset + 1] = points[offset + 1] * TORUS_SCALE * (1 - blend) + y * blend;
      points[offset + 2] = points[offset + 2] * TORUS_SCALE * (1 - blend) + radius * blend;
      points[offset + 3] = 1 - blend + alpha * blend;
    }
  }
  return points;
}
