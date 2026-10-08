import { ROUND_POINT_FLOATS } from "./roundPoints";

// Geometry and motion adapted from ky0ju's Processing sketch:
// https://x.com/ky0ju_art/status/1169639081279508480
// The sketch draws on an 800 pixel square canvas, so one source unit is one
// pixel there.
export const TWISTING_SWARM_SOURCE_SIZE = 800;

const HALF_SIZE = TWISTING_SWARM_SOURCE_SIZE / 2;
const GRID_STEP = 10;
const SWAY = 200;
const TAU = Math.PI * 2;

/// How far the sketch's clock moves each source frame. The sketch subtracts
/// a tenth of the last grid cell's depth, and that cell is the corner at
/// (390, 390), outside the disc, where the depth is negative: the clock runs
/// forward.
export const TWISTING_SWARM_PHASE_PER_FRAME =
  0.1 * (Math.hypot(HALF_SIZE - GRID_STEP, HALF_SIZE - GRID_STEP) / HALF_SIZE - 1);

const FLOATS_PER_CELL = 5;

/// The grid cells the sketch can show, five numbers each: x, y, depth, and
/// the cosine and sine of the cell's turn. Depth runs from 1 at the center
/// to 0 on the circle the canvas encloses; a cell beyond it gets a negative
/// opacity from the sketch and is never seen. The sketch turns the canvas a
/// little further before every cell, visible or not, so a cell's turn is the
/// sum over every cell up to and including it.
function layoutCells(): Float32Array {
  const cells: number[] = [];
  let turn = 0;
  for (let x = -HALF_SIZE; x < HALF_SIZE; x += GRID_STEP) {
    for (let y = -HALF_SIZE; y < HALF_SIZE; y += GRID_STEP) {
      const depth = 1 - Math.hypot(x, y) / HALF_SIZE;
      turn += (depth * Math.PI) / 30;
      if (depth > 0) cells.push(x, y, depth, Math.cos(turn), Math.sin(turn));
    }
  }
  return Float32Array.from(cells);
}

const CELLS = layoutCells();

export const TWISTING_SWARM_DOT_COUNT = CELLS.length / FLOATS_PER_CELL;

/// The dots at clock `phase` as round points. Each sways along its own
/// turned axis, a wave running from the rim to the center, and shrinks and
/// fades with its depth.
export function buildTwistingSwarmDots(
  phase: number,
  out = new Float32Array(TWISTING_SWARM_DOT_COUNT * ROUND_POINT_FLOATS),
): Float32Array {
  let offset = 0;
  for (let cell = 0; cell < CELLS.length; cell += FLOATS_PER_CELL) {
    const x = CELLS[cell]!;
    const depth = CELLS[cell + 2]!;
    const cos = CELLS[cell + 3]!;
    const sin = CELLS[cell + 4]!;
    const y = CELLS[cell + 1]! + Math.sin(depth * TAU + phase) * SWAY;

    out[offset] = x * cos - y * sin;
    out[offset + 1] = x * sin + y * cos;
    // The sketch's circle is 10 times the depth across.
    out[offset + 2] = 5 * depth;
    out[offset + 3] = depth;
    offset += ROUND_POINT_FLOATS;
  }
  return out;
}
