import type { TerminalViewport } from "@chan/ghostty-web-ng";

/// Chan-specific wheel calibration, and the write chan's output takes to
/// the terminal. The widget owns output following.

/// Compatibility constant, not a preference: macOS trackpads deliver pixel
/// deltas that Ghostty converts to roughly twice xterm.js's travel on the
/// same content, and 0.5 is the current parity invariant with xterm.js,
/// revisited only by owner calibration on macOS hardware.
export const GHOSTTY_MACOS_PIXEL_SCROLL_FACTOR = 0.5;

// WheelEvent.DOM_DELTA_PIXEL; compared against a literal so the module never
// touches the WheelEvent global (absent in some test environments).
const DOM_DELTA_PIXEL = 0;

export type GhosttyViewportTerminal = {
  readonly viewport: Pick<TerminalViewport, "scrollBy">;
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

  write(data: string | Uint8Array): void {
    this.terminal.write(data);
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
