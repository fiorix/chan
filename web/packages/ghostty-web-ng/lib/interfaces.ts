/**
 * Terminal options and buffer interfaces
 */

import type { GhosttyVt, VtSearch, VtTerminal, VtTrackedCell } from '../vt/ghosttyVt';
import type { HighlightRange, HighlightStyle } from './highlights';

export interface ITerminalOptions {
  cols?: number; // Default: 80
  rows?: number; // Default: 24
  cursorBlink?: boolean; // Default: false
  cursorStyle?: 'block' | 'underline' | 'bar';
  theme?: ITheme;
  scrollback?: number; // Default: 10000
  fontSize?: number; // Default: 15
  fontFamily?: string; // Default: 'monospace'
  /** Cell-height multiplier, at least 1; defaults to 1. Construction only. */
  lineHeight?: number;
  /** Draw supported box and block characters as cell paths. Defaults to false. Construction only. */
  boxGlyphs?: boolean;
  /** Composite the scrollbar over content. Omit for the background strip. Construction only. */
  scrollbar?: 'overlay';
  disableStdin?: boolean; // Disable keyboard input (default: false)

  /** Test-only paint controls. Omit in production. */
  testHooks?: TerminalTestHooks;

  // Scrolling options
  smoothScrollDuration?: number; // Duration in ms for smooth scroll animation (default: 100, 0 = instant)

  // The core this terminal runs on, through chan's libghostty-vt binding.
  ghostty: GhosttyVt;

  /** Receives automatic and explicit widget copies; defaults to the clipboard. */
  copy?: (text: string) => void;
  /** Asked on each text read and word/line click; defaults to false. */
  joinDrawnWraps?: () => boolean;
}

/** Test-only instrumentation; observe repaints with an ordinary paint layer. */
export interface TerminalTestHooks {
  /** Fixed paint opacity in [0, 1], disabling automatic scrollbar fades while set. */
  scrollbarOpacity?: number;
}

export interface ITheme {
  /** Cell ink contrast before faint/antialiasing; default 1, invalid values use 1. */
  minimumContrastRatio?: number;
  foreground?: string;
  background?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;

