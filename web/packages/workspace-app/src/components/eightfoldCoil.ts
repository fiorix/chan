import { LINE_SEGMENT_FLOATS, type LineSegmentRun } from "./lineSegments";

// Inspired by A. L. Crego's "Soothe":
// https://x.com/ALCrego_/status/2107957558577336759
// The post carries no code. The construction and the timing here were
// measured from its video.

/// Lengths are in units of the radius of the circle the eight nodes sit on.
/// The video's square frame is this many of them across, so it crops the
/// outer circle, which is two units in radius.
export const EIGHTFOLD_COIL_SOURCE_SIZE = 3.538;
export const EIGHTFOLD_COIL_SPOKE_COUNT = 8;

const OUTER_RADIUS = 2;
const TAU = Math.PI * 2;

// A spoke winds up over 5.7 seconds and unwinds over the 4.3 that follow,
// each along a smoothstep. The spokes go in pairs half a second apart, so
// the whole loop is 11.5 seconds and a spoke rests for the last 1.5 of it.
const WIND_SECONDS = 5.7;
const UNWIND_SECONDS = 4.3;
const PAIR_DELAY_SECONDS = 0.5;
export const EIGHTFOLD_COIL_PERIOD_SECONDS =
  WIND_SECONDS + UNWIND_SECONDS + 3 * PAIR_DELAY_SECONDS;
// Just over ten turns at the node.
const PEAK_TWIST = (3643.6 * Math.PI) / 180;

/// Each half of a spoke, node to end, is this many segments. At the peak a
/// segment turns about three degrees from the last.
const SEGMENTS_PER_ARM = 1200;
const SEGMENTS_PER_SPOKE = 2 * SEGMENTS_PER_ARM;
const SPOKE_SEGMENTS = EIGHTFOLD_COIL_SPOKE_COUNT * SEGMENTS_PER_SPOKE;

const CIRCLE_SEGMENTS = 256;
const MARKER_SEGMENTS = 24;
const MARKER_RADIUS = 0.022;
// The two fainter rings the video draws outside the outer circle.
const HALO_RADII = [2.16, 2.316] as const;

const FULL_SEGMENTS =
  SPOKE_SEGMENTS +
  CIRCLE_SEGMENTS +
  EIGHTFOLD_COIL_SPOKE_COUNT * MARKER_SEGMENTS;

export const EIGHTFOLD_COIL_SEGMENT_COUNT =
  FULL_SEGMENTS + (1 + HALO_RADII.length) * CIRCLE_SEGMENTS;

/// The picture's strokes by weight, in the order the segments are laid out:
/// the spokes, the outer circle and the node markers at full weight, then
/// the thin circle through the nodes and the two outer rings.
export const EIGHTFOLD_COIL_RUNS: readonly LineSegmentRun[] = [
  { segmentCount: FULL_SEGMENTS, weight: 1 },
  { segmentCount: CIRCLE_SEGMENTS, weight: 0.45 },
  { segmentCount: CIRCLE_SEGMENTS, weight: 0.6 },
  { segmentCount: CIRCLE_SEGMENTS, weight: 0.35 },
];

function smoothstep(amount: number): number {
  return amount * amount * (3 - 2 * amount);
}

/// The twist at spoke `spoke`'s node, in radians, `seconds` into the loop.
/// Spokes are numbered clockwise on screen from the one pointing right. The
/// left and lower-left spokes lead; the pairs follow a quarter turn
/// clockwise each time: up, right, down.
export function eightfoldCoilTwist(spoke: number, seconds: number): number {
  const leader = spoke % 2 === 0 ? spoke : spoke + 1;
  const pair = ((leader - 4) / 2 + 4) % 4;
  const local =
    (((seconds - pair * PAIR_DELAY_SECONDS) %
      EIGHTFOLD_COIL_PERIOD_SECONDS) +
      EIGHTFOLD_COIL_PERIOD_SECONDS) %
    EIGHTFOLD_COIL_PERIOD_SECONDS;
  if (local < WIND_SECONDS) {
    return PEAK_TWIST * smoothstep(local / WIND_SECONDS);
  }
  if (local < WIND_SECONDS + UNWIND_SECONDS) {
    return (
      PEAK_TWIST *
      smoothstep((WIND_SECONDS + UNWIND_SECONDS - local) / UNWIND_SECONDS)
    );
  }
  return 0;
}

