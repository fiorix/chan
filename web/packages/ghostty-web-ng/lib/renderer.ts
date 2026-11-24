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
import { drawBoxGlyph, isCustomGlyph } from './box-glyphs';
import { compositeColor, contrastingColor, parseColor, rgbColor, type Color } from './color';
import type { ITheme } from './interfaces';
import type { SelectionManager } from './selection-manager';
import type { HighlightsManager, HighlightSpan, HighlightStyle } from './highlights';

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
  lineHeight?: number; // Default: 1
  boxGlyphs?: boolean; // Default: false
  scrollbar?: 'overlay'; // Composite the translucent bar over content
}

/** A snapshot of the rows repainted beneath a layer, in CSS pixels. */
export interface PaintFrame {
  readonly ctx: CanvasRenderingContext2D;
  readonly metrics: Readonly<FontMetrics>;
  readonly pixelRatio: number;
  readonly viewportOffset: number;
  readonly topRow: number;
  readonly full: boolean;
  readonly changedRows: readonly number[];
  readonly rows: number;
  readonly cols: number;
}

/** Numeric layers paint in stable ascending order; the sole mask paints last. */
export interface PaintLayer {
  readonly order: number | 'mask';
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
type RendererTheme = Required<Omit<ITheme, 'selectionForeground' | 'contrastBackdrop'>> &
  Pick<ITheme, 'selectionForeground' | 'contrastBackdrop'>;

export const DEFAULT_THEME: RendererTheme = {
  minimumContrastRatio: 1,
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
  private readonly contrastCache = new Map<string, string>();
  private readonly backgroundCache = new Map<string, Color | undefined>();
  private devicePixelRatio: number;
  private readonly followsDevicePixelRatio: boolean;
  private readonly lineHeight: number;
  private readonly boxGlyphs: boolean;
  private readonly scrollbar?: 'overlay';
  private metrics: FontMetrics;
  private resizeRequired = false;

  private paintLayers: PaintLayer[] = [];
  private repaintAll = false;
  private rendering = false;
  private paintedScrollbar = false;

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

  private highlightSource?: HighlightsManager;
  private currentHighlightRows: HighlightSpan[][] = [];

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
    this.theme = this.resolveTheme(options.theme ?? {});
    this.devicePixelRatio = options.devicePixelRatio ?? window.devicePixelRatio ?? 1;
    this.followsDevicePixelRatio = options.devicePixelRatio === undefined;
    const lineHeight = options.lineHeight ?? 1;
    this.lineHeight = Number.isFinite(lineHeight) && lineHeight >= 1 ? lineHeight : 1;
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
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = `${this.fontSize}px ${this.fontFamily}`;
    const ink = ctx.measureText('M');
    const ascent = ink.actualBoundingBoxAscent || this.fontSize * 0.8;
    const descent = ink.actualBoundingBoxDescent || this.fontSize * 0.2;
    const natural = {
      width: Math.ceil(ink.width),
      height: Math.ceil(ascent + descent) + 2,
      baseline: Math.ceil(ascent) + 1,
    };
    const fallbackHeight = natural.height * this.lineHeight;
    const fallback = {
      width: natural.width,
      height: fallbackHeight,
      baseline: Math.max(0, Math.min(fallbackHeight, natural.baseline + (fallbackHeight - natural.height) / 2)),
    };
    const measured = this.measureCell();
    const ratio = this.devicePixelRatio;
    if (!measured || !Number.isFinite(ratio) || ratio <= 0 ||
        !Number.isFinite(measured.width) || measured.width <= 0 ||
        !Number.isFinite(measured.height) || measured.height <= 0) return fallback;
    const width = Math.floor(measured.width * ratio) / ratio;
    const height = Math.floor(Math.ceil(measured.height * ratio) * this.lineHeight) / ratio;
    if (width <= 0 || height <= 0) return fallback;
    return {
      width,
      height,
      baseline: Math.max(0, Math.min(height, natural.baseline + (height - natural.height) / 2)),
    };
  }

