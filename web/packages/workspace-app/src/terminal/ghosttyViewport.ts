/// Single owner for every Chan-initiated Ghostty viewport mutation on the
/// primary buffer: PTY writes that must not yank a user-anchored viewport,
/// and the calibrated macOS pixel-scroll path. ghostty-web is constructed
/// with smoothScrollDuration 0 so its wheel handler applies synchronously
/// and no private animation target can outlive a write-side restore; the
/// controller's restore therefore sticks.

/// Compatibility constant, not a preference: macOS trackpads deliver pixel
/// deltas that Ghostty converts to roughly twice xterm.js's travel on the
/// same content, and 0.5 is the current parity invariant with xterm.js,
/// revisited only by owner calibration on macOS hardware.
export const GHOSTTY_MACOS_PIXEL_SCROLL_FACTOR = 0.5;

// WheelEvent.DOM_DELTA_PIXEL; compared against a literal so the module never
// touches the WheelEvent global (absent in some test environments).
const DOM_DELTA_PIXEL = 0;

export type GhosttyViewportTerminal = {
  getViewportY(): number;
  getScrollbackLength(): number;
  scrollLines(amount: number): void;
  scrollToLine(line: number): void;
  write(data: string | Uint8Array): void;
};

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

  /// ghostty-web calls scrollToBottom() after every write whenever the
  /// viewport is away from the bottom. Restore a user's scrolled viewport
  /// immediately after the synchronous WASM write, advancing the distance
  /// from bottom as new scrollback lines are appended. A viewport at the
  /// bottom keeps following output natively. Writes never feed the wheel
  /// path, so programmatic output cannot masquerade as user scroll input.
  write(data: string | Uint8Array): void {
    const viewportBefore = this.terminal.getViewportY();
    if (viewportBefore <= 0) {
      this.terminal.write(data);
      return;
    }

    const scrollbackBefore = this.terminal.getScrollbackLength();
    this.terminal.write(data);
    const scrollbackAfter = this.terminal.getScrollbackLength();
    const appendedLines = Math.max(0, scrollbackAfter - scrollbackBefore);
    this.terminal.scrollToLine(
      Math.min(scrollbackAfter, viewportBefore + appendedLines),
    );
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
    if (rows !== 0) this.terminal.scrollLines(rows);
    return true;
  }
}
