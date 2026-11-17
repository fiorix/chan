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
import { VtCells, type VtCell, type VtTerminal } from '../vt/ghosttyVt';
import type { CanvasRenderer } from './renderer';
import type { Terminal } from './terminal';

// ============================================================================
// Type Definitions
// ============================================================================

export interface SelectionCoordinates {
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
}

/// One cell of a selection: `absoluteRow` 0 is the oldest history row and
/// the active rows follow.
export type SelectionAnchor = { col: number; absoluteRow: number };

/// A selection as two corners, both cells included.
export type SelectionRange = { start: SelectionAnchor; end: SelectionAnchor };

/// Word characters: letters, numbers, and common path/URL characters.
// Matches native Ghostty behavior where double-click selects entire paths.
// Includes: / (path sep), . (extensions), ~ (home), @ (emails), + (encodings)
const WORD_CHAR = /[\w\-./~@+]/;

function isWordCell(cell: VtCell | undefined): boolean {
  return !!cell && cell.codepoint !== 0 && WORD_CHAR.test(String.fromCodePoint(cell.codepoint));
}

function isBlankCell(cell: VtCell | undefined): boolean {
  return !cell || cell.codepoint === 0 || cell.codepoint === 32;
}

// ============================================================================
// SelectionManager Class
// ============================================================================

export class SelectionManager {
  private terminal: Terminal;
  private renderer: CanvasRenderer;
  private wasmTerm: VtTerminal;
  private textarea: HTMLTextAreaElement;

  // Selection state - coordinates are in ABSOLUTE buffer space (viewportY + viewportRow)
  // This ensures selection persists correctly when scrolling
  private selectionStart: SelectionAnchor | null = null;
  private selectionEnd: SelectionAnchor | null = null;
  // Where a copy goes. The terminal hands this in; the widget's own
  // clipboard write applies when it does not.
  private copy?: (text: string) => void;
  private isSelecting: boolean = false;
  private pressClientX: number = 0;
  private pressClientY: number = 0;
  private dragThresholdMet: boolean = false;

  // Track rows that need redraw for clearing old selection
  // Using a Set prevents the overwrite bug where mousemove would clobber
  // the rows marked by clearSelection()
  private dirtySelectionRows: Set<number> = new Set();

  // Event emitter
  private selectionChangedEmitter = new EventEmitter<void>();

  // Store bound event handlers for cleanup
  private boundContextMenuHandler: ((e: MouseEvent) => void) | null = null;

  // The row a read of the selection's text or a click's word or line looks
  // at, one row at a time.
  private readonly cells = new VtCells();

  // Auto-scroll state for drag selection
  private autoScrollInterval: ReturnType<typeof setInterval> | null = null;
  private autoScrollDirection: number = 0; // -1 = up, 0 = none, 1 = down
  private static readonly AUTO_SCROLL_EDGE_SIZE = 30; // pixels from edge to trigger scroll