  private syncDevicePixelRatio(): void {
    if (!this.followsDevicePixelRatio) return;
    const ratio = window.devicePixelRatio;
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio === this.devicePixelRatio) return;
    this.devicePixelRatio = ratio;
    this.metrics = this.measureFont();
    this.resizeRequired = true;
    this.repaintAll = true;
  }

  private measureCell(): { width: number; height: number } | null {
    try {
      if (typeof OffscreenCanvas !== 'undefined') {
        const ctx = new OffscreenCanvas(100, 100).getContext('2d');
        const probe = ctx?.measureText('W');
        if (ctx && probe && 'fontBoundingBoxAscent' in probe && 'fontBoundingBoxDescent' in probe) {
          ctx.font = `${this.fontSize}px ${this.fontFamily}`;
          const measured = ctx.measureText('W');
          return { width: measured.width, height: measured.fontBoundingBoxAscent + measured.fontBoundingBoxDescent };
        }
      }
    } catch {
      // Engines without offscreen text metrics use the same DOM measurement.
    }
    const parent = this.canvas.parentElement;
    if (!parent) return null;
    const span = document.createElement('span');
    span.textContent = 'W'.repeat(32);
    span.setAttribute('aria-hidden', 'true');
    Object.assign(span.style, {
      display: 'inline-block', visibility: 'hidden', position: 'absolute',
      top: '0', left: '-9999em', lineHeight: 'normal', whiteSpace: 'pre',
      fontKerning: 'none', fontFamily: this.fontFamily, fontSize: `${this.fontSize}px`,
    });
    parent.appendChild(span);
    try {
      return { width: span.offsetWidth / 32, height: span.offsetHeight };
    } finally {
      span.remove();
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
    this.syncDevicePixelRatio();
    const cssWidth = cols * this.metrics.width;
    const cssHeight = rows * this.metrics.height;

    // Set CSS size (what user sees)
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;

    // The backing store and resize comparison use identical integer sizes.
    // Fractional device products otherwise reset the canvas on every frame.
    this.canvas.width = Math.round(cssWidth * this.devicePixelRatio);
    this.canvas.height = Math.round(cssHeight * this.devicePixelRatio);
    this.resizeRequired = false;

    // Scale context to match DPI: the size assignment above reset the
    // context, so this puts the device scale back for the rest of the frame.
    this.ctx.setTransform(this.devicePixelRatio, 0, 0, this.devicePixelRatio, 0, 0);

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
    if (this.rendering) {
      this.repaintAll = true;
      return;
    }
    this.syncDevicePixelRatio();
    this.rendering = true;
    const layers = [...this.paintLayers];
    forceAll ||= this.repaintAll;
    this.repaintAll = false;
    let begun = false;
    let layerErrors: unknown[] = [];
    try {
      const dirty = term.beginFrame();
      begun = true;
      layerErrors = this.paintFrame(term, forceAll || dirty === ABI.GhosttyRenderStateDirty.FULL,
        viewportY, scrollbarOpacity, layers);
    } catch (error) {
      // The rows may be half painted: the next frame paints them all.
      this.repaintAll = true;
      throw error;
    } finally {
      try {
        if (begun) term.endFrame();
      } finally {
        this.rendering = false;
        this.currentTerm = null;
      }
    }
    // A layer's failure invalidates nothing. Its rows and the other layers
    // are painted, and a forced repaint would call a layer that keeps
    // failing again on every frame.
    if (layerErrors.length > 0) throw layerErrors[0];
  }

  /** Paints the frame and returns what its layers threw, in paint order. */
  private paintFrame(
    term: VtTerminal,
    forceAll: boolean,
    viewportY: number,
    scrollbarOpacity: number,
    layers: readonly PaintLayer[],
  ): unknown[] {
    // The canvas scale is absolute, not relative: a host that resets the
    // drawing state at an unchanged size leaves an identity transform
    // behind, and the next repaint must heal it without waiting for a
    // resize. Every row, glyph and cursor below draws in CSS units.
    this.ctx.setTransform(this.devicePixelRatio, 0, 0, this.devicePixelRatio, 0, 0);
    this.currentTerm = term;

    const cursor = term.getCursor();
    const dims = term.getDimensions();
    const scrollbackLength = term.getScrollbackLength();
    // The history rows the view shows above the screen. A fractional offset
    // (chan's pixel scroll) shows the rows of its floor, and one below 0 the
    // bottom view, as the hover, the selection and the masker map them; only
    // the scrollbar reads the fraction.
    const historyRows = Math.max(0, Math.floor(viewportY));

    // The scrollbar touches every row. Fresh content under it also removes
    // the previous strip when it disappears and prevents alpha accumulation.
    const scrollbar = scrollbarOpacity > 0 && scrollbackLength > 0;
    if (scrollbar || this.paintedScrollbar) forceAll = true;

    // Resize canvas if dimensions changed
    const needsResize =
      this.resizeRequired ||
      this.canvas.width !== Math.round(dims.cols * this.metrics.width * this.devicePixelRatio) ||
      this.canvas.height !== Math.round(dims.rows * this.metrics.height * this.devicePixelRatio);

    if (needsResize) {
      this.resize(dims.cols, dims.rows);
      forceAll = true; // Force full render after resize
    }

    // Force re-render when viewport changes (scrolling)
    if (viewportY !== this.lastViewportY) {
      forceAll = true;
      this.lastViewportY = viewportY;
    }

    // Cache overlays before any cursor-only redraw can paint a row.
    this.currentSelectionCoords = this.selectionManager?.hasSelection()
      ? this.selectionManager.getSelectionCoords() : null;
    const highlights = this.highlightSource?.frame(scrollbackLength - historyRows, dims.rows, dims.cols);
    this.cacheHighlights(highlights?.spans ?? []);

    const cursorRows = new Set<number>();
    const cursorShown = cursor.visible && this.cursorVisible;
    const cursorMoved = cursor.x !== this.lastCursorPosition.x || cursor.y !== this.lastCursorPosition.y;
    if (historyRows === 0 && (cursorMoved || cursorShown !== this.lastCursorShown)) {
      cursorRows.add(cursor.y);
      cursorRows.add(this.lastCursorPosition.y);
    }

    // Check if we need to redraw selection-related lines
    const selectionRows = highlights?.dirtyRows ?? new Set<number>();

    // Mark current selection rows for redraw (includes programmatic selections)
    if (this.currentSelectionCoords) {
      const coords = this.currentSelectionCoords;
      for (let row = Math.max(0, coords.startRow); row <= Math.min(dims.rows - 1, coords.endRow); row++) {
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
          : forceAll || term.isRowDirty(y) || cursorRows.has(y) || selectionRows.has(y) || hyperlinkRows.has(y);

      if (needsRender) {
        rowsToRender.add(y);
        // Include adjacent rows to handle glyph overflow
        if (y > 0) rowsToRender.add(y - 1);
        if (y < dims.rows - 1) rowsToRender.add(y + 1);
      }
    }

    const changedRows: number[] = [];
    // Render each line
    for (let y = 0; y < dims.rows; y++) {
      if (!rowsToRender.has(y)) {
        continue;
      }

      if (this.readViewRow(term, y, historyRows, scrollbackLength)) {
        this.renderLine(this.cells, y, dims.cols);
        changedRows.push(y);
      }
    }

    // Selection highlighting is now integrated into renderCellBackground/renderCellText
    // No separate overlay pass needed - this fixes z-order issues with complex glyphs

    // Link underlines are drawn during cell rendering (see renderCell)

    // Render cursor (only if the view shows no history row)
    if (historyRows === 0 && cursorShown && rowsToRender.has(cursor.y)) {
      this.renderCursor(cursor.x, cursor.y);
    }

    // Render scrollbar if scrolled or scrollback exists (with opacity for fade effect)
    if (scrollbar) this.renderScrollbar(viewportY, scrollbackLength, dims.rows, scrollbarOpacity);
    this.paintedScrollbar = scrollbar;
    this.lastCursorPosition = { x: cursor.x, y: cursor.y };
    this.lastCursorShown = cursorShown;

    if (changedRows.length === 0) return [];
    const frame: PaintFrame = Object.freeze({
      ctx: this.ctx,
      metrics: Object.freeze(this.getMetrics()),
      pixelRatio: this.devicePixelRatio,
      viewportOffset: viewportY,
      topRow: scrollbackLength - historyRows,
      full: changedRows.length === dims.rows,
      changedRows: Object.freeze(changedRows),
      rows: dims.rows,
      cols: dims.cols,
    });
    const errors: unknown[] = [];
    for (const layer of layers) {
      this.ctx.save();
      try {
        // Layers only composite onto fresh pixels, even if they draw a full
        // canvas. A failing ordinary layer must not skip the final mask.
        this.ctx.beginPath();
        for (const row of changedRows) {
          this.ctx.rect(0, row * this.metrics.height, dims.cols * this.metrics.width, this.metrics.height);
        }
        this.ctx.clip();
        this.ctx.beginPath();
        layer.paint(frame);
      } catch (error) {
        errors.push(error);
      } finally {
        this.ctx.restore();
        this.ctx.beginPath();
      }
    }
    return errors;
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

    const highlight = this.highlightAt(x, y, cell.width);
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
    const highlight = isSelected ? null : this.highlightAt(x, y, cell.width);

    // Set text style
    let fontStyle = '';
    if (cell.flags & VtFlag.ITALIC) fontStyle += 'italic ';
    if (cell.flags & VtFlag.BOLD) fontStyle += 'bold ';
    this.ctx.font = `${fontStyle}${this.fontSize}px ${this.fontFamily}`;

    // Set text color - use override, selection foreground, or normal color
    if (colorOverride) {
      this.ctx.fillStyle = colorOverride;
    } else if (isSelected && this.theme.selectionForeground) {
      this.ctx.fillStyle = this.theme.selectionForeground;
    } else if (highlight?.foreground) {
      this.ctx.fillStyle = highlight.foreground;
    } else {
      // Extract colors and handle inverse: when inverted, foreground
      // becomes background
      const inverse = (cell.flags & VtFlag.INVERSE) !== 0;
      const foreground = inverse ? cell.bg : cell.fg;
      let background: Color | undefined;
      if (this.theme.minimumContrastRatio > 1) {
        const rowBackground = this.contrastRowBackground();
        if (isSelected || highlight) {
          const overlay = this.backgroundColor(isSelected ? this.theme.selectionBackground
            : highlight!.background ?? this.theme.selectionBackground);
          if (overlay) background = compositeColor(overlay, rowBackground);
        } else {
          background = inverse ? rgbColor(cell.fg) : cell.defaultBg ? rowBackground : rgbColor(cell.bg);
        }
      }
      this.ctx.fillStyle = this.cellForeground(foreground, background);
    }

    // Apply faint effect
    if (cell.flags & VtFlag.FAINT) {
      this.ctx.globalAlpha = 0.5;
    }

    // Draw text
    const textX = cellX;
    const textY = cellY + this.metrics.baseline;

    // Complex clusters stay with the font. Cell paths share the resolved
    // foreground and decorations, including selection and cursor overrides.
    const char = cell.cluster ?? String.fromCodePoint(cell.codepoint || 32);
    const boxed = this.boxGlyphs && cell.cluster === null && isCustomGlyph(cell.codepoint);
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

    // Cell paths sit above decorations where their ink intersects.
    if (boxed) {
      drawBoxGlyph(this.ctx, this.metrics, cell.codepoint, x, y,
        (cell.flags & VtFlag.FAINT) !== 0, this.devicePixelRatio);
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
    this.theme = this.resolveTheme(theme);
    this.contrastCache.clear();
    this.backgroundCache.clear();
    this.repaintAll = true;
  }

  private resolveTheme(theme: ITheme): RendererTheme {
    const supplied = Object.fromEntries(Object.entries(theme).filter(([, value]) => value !== undefined));
    const ratio = theme.minimumContrastRatio ?? 1;
    return { ...DEFAULT_THEME, ...supplied,
      minimumContrastRatio: Number.isFinite(ratio) && ratio >= 1 ? ratio : 1 };
  }

  private backgroundColor(css: string): Color | undefined {
    if (!this.backgroundCache.has(css)) {
      if (this.backgroundCache.size >= 256) this.backgroundCache.clear();
      this.backgroundCache.set(css, parseColor(css));
    }
    return this.backgroundCache.get(css);
  }

  /**
   * The row fill as the contrast floor measures it: over the theme's known
   * backdrop when the fill itself is not opaque.
   */
  private contrastRowBackground(): Color | undefined {
    const fill = this.backgroundColor(this.theme.background);
    if (!fill || fill[3] >= 1 || this.theme.contrastBackdrop === undefined) return fill;
    const backdrop = this.backgroundColor(this.theme.contrastBackdrop);
    return backdrop && backdrop[3] >= 1 ? compositeColor(fill, backdrop) : fill;
  }

  private cellForeground(foreground: number, background: Color | undefined): string {
    // A background that is still not opaque has no known color to measure against.
    if (this.theme.minimumContrastRatio <= 1 || !background || background[3] < 1) return this.rgbToCSS(foreground);
    const key = `${foreground}:${background}`;
    let color = this.contrastCache.get(key);
    if (color === undefined) {
      color = this.rgbToCSS(contrastingColor(foreground, background, this.theme.minimumContrastRatio));
      if (this.contrastCache.size >= 1024) this.contrastCache.clear();
      this.contrastCache.set(key, color);
    }
    return color;
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
    const ctx = this.ctx;
    const canvasHeight = this.canvas.height / this.devicePixelRatio;
    const canvasWidth = this.canvas.width / this.devicePixelRatio;

    // Scrollbar dimensions
    const scrollbarWidth = 8;
    const scrollbarX = canvasWidth - scrollbarWidth - 4;
    const scrollbarPadding = 4;
    const scrollbarTrackHeight = canvasHeight - scrollbarPadding * 2;

    // The overlay composites onto the fresh rows painted by this frame.
    if (this.scrollbar !== 'overlay') {
      ctx.clearRect(scrollbarX - 2, 0, scrollbarWidth + 6, canvasHeight);
      ctx.fillStyle = this.theme.background;
      ctx.fillRect(scrollbarX - 2, 0, scrollbarWidth + 6, canvasHeight);
    }

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
  public getMetrics(): FontMetrics {
    this.syncDevicePixelRatio();
    return { ...this.metrics };
  }

  /** Register a copied layer; changes become visible on the next frame. */
  public addPaintLayer(layer: PaintLayer): () => void {
    if (layer.order !== 'mask' && !Number.isFinite(layer.order)) {
      throw new RangeError('Paint layer order must be finite or "mask"');
    }
    if (layer.order === 'mask' && this.paintLayers.some((entry) => entry.order === 'mask')) {
      throw new Error('Only one mask paint layer can be registered');
    }
    const entry: PaintLayer = { order: layer.order, paint: layer.paint };
    this.paintLayers.push(entry);
    this.paintLayers.sort((a, b) => a.order === 'mask' ? 1 : b.order === 'mask' ? -1 : a.order - b.order);
    this.repaintAll = true;
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      this.paintLayers = this.paintLayers.filter((candidate) => candidate !== entry);
      this.repaintAll = true;
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

  public setHighlights(source: HighlightsManager): void {
    this.highlightSource = source;
  }

  private cacheHighlights(spans: HighlightSpan[]): void {
    const rows: HighlightSpan[][] = [];
    for (const span of spans) {
      for (let row = span.startRow; row <= span.endRow; row++) {
        (rows[row] ??= []).push(span);
      }
    }
    this.currentHighlightRows = rows;
  }

  /** Last covering span wins; a wide glyph includes either of its cells. */
  private highlightAt(x: number, y: number, width: number): Readonly<HighlightStyle> | null {
    const spans = this.currentHighlightRows[y];
    if (!spans) return null;
    for (let i = spans.length - 1; i >= 0; i--) {
      const span = spans[i];
      if (y === span.startRow && x + width - 1 < span.startCol) continue;
      if (y === span.endRow && x > span.endCol) continue;
      return span.style;
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
    return this.getMetrics().width;
  }

  /**
   * Get character cell height (for coordinate conversion)
   */
  public get charHeight(): number {
    return this.getMetrics().height;
  }

  /**
   * Clear entire canvas
   */
  public clear(): void {
    this.repaintAll = true;
    this.ctx.setTransform(this.devicePixelRatio, 0, 0, this.devicePixelRatio, 0, 0);
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