function writeCircle(
  out: Float32Array,
  firstSegment: number,
  centerX: number,
  centerY: number,
  radius: number,
  segments: number,
): void {
  let offset = firstSegment * LINE_SEGMENT_FLOATS;
  for (let segment = 0; segment < segments; segment += 1) {
    const from = (segment / segments) * TAU;
    const to = ((segment + 1) / segments) * TAU;
    out[offset] = centerX + Math.cos(from) * radius;
    out[offset + 1] = centerY + Math.sin(from) * radius;
    out[offset + 2] = centerX + Math.cos(to) * radius;
    out[offset + 3] = centerY + Math.sin(to) * radius;
    offset += LINE_SEGMENT_FLOATS;
  }
}

/// A segment buffer with everything that never moves already in it: the
/// outer circle, a marker on each node, the circle through the nodes and
/// the two outer rings. buildEightfoldCoilSpokes fills in the rest.
export function createEightfoldCoilSegments(): Float32Array {
  const out = new Float32Array(
    EIGHTFOLD_COIL_SEGMENT_COUNT * LINE_SEGMENT_FLOATS,
  );
  let segment = SPOKE_SEGMENTS;
  writeCircle(out, segment, 0, 0, OUTER_RADIUS, CIRCLE_SEGMENTS);
  segment += CIRCLE_SEGMENTS;
  for (let spoke = 0; spoke < EIGHTFOLD_COIL_SPOKE_COUNT; spoke += 1) {
    const angle = (spoke * TAU) / EIGHTFOLD_COIL_SPOKE_COUNT;
    writeCircle(
      out,
      segment,
      Math.cos(angle),
      Math.sin(angle),
      MARKER_RADIUS,
      MARKER_SEGMENTS,
    );
    segment += MARKER_SEGMENTS;
  }
  for (const radius of [1, ...HALO_RADII]) {
    writeCircle(out, segment, 0, 0, radius, CIRCLE_SEGMENTS);
    segment += CIRCLE_SEGMENTS;
  }
  return out;
}

/// Writes the eight spokes at `seconds` into the front of `out`. A spoke
/// runs straight from the center through its node to the outer circle, then
/// every point on it is turned about the node, clockwise on screen, by the
/// spoke's twist scaled down linearly from the node to nothing at either
/// end. The ends stay put and the middle winds into a spiral of evenly
/// spaced rings.
export function buildEightfoldCoilSpokes(
  seconds: number,
  out: Float32Array,
): Float32Array {
  let offset = 0;
  for (let spoke = 0; spoke < EIGHTFOLD_COIL_SPOKE_COUNT; spoke += 1) {
    const angle = (spoke * TAU) / EIGHTFOLD_COIL_SPOKE_COUNT;
    const nodeX = Math.cos(angle);
    const nodeY = Math.sin(angle);
    const twist = eightfoldCoilTwist(spoke, seconds);

    // The center, one unit back along the spoke from its node.
    let lastX = 0;
    let lastY = 0;
    for (let step = 1; step <= SEGMENTS_PER_SPOKE; step += 1) {
      const along = step / SEGMENTS_PER_ARM - 1;
      const turn = angle + twist * (1 - Math.abs(along));
      const x = nodeX + along * Math.cos(turn);
      const y = nodeY + along * Math.sin(turn);
      out[offset] = lastX;
      out[offset + 1] = lastY;
      out[offset + 2] = x;
      out[offset + 3] = y;
      offset += LINE_SEGMENT_FLOATS;
      lastX = x;
      lastY = y;
    }
  }
  return out;
}