  // ANSI colors (0-15)
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

export interface IDisposable {
  dispose(): void;
}

export type IEvent<T> = (listener: (arg: T) => void) => IDisposable;

/** A parsed write or a completed grid resize, delivered before painting. */
export type TerminalChange = { kind: 'write' | 'resize' };

/** Read-only terminal access; every member throws TerminalCoreDisposedError after disposal. */
export type TerminalCore = Readonly<Pick<VtTerminal,
  'cols' | 'getScrollbackLength' | 'getDimensions' | 'plainText' | 'readRow' | 'readHistoryRow' |
  'isRowWrapped' | 'isScrollbackRowWrapped' | 'encodePaste'
>> & {
  readonly beforeResize: (listener: (from: Readonly<{ cols: number; rows: number }>) => void) => () => void;
  readonly createSearch: () => TerminalCoreSearch;
  readonly trackCell: (row: number, col: number) => TerminalCoreTrackedCell | null;
};

/** Owns only its search state. Free is idempotent; terminal disposal also releases it. */
export type TerminalCoreSearch = Readonly<Pick<VtSearch,
  'setNeedle' | 'restart' | 'step' | 'feed' | 'selectNext' | 'selectPrev' | 'caughtUp' |
  'state' | 'matchesBetween' | 'indexOfMatchAt' | 'completingUnitMs' | 'free'
>>;

/** Owns only its tracked point. Free is idempotent; terminal disposal also releases it. */
export type TerminalCoreTrackedCell = Readonly<Pick<VtTrackedCell, 'point' | 'moveTo' | 'free'>>;

/** Which provider found a link: an OSC 8 hyperlink or a URL in the text. */
export type TerminalLinkKind = 'osc8' | 'url';

/**
 * A click on a link the terminal underlines. `target` is the real target,
 * the OSC 8 URI exactly as the program wrote it or the matched URL, which can
 * differ from the text on the screen and is not to be trusted. `range` is the
 * link's cells, absolute rows (0 is the oldest history row), both ends
 * included. `event` is the click.
 */
export interface TerminalLinkActivation {
  readonly target: string;
  readonly kind: TerminalLinkKind;
  readonly range: {
    readonly start: { readonly x: number; readonly y: number };
    readonly end: { readonly x: number; readonly y: number };
  };
  readonly event: MouseEvent;
}

export interface TerminalViewport {
  /** Rows back from the bottom; fractions accumulate between pixel-wheel events. */
  readonly offset: number;
  /** Offsets below one row follow output while retaining their fraction. */
  readonly followOutput: 'at-bottom';
  /** Set the bottom-relative offset, clamped to retained history. */
  scrollTo(offset: number): void;
  /** Add rows to the offset: positive moves toward older output. */
  scrollBy(rows: number): void;
  /** Return to live output and cancel pending smooth scrolling. */
  scrollToBottom(): void;
  /** Reveal an absolute buffer row; leave a visible row in place. */
  reveal(row: number, align?: 'start' | 'center' | 'end'): void;
}

/** Named paint independent of selection, copy and content-change events. */
export interface TerminalHighlights {
  /** Replace a layer with copied, ordered ranges and style; invalid coordinates throw while open. */
  set(name: string, ranges: readonly HighlightRange[], style?: HighlightStyle): void;
  /** Remove only this layer, repainting its previous coverage; false if absent. */
  clear(name: string): boolean;
  /** A fresh snapshot, or undefined when absent, before open or after disposal. */
  get(name: string): { ranges: readonly HighlightRange[]; style: Readonly<HighlightStyle> } | undefined;
}

/**
 * Keyboard event with key and DOM event
 */
export interface IKeyEvent {
  key: string;
  domEvent: KeyboardEvent;
}

// ============================================================================
// Buffer API Interfaces (xterm.js compatibility)
// ============================================================================

/**
 * Top-level buffer API namespace
 * Provides access to active, normal, and alternate screen buffers
 */
export interface IBufferNamespace {
  /** The currently active buffer (normal or alternate) */
  readonly active: IBuffer;
  /** The normal buffer (primary screen) */
  readonly normal: IBuffer;
  /** The alternate buffer (used by full-screen apps like vim) */
  readonly alternate: IBuffer;
}

/**
 * A terminal buffer (normal or alternate screen)
 */
export interface IBuffer {
  /** Buffer type: 'normal' or 'alternate' */
  readonly type: 'normal' | 'alternate';
  /** Total buffer length (rows + scrollback for normal, just rows for alternate) */
  readonly length: number;

  /**
   * Get a line from the buffer
   * @param y Line index (0 = top of scrollback for normal buffer)
   * @returns Line object or undefined if out of bounds
   */
  getLine(y: number): IBufferLine | undefined;
}

/**
 * A single line in the buffer
 */
export interface IBufferLine {
  /** Length of the line (in columns) */
  readonly length: number;
  /** Whether this line wraps to the next line */
  readonly isWrapped: boolean;

  /**
   * Get a cell from this line
   * @param x Column index (0-indexed)
   * @returns Cell object or undefined if out of bounds
   */
  getCell(x: number): IBufferCell | undefined;

  /**
   * Translate the line to a string
   * @param trimRight Whether to trim trailing whitespace (default: false)
   * @param startColumn Start column (default: 0)
   * @param endColumn End column (default: length)
   * @returns String representation of the line
   */
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

/**
 * A single cell in the buffer
 */
export interface IBufferCell {
  /** Character(s) in this cell (may be empty, single char, or emoji) */
  getChars(): string;
  /** Character width (1 = normal, 2 = wide/emoji, 0 = combining) */
  getWidth(): number;

  // Link detection support
  /** Get hyperlink ID for this cell (0 = no link) */
  getHyperlinkId(): number;
  /** Get the Unicode codepoint for this cell */
  getCodepoint(): number;
}
