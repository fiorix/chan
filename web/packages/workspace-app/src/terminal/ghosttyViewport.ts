import type { TerminalChange, TerminalViewport } from "@chan/ghostty-web-ng";

/// Chan-specific wheel calibration and the view queries used by find.
/// The widget owns output following and publishes every parsed change.

/// Compatibility constant, not a preference: macOS trackpads deliver pixel
/// deltas that Ghostty converts to roughly twice xterm.js's travel on the
/// same content, and 0.5 is the current parity invariant with xterm.js,
/// revisited only by owner calibration on macOS hardware.
export const GHOSTTY_MACOS_PIXEL_SCROLL_FACTOR = 0.5;

// WheelEvent.DOM_DELTA_PIXEL; compared against a literal so the module never
// touches the WheelEvent global (absent in some test environments).
const DOM_DELTA_PIXEL = 0;

/// The whole history rows a view at viewport offset `offset` shows above the
/// screen. A pixel scroll leaves the offset a fraction of a row back, and
/// ghostty-web's renderer, hover and selection and chan's masker all read it
/// through its floor, so a view less than a row back is the bottom view, its
/// prompt and cursor included. Every decision here about where the view is
/// reads the offset through this.
export function ghosttyHistoryRows(offset: number): number {
  return Math.max(0, Math.floor(offset));
}

export type GhosttyViewportTerminal = {
  readonly rows: number;
  readonly viewport: TerminalViewport;
  getScrollbackLength(): number;
  write(data: string | Uint8Array): void;
  onChange(listener: (change: TerminalChange) => void): { dispose(): void };
};

export type GhosttyChange = TerminalChange["kind"];

export type GhosttyWheelEvent = Pick<WheelEvent, "deltaY" | "deltaMode">;

/// Live terminal state the wheel decision depends on. Functions rather than
/// values: mouse tracking, buffer ownership, and cell metrics all change
/// while the terminal runs.
export type GhosttyViewportContext = {
  os(): string;
  hasMouseTracking(): boolean;
  isAlternateScreen(): boolean;
  cellHeight(): number;
};

export class GhosttyViewportController {
  constructor(
    private readonly terminal: GhosttyViewportTerminal,
    private readonly context: GhosttyViewportContext,
  ) {}

  /// The widget delivers changes before painting, including writes made by
  /// callers outside this adapter. The returned function ends the subscription.
  observeChanges(observer: (change: GhosttyChange) => void): () => void {
    const subscription = this.terminal.onChange(({ kind }) => observer(kind));
    return () => subscription.dispose();
  }

  write(data: string | Uint8Array): void {
    this.terminal.write(data);
  }

  reveal(row: number): void {
    this.terminal.viewport.reveal(row, "center");
  }

  /// Whether absolute row `row`, numbered as `reveal` numbers it, is on the
  /// screen. `rows` is the screen's height, the terminal's own unless given:
  /// while a resize is under way ghostty-web has already set its new row
  /// count, though the core still holds the old grid until the resize
  /// reaches it, so a reader of the grid as it was passes the old count.
  shows(row: number, rows = this.terminal.rows): boolean {
    const onScreen = row - this.terminal.getScrollbackLength() + ghosttyHistoryRows(this.terminal.viewport.offset);
    return onScreen >= 0 && onScreen < rows;
  }

  /// Claim only macOS pixel-mode primary-buffer wheel events with no mouse
  /// tracking and apply the calibrated travel through the public fractional
  /// scroll API. Fractional rows land directly in Ghostty's viewport, so a
  /// slow gesture accumulates without a dead zone and never quantizes to a
  /// whole row. Every other event (line/page deltas, non-macOS, alternate
  /// screen, mouse tracking) declines and keeps its current owner.
  handleWheel(e: GhosttyWheelEvent): boolean {
    if (
      this.context.os() !== "mac" ||
      e.deltaMode !== DOM_DELTA_PIXEL ||
      this.context.hasMouseTracking() ||
      this.context.isAlternateScreen()
    ) {
      return false;
    }

    const cellHeight = this.context.cellHeight();
    if (!Number.isFinite(cellHeight) || cellHeight <= 0) return false;

    const rows = (e.deltaY * GHOSTTY_MACOS_PIXEL_SCROLL_FACTOR) / cellHeight;
    if (rows !== 0) this.terminal.viewport.scrollBy(-rows);
    return true;
  }
}
