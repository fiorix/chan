import type { FontMetrics } from './renderer';

/// A rectangle inside one cell, as fractions of the cell: x0, y0, x1, y1.
type BlockRect = [number, number, number, number];

type BlockGlyph = {
  rects: BlockRect[];
  /// Shade characters paint the same rectangle as a solid block at reduced
  /// coverage. Alpha rather than a dither pattern: a dither is a texture at
  /// the cell's own scale, so it moires against the cell grid at some sizes
  /// and turns into flat colour at others.
  alpha?: number;
};

// The four quadrants, named so the quadrant characters below read as the
// shapes they are rather than as four numbers each.
const UPPER_LEFT: BlockRect = [0, 0, 1 / 2, 1 / 2];
const UPPER_RIGHT: BlockRect = [1 / 2, 0, 1, 1 / 2];
const LOWER_LEFT: BlockRect = [0, 1 / 2, 1 / 2, 1];
const LOWER_RIGHT: BlockRect = [1 / 2, 1 / 2, 1, 1];

/// The block elements, U+2580..U+259F, as the fraction of the cell each one
/// fills.
///
/// WHY these are drawn rather than left to the font: a block element is
/// defined by the cell, not by a typeface, and every font renders it at the
/// glyph's own ink height. Under a taller-than-font line height that leaves
/// an unpainted strip at each cell boundary, so a bar chart or a progress
/// bar (btop, gauges, sparklines) comes out banded. Filling the cell
/// rectangle is the only way the character means what it says.
const BLOCK_GLYPHS = new Map<number, BlockGlyph>([
  [0x2580, { rects: [[0, 0, 1, 1 / 2]] }],
  [0x2581, { rects: [[0, 7 / 8, 1, 1]] }],
  [0x2582, { rects: [[0, 6 / 8, 1, 1]] }],
  [0x2583, { rects: [[0, 5 / 8, 1, 1]] }],
  [0x2584, { rects: [[0, 4 / 8, 1, 1]] }],
  [0x2585, { rects: [[0, 3 / 8, 1, 1]] }],
  [0x2586, { rects: [[0, 2 / 8, 1, 1]] }],
  [0x2587, { rects: [[0, 1 / 8, 1, 1]] }],
  [0x2588, { rects: [[0, 0, 1, 1]] }],
  [0x2589, { rects: [[0, 0, 7 / 8, 1]] }],
  [0x258a, { rects: [[0, 0, 6 / 8, 1]] }],
  [0x258b, { rects: [[0, 0, 5 / 8, 1]] }],
  [0x258c, { rects: [[0, 0, 4 / 8, 1]] }],
  [0x258d, { rects: [[0, 0, 3 / 8, 1]] }],
  [0x258e, { rects: [[0, 0, 2 / 8, 1]] }],
  [0x258f, { rects: [[0, 0, 1 / 8, 1]] }],
  [0x2590, { rects: [[1 / 2, 0, 1, 1]] }],
  [0x2591, { alpha: 0.25, rects: [[0, 0, 1, 1]] }],
  [0x2592, { alpha: 0.5, rects: [[0, 0, 1, 1]] }],
  [0x2593, { alpha: 0.75, rects: [[0, 0, 1, 1]] }],
  [0x2594, { rects: [[0, 0, 1, 1 / 8]] }],
  [0x2595, { rects: [[7 / 8, 0, 1, 1]] }],
  [0x2596, { rects: [LOWER_LEFT] }],
  [0x2597, { rects: [LOWER_RIGHT] }],
  [0x2598, { rects: [UPPER_LEFT] }],
  [0x2599, { rects: [UPPER_LEFT, LOWER_LEFT, LOWER_RIGHT] }],
  [0x259a, { rects: [UPPER_LEFT, LOWER_RIGHT] }],
  [0x259b, { rects: [UPPER_LEFT, UPPER_RIGHT, LOWER_LEFT] }],
  [0x259c, { rects: [UPPER_LEFT, UPPER_RIGHT, LOWER_RIGHT] }],
  [0x259d, { rects: [UPPER_RIGHT] }],
  [0x259e, { rects: [UPPER_RIGHT, LOWER_LEFT] }],
  [0x259f, { rects: [UPPER_RIGHT, LOWER_LEFT, LOWER_RIGHT] }],
]);

