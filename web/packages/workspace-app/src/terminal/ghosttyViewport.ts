/// Single owner for every Chan-initiated Ghostty viewport mutation on the
/// primary buffer: PTY writes that must not yank a user-anchored viewport,
/// the calibrated macOS pixel-scroll path, and find scrolling to a match.
/// ghostty-web is constructed with smoothScrollDuration 0 so its wheel
/// handler applies synchronously and no private animation target can
/// outlive a write-side restore; the controller's restore therefore sticks.
/// It is also where a reader of the core hears of every change to what the
/// terminal holds (`observeChanges`).

/// Compatibility constant, not a preference: macOS trackpads deliver pixel
/// deltas that Ghostty converts to roughly twice xterm.js's travel on the
/// same content, and 0.5 is the current parity invariant with xterm.js,
/// revisited only by owner calibration on macOS hardware.
export const GHOSTTY_MACOS_PIXEL_SCROLL_FACTOR = 0.5;

// WheelEvent.DOM_DELTA_PIXEL; compared against a literal so the module never
// touches the WheelEvent global (absent in some test environments).
const DOM_DELTA_PIXEL = 0;

export type GhosttyViewportTerminal = {
  readonly rows: number;
  getViewportY(): number;
  getScrollbackLength(): number;
  scrollLines(amount: number): void;
  scrollToLine(line: number): void;
  write(data: string | Uint8Array): void;
  /// ghostty-web's resize event: it fires once the core has the new grid,
  /// before ghostty-web repaints it, whoever called `resize`.
  onResize(listener: (size: { cols: number; rows: number }) => void): { dispose(): void };
};

/// A change to what the terminal holds: output written, or the grid
/// resized, which reflows the screen and its history.
export type GhosttyChange = "write" | "resize";

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
  private readonly changeObservers = new Set<(change: GhosttyChange) => void>();

  constructor(
    private readonly terminal: GhosttyViewportTerminal,
    private readonly context: GhosttyViewportContext,
  ) {
    // Lives as long as the terminal, whose disposal ends the subscription.
    terminal.onResize(() => this.notify("resize"));
  }

  /// Calls `observer` after every change to what the terminal holds, so a
  /// reader of the core that keeps state across changes (find's search)
  /// learns of them without a hook of its own: each write through `write`,
  /// the one path chan's writes to the terminal take (PTY output and the
  /// lines chan prints itself), and each resize, heard from ghostty-web's
  /// own resize event so that no caller can resize around it. A resize is
  /// reported before ghostty-web repaints the new grid, so an observer can
  /// take a mark off rows the reflow gave other text before they are drawn.
  /// Returns the call that stops it.
  observeChanges(observer: (change: GhosttyChange) => void): () => void {
    this.changeObservers.add(observer);
    return () => {
      this.changeObservers.delete(observer);
    };
  }

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
    } else {
      const scrollbackBefore = this.terminal.getScrollbackLength();
      this.terminal.write(data);
      const scrollbackAfter = this.terminal.getScrollbackLength();
      const appendedLines = Math.max(0, scrollbackAfter - scrollbackBefore);
      this.terminal.scrollToLine(
        Math.min(scrollbackAfter, viewportBefore + appendedLines),
      );
    }
    this.notify("write");
  }

  private notify(change: GhosttyChange): void {
    for (const observer of this.changeObservers) observer(change);
  }

  /// Bring absolute row `row` into view: 0 is the oldest history row and the
  /// active rows follow, the numbering of ghostty-web's selection anchors. A
  /// row already on screen leaves the viewport where it is; any other is
  /// centred, clamped to the buffer. ghostty-web's viewport offset counts
  /// the lines scrolled back from the bottom, so screen row `row -
  /// scrollback + offset` shows `row`, and `scrollToLine` sets that offset,
  /// although its doc comment describes a line counted from the top. The
  /// alternate screen has no history: its scrollback length is 0, its rows
  /// are its own, and the offset clamps to 0.
  reveal(row: number): void {
    const scrollback = this.terminal.getScrollbackLength();
    const rows = this.terminal.rows;
    const onScreen = row - scrollback + this.terminal.getViewportY();
    if (onScreen >= 0 && onScreen < rows) return;
    const centred = scrollback - row + Math.floor(rows / 2);
    this.terminal.scrollToLine(Math.max(0, Math.min(scrollback, centred)));
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
