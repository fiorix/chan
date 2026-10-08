import { LINE_SEGMENT_FLOATS } from "./lineSegments";

// Geometry and motion adapted from Hau_kun's Processing sketch:
// https://x.com/Hau_kun/status/1277257755846340609
// The sketch draws on a 720 pixel square canvas, so one source unit is one
// pixel there.
export const BRANCHING_WREATH_SOURCE_SIZE = 720;
export const BRANCHING_WREATH_TREE_COUNT = 10;

const TRUNK_LENGTH = 126;
const BRANCH_RATIO = 0.7;
const SHORTEST_BRANCH = 3;

// A branch's length, and the turn each of its two children makes from it:
// the tangent of that length, in radians, before the clock is added.
const LENGTHS: number[] = [];
const TURNS: number[] = [];
for (
  let length = TRUNK_LENGTH;
  length > SHORTEST_BRANCH;
  length *= BRANCH_RATIO
) {
  LENGTHS.push(length);
  TURNS.push(Math.tan(length));
}

/// Every tree is a full binary tree, eleven branches deep.
export const BRANCHING_WREATH_SEGMENT_COUNT =
  BRANCHING_WREATH_TREE_COUNT * (2 ** LENGTHS.length - 1);

/// The branches at clock `time`, in the sketch's order: ten trees around the
/// center, each branch followed by the subtree it turns toward and then the
/// one it turns away from. The clock adds to every turn, so each level of a
/// tree swings against the one below it, and the picture repeats when the
/// clock has gone once around.
export function buildBranchingWreathSegments(
  time: number,
  out = new Float32Array(
    BRANCHING_WREATH_SEGMENT_COUNT * LINE_SEGMENT_FLOATS,
  ),
): Float32Array {
  let offset = 0;

  function branch(x: number, y: number, angle: number, level: number): void {
    const length = LENGTHS[level]!;
    const endX = x + Math.cos(angle) * length;
    const endY = y + Math.sin(angle) * length;
    out[offset] = x;
    out[offset + 1] = y;
    out[offset + 2] = endX;
    out[offset + 3] = endY;
    offset += LINE_SEGMENT_FLOATS;

    if (level + 1 === LENGTHS.length) return;
    const turn = TURNS[level]! + time;
    branch(endX, endY, angle + turn, level + 1);
    branch(endX, endY, angle - turn, level + 1);
  }

  for (let tree = 0; tree < BRANCHING_WREATH_TREE_COUNT; tree += 1) {
    branch(0, 0, (tree * Math.PI) / 5, 0);
  }
  return out;
}
