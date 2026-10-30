import type {
  CanvasRenderer,
  FontMetrics,
  GhosttyCell,
  IRenderable,
} from "ghostty-web";

export type CellDimensions = {
  width: number;
  height: number;
};

type FontMeasurement = {
  width: number;
  height: number;
};

type GhosttyRendererLike = Pick<CanvasRenderer, "getMetrics" | "resize">;

type GhosttyCellTextRenderer = GhosttyRendererLike & {
  ctx?: CanvasRenderingContext2D;
  devicePixelRatio?: number;
  renderCellText?: (
    cell: GhosttyCell,
    column: number,
    row: number,
    overrideColor?: string,
  ) => void;
};

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

type GhosttyOverlayScrollbarRenderer = GhosttyRendererLike & {
  canvas?: HTMLCanvasElement;
  ctx?: CanvasRenderingContext2D;
  devicePixelRatio?: number;
  render?: (
    buffer: IRenderable,
    forceAll?: boolean,
    viewportY?: number,
    scrollbackProvider?: unknown,
    scrollbarOpacity?: number,
  ) => void;
  renderScrollbar?: (
    viewportY: number,
    scrollbackLength: number,
    rows: number,
    opacity?: number,
  ) => void;
};

type GhosttyScrollbarClickSource = {
  handleMouseDown?: (event: MouseEvent) => void;
  scrollbarOpacity?: number;
};

const XTERM_DOM_MEASURE_REPETITIONS = 32;
const CELL_FLAG_INVISIBLE = 32;
const CELL_FLAG_FAINT = 128;
const customGlyphRenderers = new WeakSet<object>();
const overlayScrollbarRenderers = new WeakSet<object>();

// ghostty-web's overlay scrollbar geometry, mirrored so chan can paint the same
// bar in the same place without the opaque fill upstream draws it on.
const SCROLLBAR_THUMB_WIDTH = 8;
const SCROLLBAR_MARGIN = 4;
const SCROLLBAR_MIN_THUMB_HEIGHT = 20;
const SCROLLBAR_TRACK_ALPHA = 0.1;
const SCROLLBAR_THUMB_ALPHA_SCROLLED = 0.5;
const SCROLLBAR_THUMB_ALPHA_AT_BOTTOM = 0.3;

/// Reproduce xterm.js's device-pixel cell rounding from an already measured
/// "W". Keeping this pure makes the renderer alignment independently testable.
export function xtermCellDimensionsFromMeasurement(
  measurement: FontMeasurement,
  devicePixelRatio: number,
  lineHeight: number,
): CellDimensions | null {
  if (
    !Number.isFinite(measurement.width) ||
    !Number.isFinite(measurement.height) ||
    !Number.isFinite(devicePixelRatio) ||
    !Number.isFinite(lineHeight) ||
    measurement.width <= 0 ||
    measurement.height <= 0 ||
    devicePixelRatio <= 0 ||
    lineHeight < 1
  ) {
    return null;
  }

  const deviceCharWidth = Math.floor(
    measurement.width * devicePixelRatio,
  );
  const deviceCharHeight = Math.ceil(
    measurement.height * devicePixelRatio,
  );
  const deviceCellHeight = Math.floor(deviceCharHeight * lineHeight);
  if (deviceCharWidth <= 0 || deviceCellHeight <= 0) return null;

  return {
    width: deviceCharWidth / devicePixelRatio,
    height: deviceCellHeight / devicePixelRatio,
  };
}

