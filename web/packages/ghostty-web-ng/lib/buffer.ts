/**
 * Buffer API - read-only terminal buffer access
 *
 * Wraps Ghostty WASM terminal contents.
 *
 * Usage:
 * ```typescript
 * const cell = term.buffer.active.getLine(0)?.getCell(5);
 * console.log(cell?.getChars(), cell?.getWidth());
 *
 * if (term.buffer.active.type === 'alternate') {
 *   console.log('Full-screen app running');
 * }
 * ```
 */

import { ABI, VtCells, type VtCell, type VtTerminal } from '../vt/ghosttyVt';
import type {
  IBuffer,
  IBufferCell,
  IBufferLine,
  IBufferNamespace,
} from './interfaces';

/// A cell nothing was written to, in ghostty-web's default colours.
function nullCell(): VtCell {
  return {
    codepoint: 0,
    cluster: null,
    width: 1,
    flags: 0,
    fg: 0xcccccc,
    bg: 0x000000,
    defaultBg: true,
    underline: ABI.GhosttySgrUnderline.NONE,
    underlineColor: null,
    hyperlink: 0,
  };
}

// ============================================================================
// BufferNamespace - Top-level buffer API
// ============================================================================

/**
 * Top-level buffer API namespace
 * Provides access to active, normal, and alternate screen buffers
 */
export class BufferNamespace implements IBufferNamespace {
  #readCore: () => VtTerminal | undefined;

  // Lazy-initialized buffer wrappers (stateless, so we can cache them)
  #_normalBuffer?: Buffer;
  #_alternateBuffer?: Buffer;

  constructor(readCore: () => VtTerminal | undefined) {
    this.#readCore = readCore;
  }

  get active(): IBuffer {
    // Query WASM to determine which buffer is active
    const wasmTerm = this.#readCore();
    if (!wasmTerm) {
      return this.normal; // Default to normal if not initialized
    }

    return wasmTerm.isAlternateScreen() ? this.alternate : this.normal;
  }

  get normal(): IBuffer {
    if (!this.#_normalBuffer) {
      this.#_normalBuffer = new Buffer(this.#readCore, 'normal');
    }
    return this.#_normalBuffer;
  }

  get alternate(): IBuffer {
    if (!this.#_alternateBuffer) {
      this.#_alternateBuffer = new Buffer(this.#readCore, 'alternate');
    }
    return this.#_alternateBuffer;
  }
}

// ============================================================================
// Buffer - Represents a terminal buffer (normal or alternate)
// ============================================================================

/**
 * A terminal buffer (normal or alternate screen)
 */
export class Buffer implements IBuffer {
  #readCore: () => VtTerminal | undefined;
  #bufferType: 'normal' | 'alternate';
  // A view for each screen row its lines are read into, which reads nothing
  // while its row is unchanged.
  #screenRows: VtCells[] = [];

  constructor(readCore: () => VtTerminal | undefined, type: 'normal' | 'alternate') {
    this.#readCore = readCore;
    this.#bufferType = type;
  }

  get type(): 'normal' | 'alternate' {
    return this.#bufferType;
  }

  get length(): number {
    const wasmTerm = this.#getWasmTerm();
    if (!wasmTerm) return 0;

    if (this.#bufferType === 'alternate') {
      // Alternate buffer has no scrollback, just visible rows
      return wasmTerm.rows;
    } else {
      // Normal buffer: scrollback + visible rows
      const scrollback = wasmTerm.getScrollbackLength();
      return scrollback + wasmTerm.rows;
    }
  }

