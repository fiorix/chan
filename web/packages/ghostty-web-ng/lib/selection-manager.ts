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
  private selectionStart: { col: number; absoluteRow: number } | null = null;
  private selectionEnd: { col: number; absoluteRow: number } | null = null;
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
    textarea: HTMLTextAreaElement
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

  /**
   * Get the selected text as a string
   */
  getSelection(): string {
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
      this.copyToClipboard(text);
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
   * Select all text in the terminal
   */
  selectAll(): void {
    const dims = this.wasmTerm.getDimensions();
    const viewportY = this.getViewportY();
    this.selectionStart = { col: 0, absoluteRow: viewportY };
    this.selectionEnd = { col: dims.cols - 1, absoluteRow: viewportY + dims.rows - 1 };
    this.requestRender();
    this.selectionChangedEmitter.fire();
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
      // A touch drag is no selection gesture of its own: before this
      // stage a touch drag never selected, and touch selection stays a
      // design of its own. Only the primary pointer of a mouse or pen
      // press starts a drag.
      if (e.pointerType === 'touch' || e.isPrimary === false) return;
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
    // never fire pointer events. After a real pointer press the widget
    // focuses the textarea for the keyboard first, so this listener moves
    // the keyboard back to the parent. It is load-bearing, not a leftover.
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
        // A move with no button pressed ends a drag whose release the
        // canvas never saw (its element detached, capture lost without
        // the event). The press is stale, so the drag is dropped rather
        // than kept selecting.
        if ((e.buttons & 1) === 0) {
          this.clearSelection();
          endDrag(false);
          return;
        }
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
        // Past an edge the clamped cell keeps the pointer's column, which
        // reads as a sliver: above the canvas the drag starts at column
        // zero, past the bottom it runs to the last column.
        const col = y < 0 ? 0 : y > rect.height ? this.terminal.cols - 1 : cell.col;
        this.selectionEnd = { col, absoluteRow };
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
            this.copyToClipboard(text);
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
        // Double-click - select word
        const cell = this.pixelToCell(at.x, at.y);
        const word = this.getWordAtCell(cell.col, cell.row);

        if (word) {
          const absoluteRow = this.viewportRowToAbsolute(cell.row);
          this.selectionStart = { col: word.startCol, absoluteRow };
          this.selectionEnd = { col: word.endCol, absoluteRow };
          this.requestRender();

          const text = this.getSelection();
          if (text) {
            this.copyToClipboard(text);
            this.selectionChangedEmitter.fire();
          }
        }
      } else if (e.detail >= 3) {
        // Triple-click (or more) - select line content (like native Ghostty)
        const cell = this.pixelToCell(at.x, at.y);
        const absoluteRow = this.viewportRowToAbsolute(cell.row);

        // Find actual line length (exclude trailing empty cells)
        // Use scrollback-aware line retrieval (like getSelection does)
        const scrollbackLength = this.wasmTerm.getScrollbackLength();
        // Find last non-empty cell (-1 means empty line)
        let endCol = -1;
        if (this.readAbsoluteRow(absoluteRow, scrollbackLength)) {
          const line = this.cells;
          for (let i = line.length - 1; i >= 0; i--) {
            const cell = line.at(i)!;
            if (cell.codepoint !== 0 && cell.codepoint !== 32) {
              endCol = i;
              break;
            }
          }
        }

        // Only select if line has content (endCol >= 0)
        if (endCol >= 0) {
          // Select line content only (not trailing whitespace)
          this.selectionStart = { col: 0, absoluteRow };
          this.selectionEnd = { col: endCol, absoluteRow };
          this.requestRender();

          const text = this.getSelection();
          if (text) {
            this.copyToClipboard(text);
            this.selectionChangedEmitter.fire();
          }
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

    // A click outside the terminal element keeps the selection, which
    // find reads as its active-match highlight. A press inside the canvas
    // starts a new drag and clears the old selection there.
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
      // dragging, through the viewport API, which cancels a smooth scroll
      // and keeps the target with the view. A drag
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
   * Get word boundaries at a cell position
   */
  private getWordAtCell(col: number, row: number): { startCol: number; endCol: number } | null {
    const absoluteRow = this.viewportRowToAbsolute(row);
    const scrollbackLength = this.wasmTerm.getScrollbackLength();
    if (!this.readAbsoluteRow(absoluteRow, scrollbackLength)) return null;
    const line = this.cells;

    // Word characters: letters, numbers, and common path/URL characters
    // Matches native Ghostty behavior where double-click selects entire paths
    // Includes: / (path sep), . (extensions), ~ (home), @ (emails), + (encodings)
    const isWordChar = (cell: VtCell | undefined) => {
      if (!cell || cell.codepoint === 0) return false;
      const char = String.fromCodePoint(cell.codepoint);
      return /[\w\-./~@+]/.test(char);
    };

    // Only return if we're actually on a word character
    if (!isWordChar(line.at(col))) return null;

    // Find start of word
    let startCol = col;
    while (startCol > 0 && isWordChar(line.at(startCol - 1))) {
      startCol--;
    }

    // Find end of word
    let endCol = col;
    while (endCol < line.length - 1 && isWordChar(line.at(endCol + 1))) {
      endCol++;
    }

    return { startCol, endCol };
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