/// Measure the same glyph, font box, and fallback DOM span used by xterm.js.
/// Ghostty measures "M" ink bounds and adds two pixels; that produces a
/// different grid even when both terminals receive the same font options.
export function measureXtermCellDimensions(
  parent: HTMLElement,
  fontFamily: string,
  fontSize: number,
  lineHeight: number,
): CellDimensions | null {
  const devicePixelRatio = window.devicePixelRatio || 1;
  const canvasMeasurement = measureWithTextMetrics(fontFamily, fontSize);
  if (canvasMeasurement) {
    return xtermCellDimensionsFromMeasurement(
      canvasMeasurement,
      devicePixelRatio,
      lineHeight,
    );
  }

  const span = document.createElement("span");
  span.classList.add("xterm-char-measure-element");
  span.textContent = "W".repeat(XTERM_DOM_MEASURE_REPETITIONS);
  span.setAttribute("aria-hidden", "true");
  span.style.whiteSpace = "pre";
  span.style.fontKerning = "none";
  span.style.fontFamily = fontFamily;
  span.style.fontSize = `${fontSize}px`;
  parent.appendChild(span);
  try {
    return xtermCellDimensionsFromMeasurement(
      {
        width: span.offsetWidth / XTERM_DOM_MEASURE_REPETITIONS,
        height: span.offsetHeight,
      },
      devicePixelRatio,
      lineHeight,
    );
  } finally {
    span.remove();
  }
}

/// Align ghostty-web's canvas grid to chan's xterm.js grid. The pinned
/// ghostty-web build exposes no line-height or letter-spacing option, so this
/// guarded adapter updates its renderer metrics after open(). It fails open if
/// a future ghostty-web release changes that internal field.
export function alignGhosttyRendererToXterm(
  renderer: GhosttyRendererLike,
  target: CellDimensions,
  cols: number,
  rows: number,
): FontMetrics | null {
  const current = renderer.getMetrics();
  const mutable = renderer as GhosttyRendererLike & {
    metrics?: FontMetrics;
  };
  if (
    !Object.prototype.hasOwnProperty.call(renderer, "metrics") ||
    !validCellDimensions(target) ||
    !Number.isFinite(current.baseline)
  ) {
    return null;
  }

  const metrics = {
    width: target.width,
    height: target.height,
    baseline: Math.max(
      0,
      Math.min(
        target.height,
        current.baseline + (target.height - current.height) / 2,
      ),
    ),
  };
  mutable.metrics = metrics;
  renderer.resize(cols, rows);
  return metrics;
}

/// ghostty-web paints every codepoint through the text font. Box-drawing
/// glyphs then stop short of the cell edges and produce dotted borders,
/// especially after aligning its wider native cell to xterm's grid. xterm's
/// WebGL renderer draws these common glyphs as cell-spanning paths instead.
/// Install the same behavior around Ghostty's guarded private text hook.
export function installGhosttyCustomGlyphs(
  renderer: GhosttyRendererLike,
): boolean {
  if (customGlyphRenderers.has(renderer)) return true;
  const mutable = renderer as GhosttyCellTextRenderer;
  const context = mutable.ctx;
  const original = mutable.renderCellText;
  if (!context || typeof original !== "function") return false;

  mutable.renderCellText = (
    cell,
    column,
    row,
    overrideColor,
  ): void => {
    if (cell.grapheme_len > 0 || !isCustomGlyph(cell.codepoint)) {
      original.call(renderer, cell, column, row, overrideColor);
      return;
    }

    // Let Ghostty resolve inverse/selection/cursor colors and text
    // decorations, but suppress the font's disconnected glyph.
    original.call(
      renderer,
      { ...cell, codepoint: 32, grapheme_len: 0 },
      column,
      row,
      overrideColor,
    );
    if ((cell.flags & CELL_FLAG_INVISIBLE) !== 0) return;
    const metrics = renderer.getMetrics();
    const faint = (cell.flags & CELL_FLAG_FAINT) !== 0;
    if (isCustomBoxGlyph(cell.codepoint)) {
      drawCustomBoxGlyph(context, metrics, cell.codepoint, column, row, faint);
      return;
    }
    drawCustomBlockGlyph(
      context,
      metrics,
      cell.codepoint,
      column,
      row,
      faint,
      rendererRatio(mutable),
    );
  };
  customGlyphRenderers.add(renderer);
  return true;
}

