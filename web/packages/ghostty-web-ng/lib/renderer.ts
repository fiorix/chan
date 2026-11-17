/**
 * Canvas Renderer for Terminal Display
 *
 * High-performance canvas-based renderer that draws the terminal using
 * Ghostty's WASM terminal emulator. Features:
 * - Font metrics measurement with DPI scaling
 * - Full color support (256-color palette + RGB)
 * - All text styles (bold, italic, underline, strikethrough, etc.)
 * - Multiple cursor styles (block, underline, bar)
 * - Dirty line optimization for 60 FPS
 */

import { ABI, VtCells, VtFlag, type VtCell, type VtTerminal } from '../vt/ghosttyVt';
import { drawBoxGlyph } from './box-glyphs';
import type { ITheme } from './interfaces';
import type { SelectionManager } from './selection-manager';
import type { HighlightsManager, HighlightStyle } from './highlights';

// ============================================================================
// Type Definitions
// ============================================================================

export interface RendererOptions {
  fontSize?: number; // Default: 15
  fontFamily?: string; // Default: 'monospace'
  cursorStyle?: 'block' | 'underline' | 'bar'; // Default: 'block'
  cursorBlink?: boolean; // Default: false
  theme?: ITheme;
  devicePixelRatio?: number; // Default: window.devicePixelRatio
  lineHeight?: number; // Default: 1; multiplies the measured cell height, xterm-style
  boxGlyphs?: boolean; // Default: false; draw box-drawing and block elements as cell paths
  scrollbar?: 'overlay'; // Paint the translucent overlay scrollbar onto the content
}

/// What a paint layer sees of the frame it paints over: the context and the
/// grid it paints on, whether every row is being repainted, and which view
/// rows this frame repainted.
export interface PaintFrame {
  ctx: CanvasRenderingContext2D;
  metrics: FontMetrics;
  pixelRatio: number;
  viewportOffset: number;
  full: boolean;
  changedRows: number[];
  rows: number;
  cols: number;
}

/// One coat of paint over the frame, after the cells, the cursor and the
/// scrollbar, in ascending order. The returned disposer removes the layer.
export interface PaintLayer {
  order: number;
  paint(frame: PaintFrame): void;
}

export interface FontMetrics {
  width: number; // Character cell width in CSS pixels
  height: number; // Character cell height in CSS pixels
  baseline: number; // Distance from top to text baseline
}

// ============================================================================
// Default Theme
// ============================================================================

/**
 * A theme with every color the renderer needs. The selection foreground is
 * the one it does without: a theme that names none leaves selected text in
 * its own color, as xterm.js does.
 */
type RendererTheme = Required<Omit<ITheme, 'selectionForeground'>> &
  Pick<ITheme, 'selectionForeground'>;

