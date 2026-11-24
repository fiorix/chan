/**
 * Selection Manager - Handles text selection in the terminal
 *
 * Features:
 * - Mouse drag selection
 * - Double-click word selection
 * - Text extraction from terminal buffer
 * - Automatic clipboard copy
 * - Visual selection highlighting (integrated into CanvasRenderer cell rendering)
 * - Auto-scroll during drag selection
 */

import { EventEmitter } from './event-emitter';
import { copiedText } from '../vt/ghosttyCopy';
import { drawnWrapAbove, scrollbackAcrossDrawnWraps, textAcrossDrawnWraps } from './drawn-wraps';
import { VtCells, type VtCell, type VtTerminal, type VtTrackedCell } from '../vt/ghosttyVt';
import type { CanvasRenderer } from './renderer';
import type { Terminal } from './terminal';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * How far a press moves, in cell widths, before it is a drag that selects
 * rather than a click. The terminal reads the same distance to tell a link
 * click from the end of a drag.
 */
export const DRAG_THRESHOLD_CELLS = 0.5;

export interface SelectionCoordinates {
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
}

/** A cell in the active buffer; row zero is the oldest retained row. */
export type SelectionAnchor = { col: number; absoluteRow: number };

/** Inclusive endpoints, in either direction; returned ranges are snapshots. */
export type SelectionRange = { start: SelectionAnchor; end: SelectionAnchor };

// Keep the widget's path/URL word alphabet for double clicks.
const WORD_CHAR = /[\w\-./~@+]/;

function isWordCell(cell: VtCell | undefined): boolean {
  return !!cell && cell.codepoint !== 0 && WORD_CHAR.test(String.fromCodePoint(cell.codepoint));
}

function isBlankCell(cell: VtCell | undefined): boolean {
  return !cell || cell.codepoint === 0 || cell.codepoint === 32;
}

function assertIntegerRange(range: SelectionRange): void {
  for (const anchor of [range.start, range.end]) {
    if (!Number.isInteger(anchor.col) || !Number.isInteger(anchor.absoluteRow)) {
      throw new RangeError('Selection coordinates must be finite integers');
    }
  }
}

// ============================================================================
// SelectionManager Class
// ============================================================================

export class SelectionManager {
  private terminal: Terminal;
  private renderer: CanvasRenderer;
  private wasmTerm: VtTerminal;
  private textarea: HTMLTextAreaElement;

  private startAnchor: SelectionAnchor | null = null;
  private endAnchor: SelectionAnchor | null = null;
  private startCell: VtTrackedCell | null = null;
  private endCell: VtTrackedCell | null = null;
  private selectionOnAlternateScreen = false;

  // Find assigns these properties directly. Each assignment replaces that
  // endpoint's reference; reads expose its current absolute coordinates.
  private get selectionStart(): SelectionAnchor | null {
    this.syncSelection();
    return this.startAnchor ? { ...this.startAnchor } : null;
  }

  private set selectionStart(anchor: SelectionAnchor | null) {
    this.replaceEndpoint('start', anchor);
  }

  private get selectionEnd(): SelectionAnchor | null {
    this.syncSelection();
    return this.endAnchor ? { ...this.endAnchor } : null;
  }

  private set selectionEnd(anchor: SelectionAnchor | null) {
    this.replaceEndpoint('end', anchor);
  }
  private isSelecting: boolean = false;
  private mouseDownX: number = 0;
  private mouseDownY: number = 0;
  private dragThresholdMet: boolean = false;
  private activePointer: {
    id: number;
    type: string;
    buttons: number;
    lastEvent: PointerEvent;
    localSelection: boolean;
    ending: boolean;
  } | null = null;
  private clickSelects = true;
  private contextMenuTimeout: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  // Track rows that need redraw for clearing old selection
  // Using a Set prevents the overwrite bug where mousemove would clobber
  // the rows marked by clearSelection()
  private dirtySelectionRows: Set<number> = new Set();

  // Event emitter
  private selectionChangedEmitter = new EventEmitter<void>();

  private boundClickHandler: ((e: MouseEvent) => void) | null = null;
  private boundContextMenuHandler: ((e: MouseEvent) => void) | null = null;

  // The row a read of the selection's text or a click's word or line looks
  // at, one row at a time.
  private readonly cells = new VtCells();
  // The rows of a range's first and last cells, each in a view of its own.
  // A view answers a repeated read of its row from what it holds until the
  // core changes the row, so a paint that widens an unchanged selection
  // reads no row; one shared view would lose each row to the other.
  private readonly firstCells = new VtCells();
  private readonly lastCells = new VtCells();

  // Auto-scroll state for drag selection
  private autoScrollInterval: ReturnType<typeof setInterval> | null = null;
  private autoScrollDirection: number = 0; // -1 = up, 0 = none, 1 = down
  private static readonly AUTO_SCROLL_EDGE_SIZE = 30; // pixels from edge to trigger scroll

  /**
   * Get current viewport Y position (how many lines scrolled into history)
   */
  private getViewportY(): number {
    const rawViewportY =
      typeof (this.terminal as any).getViewportY === 'function'
        ? (this.terminal as any).getViewportY()
        : (this.terminal as any).viewportY || 0;
    return Math.max(0, Math.floor(rawViewportY));
  }