/// ghostty-web's overlay scrollbar clears and background-fills a full-height
/// strip at the right edge of its canvas on every frame it draws, ahead of its
/// own opacity and scrollback checks, so the columns beneath it are erased just
/// after they render and stay erased until something marks those rows dirty.
/// The strip is anchored to the canvas rather than to the host, so no width
/// held back by the fitter can move content out from under it. Paint the same
/// translucent track and thumb straight onto the content instead, and force a
/// full row repaint on every frame that paints the overlay plus the first frame
/// after it stops: the thumb is translucent, so without fresh pixels beneath it
/// it composites over its own previous alpha and converges on an opaque bar,
/// which is the blank strip again in a different color. Fails open if the
/// pinned build stops exposing the hooks or its device-pixel ratio.
export function installGhosttyOverlayScrollbar(
  renderer: GhosttyRendererLike,
): boolean {
  if (overlayScrollbarRenderers.has(renderer)) return true;
  const mutable = renderer as GhosttyOverlayScrollbarRenderer;
  const canvas = mutable.canvas;
  const context = mutable.ctx;
  const originalRender = mutable.render;
  if (
    !canvas ||
    !context ||
    typeof originalRender !== "function" ||
    typeof mutable.renderScrollbar !== "function" ||
    !Number.isFinite(mutable.devicePixelRatio) ||
    (mutable.devicePixelRatio ?? 0) <= 0
  ) {
    return false;
  }

  let paintedOverlay = false;
  mutable.render = (
    buffer,
    forceAll,
    viewportY,
    scrollbackProvider,
    scrollbarOpacity = 1,
  ): void => {
    const paintsOverlay = Boolean(scrollbackProvider) && scrollbarOpacity > 0;
    const needsFreshPixels = paintsOverlay || paintedOverlay;
    paintedOverlay = paintsOverlay;
    originalRender.call(
      renderer,
      buffer,
      forceAll === true || needsFreshPixels,
      viewportY,
      scrollbackProvider,
      scrollbarOpacity,
    );
  };

  mutable.renderScrollbar = (
    viewportY,
    scrollbackLength,
    rows,
    opacity = 1,
  ): void => {
    if (opacity <= 0 || scrollbackLength === 0) return;
    const ratio = mutable.devicePixelRatio ?? 1;
    const barX =
      canvas.width / ratio - SCROLLBAR_THUMB_WIDTH - SCROLLBAR_MARGIN;
    const trackHeight = canvas.height / ratio - SCROLLBAR_MARGIN * 2;
    const thumbHeight = Math.max(
      SCROLLBAR_MIN_THUMB_HEIGHT,
      (rows / (scrollbackLength + rows)) * trackHeight,
    );
    const thumbY =
      SCROLLBAR_MARGIN +
      (trackHeight - thumbHeight) * (1 - viewportY / scrollbackLength);
    const thumbAlpha =
      viewportY > 0
        ? SCROLLBAR_THUMB_ALPHA_SCROLLED
        : SCROLLBAR_THUMB_ALPHA_AT_BOTTOM;

    context.save();
    context.fillStyle = `rgba(128, 128, 128, ${SCROLLBAR_TRACK_ALPHA * opacity})`;
    context.fillRect(
      barX,
      SCROLLBAR_MARGIN,
      SCROLLBAR_THUMB_WIDTH,
      trackHeight,
    );
    context.fillStyle = `rgba(128, 128, 128, ${thumbAlpha * opacity})`;
    context.fillRect(barX, thumbY, SCROLLBAR_THUMB_WIDTH, thumbHeight);
    context.restore();
  };

  overlayScrollbarRenderers.add(renderer);
  return true;
}

/// ghostty-web claims mousedown across its overlay scrollbar strip whenever the
/// buffer holds scrollback rather than while the overlay is visible, and stops
/// immediate propagation, so nothing downstream can recover the event. Those
/// pixels are content under chan's full-width grid, so an invisible overlay
/// would swallow a click meant to place a selection in the last columns. Bind
/// ghostty's own handler behind its own opacity, the same state that decides
/// whether the user can see a scrollbar to aim at; a second copy of the fade
/// timing would be a second answer to when a click means scroll. The handler
/// does nothing outside the strip, so gating the whole listener costs no other
/// behavior. Returns the listener cleanup, or null if the pinned build stops
/// exposing the handler or the opacity, in which case its hidden click region
/// stays live.
export function gateGhosttyScrollbarClicks(
  terminal: object,
  host: HTMLElement,
): (() => void) | null {
  const source = terminal as GhosttyScrollbarClickSource;
  const claimStrip = source.handleMouseDown;
  if (
    typeof claimStrip !== "function" ||
    !Object.prototype.hasOwnProperty.call(terminal, "scrollbarOpacity")
  ) {
    return null;
  }

  const gated = (event: MouseEvent): void => {
    if ((source.scrollbarOpacity ?? 0) > 0) claimStrip(event);
  };
  // Upstream registers its own listener in open() with capture, so the removal
  // has to match those options for the gate to be the only claimant.
  host.removeEventListener("mousedown", claimStrip, true);
  host.addEventListener("mousedown", gated, true);
  return () => host.removeEventListener("mousedown", gated, true);
}