/// Whether the widget draws this codepoint as cell paths instead of the
/// font: the box-drawing set below and the block elements above.
export function isCustomGlyph(codepoint: number): boolean {
  return isCustomBoxGlyph(codepoint) || BLOCK_GLYPHS.has(codepoint);
}

function isCustomBoxGlyph(codepoint: number): boolean {
  return (
    codepoint === 0x2500 ||
    codepoint === 0x2502 ||
    codepoint === 0x250c ||
    codepoint === 0x2510 ||
    codepoint === 0x2514 ||
    codepoint === 0x2518 ||
    codepoint === 0x251c ||
    codepoint === 0x2524 ||
    codepoint === 0x252c ||
    codepoint === 0x2534 ||
    codepoint === 0x253c ||
    codepoint === 0x256d ||
    codepoint === 0x256e ||
    codepoint === 0x256f ||
    codepoint === 0x2570 ||
    codepoint === 0x2574 ||
    codepoint === 0x2575 ||
    codepoint === 0x2576 ||
    codepoint === 0x2577
  );
}

/// Draw a box-drawing or block element as cell paths. Returns false when the
/// codepoint is not one of the widget's own glyphs and the caller should
/// draw the font instead.
export function drawBoxGlyph(
  context: CanvasRenderingContext2D,
  metrics: FontMetrics,
  codepoint: number,
  column: number,
  row: number,
  faint: boolean,
  ratio: number,
): boolean {
  if (isCustomBoxGlyph(codepoint)) {
    drawCustomBoxGlyph(context, metrics, codepoint, column, row, faint);
    return true;
  }
  if (BLOCK_GLYPHS.has(codepoint)) {
    drawCustomBlockGlyph(context, metrics, codepoint, column, row, faint, ratio);
    return true;
  }
  return false;
}

/// Round to the nearest device pixel.
///
/// A cell edge that lands mid-device-pixel antialiases, and the neighbouring
/// cell antialiases its own copy of the same edge, so a run of solid blocks
/// grows a seam at every boundary instead of tiling. Snapping both cells to
/// the same rounded edge is what makes the run solid.
function snapToDevice(value: number, ratio: number): number {
  return Math.round(value * ratio) / ratio;
}

function drawCustomBlockGlyph(
  context: CanvasRenderingContext2D,
  metrics: FontMetrics,
  codepoint: number,
  column: number,
  row: number,
  faint: boolean,
  ratio: number,
): void {
  const glyph = BLOCK_GLYPHS.get(codepoint);
  if (!glyph) return;

  // The cell's own edges are snapped once and then reused for the 0 and 1
  // fractions, so a full block ends exactly where its neighbour begins.
  const left = snapToDevice(column * metrics.width, ratio);
  const right = snapToDevice((column + 1) * metrics.width, ratio);
  const top = snapToDevice(row * metrics.height, ratio);
  const bottom = snapToDevice((row + 1) * metrics.height, ratio);
  const x = (fraction: number) =>
    fraction === 0
      ? left
      : fraction === 1
        ? right
        : snapToDevice(left + fraction * metrics.width, ratio);
  const y = (fraction: number) =>
    fraction === 0
      ? top
      : fraction === 1
        ? bottom
        : snapToDevice(top + fraction * metrics.height, ratio);

  context.save();
  context.globalAlpha = (glyph.alpha ?? 1) * (faint ? 0.5 : 1);
  for (const [x0, y0, x1, y1] of glyph.rects) {
    context.fillRect(x(x0), y(y0), x(x1) - x(x0), y(y1) - y(y0));
  }
  context.restore();
}