  /**
   * Convert viewport row to absolute buffer row
   * Absolute row is an index into combined buffer: scrollback (0 to len-1) + screen (len to len+rows-1)
   */
  private viewportRowToAbsolute(viewportRow: number): number {
    const scrollbackLength = this.wasmTerm.getScrollbackLength();
    const viewportY = this.getViewportY();
    return scrollbackLength + viewportRow - viewportY;
  }

  /**
   * Convert absolute buffer row to viewport row (may be outside visible range)
   */
  private absoluteRowToViewport(absoluteRow: number): number {
    const scrollbackLength = this.wasmTerm.getScrollbackLength();
    const viewportY = this.getViewportY();
    return absoluteRow - scrollbackLength + viewportY;
  }
  private static readonly AUTO_SCROLL_SPEED = 3; // lines per interval
  private static readonly AUTO_SCROLL_INTERVAL = 50; // ms between scroll steps

  constructor(
    terminal: Terminal,
    renderer: CanvasRenderer,
    wasmTerm: VtTerminal,
    textarea: HTMLTextAreaElement,
    private mouseInput?: {
      claimScrollbarPress: (event: PointerEvent) => boolean;
      press: (event: PointerEvent, reported: boolean) => void;
      move: (event: MouseEvent, reportMotion: boolean) => void;
      release: (event: MouseEvent) => void;
      end: (event?: MouseEvent) => void;
    }
  ) {
    this.terminal = terminal;
    this.renderer = renderer;
    this.wasmTerm = wasmTerm;
    this.textarea = textarea;

    // Attach mouse event listeners
    this.attachEventListeners();
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  private replaceEndpoint(endpoint: 'start' | 'end', anchor: SelectionAnchor | null): void {
    this.syncSelection();
    const cell = anchor ? this.wasmTerm.trackCell(anchor.absoluteRow, anchor.col) : null;
    if (endpoint === 'start') {
      this.startCell?.free();
      this.startCell = cell;
      this.startAnchor = cell && anchor ? { ...anchor } : null;
    } else {
      this.endCell?.free();
      this.endCell = cell;
      this.endAnchor = cell && anchor ? { ...anchor } : null;
    }
    this.selectionOnAlternateScreen = this.wasmTerm.isAlternateScreen();
  }

  /** Resolve tracked endpoints before observers or paint read a changed grid. */
  syncSelection(): void {
    if (!this.startCell && !this.endCell) return;
    if (this.selectionOnAlternateScreen !== this.wasmTerm.isAlternateScreen()) {
      this.invalidateSelectionRows();
      this.releaseSelection();
      return;
    }
    let start = this.startCell?.point() ?? null;
    let end = this.endCell?.point() ?? null;
    if (this.startAnchor && this.endAnchor) {
      const forwards = this.startAnchor.absoluteRow < this.endAnchor.absoluteRow ||
        (this.startAnchor.absoluteRow === this.endAnchor.absoluteRow && this.startAnchor.col <= this.endAnchor.col);
      const first = forwards ? start : end;
      const last = forwards ? end : start;
      const firstCell = forwards ? this.startCell : this.endCell;
      // Direction belongs to the gesture. Pruning belongs to text order:
      // a backward drag loses its older endpoint just like a forward drag.
      if (!last || (!first && !firstCell?.moveTo(0, 0))) {
        this.invalidateSelectionRows();
        this.releaseSelection();
        return;
      }
      if (!first) {
        if (forwards) start = { row: 0, col: 0 };
        else end = { row: 0, col: 0 };
      }
    } else if ((this.startCell && !start) || (this.endCell && !end)) {
      this.invalidateSelectionRows();
      this.releaseSelection();
      return;
    }
    if (start?.row !== this.startAnchor?.absoluteRow || start?.col !== this.startAnchor?.col ||
        end?.row !== this.endAnchor?.absoluteRow || end?.col !== this.endAnchor?.col) {
      this.invalidateSelectionRows();
    }
    this.startAnchor = start ? { col: start.col, absoluteRow: start.row } : null;
    this.endAnchor = end ? { col: end.col, absoluteRow: end.row } : null;
  }

  private invalidateSelectionRows(): void {
    // A moved/pruned range can leave paint at its old viewport coordinates.
    for (let row = 0; row < this.terminal.rows; row++) this.dirtySelectionRows.add(row);
  }

  private releaseSelection(): void {
    this.startCell?.free();
    this.endCell?.free();
    this.startCell = this.endCell = null;
    this.startAnchor = this.endAnchor = null;
    this.isSelecting = false;
    this.stopAutoScroll();
  }

  /** Read complete clusters, joining wraps and filtering undrawn controls. */
  getSelection(): string {
    const range = this.getSelectionRange();
    return range ? this.rangeText(range) : '';
  }

  /**
   * The text a selection of `range` would read, clamped and widened to whole
   * glyphs the same way, without selecting it or copying.
   */
  getRangeText(range: SelectionRange): string {
    assertIntegerRange(range);
    const clamped = this.clampRange(range);
    return clamped ? this.rangeText(clamped) : '';
  }

  private rangeText(range: SelectionRange): string {
    const drawn = this.terminal.options.joinDrawnWraps?.() ?? false;
    const textRange = {
      startCol: range.start.col, startRow: range.start.absoluteRow,
      endCol: range.end.col, endRow: range.end.absoluteRow,
    };
    const text = (drawn ? textAcrossDrawnWraps(this.wasmTerm, textRange) : null) ?? this.wasmTerm.plainText(textRange);
    return copiedText(text ?? this.readOwnSelection(range, drawn));
  }

  /** Read history and screen without changing the selection or copying. */
  getScrollbackText(): string {
    const drawn = this.terminal.options.joinDrawnWraps?.() ?? false;
    const text = (drawn ? scrollbackAcrossDrawnWraps(this.wasmTerm) : null) ?? this.wasmTerm.plainText();
    const { cols, rows } = this.wasmTerm.getDimensions();
    return copiedText(text ?? this.readOwnSelection({
      start: { col: 0, absoluteRow: 0 },
      end: { col: cols - 1, absoluteRow: this.wasmTerm.getScrollbackLength() + rows - 1 },
    }, drawn));
  }

  /** A row read remains available when the core cannot format a selection. */
  private readOwnSelection(range: SelectionRange, drawn: boolean): string {
    let { start, end } = range;
    if (start.absoluteRow > end.absoluteRow || (start.absoluteRow === end.absoluteRow && start.col > end.col)) {
      [start, end] = [end, start];
    }
    const history = this.wasmTerm.getScrollbackLength();
    let text = '';
    for (let row = start.absoluteRow; row <= end.absoluteRow; row++) {
      if (!this.readAbsoluteRow(row, history)) continue;
      const first = row === start.absoluteRow ? start.col : 0;
      const last = row === end.absoluteRow ? end.col : this.cells.length - 1;
      let line = '';
      for (let col = first; col <= last; col++) {
        const cell = this.cells.at(col);
        if (cell?.width === 0) continue;
        line += cell?.codepoint ? cell.cluster ?? String.fromCodePoint(cell.codepoint) : ' ';
      }
      if (row > start.absoluteRow && !this.continuesAbove(row, drawn)) text += '\n';
      text += line.replace(/ +$/, '');
    }
    return text.replace(/\n+$/, '');
  }

  /**
   * Check if there's an active selection
   */
  hasSelection(): boolean {
    this.syncSelection();
    if (!this.startAnchor || !this.endAnchor) return false;

    // Don't report selection until drag threshold is met (prevents flash on click)
    if (this.isSelecting && !this.dragThresholdMet) return false;

    return true;
  }

  /** Whether the captured gesture began as a local left-button selection. */
  hasLocalSelectionGesture(): boolean {
    return this.activePointer?.localSelection ?? false;
  }

  /**
   * Copy the current selection to clipboard
   * @returns true if there was text to copy, false otherwise
   */
  copySelection(): boolean {
    if (!this.hasSelection()) return false;

    const text = this.getSelection();
    if (text) {
      this.copyToClipboard(text);
      return true;
    }
    return false;
  }

  /**
   * Clear the selection
   */
  clearSelection(): void {
    if (!this.startAnchor && !this.endAnchor) return;

    // Mark current selection rows as dirty for redraw
    const coords = this.normalizeSelection();
    if (coords) {
      for (let row = coords.startRow; row <= coords.endRow; row++) {
        this.dirtySelectionRows.add(row);
      }
    }

    this.releaseSelection();

    // Force redraw of previously selected lines to clear the overlay
    this.requestRender();
  }

  /** Select the entire retained history and active screen. */
  selectAll(): void {
    const { cols, rows } = this.wasmTerm.getDimensions();
    this.setSelection({
      start: { col: 0, absoluteRow: 0 },
      end: { col: cols - 1, absoluteRow: this.wasmTerm.getScrollbackLength() + rows - 1 },
    });
  }

  /** Set inclusive absolute endpoints without copying; null clears. */
  setSelection(range: SelectionRange | null): void {
    if (range) {
      assertIntegerRange(range);
      range = this.clampRange(range);
    }
    if (!range) {
      this.clearSelection();
      return;
    }
    this.markCurrentSelectionDirty();
    this.selectionStart = range.start;
    this.selectionEnd = range.end;
    this.isSelecting = false;
    this.requestRender();
    this.selectionChangedEmitter.fire();
  }

  /** Current coordinates, copied and widened to whole glyphs. */
  getSelectionRange(): SelectionRange | null {
    this.syncSelection();
    if (!this.startAnchor || !this.endAnchor) return null;
    return this.clampRange({ start: this.startAnchor, end: this.endAnchor });
  }

  private clampRange(range: SelectionRange): SelectionRange | null {
    const { cols, rows } = this.wasmTerm.getDimensions();
    const history = this.wasmTerm.getScrollbackLength();
    const last = history + rows - 1;
    const { start, end } = range;
    if (Math.max(start.absoluteRow, end.absoluteRow) < 0 || Math.min(start.absoluteRow, end.absoluteRow) > last) return null;
    const clamp = (anchor: SelectionAnchor): SelectionAnchor => ({
      col: Math.max(0, Math.min(anchor.col, cols - 1)),
      absoluteRow: Math.max(0, Math.min(anchor.absoluteRow, last)),
    });
    const a = clamp(start);
    const b = clamp(end);
    const forwards = a.absoluteRow < b.absoluteRow || (a.absoluteRow === b.absoluteRow && a.col <= b.col);
    const first = forwards ? a : b;
    const final = forwards ? b : a;
    // The spacer after a wide glyph belongs to that glyph; an empty spacer
    // at the right edge before a wrap belongs to neither endpoint glyph.
    const firstCells = this.firstCells;
    if (this.readAbsoluteRow(first.absoluteRow, history, firstCells) && firstCells.at(first.col)?.width === 0 && firstCells.at(first.col - 1)?.width === 2) {
      first.col--;
    }
    const lastCells = this.lastCells;
    if (this.readAbsoluteRow(final.absoluteRow, history, lastCells) && lastCells.at(final.col)?.width === 2) {
      final.col = Math.min(final.col + 1, cols - 1);
    }
    return { start: a, end: b };
  }

  /** Client CSS pixels, clamped to a connected grid; null without geometry. */
  cellAt(clientX: number, clientY: number): { col: number; row: number; absoluteRow: number } | null {
    const canvas = this.renderer.getCanvas();
    if (!canvas.isConnected || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    const rect = canvas.getBoundingClientRect();
    const { width, height } = this.renderer.getMetrics();
    if (![rect.left, rect.top, rect.width, rect.height, width, height].every(Number.isFinite) ||
        rect.width <= 0 || rect.height <= 0 || width <= 0 || height <= 0) return null;
    const cell = this.pixelToCell(clientX - rect.left, clientY - rect.top);
    return { ...cell, absoluteRow: this.viewportRowToAbsolute(cell.row) };
  }

  /**
   * Select `length` cells from a column of a viewport row, carrying past the
   * last column into the rows below it.
   */
  select(column: number, row: number, length: number): void {
    // The rows the old selection painted repaint without it
    this.markCurrentSelectionDirty();

    // Clamp to valid ranges
    const dims = this.wasmTerm.getDimensions();
    row = Math.max(0, Math.min(row, dims.rows - 1));
    column = Math.max(0, Math.min(column, dims.cols - 1));

    // Calculate end position
    let endRow = row;
    let endCol = column + length - 1;

    // Handle wrapping if selection extends past end of line
    while (endCol >= dims.cols) {
      endCol -= dims.cols;
      endRow++;
    }

    // Clamp end row
    endRow = Math.min(endRow, dims.rows - 1);

    // Convert viewport rows to absolute rows
    this.selectionStart = { col: column, absoluteRow: this.viewportRowToAbsolute(row) };
    this.selectionEnd = { col: endCol, absoluteRow: this.viewportRowToAbsolute(endRow) };
    this.requestRender();
    this.selectionChangedEmitter.fire();
  }

  /**
   * Select entire lines from start to end
   * xterm.js compatible API
   */
  selectLines(start: number, end: number): void {
    // The rows the old selection painted repaint without it
    this.markCurrentSelectionDirty();

    const dims = this.wasmTerm.getDimensions();

    // Clamp to valid row ranges
    start = Math.max(0, Math.min(start, dims.rows - 1));
    end = Math.max(0, Math.min(end, dims.rows - 1));

    // Ensure start <= end
    if (start > end) {
      [start, end] = [end, start];
    }

    // Convert viewport rows to absolute rows
    this.selectionStart = { col: 0, absoluteRow: this.viewportRowToAbsolute(start) };
    this.selectionEnd = { col: dims.cols - 1, absoluteRow: this.viewportRowToAbsolute(end) };
    this.requestRender();
    this.selectionChangedEmitter.fire();
  }

  /**
   * Get current selection coordinates (for rendering)
   */
  getSelectionCoords(): SelectionCoordinates | null {
    return this.normalizeSelection();
  }

  /**
   * Get dirty selection rows that need redraw (for clearing old highlight)
   */
  getDirtySelectionRows(): Set<number> {
    return this.dirtySelectionRows;
  }

  /**
   * Clear the dirty selection rows tracking (after redraw)
   */
  clearDirtySelectionRows(): void {
    this.dirtySelectionRows.clear();
  }

  /**
   * Cleanup resources
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.endPointer(false);
    this.releaseSelection();
    this.resetTextarea();
    this.selectionChangedEmitter.dispose();
    const canvas = this.renderer.getCanvas();
    canvas.removeEventListener('pointerdown', this.handlePointerDown);
    canvas.removeEventListener('pointermove', this.handlePointerMove);
    canvas.removeEventListener('pointerup', this.handlePointerUp);
    canvas.removeEventListener('pointercancel', this.handlePointerCancel);
    canvas.removeEventListener('lostpointercapture', this.handleLostPointerCapture);
    canvas.removeEventListener('mousedown', this.handleFocus);
    if (this.boundClickHandler) canvas.removeEventListener('click', this.boundClickHandler);
    if (this.boundContextMenuHandler) canvas.removeEventListener('contextmenu', this.boundContextMenuHandler);
  }

  private matchesPointer(event: PointerEvent): boolean {
    const pointer = this.activePointer;
    return !!pointer && event.pointerId === pointer.id && event.pointerType === pointer.type && event.isPrimary;
  }

  private hasCapture(): boolean {
    const canvas = this.renderer.getCanvas();
    return !!this.activePointer && canvas.isConnected && canvas.hasPointerCapture(this.activePointer.id);
  }

  private handleFocus = (event: MouseEvent): void => {
    if (event.button === 0) this.renderer.getCanvas().parentElement?.focus({ preventScroll: true });
  };

  private handlePointerDown = (event: PointerEvent): void => {
    if (this.activePointer?.ending) return;
    if (event.defaultPrevented) this.clickSelects = false;
    if (this.disposed || event.defaultPrevented || !event.isPrimary ||
        (event.pointerType !== 'mouse' && event.pointerType !== 'pen') ||
        event.button < 0 || event.button > 2) return;
    if (this.activePointer && !this.matchesPointer(event) && this.hasCapture()) return;
    this.endPointer(false);
    this.resetTextarea();
    this.clickSelects = false;
    if (this.mouseInput?.claimScrollbarPress(event)) return;
    const canvas = this.renderer.getCanvas();
    // No selection is changed until capture is known to have succeeded.
    try {
      canvas.setPointerCapture(event.pointerId);
      if (!canvas.hasPointerCapture(event.pointerId)) return;
    } catch {
      return;
    }
    const reported = this.wasmTerm.hasMouseTracking() && !event.shiftKey;
    this.activePointer = {
      id: event.pointerId, type: event.pointerType, buttons: event.buttons, lastEvent: event,
      localSelection: event.button === 0 && !reported, ending: false,
    };
    this.clickSelects = !reported;
    this.mouseInput?.press(event, reported);
    if (event.button !== 0 || !this.clickSelects) return;
    const rect = canvas.getBoundingClientRect();
    const cell = this.pixelToCell(event.clientX - rect.left, event.clientY - rect.top);
    this.clearSelection();
    const absoluteRow = this.viewportRowToAbsolute(cell.row);
    this.selectionStart = { col: cell.col, absoluteRow };
    this.selectionEnd = { col: cell.col, absoluteRow };
    this.isSelecting = true;
    this.mouseDownX = event.clientX;
    this.mouseDownY = event.clientY;
    this.dragThresholdMet = false;
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (this.disposed || !event.isPrimary || (event.pointerType !== 'mouse' && event.pointerType !== 'pen')) return;
    if (!this.activePointer) {
      if (event.buttons === 0) this.mouseInput?.move(event, true);
      return;
    }
    if (!this.matchesPointer(event)) return;
    if (!this.hasCapture()) {
      this.endPointer(false);
      return;
    }
    const pointer = this.activePointer;
    if (pointer.ending) return;
    pointer.lastEvent = event;
    let buttonChanged = false;
    // Pointer Events reports chorded button changes as moves, not downs/ups.
    if (event.button >= 0 && event.button <= 2) {
      const mask = [1, 4, 2][event.button];
      if ((pointer.buttons & mask) !== (event.buttons & mask)) {
        buttonChanged = true;
        if (event.buttons & mask) this.mouseInput?.press(event, this.wasmTerm.hasMouseTracking() && !event.shiftKey);
        else this.mouseInput?.release(event);
      }
    }
    pointer.buttons = event.buttons;
    this.mouseInput?.move(event, !buttonChanged);
    if (event.buttons === 0 && !pointer.localSelection) {
      this.endPointer(false);
      return;
    }
    if (!this.isSelecting) return;
    if (!this.dragThresholdMet) {
      const dx = event.clientX - this.mouseDownX;
      const dy = event.clientY - this.mouseDownY;
      const threshold = this.renderer.getMetrics().width * DRAG_THRESHOLD_CELLS;
      if (dx * dx + dy * dy < threshold * threshold) return;
      this.dragThresholdMet = true;
    }
    const canvas = this.renderer.getCanvas();
    const rect = canvas.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const cell = this.pixelToCell(event.clientX - rect.left, y);
    const col = y < 0 ? 0 : y >= rect.height ? this.terminal.cols - 1 : cell.col;
    this.markCurrentSelectionDirty();
    this.selectionEnd = { col, absoluteRow: this.viewportRowToAbsolute(cell.row) };
    this.requestRender();
    this.updateAutoScroll(y, rect.height);
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (!this.matchesPointer(event)) return;
    this.endPointer(this.renderer.getCanvas().isConnected, event);
  };

  private handlePointerCancel = (event: PointerEvent): void => {
    if (this.matchesPointer(event)) this.endPointer(false);
  };

  private handleLostPointerCapture = (event: PointerEvent): void => {
    if (!this.matchesPointer(event)) return;
    this.endPointer(this.renderer.getCanvas().isConnected);
  };

  private endPointer(copy: boolean, release?: MouseEvent): void {
    const pointer = this.activePointer;
    if (!pointer || pointer.ending) return;
    const canvas = this.renderer.getCanvas();
    // Release reports still belong to this gesture. Keep its disposition
    // through emission, but reject a synchronous attempt to end it again.
    pointer.ending = true;
    try {
      this.mouseInput?.end(!this.disposed && canvas.isConnected ? release ?? pointer.lastEvent : undefined);
    } finally {
      this.activePointer = null;
      this.stopAutoScroll();
      const selecting = this.isSelecting;
      this.isSelecting = false;
      // Clear ownership before releasePointerCapture can deliver a loss event.
      try {
        if (canvas.hasPointerCapture(pointer.id)) canvas.releasePointerCapture(pointer.id);
      } catch {
        // A detached element can already have lost its capture.
      }
      if (selecting) {
        if (!this.dragThresholdMet) {
          this.clearSelection();
        } else if (copy && this.hasSelection()) {
          const text = this.getSelection();
          if (text) {
            this.copyToClipboard(text);
            this.selectionChangedEmitter.fire();
          }
        }
      }
    }
  }

  private resetTextarea = (): void => {
    if (this.contextMenuTimeout !== null) {
      clearTimeout(this.contextMenuTimeout);
      this.contextMenuTimeout = null;
    }
    this.textarea.removeEventListener('blur', this.resetTextarea);
    this.textarea.style.pointerEvents = 'none';
    this.textarea.style.zIndex = '-10';
    this.textarea.style.width = '0';
    this.textarea.style.height = '0';
    this.textarea.style.left = '0';
    this.textarea.style.top = '0';
    this.textarea.value = '';
  };

  private attachEventListeners(): void {
    const canvas = this.renderer.getCanvas();
    canvas.addEventListener('pointerdown', this.handlePointerDown);
    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerup', this.handlePointerUp);
    canvas.addEventListener('pointercancel', this.handlePointerCancel);
    canvas.addEventListener('lostpointercapture', this.handleLostPointerCapture);
    canvas.addEventListener('mousedown', this.handleFocus);

    // Handle click events for double-click (word) and triple-click (line) selection
    // Use event.detail which browsers set to click count (1, 2, 3, etc.)
    this.boundClickHandler = (e: MouseEvent) => {
      if (!this.clickSelects || e.button !== 0) return;
      if (e.detail < 2) return;
      const cell = this.cellAt(e.clientX, e.clientY);
      if (!cell) return;
      const drawn = this.terminal.options.joinDrawnWraps?.() ?? false;
      const extent = e.detail === 2
        ? this.wordAcrossWraps(cell.col, cell.absoluteRow, drawn)
        : this.lineAcrossWraps(cell.absoluteRow, drawn);
      if (!extent) return;
      this.setSelection(extent);
      this.copySelection();
    };
    canvas.addEventListener('click', this.boundClickHandler);

    // Right-click (context menu) - position textarea to show browser's native menu
    // This allows Copy/Paste options to appear in the context menu
    this.boundContextMenuHandler = (e: MouseEvent) => {
      this.resetTextarea();
      // Position textarea at mouse cursor
      this.textarea.style.position = 'fixed';
      this.textarea.style.left = `${e.clientX}px`;
      this.textarea.style.top = `${e.clientY}px`;
      this.textarea.style.width = '1px';
      this.textarea.style.height = '1px';
      this.textarea.style.zIndex = '1000';
      this.textarea.style.opacity = '0';

      // Enable pointer events temporarily so context menu targets the textarea
      this.textarea.style.pointerEvents = 'auto';

      // If there's a selection, populate textarea with it and select the text
      if (this.hasSelection()) {
        const text = this.getSelection();
        this.textarea.value = text;
        this.textarea.select();
        this.textarea.setSelectionRange(0, text.length);
      } else {
        // No selection - clear textarea but still show menu (for paste)
        this.textarea.value = '';
      }

      // Focus the textarea so the context menu appears on it
      this.textarea.focus({ preventScroll: true });

      // After a short delay, restore the textarea to its hidden state
      // This allows the context menu to appear first
      this.contextMenuTimeout = setTimeout(() => {
        this.contextMenuTimeout = null;
        this.textarea.addEventListener('blur', this.resetTextarea, { once: true });
      }, 10);

      // Don't prevent default - let browser show the context menu on the textarea
    };

    canvas.addEventListener('contextmenu', this.boundContextMenuHandler);

  }

  /**
   * Mark current selection rows as dirty for redraw
   */
  private markCurrentSelectionDirty(): void {
    const coords = this.normalizeSelection();
    if (coords) {
      for (let row = coords.startRow; row <= coords.endRow; row++) {
        this.dirtySelectionRows.add(row);
      }
    }
  }

  /**
   * Update auto-scroll based on mouse Y position within canvas
   */
  private updateAutoScroll(offsetY: number, canvasHeight: number): void {
    const edgeSize = SelectionManager.AUTO_SCROLL_EDGE_SIZE;

    if (offsetY < edgeSize) {
      // Near top edge - scroll up
      this.startAutoScroll(-1);
    } else if (offsetY > canvasHeight - edgeSize) {
      // Near bottom edge - scroll down
      this.startAutoScroll(1);
    } else {
      // In middle - stop scrolling
      this.stopAutoScroll();
    }
  }

  /**
   * Start auto-scrolling in the given direction
   */
  private startAutoScroll(direction: number): void {
    // Don't restart if already scrolling in same direction
    if (this.autoScrollInterval !== null && this.autoScrollDirection === direction) {
      return;
    }

    // Stop any existing scroll
    this.stopAutoScroll();

    this.autoScrollDirection = direction;

    // Start scrolling interval
    this.autoScrollInterval = setInterval(() => {
      if (!this.isSelecting || !this.hasCapture()) {
        this.endPointer(false);
        this.stopAutoScroll();
        return;
      }

      // Pointer Y grows toward newer output; viewport offsets grow into history.
      const scrollAmount = SelectionManager.AUTO_SCROLL_SPEED * this.autoScrollDirection;
      const topBefore = this.viewportRowToAbsolute(0);
      this.terminal.viewport.scrollBy(-scrollAmount);

      // A view that could not scroll shows the same rows, so the end stays
      // at the cell the pointer named: a drag resting in the edge zone of a
      // view at its limit selects no more than the pointer covers.
      if (this.viewportRowToAbsolute(0) === topBefore) return;

      // Extend selection in the scroll direction
      // Key insight: we need to EXTEND the selection, not reset it to viewport edge
      if (this.selectionEnd) {
        const dims = this.wasmTerm.getDimensions();
        if (this.autoScrollDirection < 0) {
          // Scrolling up - extend selection upward (decrease absoluteRow)
          // Set to top of viewport, but only if it extends the selection
          const topAbsoluteRow = this.viewportRowToAbsolute(0);
          if (topAbsoluteRow < this.selectionEnd.absoluteRow) {
            this.selectionEnd = { col: 0, absoluteRow: topAbsoluteRow };
          }
        } else {
          // Scrolling down - extend selection downward (increase absoluteRow)
          // Set to bottom of viewport, but only if it extends the selection
          const bottomAbsoluteRow = this.viewportRowToAbsolute(dims.rows - 1);
          if (bottomAbsoluteRow > this.selectionEnd.absoluteRow) {
            this.selectionEnd = { col: dims.cols - 1, absoluteRow: bottomAbsoluteRow };
          }
        }
      }

      this.requestRender();
    }, SelectionManager.AUTO_SCROLL_INTERVAL);
  }

  /**
   * Stop auto-scrolling
   */
  private stopAutoScroll(): void {
    if (this.autoScrollInterval !== null) {
      clearInterval(this.autoScrollInterval);
      this.autoScrollInterval = null;
    }
    this.autoScrollDirection = 0;
  }

  /**
   * Convert pixel coordinates to terminal cell coordinates
   */
  private pixelToCell(x: number, y: number): { col: number; row: number } {
    const metrics = this.renderer.getMetrics();

    const col = Math.floor(x / metrics.width);
    const row = Math.floor(y / metrics.height);

    // Clamp to terminal bounds
    return {
      col: Math.max(0, Math.min(col, this.terminal.cols - 1)),
      row: Math.max(0, Math.min(row, this.terminal.rows - 1)),
    };
  }

  /**
   * Normalize selection coordinates (handle backward selection)
   * Returns coordinates in VIEWPORT space for rendering, clamped to visible area
   */
  private normalizeSelection(): SelectionCoordinates | null {
    const range = this.getSelectionRange();
    if (!range) return null;

    let { col: startCol, absoluteRow: startAbsRow } = range.start;
    let { col: endCol, absoluteRow: endAbsRow } = range.end;

    // Swap if selection goes backwards
    if (startAbsRow > endAbsRow || (startAbsRow === endAbsRow && startCol > endCol)) {
      [startCol, endCol] = [endCol, startCol];
      [startAbsRow, endAbsRow] = [endAbsRow, startAbsRow];
    }

    // Convert to viewport coordinates
    let startRow = this.absoluteRowToViewport(startAbsRow);
    let endRow = this.absoluteRowToViewport(endAbsRow);

    // Clamp to visible viewport range
    const dims = this.wasmTerm.getDimensions();
    const maxRow = dims.rows - 1;

    // If entire selection is outside viewport, return null
    if (endRow < 0 || startRow > maxRow) {
      return null;
    }

    // Clamp rows to visible range, adjusting columns for partial rows
    if (startRow < 0) {
      startRow = 0;
      startCol = 0; // Selection starts from beginning of first visible row
    }
    if (endRow > maxRow) {
      endRow = maxRow;
      endCol = dims.cols - 1; // Selection extends to end of last visible row
    }

    return { startCol, startRow, endCol, endRow };
  }

  /**
   * The word under a cell, carried across core wraps and enabled drawn
   * wraps. Null when the cell holds no
   * word character.
   */
  private wordAcrossWraps(col: number, absoluteRow: number, drawn: boolean): { start: SelectionAnchor; end: SelectionAnchor } | null {
    const cells = this.readCells(absoluteRow);
    if (!cells || !isWordCell(cells.at(col))) return null;
    let start = { col, absoluteRow };
    let startCells = cells;
    for (;;) {
      while (start.col > 0 && isWordCell(startCells.at(start.col - 1))) start.col--;
      if (start.col > 0 || !this.continuesAbove(start.absoluteRow, drawn)) break;
      const above = this.readCells(start.absoluteRow - 1);
      if (!above || !isWordCell(above.at(above.length - 1))) break;
      start = { col: above.length - 1, absoluteRow: start.absoluteRow - 1 };
      startCells = above;
    }
    let end = { col, absoluteRow };
    let endCells = cells;
    for (;;) {
      while (end.col < endCells.length - 1 && isWordCell(endCells.at(end.col + 1))) end.col++;
      if (end.col < endCells.length - 1 || !this.continuesAbove(end.absoluteRow + 1, drawn)) break;
      const below = this.readCells(end.absoluteRow + 1);
      if (!below || !isWordCell(below.at(0))) break;
      end = { col: 0, absoluteRow: end.absoluteRow + 1 };
      endCells = below;
    }
    return { start, end };
  }

  /**
   * The whole line across core wraps and enabled drawn wraps, through
   * its last nonblank cell. Null when the line is blank.
   */
  private lineAcrossWraps(absoluteRow: number, drawn: boolean): { start: SelectionAnchor; end: SelectionAnchor } | null {
    let first = absoluteRow;
    while (first > 0 && this.continuesAbove(first, drawn)) first--;
    let last = absoluteRow;
    while (this.continuesAbove(last + 1, drawn)) last++;
    for (let row = last; row >= first; row--) {
      const cells = this.readCells(row);
      if (!cells) continue;
      for (let col = cells.length - 1; col >= 0; col--) {
        if (!isBlankCell(cells.at(col))) {
          return { start: { col: 0, absoluteRow: first }, end: { col, absoluteRow: row } };
        }
      }
    }
    return null;
  }

  /**
   * Whether a row continues the preceding row under the current policy.
   */
  private continuesAbove(absoluteRow: number, drawn: boolean): boolean {
    const history = this.wasmTerm.getScrollbackLength();
    if (absoluteRow < 1 || absoluteRow >= history + this.terminal.rows) return false;
    const wrapped = absoluteRow < history
      ? this.wasmTerm.isScrollbackRowWrapped(absoluteRow)
      : this.wasmTerm.isRowWrapped(absoluteRow - history);
    return wrapped || (drawn && drawnWrapAbove(this.wasmTerm, absoluteRow));
  }

  /**
   * Row `row` of the history and the screen, 0 the oldest history row, in
   * a view of its own. Null when no such row exists.
   */
  private readCells(absoluteRow: number): VtCells | null {
    const cells = new VtCells();
    const history = this.wasmTerm.getScrollbackLength();
    const read = absoluteRow < history
      ? this.wasmTerm.readHistoryRow(absoluteRow, cells)
      : this.wasmTerm.readRow(absoluteRow - history, cells);
    return read ? cells : null;
  }

  /**
   * Read absolute row `row` (history first, then the screen) into `into`,
   * this.cells unless given. False when there is no such row.
   */
  private readAbsoluteRow(row: number, scrollbackLength: number, into: VtCells = this.cells): boolean {
    return row < scrollbackLength
      ? this.wasmTerm.readHistoryRow(row, into)
      : this.wasmTerm.readRow(row - scrollbackLength, into);
  }

  /**
   * Copy text to clipboard
   *
   * Strategy (modern APIs first):
   * 1. Try ClipboardItem API (works in Safari and modern browsers)
   *    - Safari requires the ClipboardItem to be created synchronously within user gesture
   * 2. Try navigator.clipboard.writeText (modern async API, may fail in Safari)
   * 3. Fall back to execCommand (legacy, for older browsers)
   */
  private copyToClipboard(text: string): void {
    if (this.terminal.options.copy) {
      this.terminal.options.copy(text);
      return;
    }
    // First try: ClipboardItem API (modern, Safari-compatible)
    // Safari allows this because we create the ClipboardItem synchronously
    // within the user gesture, even though the write is async
    if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
      try {
        const blob = new Blob([text], { type: 'text/plain' });
        const clipboardItem = new ClipboardItem({
          'text/plain': blob,
        });
        navigator.clipboard.write([clipboardItem]).catch((err) => {
          console.warn('ClipboardItem write failed, trying writeText:', err);
          // Try writeText as fallback
          this.copyWithWriteText(text);
        });
        return;
      } catch (err) {
        // ClipboardItem not supported or failed, fall through
      }
    }

    // Second try: basic async writeText (works in Chrome, may fail in Safari)
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch((err) => {
        console.warn('Clipboard writeText failed, trying execCommand:', err);
        // Fall back to execCommand
        this.copyWithExecCommand(text);
      });
      return;
    }

    // Third try: legacy execCommand fallback
    this.copyWithExecCommand(text);
  }