function measureWithTextMetrics(
  fontFamily: string,
  fontSize: number,
): FontMeasurement | null {
  try {
    if (typeof OffscreenCanvas === "undefined") return null;
    const context = new OffscreenCanvas(100, 100).getContext("2d");
    if (!context) return null;
    const supportProbe = context.measureText("W");
    if (
      !("fontBoundingBoxAscent" in supportProbe) ||
      !("fontBoundingBoxDescent" in supportProbe)
    ) {
      return null;
    }
    context.font = `${fontSize}px ${fontFamily}`;
    const metrics = context.measureText("W");
    return {
      width: metrics.width,
      height:
        metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent,
    };
  } catch {
    return null;
  }
}

function validCellDimensions(cell: CellDimensions): boolean {
  return (
    Number.isFinite(cell.width) &&
    Number.isFinite(cell.height) &&
    cell.width > 0 &&
    cell.height > 0
  );
}

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
/// glyph's own ink height. Under chan's 1.2 line height that leaves an
/// unpainted strip at each cell boundary, so a bar chart or a progress bar
/// (btop, gauges, sparklines) comes out banded. Filling the cell rectangle
/// is the only way the character means what it says.
const BLOCK_GLYPHS = new Map<number, BlockGlyph>([
  [0x2580, { rects: [[0, 0, 1, 1 / 2]] }], // upper half
  [0x2581, { rects: [[0, 7 / 8, 1, 1]] }], // lower one eighth
  [0x2582, { rects: [[0, 6 / 8, 1, 1]] }], // lower one quarter
  [0x2583, { rects: [[0, 5 / 8, 1, 1]] }], // lower three eighths
  [0x2584, { rects: [[0, 4 / 8, 1, 1]] }], // lower half
  [0x2585, { rects: [[0, 3 / 8, 1, 1]] }], // lower five eighths
  [0x2586, { rects: [[0, 2 / 8, 1, 1]] }], // lower three quarters
  [0x2587, { rects: [[0, 1 / 8, 1, 1]] }], // lower seven eighths
  [0x2588, { rects: [[0, 0, 1, 1]] }], // full block
  [0x2589, { rects: [[0, 0, 7 / 8, 1]] }], // left seven eighths
  [0x258a, { rects: [[0, 0, 6 / 8, 1]] }], // left three quarters
  [0x258b, { rects: [[0, 0, 5 / 8, 1]] }], // left five eighths
  [0x258c, { rects: [[0, 0, 4 / 8, 1]] }], // left half
  [0x258d, { rects: [[0, 0, 3 / 8, 1]] }], // left three eighths
  [0x258e, { rects: [[0, 0, 2 / 8, 1]] }], // left one quarter
  [0x258f, { rects: [[0, 0, 1 / 8, 1]] }], // left one eighth
  [0x2590, { rects: [[1 / 2, 0, 1, 1]] }], // right half
  [0x2591, { alpha: 0.25, rects: [[0, 0, 1, 1]] }], // light shade
  [0x2592, { alpha: 0.5, rects: [[0, 0, 1, 1]] }], // medium shade
  [0x2593, { alpha: 0.75, rects: [[0, 0, 1, 1]] }], // dark shade
  [0x2594, { rects: [[0, 0, 1, 1 / 8]] }], // upper one eighth
  [0x2595, { rects: [[7 / 8, 0, 1, 1]] }], // right one eighth
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

function isCustomGlyph(codepoint: number): boolean {
  return isCustomBoxGlyph(codepoint) || BLOCK_GLYPHS.has(codepoint);
}

function isCustomBoxGlyph(codepoint: number): boolean {
  return (
    codepoint === 0x2500 || // ─
    codepoint === 0x2502 || // │
    codepoint === 0x250c || // ┌
    codepoint === 0x2510 || // ┐
    codepoint === 0x2514 || // └
    codepoint === 0x2518 || // ┘
    codepoint === 0x251c || // ├
    codepoint === 0x2524 || // ┤
    codepoint === 0x252c || // ┬
    codepoint === 0x2534 || // ┴
    codepoint === 0x253c || // ┼
    codepoint === 0x256d || // ╭
    codepoint === 0x256e || // ╮
    codepoint === 0x256f || // ╯
    codepoint === 0x2570 || // ╰
    codepoint === 0x2574 || // ╴
    codepoint === 0x2575 || // ╵
    codepoint === 0x2576 || // ╶
    codepoint === 0x2577 // ╷
  );
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

/// The renderer's device-pixel ratio, read per draw because a window moved
/// between displays changes it under a live renderer.
function rendererRatio(renderer: GhosttyCellTextRenderer): number {
  const ratio = renderer.devicePixelRatio;
  if (typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0) {
    return ratio;
  }
  return window.devicePixelRatio || 1;
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
    case 0x2500: // ─
      context.moveTo(left, centerY);
      context.lineTo(right, centerY);
      break;
    case 0x2502: // │
      context.moveTo(centerX, top);
      context.lineTo(centerX, bottom);
      break;
    case 0x250c: // ┌
      context.moveTo(centerX, bottom);
      context.lineTo(centerX, centerY);
      context.lineTo(right, centerY);
      break;
    case 0x2510: // ┐
      context.moveTo(left, centerY);
      context.lineTo(centerX, centerY);
      context.lineTo(centerX, bottom);
      break;
    case 0x2514: // └
      context.moveTo(centerX, top);
      context.lineTo(centerX, centerY);
      context.lineTo(right, centerY);
      break;
    case 0x2518: // ┘
      context.moveTo(centerX, top);
      context.lineTo(centerX, centerY);
      context.lineTo(left, centerY);
      break;
    case 0x251c: // ├
      context.moveTo(centerX, top);
      context.lineTo(centerX, bottom);
      context.moveTo(centerX, centerY);
      context.lineTo(right, centerY);
      break;
    case 0x2524: // ┤
      context.moveTo(centerX, top);
      context.lineTo(centerX, bottom);
      context.moveTo(centerX, centerY);
      context.lineTo(left, centerY);
      break;
    case 0x252c: // ┬
      context.moveTo(left, centerY);
      context.lineTo(right, centerY);
      context.moveTo(centerX, centerY);
      context.lineTo(centerX, bottom);
      break;
    case 0x2534: // ┴
      context.moveTo(left, centerY);
      context.lineTo(right, centerY);
      context.moveTo(centerX, centerY);
      context.lineTo(centerX, top);
      break;
    case 0x253c: // ┼
      context.moveTo(left, centerY);
      context.lineTo(right, centerY);
      context.moveTo(centerX, top);
      context.lineTo(centerX, bottom);
      break;
    case 0x256d: // ╭
      roundedCorner(context, centerX, bottom, right, centerY, 1, 1, metrics);
      break;
    case 0x256e: // ╮
      roundedCorner(context, centerX, bottom, left, centerY, -1, 1, metrics);
      break;
    case 0x256f: // ╯
      roundedCorner(context, centerX, top, left, centerY, -1, -1, metrics);
      break;
    case 0x2570: // ╰
      roundedCorner(context, centerX, top, right, centerY, 1, -1, metrics);
      break;
    case 0x2574: // ╴
      context.moveTo(centerX, centerY);
      context.lineTo(left, centerY);
      break;
    case 0x2575: // ╵
      context.moveTo(centerX, centerY);
      context.lineTo(centerX, top);
      break;
    case 0x2576: // ╶
      context.moveTo(centerX, centerY);
      context.lineTo(right, centerY);
      break;
    case 0x2577: // ╷
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