  getLine(y: number): IBufferLine | undefined {
    const wasmTerm = this.#getWasmTerm();
    if (!wasmTerm) return undefined;

    // Check bounds
    if (y < 0 || y >= this.length) {
      return undefined;
    }

    // Determine if accessing scrollback or visible screen. A screen row's
    // line reads into the view the buffer keeps for that row, which reads
    // nothing while the row is unchanged, so a line or cell held after the
    // row changed shows it as the row's next read found it; as with
    // xterm.js's lines, read a line when it is used. A history row's line
    // reads into a view of its own.
    const scrollbackLength = wasmTerm.getScrollbackLength();
    let cells: VtCells;
    let read: boolean;
    let isWrapped: boolean;

    if (this.#bufferType === 'normal' && y < scrollbackLength) {
      // Accessing scrollback
      // History rows: offset 0 = oldest, offset (length-1) = newest
      // Buffer coords: y=0 = oldest, y=(length-1) = newest
      // So the history offset is y directly!
      cells = new VtCells();
      read = wasmTerm.readHistoryRow(y, cells);
      // TODO: We'd need WASM API to check if scrollback line is wrapped
      // For now, assume not wrapped
      isWrapped = false;
    } else {
      // Accessing visible screen
      const lineNumber = this.#bufferType === 'normal' ? y - scrollbackLength : y;
      cells = this.#screenRows[lineNumber] ??= new VtCells();
      read = wasmTerm.readRow(lineNumber, cells);
      isWrapped = wasmTerm.isRowWrapped(lineNumber);
    }

    if (!read) {
      return undefined;
    }

    return new BufferLine(cells, isWrapped, wasmTerm.cols);
  }

  #getWasmTerm(): VtTerminal | undefined {
    return this.#readCore();
  }
}

// ============================================================================
// BufferLine - Represents a single line in the buffer
// ============================================================================

/**
 * A single line in the buffer
 */
export class BufferLine implements IBufferLine {
  #cells: VtCells;
  #_isWrapped: boolean;
  #_length: number;

  constructor(cells: VtCells, isWrapped: boolean, length: number) {
    this.#cells = cells;
    this.#_isWrapped = isWrapped;
    this.#_length = length;
  }

  get length(): number {
    return this.#_length;
  }

  get isWrapped(): boolean {
    return this.#_isWrapped;
  }

  getCell(x: number): IBufferCell | undefined {
    if (x < 0 || x >= this.#_length) {
      return undefined;
    }

    const cell = this.#cells.at(x);
    if (!cell) {
      // Cell beyond what was returned (empty/null cell)
      return new BufferCell(nullCell());
    }

    return new BufferCell(cell);
  }

  translateToString(trimRight = false, startColumn = 0, endColumn = this.#_length): string {
    // Clamp bounds
    const start = Math.max(0, Math.min(startColumn, this.#_length));
    const end = Math.max(start, Math.min(endColumn, this.#_length));

    let result = '';
    for (let x = start; x < end; x++) {
      const cell = this.getCell(x);
      if (cell) {
        const chars = cell.getChars();
        result += chars;
      }
    }

    if (trimRight) {
      result = result.trimEnd();
    }

    return result;
  }
}

// ============================================================================
// BufferCell - Represents a single cell in the buffer
// ============================================================================

/**
 * A single cell in the buffer
 */
export class BufferCell implements IBufferCell {
  #cell: VtCell;

  constructor(cell: VtCell) {
    this.#cell = cell;
  }

  getChars(): string {
    const codepoint = this.#cell.codepoint;

    // Return empty string for null character or invalid codepoints
    if (codepoint === 0) {
      return '';
    }

    // Validate codepoint is within valid Unicode range
    // Valid: 0x0000 to 0x10FFFF, excluding surrogates (0xD800-0xDFFF)
    if (codepoint < 0 || codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff)) {
      // Return replacement character for invalid codepoints
      return '\uFFFD';
    }

    return String.fromCodePoint(codepoint);
  }

  getWidth(): number {
    return this.#cell.width;
  }

  /**
   * Get hyperlink ID for this cell (0 = no link)
   * Used by link detection system
   */
  getHyperlinkId(): number {
    return this.#cell.hyperlink;
  }

  /**
   * Get the Unicode codepoint for this cell
   * Used by link detection system
   */
  getCodepoint(): number {
    return this.#cell.codepoint;
  }
}