  /**
   * Copy using navigator.clipboard.writeText
   */
  private copyWithWriteText(text: string): void {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch((err) => {
        console.warn('Clipboard writeText failed, trying execCommand:', err);
        this.copyWithExecCommand(text);
      });
    } else {
      this.copyWithExecCommand(text);
    }
  }

  /**
   * Copy using legacy execCommand (fallback for older browsers)
   */
  private copyWithExecCommand(text: string): void {
    const previouslyFocused = document.activeElement as HTMLElement;
    try {
      // Position textarea offscreen but in a way that allows selection
      const textarea = this.textarea;
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '0';
      textarea.style.width = '1px';
      textarea.style.height = '1px';
      textarea.style.opacity = '0';

      // Select all text and copy
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, text.length);

      const success = document.execCommand('copy');

      // Restore focus
      if (previouslyFocused) {
        previouslyFocused.focus();
      }

      if (!success) {
        console.warn('execCommand copy failed');
      }
    } catch (err) {
      console.warn('execCommand copy threw:', err);
      // Restore focus on error
      if (previouslyFocused) {
        previouslyFocused.focus();
      }
    }
  }

  /**
   * Request a render update (triggers selection overlay redraw)
   */
  private requestRender(): void {
    // The render loop will automatically pick up the new selection state
    // and redraw the affected lines. This happens at 60fps.
    //
    // Note: When clearSelection() is called, it adds dirty rows to dirtySelectionRows
    // which the renderer can use to know which lines to redraw.
  }
}