  /**
   * Get current viewport Y position (how many lines scrolled into history)
   */
  private getViewportY(): number {
    return Math.max(0, Math.floor(this.terminal.getViewportY()));
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
    copy?: (text: string) => void
  ) {
    this.terminal = terminal;
    this.renderer = renderer;
    this.wasmTerm = wasmTerm;
    this.textarea = textarea;
    this.copy = copy;

    // Attach mouse event listeners
    this.attachEventListeners();
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Get the selected text as a string: the binding formats the whole
   * selection in one core call, joining soft wraps and reading wide
   * glyphs and clusters whole, less what the screen does not draw.
   * Falls back to a row-by-row read when the core cannot format it.
   */
  getSelection(): string {
    if (!this.selectionStart || !this.selectionEnd) return '';

    const text = this.wasmTerm.plainText({
      startCol: this.selectionStart.col,
      startRow: this.selectionStart.absoluteRow,
      endCol: this.selectionEnd.col,
      endRow: this.selectionEnd.absoluteRow,
    });
    return copiedText(text ?? this.readOwnSelection());
  }

  /**
   * The old row-by-row read, kept for when the core cannot format.
   */
  private readOwnSelection(): string {
    if (!this.selectionStart || !this.selectionEnd) return '';

    // Get absolute row coordinates (not clamped to viewport)
    let { col: startCol, absoluteRow: startAbsRow } = this.selectionStart;
    let { col: endCol, absoluteRow: endAbsRow } = this.selectionEnd;

    // Swap if selection goes backwards
    if (startAbsRow > endAbsRow || (startAbsRow === endAbsRow && startCol > endCol)) {
      [startCol, endCol] = [endCol, startCol];
      [startAbsRow, endAbsRow] = [endAbsRow, startAbsRow];
    }

    const scrollbackLength = this.wasmTerm.getScrollbackLength();
    let text = '';

    for (let absRow = startAbsRow; absRow <= endAbsRow; absRow++) {
      // Fetch line based on absolute row position
      // Absolute row < scrollbackLength means it's in scrollback
      // Absolute row >= scrollbackLength means it's in the screen buffer
      if (!this.readAbsoluteRow(absRow, scrollbackLength)) continue;
      const line = this.cells;

      // Track the last non-empty column for trimming trailing spaces
      let lastNonEmpty = -1;

      // Determine column range for this row
      const colStart = absRow === startAbsRow ? startCol : 0;
      const colEnd = absRow === endAbsRow ? endCol : line.length - 1;

      // Build the line text
      let lineText = '';
      for (let col = colStart; col <= colEnd; col++) {
        const cell = line.at(col);
        if (cell && cell.codepoint !== 0) {
          // A cell with several codepoints carries its whole cluster
          const char = cell.cluster ?? String.fromCodePoint(cell.codepoint);
          lineText += char;
          if (char.trim()) {
            lastNonEmpty = lineText.length;
          }
        } else {
          lineText += ' ';
        }
      }

      // Trim trailing spaces from each line
      if (lastNonEmpty >= 0) {
        lineText = lineText.substring(0, lastNonEmpty);
      } else {
        lineText = '';
      }

      text += lineText;

      // Add newline between rows (but not after the last row)
      if (absRow < endAbsRow) {
        text += '\n';
      }
    }

    return text;
  }

  /**
   * Check if there's an active selection
   */
  hasSelection(): boolean {
    if (!this.selectionStart || !this.selectionEnd) return false;

    // Don't report selection until drag threshold is met (prevents flash on click)
    if (this.isSelecting && !this.dragThresholdMet) return false;

    return true;
  }

  /**
   * Copy the current selection to clipboard
   * @returns true if there was text to copy, false otherwise
   */
  copySelection(): boolean {
    if (!this.hasSelection()) return false;

    const text = this.getSelection();
    if (text) {
      this.writeCopy(text);
      return true;
    }
    return false;
  }

  /**
   * Clear the selection
   */
  clearSelection(): void {
    if (!this.hasSelection()) return;

    // Mark current selection rows as dirty for redraw
    const coords = this.normalizeSelection();
    if (coords) {
      for (let row = coords.startRow; row <= coords.endRow; row++) {
        this.dirtySelectionRows.add(row);
      }
    }

    this.selectionStart = null;
    this.selectionEnd = null;
    this.isSelecting = false;

    // Force redraw of previously selected lines to clear the overlay
    this.requestRender();
  }

  /**
   * Select the history and the screen, as one buffer.
   */
  selectAll(): void {
    const dims = this.wasmTerm.getDimensions();
    this.selectionStart = { col: 0, absoluteRow: 0 };
    this.selectionEnd = { col: dims.cols - 1, absoluteRow: this.wasmTerm.getScrollbackLength() + dims.rows - 1 };
    this.requestRender();
    this.selectionChangedEmitter.fire();
  }

  /**
   * Set the selection to a range of absolute buffer rows, or clear it
   * with null. A programmatic selection: it never copies to the clipboard.
   */
  setSelection(range: SelectionRange | null): void {
    if (!range) {
      this.clearSelection();
      return;
    }
    this.markCurrentSelectionDirty();
    this.selectionStart = { ...range.start };
    this.selectionEnd = { ...range.end };
    this.requestRender();
    this.selectionChangedEmitter.fire();
  }

  /**
   * The current selection anchors, or null when nothing is selected.
   */
  getSelectionRange(): SelectionRange | null {
    if (!this.selectionStart || !this.selectionEnd) return null;
    return { start: { ...this.selectionStart }, end: { ...this.selectionEnd } };
  }

  /**
   * The cell under a client pixel of the canvas: its column, its viewport
   * row and its absolute buffer row. Clamped to the grid.
   */
  cellAt(clientX: number, clientY: number): { col: number; row: number; absoluteRow: number } {
    const rect = this.renderer.getCanvas().getBoundingClientRect();
    const cell = this.pixelToCell(clientX - rect.left, clientY - rect.top);
    return { ...cell, absoluteRow: this.viewportRowToAbsolute(cell.row) };
  }

  /**
   * Select text at specific column and row with length
   * xterm.js compatible API
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
    const viewportY = this.getViewportY();
    this.selectionStart = { col: column, absoluteRow: viewportY + row };
    this.selectionEnd = { col: endCol, absoluteRow: viewportY + endRow };
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
    this.selectionChangedEmitter.dispose();

    // Stop auto-scroll if active
    this.stopAutoScroll();

    // Clean up context menu event listener
    if (this.boundContextMenuHandler) {
      const canvas = this.renderer.getCanvas();
      canvas.removeEventListener('contextmenu', this.boundContextMenuHandler);
      this.boundContextMenuHandler = null;
    }

    // Canvas event listeners will be cleaned up when canvas is removed from DOM
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Attach pointer event listeners to the canvas. Everything lives on the
   * canvas: a press captures its pointer, so moves and the release outside
   * the canvas still reach it, and no document listener is needed.
   */
  private attachEventListeners(): void {
    const canvas = this.renderer.getCanvas();

    // Pointer down - start selection or clear existing
    canvas.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button === 0) {
        // Primary button only

        // CRITICAL: Focus the terminal so it can receive keyboard input
        // The canvas doesn't have tabindex, but the parent container does
        if (canvas.parentElement) {
          canvas.parentElement.focus();
        }

        // Capture the pointer so the move and the release outside the
        // canvas still reach it. Guarded: jsdom has no pointer capture,
        // where tests dispatch on the canvas itself.
        canvas.setPointerCapture?.(e.pointerId);

        const rect = canvas.getBoundingClientRect();
        const cell = this.pixelToCell(e.clientX - rect.left, e.clientY - rect.top);

        // Always clear previous selection on new press
        const hadSelection = this.hasSelection();
        if (hadSelection) {
          this.clearSelection();
        }

        // Start new selection (convert to absolute coordinates)
        const absoluteRow = this.viewportRowToAbsolute(cell.row);
        this.selectionStart = { col: cell.col, absoluteRow };
        this.selectionEnd = { col: cell.col, absoluteRow };
        this.isSelecting = true;
        this.pressClientX = e.clientX;
        this.pressClientY = e.clientY;
        this.dragThresholdMet = false;
      }
    });

    // A compat-mouse press focuses the parent too, for dispatchers that
    // never fire pointer events. After a real pointer press this repeats
    // the focus above and changes nothing.
    canvas.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.button === 0) {
        if (canvas.parentElement) {
          canvas.parentElement.focus();
        }
      }
    });

    // Pointer move on canvas - update selection. Under capture this also
    // carries positions outside the canvas, clamped to it by pixelToCell.
    canvas.addEventListener('pointermove', (e: PointerEvent) => {
      if (this.isSelecting) {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Check if drag threshold has been met
        if (!this.dragThresholdMet) {
          const dx = e.clientX - this.pressClientX;
          const dy = e.clientY - this.pressClientY;
          // Use 50% of cell width as threshold to scale with font size
          const threshold = this.renderer.getMetrics().width * 0.5;
          if (dx * dx + dy * dy < threshold * threshold) {
            return; // Below threshold, ignore
          }
          this.dragThresholdMet = true;
        }

        // Mark current selection rows as dirty before updating
        this.markCurrentSelectionDirty();

        const cell = this.pixelToCell(x, y);
        const absoluteRow = this.viewportRowToAbsolute(cell.row);
        this.selectionEnd = { col: cell.col, absoluteRow };
        this.requestRender();

        // Auto-scroll at the canvas edges and past them, where the
        // captured pointer reports outside positions instead of leaving
        const edgeSize = SelectionManager.AUTO_SCROLL_EDGE_SIZE;
        if (y < edgeSize) {
          this.startAutoScroll(-1); // Scroll up
        } else if (y > rect.height - edgeSize) {
          this.startAutoScroll(1); // Scroll down
        } else {
          this.stopAutoScroll();
        }
      }
    });

    const endDrag = (copy: boolean): void => {
      if (this.isSelecting) {
        this.isSelecting = false;
        this.stopAutoScroll();

        // Check if this was a press without drag (threshold never met).
        if (!this.dragThresholdMet) {
          this.clearSelection();
          return;
        }

        if (copy && this.hasSelection()) {
          const text = this.getSelection();
          if (text) {
            this.writeCopy(text);
            this.selectionChangedEmitter.fire();
          }
        }
      }
    };
    canvas.addEventListener('pointerup', () => endDrag(true));
    // An interrupted drag keeps its selection but copies nothing. The
    // implicit release after a pointerup lands here with nothing to end.
    canvas.addEventListener('pointercancel', () => endDrag(false));
    canvas.addEventListener('lostpointercapture', () => endDrag(false));

    // Handle click events for double-click (word) and triple-click (line) selection
    // Use event.detail which browsers set to click count (1, 2, 3, etc.)
    canvas.addEventListener('click', (e: MouseEvent) => {
      // event.detail: 1 = single, 2 = double, 3 = triple click
      const rect = canvas.getBoundingClientRect();
      const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (e.detail === 2) {
        // Double-click - select the word under the cell, carrying across
        // soft wraps the way xterm.js does. No word under the cell selects
        // nothing.
        const cell = this.pixelToCell(at.x, at.y);
        const extent = this.wordAcrossWraps(cell.col, this.viewportRowToAbsolute(cell.row));
        if (!extent) return;
        this.selectionStart = extent.start;
        this.selectionEnd = extent.end;
        this.requestRender();

        const text = this.getSelection();
        if (text) {
          this.writeCopy(text);
          this.selectionChangedEmitter.fire();
        }
      } else if (e.detail >= 3) {
        // Triple-click (or more) - select the whole wrapped line, to its
        // last cell that is not blank. An empty line selects nothing.
        const cell = this.pixelToCell(at.x, at.y);
        const extent = this.lineAcrossWraps(this.viewportRowToAbsolute(cell.row));
        if (!extent) return;
        this.selectionStart = extent.start;
        this.selectionEnd = extent.end;
        this.requestRender();

        const text = this.getSelection();
        if (text) {
          this.writeCopy(text);
          this.selectionChangedEmitter.fire();
        }
      }
    });

    // Right-click (context menu) - position textarea to show browser's native menu
    // This allows Copy/Paste options to appear in the context menu
    this.boundContextMenuHandler = (e: MouseEvent) => {
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
      this.textarea.focus();

      // After a short delay, restore the textarea to its hidden state
      // This allows the context menu to appear first
      setTimeout(() => {
        // Reset when the menu closes: a menu choice or a click away moves
        // the keyboard off the textarea (blur), and a press on the canvas
        // starts a drag or focuses past it. All element-scoped.
        const resetTextarea = () => {
          this.textarea.style.pointerEvents = 'none';
          this.textarea.style.zIndex = '-10';
          this.textarea.style.width = '0';
          this.textarea.style.height = '0';
          this.textarea.style.left = '0';
          this.textarea.style.top = '0';
          this.textarea.value = '';

          // Remove the one-time listeners
          this.textarea.removeEventListener('blur', resetTextarea);
          canvas.removeEventListener('pointerdown', resetTextarea);
        };

        // Reset on any of these events (menu closed)
        this.textarea.addEventListener('blur', resetTextarea, { once: true });
        canvas.addEventListener('pointerdown', resetTextarea, { once: true });
      }, 10);

      // Don't prevent default - let browser show the context menu on the textarea
    };

    canvas.addEventListener('contextmenu', this.boundContextMenuHandler);

    // A click outside the terminal element keeps the selection: the
    // selection is also find's active-match highlight, and clearing it on
    // a click in the find bar took find's highlight. A press inside the
    // canvas starts a new drag and clears the old selection there.
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
      if (!this.isSelecting) {
        this.stopAutoScroll();
        return;
      }

      // Scroll the terminal to reveal more content in the direction user is
      // dragging, through the viewport API: unlike the unwired write it
      // cancels a smooth scroll and keeps the target with the view. A drag
      // upward (direction -1) grows the offset, a downward one shrinks it.
      this.terminal.viewport.scrollBy(-SelectionManager.AUTO_SCROLL_SPEED * this.autoScrollDirection);

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
    if (!this.selectionStart || !this.selectionEnd) return null;

    let { col: startCol, absoluteRow: startAbsRow } = this.selectionStart;
    let { col: endCol, absoluteRow: endAbsRow } = this.selectionEnd;

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
   * The word under a cell, carried across the soft wraps that join its
   * rows, as xterm.js's double click does. Null when the cell holds no
   * word character.
   */
  private wordAcrossWraps(col: number, absoluteRow: number): { start: SelectionAnchor; end: SelectionAnchor } | null {
    const cells = this.readCells(absoluteRow);
    if (!cells || !isWordCell(cells.at(col))) return null;
    let start = { col, absoluteRow };
    let startCells = cells;
    for (;;) {
      while (start.col > 0 && isWordCell(startCells.at(start.col - 1))) start.col--;
      if (start.col > 0 || !this.continuesAbove(start.absoluteRow)) break;
      const above = this.readCells(start.absoluteRow - 1);
      if (!above || !isWordCell(above.at(above.length - 1))) break;
      start = { col: above.length - 1, absoluteRow: start.absoluteRow - 1 };
      startCells = above;
    }
    let end = { col, absoluteRow };
    let endCells = cells;
    for (;;) {
      while (end.col < endCells.length - 1 && isWordCell(endCells.at(end.col + 1))) end.col++;
      if (end.col < endCells.length - 1 || !this.continuesAbove(end.absoluteRow + 1)) break;
      const below = this.readCells(end.absoluteRow + 1);
      if (!below || !isWordCell(below.at(0))) break;
      end = { col: 0, absoluteRow: end.absoluteRow + 1 };
      endCells = below;
    }
    return { start, end };
  }

  /**
   * The whole line a row belongs to, every row a soft wrap joins to it,
   * to its last cell that is not blank, the way xterm.js's triple click
   * selects it. Null when the line is blank.
   */
  private lineAcrossWraps(absoluteRow: number): { start: SelectionAnchor; end: SelectionAnchor } | null {
    let first = absoluteRow;
    while (first > 0 && this.continuesAbove(first)) first--;
    let last = absoluteRow;
    while (this.continuesAbove(last + 1)) last++;
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
   * Whether row `row` continues the row above it through a soft wrap.
   */
  private continuesAbove(absoluteRow: number): boolean {
    const history = this.wasmTerm.getScrollbackLength();
    return absoluteRow < history
      ? this.wasmTerm.isScrollbackRowWrapped(absoluteRow)
      : this.wasmTerm.isRowWrapped(absoluteRow - history);
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
   * Read absolute row `row` (history first, then the screen) into this.cells.
   * False when there is no such row.
   */
  private readAbsoluteRow(row: number, scrollbackLength: number): boolean {
    return row < scrollbackLength
      ? this.wasmTerm.readHistoryRow(row, this.cells)
      : this.wasmTerm.readRow(row - scrollbackLength, this.cells);
  }

  /**
   * A copy goes to the terminal's writer when one is set, else to the
   * widget's own clipboard write.
   */
  private writeCopy(text: string): void {
    if (this.copy) this.copy(text);
    else this.copyToClipboard(text);
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