export const DEFAULT_THEME: RendererTheme = {
  foreground: '#d4d4d4',
  background: '#1e1e1e',
  cursor: '#ffffff',
  cursorAccent: '#1e1e1e',
  // A solid color that replaces a selected cell's background
  selectionBackground: '#d4d4d4',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

// ============================================================================
// CanvasRenderer Class
// ============================================================================

export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private fontSize: number;
  private fontFamily: string;
  private cursorStyle: 'block' | 'underline' | 'bar';
  private cursorBlink: boolean;
  private theme: RendererTheme;
  private devicePixelRatio: number;
  private lineHeight: number;
  private boxGlyphs: boolean;
  private scrollbar?: 'overlay';
  private metrics: FontMetrics;

  // Cursor blinking state
  private cursorVisible: boolean = true;
  private cursorBlinkInterval?: number;
  private lastCursorPosition: { x: number; y: number } = { x: 0, y: 0 };
  private lastCursorShown: boolean = true;

  // Viewport tracking (for scrolling)
  private lastViewportY: number = 0;

  // The terminal being rendered, and the view its rows are read into: the
  // rows a frame paints, the rows a hover change looks for links in and the
  // cursor's row, one after another.
  private currentTerm: VtTerminal | null = null;
  private readonly cells = new VtCells();

  // Selection manager (for rendering selection)
  private selectionManager?: SelectionManager;
  // Cached selection coordinates for current render pass (viewport-relative)
  private currentSelectionCoords: {
    startCol: number;
    startRow: number;
    endCol: number;
    endRow: number;
  } | null = null;

  // Highlight source and cached spans for current render pass
  // (viewport-relative, first span wins on overlap)
  private highlightSource?: HighlightsManager;
  private currentHighlightSpans:
    | { startRow: number; endRow: number; startCol: number; endCol: number; style: HighlightStyle }[]
    | null = null;

  // Paint layers, in ascending order, run after the cells, the cursor and
  // the scrollbar.
  private paintLayers: PaintLayer[] = [];

  // Whether the previous frame painted the overlay scrollbar: its pixels
  // stay translucent composites, so the frame after it stops needs fresh
  // pixels under them too.
  private paintedOverlay = false;

  // Link rendering state
  private hoveredHyperlinkId: number = 0;
  private previousHoveredHyperlinkId: number = 0;

  // Regex link hover tracking (for links without hyperlink_id)
  private hoveredLinkRange: { startX: number; startY: number; endX: number; endY: number } | null =
    null;
  private previousHoveredLinkRange: {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  } | null = null;

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      throw new Error('Failed to get 2D rendering context');
    }
    this.ctx = ctx;

    // Apply options
    this.fontSize = options.fontSize ?? 15;
    this.fontFamily = options.fontFamily ?? 'monospace';
    this.cursorStyle = options.cursorStyle ?? 'block';
    this.cursorBlink = options.cursorBlink ?? false;
    this.theme = { ...DEFAULT_THEME, ...options.theme };
    this.devicePixelRatio = options.devicePixelRatio ?? window.devicePixelRatio ?? 1;
    this.lineHeight = options.lineHeight !== undefined && options.lineHeight >= 1 ? options.lineHeight : 1;
    this.boxGlyphs = options.boxGlyphs ?? false;
    this.scrollbar = options.scrollbar;

    // Measure font metrics
    this.metrics = this.measureFont();

    // Setup cursor blinking if enabled
    if (this.cursorBlink) {
      this.startCursorBlink();
    }
  }

  // ==========================================================================
  // Font Metrics Measurement
  // ==========================================================================

  private measureFont(): FontMetrics {
    const natural = this.measureNatural();
    if (this.lineHeight === 1) return natural;
    // A taller line keeps xterm's grid: the W ink box rounded to device
    // pixels with the height multiplied, and the baseline carried over
    // from the widget's own measure so text sits where it did.
    const wide = this.measureWide();
    if (!wide) {
      return {
        width: natural.width,
        height: natural.height * this.lineHeight,
        baseline: natural.baseline,
      };
    }
    const ratio = this.devicePixelRatio > 0 ? this.devicePixelRatio : 1;
    const width = Math.floor(wide.width * ratio) / ratio;
    const height = Math.floor(Math.ceil(wide.height * ratio) * this.lineHeight) / ratio;
    const baseline = Math.max(
      0,
      Math.min(height, natural.baseline + (height - natural.height) / 2),
    );
    return { width, height, baseline };
  }

  /// The widget's own cell measure: the M ink width and the ascent and
  /// descent with two pixels of padding for overflowing glyphs.
  private measureNatural(): FontMetrics {
    // Use an offscreen canvas for measurement
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;

    // Set font (use actual pixel size for accurate measurement)
    ctx.font = `${this.fontSize}px ${this.fontFamily}`;

    // Measure width using 'M' (typically widest character)
    const widthMetrics = ctx.measureText('M');
    const nwidth = Math.ceil(widthMetrics.width);

    // Measure height using ascent + descent with padding for glyph overflow
    const nascent = widthMetrics.actualBoundingBoxAscent || this.fontSize * 0.8;
    const ndescent = widthMetrics.actualBoundingBoxDescent || this.fontSize * 0.2;

    // Add 2px padding to height to account for glyphs that overflow (like 'f', 'd', 'g', 'p')
    // and anti-aliasing pixels
    const nheight = Math.ceil(nascent + ndescent) + 2;
    const nbaseline = Math.ceil(nascent) + 1; // Offset baseline by half the padding

    return { width: nwidth, height: nheight, baseline: nbaseline };
  }

  /// The xterm cell measure: the W ink box through an offscreen canvas, or
  /// null where the engine has none.
  private measureWide(): { width: number; height: number } | null {
    try {
      if (typeof OffscreenCanvas === "undefined") return null;
      const context = new OffscreenCanvas(100, 100).getContext("2d");
      if (!context) return null;
      const probe = context.measureText("W");
      if (
        !("fontBoundingBoxAscent" in probe) ||
        !("fontBoundingBoxDescent" in probe)
      ) {
        return null;
      }
      context.font = `${this.fontSize}px ${this.fontFamily}`;
      const metrics = context.measureText("W");
      return {
        width: metrics.width,
        height: metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent,
      };
    } catch {
      return null;
    }
  }

  // ==========================================================================
  // Color Conversion
  // ==========================================================================

  private rgbToCSS(color: number): string {
    return `rgb(${(color >>> 16) & 0xff}, ${(color >>> 8) & 0xff}, ${color & 0xff})`;
  }

  // ==========================================================================
  // Canvas Sizing
  // ==========================================================================

  /**
   * Resize canvas to fit terminal dimensions
   */
  public resize(cols: number, rows: number): void {
    const cssWidth = cols * this.metrics.width;
    const cssHeight = rows * this.metrics.height;

    // Set CSS size (what user sees)
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;

    // Set actual canvas size (scaled for DPI)
    this.canvas.width = cssWidth * this.devicePixelRatio;
    this.canvas.height = cssHeight * this.devicePixelRatio;

    // Scale context to match DPI (setting canvas.width/height resets the context)
    this.ctx.scale(this.devicePixelRatio, this.devicePixelRatio);

    // Set text rendering properties for crisp text
    this.ctx.textBaseline = 'alphabetic';
    this.ctx.textAlign = 'left';

    // Fill background after resize
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, 0, cssWidth, cssHeight);
  }

  // ==========================================================================
  // Main Rendering
  // ==========================================================================

  /**
   * Render the terminal to canvas: one frame of its render state, the rows
   * that changed since the last frame (or every row with `forceAll`), with
   * the view scrolled back `viewportY` rows into the history.
   */
  public render(
    term: VtTerminal,
    forceAll: boolean = false,
    viewportY: number = 0,
    scrollbarOpacity: number = 1
  ): void {
    this.currentTerm = term;

    const cursor = term.getCursor();
    const dims = term.getDimensions();
    const scrollbackLength = term.getScrollbackLength();
    // The history rows the view shows above the screen. A fractional offset
    // (chan's pixel scroll) shows the rows of its floor, and one below 0 the
    // bottom view, as the hover, the selection and the masker map them; only
    // the scrollbar reads the fraction.
    const historyRows = Math.max(0, Math.floor(viewportY));

    // The overlay scrollbar paints translucent ink over content: without
    // fresh pixels under it the thumb composites over its own previous
    // alpha. Force a full repaint on every frame that paints it and the
    // first frame after it stops.
    const overlay = this.scrollbar === 'overlay';
    if (overlay && (scrollbarOpacity > 0 || this.paintedOverlay)) forceAll = true;

    // A resize, a screen switch, new colours or output that scrolled change
    // every row.
    if (term.beginFrame() === ABI.GhosttyRenderStateDirty.FULL) {
      forceAll = true;
    }

    // Resize canvas if dimensions changed
    const needsResize =
      this.canvas.width !== dims.cols * this.metrics.width * this.devicePixelRatio ||
      this.canvas.height !== dims.rows * this.metrics.height * this.devicePixelRatio;

    if (needsResize) {
      this.resize(dims.cols, dims.rows);
      forceAll = true; // Force full render after resize
    }

    // Force re-render when viewport changes (scrolling)
    if (viewportY !== this.lastViewportY) {
      forceAll = true;
      this.lastViewportY = viewportY;
    }

    // Check if cursor position changed or if blinking (need to redraw cursor line).
    // A cursor hidden or shown where it stands repaints its line as a move
    // does: the core marks no row dirty for it.
    const cursorPainted: number[] = [];
    const cursorMoved =
      cursor.x !== this.lastCursorPosition.x || cursor.y !== this.lastCursorPosition.y;
    const cursorShownChanged = cursor.visible !== this.lastCursorShown;
    if (cursorMoved || cursorShownChanged || this.cursorBlink) {
      // Mark cursor lines as needing redraw
      if (!forceAll && !term.isRowDirty(cursor.y)) {
        // Need to redraw cursor line
        if (term.readRow(cursor.y, this.cells)) {
          this.renderLine(this.cells, cursor.y, dims.cols);
          cursorPainted.push(cursor.y);
        }
      }
      if (cursorMoved && this.lastCursorPosition.y !== cursor.y) {
        // Also redraw old cursor line if cursor moved to different line
        if (!forceAll && !term.isRowDirty(this.lastCursorPosition.y)) {
          if (term.readRow(this.lastCursorPosition.y, this.cells)) {
            this.renderLine(this.cells, this.lastCursorPosition.y, dims.cols);
            cursorPainted.push(this.lastCursorPosition.y);
          }
        }
      }
    }

    // Check if we need to redraw selection-related lines
    const hasSelection = this.selectionManager && this.selectionManager.hasSelection();
    const selectionRows = new Set<number>();

    // Cache selection coordinates for use during cell rendering
    // This is used by isInSelection() to determine if a cell needs selection colors
    this.currentSelectionCoords = hasSelection ? this.selectionManager!.getSelectionCoords() : null;

    // Mark current selection rows for redraw (includes programmatic selections)
    if (this.currentSelectionCoords) {
      const coords = this.currentSelectionCoords;
      for (let row = coords.startRow; row <= coords.endRow; row++) {
        selectionRows.add(row);
      }
    }

    // Always mark dirty selection rows for redraw (to clear old overlay)
    if (this.selectionManager) {
      const dirtyRows = this.selectionManager.getDirtySelectionRows();
      if (dirtyRows.size > 0) {
        for (const row of dirtyRows) {
          selectionRows.add(row);
        }
        // Clear the dirty rows tracking after marking for redraw
        this.selectionManager.clearDirtySelectionRows();
      }
    }

    // Cache highlight spans for this pass and mark their rows for redraw,
    // including rows a cleared or moved layer used to cover.
    this.currentHighlightSpans = this.highlightSpans(scrollbackLength, historyRows, dims.rows, dims.cols);
    if (this.currentHighlightSpans) {
      for (const span of this.currentHighlightSpans) {
        for (let row = span.startRow; row <= span.endRow; row++) selectionRows.add(row);
      }
    }
    if (this.highlightSource) {
      for (const dirty of this.highlightSource.getDirtyAbsoluteRows()) {
        const row = dirty - scrollbackLength + historyRows;
        if (row >= 0 && row < dims.rows) selectionRows.add(row);
      }
      this.highlightSource.clearDirtyAbsoluteRows();
    }

    // Track rows with hyperlinks that need redraw when hover changes
    const hyperlinkRows = new Set<number>();
    const hyperlinkChanged = this.hoveredHyperlinkId !== this.previousHoveredHyperlinkId;
    const linkRangeChanged =
      JSON.stringify(this.hoveredLinkRange) !== JSON.stringify(this.previousHoveredLinkRange);

    if (hyperlinkChanged) {
      // Find rows containing the old or new hovered hyperlink
      // Must check the correct buffer based on viewportY (scrollback vs screen)
      for (let y = 0; y < dims.rows; y++) {
        if (this.readViewRow(term, y, historyRows, scrollbackLength)) {
          for (let x = 0; x < this.cells.length; x++) {
            const link = this.cells.at(x)!.hyperlink;
            if (link === this.hoveredHyperlinkId || link === this.previousHoveredHyperlinkId) {
              hyperlinkRows.add(y);
              break; // Found hyperlink in this row
            }
          }
        }
      }
      // Update previous state
      this.previousHoveredHyperlinkId = this.hoveredHyperlinkId;
    }

    // Track rows affected by link range changes (for regex URLs)
    if (linkRangeChanged) {
      // Add rows from old range
      if (this.previousHoveredLinkRange) {
        for (
          let y = this.previousHoveredLinkRange.startY;
          y <= this.previousHoveredLinkRange.endY;
          y++
        ) {
          hyperlinkRows.add(y);
        }
      }
      // Add rows from new range
      if (this.hoveredLinkRange) {
        for (let y = this.hoveredLinkRange.startY; y <= this.hoveredLinkRange.endY; y++) {
          hyperlinkRows.add(y);
        }
      }
      this.previousHoveredLinkRange = this.hoveredLinkRange;
    }

    // Determine which rows need rendering.
    // We also include adjacent rows (above and below) for each dirty row to handle
    // glyph overflow - tall glyphs like Devanagari vowel signs can extend into
    // adjacent rows' visual space.
    const rowsToRender = new Set<number>();
    for (let y = 0; y < dims.rows; y++) {
      // When scrolled, always force render all lines since we're showing scrollback
      const needsRender =
        historyRows > 0
          ? true
          : forceAll || term.isRowDirty(y) || selectionRows.has(y) || hyperlinkRows.has(y);

      if (needsRender) {
        rowsToRender.add(y);
        // Include adjacent rows to handle glyph overflow
        if (y > 0) rowsToRender.add(y - 1);
        if (y < dims.rows - 1) rowsToRender.add(y + 1);
      }
    }

    // Render each line
    for (let y = 0; y < dims.rows; y++) {
      if (!rowsToRender.has(y)) {
        continue;
      }

      if (this.readViewRow(term, y, historyRows, scrollbackLength)) {
        this.renderLine(this.cells, y, dims.cols);
      }
    }

    // Selection highlighting is now integrated into renderCellBackground/renderCellText
    // No separate overlay pass needed - this fixes z-order issues with complex glyphs

    // Link underlines are drawn during cell rendering (see renderCell)

    // Render cursor (only if the view shows no history row)
    if (historyRows === 0 && cursor.visible && this.cursorVisible) {
      this.renderCursor(cursor.x, cursor.y);
    }

    // Render scrollbar if scrolled or scrollback exists (with opacity for fade effect)
    if (scrollbarOpacity > 0) {
      this.renderScrollbar(viewportY, scrollbackLength, dims.rows, scrollbarOpacity);
    }
    this.paintedOverlay = overlay && scrollbarOpacity > 0 && scrollbackLength > 0;

    // Paint layers run after the cells, the cursor and the scrollbar, in
    // ascending order, over the rows this frame repainted.
    if (this.paintLayers.length > 0) {
      const painted = new Set<number>(rowsToRender);
      for (const row of cursorPainted) painted.add(row);
      const changedRows = [...painted].sort((a, b) => a - b);
      const frame: PaintFrame = {
        ctx: this.ctx,
        metrics: this.getMetrics(),
        pixelRatio: this.devicePixelRatio,
        viewportOffset: viewportY,
        full: forceAll,
        changedRows,
        rows: dims.rows,
        cols: dims.cols,
      };
      for (const layer of [...this.paintLayers]) layer.paint(frame);
    }

    // Update last cursor position and visibility
    this.lastCursorPosition = { x: cursor.x, y: cursor.y };
    this.lastCursorShown = cursor.visible;

    // ALWAYS end the frame after rendering, regardless of forceAll: what
    // changed is painted now, and the next frame lists only newer changes.
    term.endFrame();
  }

  /**
   * Read the row painted at view row `y` into this.cells: with the view
   * scrolled back `historyRows` whole rows, the last `historyRows` rows of
   * the history above the screen's first rows. False when the row has
   * nothing to read.
   */
  private readViewRow(term: VtTerminal, y: number, historyRows: number, scrollbackLength: number): boolean {
    if (y < historyRows) {
      return term.readHistoryRow(scrollbackLength - historyRows + y, this.cells);
    }
    return term.readRow(y - historyRows, this.cells);
  }

  /**
   * Render a single line using two-pass approach:
   * 1. First pass: Draw all cell backgrounds
   * 2. Second pass: Draw all cell text and decorations
   *
   * This two-pass approach is necessary for proper rendering of complex scripts
   * like Devanagari where diacritics (like vowel sign ि) can extend LEFT of the
   * base character into the previous cell's visual area. If we draw backgrounds
   * and text in a single pass (cell by cell), the background of cell N would
   * cover any left-extending portions of graphemes from cell N-1.
   *
   * Each cell carries its own cluster, read from the row `cells` holds.
   */
  private renderLine(cells: VtCells, y: number, cols: number): void {
    const lineY = y * this.metrics.height;
    const lineWidth = cols * this.metrics.width;

    // Clear line background then fill with theme color.
    // We clear just the cell area - glyph overflow is handled by also
    // redrawing adjacent rows (see render() method).
    // clearRect is needed because fillRect composites rather than replaces,
    // so transparent/translucent backgrounds wouldn't clear previous content.
    this.ctx.clearRect(0, lineY, lineWidth, this.metrics.height);
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, lineY, lineWidth, this.metrics.height);

    // PASS 1: Draw all cell backgrounds first
    // This ensures all backgrounds are painted before any text, allowing text
    // to "bleed" across cell boundaries without being covered by adjacent backgrounds
    for (let x = 0; x < cells.length; x++) {
      const cell = cells.at(x)!;
      if (cell.width === 0) continue; // Skip spacer cells for wide characters
      this.renderCellBackground(cell, x, y);
    }

    // PASS 2: Draw all cell text and decorations
    // Now text can safely extend beyond cell boundaries (for complex scripts)
    for (let x = 0; x < cells.length; x++) {
      const cell = cells.at(x)!;
      if (cell.width === 0) continue; // Skip spacer cells for wide characters
      this.renderCellText(cell, x, y);
    }
  }

  /**
   * Render a cell's background only (Pass 1 of two-pass rendering)
   * Selection highlighting is integrated here to avoid z-order issues with
   * complex glyphs (like Devanagari) that extend outside their cell bounds.
   */
  private renderCellBackground(cell: VtCell, x: number, y: number): void {
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;

    // Check if this cell is selected
    const isSelected = this.isInSelection(x, y);

    if (isSelected) {
      // Draw selection background (solid color, not overlay)
      this.ctx.fillStyle = this.theme.selectionBackground;
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
      return; // Selection background replaces cell background
    }

    // A highlight paints over the cell's background. The selection above
    // wins, so existing selections paint exactly as before.
    const highlight = this.highlightAt(x, y);
    if (highlight) {
      this.ctx.fillStyle = highlight.background ?? this.theme.selectionBackground;
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
      return;
    }

    // A default background paints nothing over the row's theme fill, which
    // a see-through theme leaves clear. Its colour cannot say it is the
    // default: a see-through theme's resolves to black in the core, as a
    // pure black a program set does. Inverse video paints the foreground,
    // default or not.
    const inverse = (cell.flags & VtFlag.INVERSE) !== 0;
    if (!inverse && cell.defaultBg) return;
    this.ctx.fillStyle = this.rgbToCSS(inverse ? cell.fg : cell.bg);
    this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
  }

  /**
   * Render a cell's text and decorations (Pass 2 of two-pass rendering)
   * A selected cell keeps its own color unless the theme names a selection
   * foreground.
   */
  private renderCellText(cell: VtCell, x: number, y: number, colorOverride?: string): void {
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;

    // Skip rendering if invisible
    if (cell.flags & VtFlag.INVISIBLE) {
      return;
    }

    // Check if this cell is selected
    const isSelected = this.isInSelection(x, y);
    const highlight = isSelected ? null : this.highlightAt(x, y);

    // Set text style
    let fontStyle = '';
    if (cell.flags & VtFlag.ITALIC) fontStyle += 'italic ';
    if (cell.flags & VtFlag.BOLD) fontStyle += 'bold ';
    this.ctx.font = `${fontStyle}${this.fontSize}px ${this.fontFamily}`;

    // Set text color - use override, selection foreground, highlight
    // foreground, or normal color, in that order.
    if (colorOverride) {
      this.ctx.fillStyle = colorOverride;
    } else if (isSelected && this.theme.selectionForeground) {
      this.ctx.fillStyle = this.theme.selectionForeground;
    } else if (highlight?.foreground) {
      this.ctx.fillStyle = highlight.foreground;
    } else {
      // Extract colors and handle inverse: when inverted, foreground
      // becomes background
      this.ctx.fillStyle = this.rgbToCSS(cell.flags & VtFlag.INVERSE ? cell.bg : cell.fg);
    }

    // Apply faint effect
    if (cell.flags & VtFlag.FAINT) {
      this.ctx.globalAlpha = 0.5;
    }

    // Draw text
    const textX = cellX;
    const textY = cellY + this.metrics.baseline;

    // The character to render: the cell's whole cluster for complex
    // scripts, else its codepoint, a space if it has none. With box
    // glyphs a box-drawing or block element draws as cell paths instead
    // of the font, so runs of them tile without seams.
    const char = cell.cluster ?? String.fromCodePoint(cell.codepoint || 32);
    const boxed =
      this.boxGlyphs &&
      cell.cluster === null &&
      drawBoxGlyph(
        this.ctx,
        this.metrics,
        cell.codepoint,
        x,
        y,
        (cell.flags & VtFlag.FAINT) !== 0,
        this.devicePixelRatio > 0 ? this.devicePixelRatio : window.devicePixelRatio || 1,
      );
    // The paths carry the cell's fill style already; decorations below
    // draw either way.
    if (!boxed) this.ctx.fillText(char, textX, textY);

    // Reset alpha
    if (cell.flags & VtFlag.FAINT) {
      this.ctx.globalAlpha = 1.0;
    }

    // Draw the underline in its style: in the colour SGR 58 gave it, which
    // neither a selection nor the cursor changes, or else in the glyph's
    if (cell.underline !== ABI.GhosttySgrUnderline.NONE) {
      this.ctx.strokeStyle =
        cell.underlineColor === null ? this.ctx.fillStyle : this.rgbToCSS(cell.underlineColor);
      this.renderUnderline(cell.underline, cellX, cellY, cell.width);
    }

    // Draw overline along the top pixel row of the cell
    if (cell.flags & VtFlag.OVERLINE) {
      const overlineY = cellY + 0.5;
      this.ctx.strokeStyle = this.ctx.fillStyle;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(cellX, overlineY);
      this.ctx.lineTo(cellX + cellWidth, overlineY);
      this.ctx.stroke();
    }

    // Draw strikethrough
    if (cell.flags & VtFlag.STRIKETHROUGH) {
      const strikeY = cellY + this.metrics.height / 2;
      this.ctx.strokeStyle = this.ctx.fillStyle;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(cellX, strikeY);
      this.ctx.lineTo(cellX + cellWidth, strikeY);
      this.ctx.stroke();
    }

    // Draw hyperlink underline (for OSC8 hyperlinks)
    if (cell.hyperlink > 0) {
      const isHovered = cell.hyperlink === this.hoveredHyperlinkId;

      // Only show underline when hovered (cleaner look)
      if (isHovered) {
        const underlineY = cellY + this.metrics.baseline + 2;
        this.ctx.strokeStyle = '#4A90E2'; // Blue underline on hover
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(cellX, underlineY);
        this.ctx.lineTo(cellX + cellWidth, underlineY);
        this.ctx.stroke();
      }
    }

    // Draw regex link underline (for plain text URLs)
    if (this.hoveredLinkRange) {
      const range = this.hoveredLinkRange;
      // Check if this cell is within the hovered link range
      const isInRange =
        (y === range.startY && x >= range.startX && (y < range.endY || x <= range.endX)) ||
        (y > range.startY && y < range.endY) ||
        (y === range.endY && x <= range.endX && (y > range.startY || x >= range.startX));

      if (isInRange) {
        const underlineY = cellY + this.metrics.baseline + 2;
        this.ctx.strokeStyle = '#4A90E2'; // Blue underline on hover
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(cellX, underlineY);
        this.ctx.lineTo(cellX + cellWidth, underlineY);
        this.ctx.stroke();
      }
    }
  }

  /**
   * Stroke an underline of `style` (a `GhosttySgrUnderline`) under the cell
   * at (cellX, cellY) that takes `columns` columns, in the current stroke
   * style. A single underline is one line two pixels below the baseline, and
   * dotted and dashed ones lie on the same line. A double underline is two
   * lines on whole pixel rows with a row between them, the first on the
   * single underline's row, since lines that straddle rows run together into
   * one band; a curly one waves between the two rows. Both rise together
   * when the lower row would leave the cell. Each column holds one period of
   * the wave or one dash, so the underlines of adjacent cells run on as one.
   */
  private renderUnderline(style: number, cellX: number, cellY: number, columns: number): void {
    const U = ABI.GhosttySgrUnderline;
    const ctx = this.ctx;
    const { width, height, baseline } = this.metrics;
    const right = cellX + width * columns;
    const y = cellY + baseline + 2;
    // The middle of the double underline's upper row.
    const top = Math.min(Math.floor(y), Math.floor(cellY + height) - 3) + 0.5;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.beginPath();
    switch (style) {
      case U.DOUBLE:
        ctx.moveTo(cellX, top);
        ctx.lineTo(right, top);
        ctx.moveTo(cellX, top + 2);
        ctx.lineTo(right, top + 2);
        break;
      case U.CURLY:
        // A stroke's end reaches past the column where the wave meets the
        // next one at a slant; the clip keeps it off a neighbour that has no
        // wave.
        ctx.rect(cellX, cellY, right - cellX, height);
        ctx.clip();
        ctx.beginPath();
        for (let i = 0; i < columns; i++) {
          const x = cellX + i * width;
          ctx.moveTo(x, top + 1);
          ctx.quadraticCurveTo(x + width / 4, top + 3, x + width / 2, top + 1);
          ctx.quadraticCurveTo(x + (width * 3) / 4, top - 1, x + width, top + 1);
        }
        break;
      case U.DOTTED:
        // The dash pattern starts at the line's start; offset by the cell's
        // own x, its dots fall on the even pixels of the row whatever column
        // the cell starts at, as one dotted line across adjacent cells.
        ctx.setLineDash([1, 1]);
        ctx.lineDashOffset = cellX;
        ctx.moveTo(cellX, y);
        ctx.lineTo(right, y);
        break;
      case U.DASHED: {
        const gap = Math.max(1, Math.round(width / 4));
        for (let i = 0; i < columns; i++) {
          const x = cellX + i * width;
          ctx.moveTo(x + gap / 2, y);
          ctx.lineTo(x + width - gap / 2, y);
        }
        break;
      }
      default:
        ctx.moveTo(cellX, y);
        ctx.lineTo(right, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Render cursor
   */
  private renderCursor(x: number, y: number): void {
    const cursorX = x * this.metrics.width;
    const cursorY = y * this.metrics.height;

    this.ctx.fillStyle = this.theme.cursor;

    switch (this.cursorStyle) {
      case 'block':
        // Full cell block
        this.ctx.fillRect(cursorX, cursorY, this.metrics.width, this.metrics.height);
        // Re-draw character under cursor with cursorAccent color
        {
          const cell = this.currentTerm?.readRow(y, this.cells) ? this.cells.at(x) : undefined;
          if (cell) {
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(cursorX, cursorY, this.metrics.width, this.metrics.height);
            this.ctx.clip();
            this.renderCellText(cell, x, y, this.theme.cursorAccent);
            this.ctx.restore();
          }
        }
        break;

      case 'underline':
        // Underline at bottom of cell
        const underlineHeight = Math.max(2, Math.floor(this.metrics.height * 0.15));
        this.ctx.fillRect(
          cursorX,
          cursorY + this.metrics.height - underlineHeight,
          this.metrics.width,
          underlineHeight
        );
        break;

      case 'bar':
        // Vertical bar at left of cell
        const barWidth = Math.max(2, Math.floor(this.metrics.width * 0.15));
        this.ctx.fillRect(cursorX, cursorY, barWidth, this.metrics.height);
        break;
    }
  }

  // ==========================================================================
  // Cursor Blinking
  // ==========================================================================

  private startCursorBlink(): void {
    // xterm.js uses ~530ms blink interval
    this.cursorBlinkInterval = window.setInterval(() => {
      this.cursorVisible = !this.cursorVisible;
      // Note: Render loop should redraw cursor line automatically
    }, 530);
  }

  private stopCursorBlink(): void {
    if (this.cursorBlinkInterval !== undefined) {
      clearInterval(this.cursorBlinkInterval);
      this.cursorBlinkInterval = undefined;
    }
    this.cursorVisible = true;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Update theme colors
   */
  public setTheme(theme: ITheme): void {
    this.theme = { ...DEFAULT_THEME, ...theme };
  }

  /**
   * Update font size
   */
  public setFontSize(size: number): void {
    this.fontSize = size;
    this.metrics = this.measureFont();
  }

  /**
   * Update font family
   */
  public setFontFamily(family: string): void {
    this.fontFamily = family;
    this.metrics = this.measureFont();
  }

  /**
   * Update cursor style
   */
  public setCursorStyle(style: 'block' | 'underline' | 'bar'): void {
    this.cursorStyle = style;
  }

  /**
   * Enable/disable cursor blinking
   */
  public setCursorBlink(enabled: boolean): void {
    if (enabled && !this.cursorBlink) {
      this.cursorBlink = true;
      this.startCursorBlink();
    } else if (!enabled && this.cursorBlink) {
      this.cursorBlink = false;
      this.stopCursorBlink();
    }
  }

  /**
   * Get current font metrics
   */

  /**
   * Render scrollbar (Phase 2)
   * Shows scroll position and allows click/drag interaction
   * @param opacity Opacity level (0-1) for fade in/out effect
   */
  private renderScrollbar(
    viewportY: number,
    scrollbackLength: number,
    visibleRows: number,
    opacity: number = 1
  ): void {
    if (this.scrollbar === 'overlay') {
      this.renderOverlayScrollbar(viewportY, scrollbackLength, visibleRows, opacity);
      return;
    }
    const ctx = this.ctx;
    const canvasHeight = this.canvas.height / this.devicePixelRatio;
    const canvasWidth = this.canvas.width / this.devicePixelRatio;

    // Scrollbar dimensions
    const scrollbarWidth = 8;
    const scrollbarX = canvasWidth - scrollbarWidth - 4;
    const scrollbarPadding = 4;
    const scrollbarTrackHeight = canvasHeight - scrollbarPadding * 2;

    // Always clear the scrollbar area first (fixes ghosting when fading out)
    ctx.clearRect(scrollbarX - 2, 0, scrollbarWidth + 6, canvasHeight);
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(scrollbarX - 2, 0, scrollbarWidth + 6, canvasHeight);

    // Don't draw scrollbar if fully transparent or no scrollback
    if (opacity <= 0 || scrollbackLength === 0) return;

    // Calculate scrollbar thumb size and position
    const totalLines = scrollbackLength + visibleRows;
    const thumbHeight = Math.max(20, (visibleRows / totalLines) * scrollbarTrackHeight);

    // Position: 0 = at bottom, scrollbackLength = at top
    const scrollPosition = viewportY / scrollbackLength; // 0 to 1
    const thumbY = scrollbarPadding + (scrollbarTrackHeight - thumbHeight) * (1 - scrollPosition);

    // Draw scrollbar track (subtle background) with opacity
    ctx.fillStyle = `rgba(128, 128, 128, ${0.1 * opacity})`;
    ctx.fillRect(scrollbarX, scrollbarPadding, scrollbarWidth, scrollbarTrackHeight);

    // Draw scrollbar thumb with opacity
    const isScrolled = viewportY > 0;
    const baseOpacity = isScrolled ? 0.5 : 0.3;
    ctx.fillStyle = `rgba(128, 128, 128, ${baseOpacity * opacity})`;
    ctx.fillRect(scrollbarX, thumbY, scrollbarWidth, thumbHeight);
  }

  /**
   * Render the overlay scrollbar: the same translucent track and thumb in
   * the same place, painted straight onto the content with no opaque
   * strip clear, so the columns under it stay readable.
   */
  private renderOverlayScrollbar(
    viewportY: number,
    scrollbackLength: number,
    visibleRows: number,
    opacity: number = 1,
  ): void {
    if (opacity <= 0 || scrollbackLength === 0) return;
    const ratio = this.devicePixelRatio > 0 ? this.devicePixelRatio : 1;
    const ctx = this.ctx;
    const barX = this.canvas.width / ratio - 8 - 4;
    const trackHeight = this.canvas.height / ratio - 4 * 2;
    const thumbHeight = Math.max(20, (visibleRows / (scrollbackLength + visibleRows)) * trackHeight);
    const thumbY = 4 + (trackHeight - thumbHeight) * (1 - viewportY / scrollbackLength);
    const thumbAlpha = viewportY > 0 ? 0.5 : 0.3;

    ctx.save();
    ctx.fillStyle = `rgba(128, 128, 128, ${0.1 * opacity})`;
    ctx.fillRect(barX, 4, 8, trackHeight);
    ctx.fillStyle = `rgba(128, 128, 128, ${thumbAlpha * opacity})`;
    ctx.fillRect(barX, thumbY, 8, thumbHeight);
    ctx.restore();
  }
  public getMetrics(): FontMetrics {
    return { ...this.metrics };
  }

  /**
   * Add a paint layer over the frame, run after the cells, the cursor and
   * the scrollbar in ascending order. Returns a disposer that removes it.
   */
  public addPaintLayer(layer: PaintLayer): () => void {
    this.paintLayers.push(layer);
    this.paintLayers.sort((a, b) => a.order - b.order);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      this.paintLayers = this.paintLayers.filter((l) => l !== layer);
    };
  }

  /**
   * Get canvas element (needed by SelectionManager)
   */
  public getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * Set selection manager (for rendering selection)
   */
  public setSelectionManager(manager: SelectionManager): void {
    this.selectionManager = manager;
  }

  /**
   * Set highlights source (for rendering highlight layers)
   */
  public setHighlights(source: HighlightsManager | undefined): void {
    this.highlightSource = source;
  }

  /**
   * The highlight layers' ranges as viewport spans for this pass, first
   * set layer wins on overlap, like one selection per layer.
   */
  private highlightSpans(
    scrollbackLength: number,
    historyRows: number,
    rows: number,
    cols: number
  ): {
    startRow: number;
    endRow: number;
    startCol: number;
    endCol: number;
    style: HighlightStyle;
  }[] | null {
    if (!this.highlightSource) return null;
    const spans: {
      startRow: number;
      endRow: number;
      startCol: number;
      endCol: number;
      style: HighlightStyle;
    }[] = [];
    for (const layer of this.highlightSource.entries()) {
      for (const range of layer.ranges) {
        const startRow = range.start.absoluteRow - scrollbackLength + historyRows;
        const endRow = range.end.absoluteRow - scrollbackLength + historyRows;
        if (endRow < 0 || startRow >= rows) continue;
        spans.push({
          startRow: Math.max(0, startRow),
          endRow: Math.min(rows - 1, endRow),
          startCol: Math.max(0, Math.min(range.start.col, cols - 1)),
          endCol: Math.max(0, Math.min(range.end.col, cols - 1)),
          style: layer.style,
        });
      }
    }
    return spans.length ? spans : null;
  }

  /**
   * The first highlight span covering a cell, or null. The selection
   * paints over highlights: callers check it first.
   */
  private highlightAt(x: number, y: number): HighlightStyle | null {
    const spans = this.currentHighlightSpans;
    if (!spans) return null;
    for (const span of spans) {
      const { startCol, startRow, endCol, endRow } = span;
      const inside =
        startRow === endRow
          ? y === startRow && x >= startCol && x <= endCol
          : y === startRow
            ? x >= startCol
            : y === endRow
              ? x <= endCol
              : y > startRow && y < endRow;
      if (inside) return span.style;
    }
    return null;
  }

  /**
   * Check if a cell at (x, y) is within the current selection.
   * Uses cached selection coordinates for performance.
   */
  private isInSelection(x: number, y: number): boolean {
    const sel = this.currentSelectionCoords;
    if (!sel) return false;

    const { startCol, startRow, endCol, endRow } = sel;

    // Single line selection
    if (startRow === endRow) {
      return y === startRow && x >= startCol && x <= endCol;
    }

    // Multi-line selection
    if (y === startRow) {
      // First line: from startCol to end of line
      return x >= startCol;
    } else if (y === endRow) {
      // Last line: from start of line to endCol
      return x <= endCol;
    } else if (y > startRow && y < endRow) {
      // Middle lines: entire line is selected
      return true;
    }

    return false;
  }

  /**
   * Set the currently hovered hyperlink ID for rendering underlines
   */
  public setHoveredHyperlinkId(hyperlinkId: number): void {
    this.hoveredHyperlinkId = hyperlinkId;
  }

  /**
   * Set the currently hovered link range for rendering underlines (for regex-detected URLs)
   * Pass null to clear the hover state
   */
  public setHoveredLinkRange(
    range: {
      startX: number;
      startY: number;
      endX: number;
      endY: number;
    } | null
  ): void {
    this.hoveredLinkRange = range;
  }

  /**
   * Get character cell width (for coordinate conversion)
   */
  public get charWidth(): number {
    return this.metrics.width;
  }

  /**
   * Get character cell height (for coordinate conversion)
   */
  public get charHeight(): number {
    return this.metrics.height;
  }

  /**
   * Clear entire canvas
   */
  public clear(): void {
    // clearRect first because fillRect composites rather than replaces,
    // so transparent/translucent backgrounds wouldn't clear previous content.
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Cleanup resources
   */
  public dispose(): void {
    this.paintLayers = [];
    this.stopCursorBlink();
  }
}