function drawCustomBoxGlyph(
  context: CanvasRenderingContext2D,
  metrics: FontMetrics,
  codepoint: number,
  column: number,
  row: number,
  faint: boolean,
): void {
  const left = column * metrics.width;
  const top = row * metrics.height;
  const right = left + metrics.width;
  const bottom = top + metrics.height;
  const centerX = left + metrics.width / 2;
  const centerY = top + metrics.height / 2;

  context.save();
  context.beginPath();
  context.strokeStyle = context.fillStyle;
  context.lineWidth = 1;
  context.lineCap = "butt";
  context.lineJoin = "miter";
  if (faint) context.globalAlpha = 0.5;

  switch (codepoint) {
    case 0x2500:
      context.moveTo(left, centerY);
      context.lineTo(right, centerY);
      break;
    case 0x2502:
      context.moveTo(centerX, top);
      context.lineTo(centerX, bottom);
      break;
    case 0x250c:
      context.moveTo(centerX, bottom);
      context.lineTo(centerX, centerY);
      context.lineTo(right, centerY);
      break;
    case 0x2510:
      context.moveTo(left, centerY);
      context.lineTo(centerX, centerY);
      context.lineTo(centerX, bottom);
      break;
    case 0x2514:
      context.moveTo(centerX, top);
      context.lineTo(centerX, centerY);
      context.lineTo(right, centerY);
      break;
    case 0x2518:
      context.moveTo(centerX, top);
      context.lineTo(centerX, centerY);
      context.lineTo(left, centerY);
      break;
    case 0x251c:
      context.moveTo(centerX, top);
      context.lineTo(centerX, bottom);
      context.moveTo(centerX, centerY);
      context.lineTo(right, centerY);
      break;
    case 0x2524:
      context.moveTo(centerX, top);
      context.lineTo(centerX, bottom);
      context.moveTo(centerX, centerY);
      context.lineTo(left, centerY);
      break;
    case 0x252c:
      context.moveTo(left, centerY);
      context.lineTo(right, centerY);
      context.moveTo(centerX, centerY);
      context.lineTo(centerX, bottom);
      break;
    case 0x2534:
      context.moveTo(left, centerY);
      context.lineTo(right, centerY);
      context.moveTo(centerX, centerY);
      context.lineTo(centerX, top);
      break;
    case 0x253c:
      context.moveTo(left, centerY);
      context.lineTo(right, centerY);
      context.moveTo(centerX, top);
      context.lineTo(centerX, bottom);
      break;
    case 0x256d:
      roundedCorner(context, centerX, bottom, right, centerY, 1, 1, metrics);
      break;
    case 0x256e:
      roundedCorner(context, centerX, bottom, left, centerY, -1, 1, metrics);
      break;
    case 0x256f:
      roundedCorner(context, centerX, top, left, centerY, -1, -1, metrics);
      break;
    case 0x2570:
      roundedCorner(context, centerX, top, right, centerY, 1, -1, metrics);
      break;
    case 0x2574:
      context.moveTo(centerX, centerY);
      context.lineTo(left, centerY);
      break;
    case 0x2575:
      context.moveTo(centerX, centerY);
      context.lineTo(centerX, top);
      break;
    case 0x2576:
      context.moveTo(centerX, centerY);
      context.lineTo(right, centerY);
      break;
    case 0x2577:
      context.moveTo(centerX, centerY);
      context.lineTo(centerX, bottom);
      break;
  }

  context.stroke();
  context.restore();
}

function roundedCorner(
  context: CanvasRenderingContext2D,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  horizontalDirection: -1 | 1,
  verticalDirection: -1 | 1,
  metrics: FontMetrics,
): void {
  const radius = metrics.width / 2;
  const curveStartY = endY + verticalDirection * radius;
  context.moveTo(startX, startY);
  context.lineTo(startX, curveStartY);
  context.bezierCurveTo(
    startX,
    curveStartY,
    startX,
    endY,
    startX + horizontalDirection * radius,
    endY,
  );
  context.lineTo(endX, endY);
}
