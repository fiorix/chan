import type { PaintFrame, PaintLayer } from "@chan/ghostty-web-ng";
import {
  findSecretMaskSpans,
  SecretAssignmentMatcher,
  type MaskGroupLine,
  type MaskLine,
  type SecretMaskSpan,
} from "./secretMasking";

/// The active buffer as the painter reads it: ghostty-web's IBuffer.
export type GhosttyMaskBuffer = {
  readonly type: "normal" | "alternate";
  readonly length: number;
  getLine(y: number): MaskLine | undefined;
};

/// What the painter uses of a ghostty terminal, all of it the widget's
/// public surface: the active buffer, the paint layers, the content-change
/// event, a full repaint, and the metrics, which are undefined while the
/// widget is not open and retains no layer.
export type GhosttyMaskTerminal = {
  readonly buffer: { readonly active: GhosttyMaskBuffer };
  getMetrics(): unknown;
  addPaintLayer(layer: PaintLayer): () => void;
  onChange(listener: () => void): { dispose(): void };
  refresh(): void;
};

/// The state a frame's spans were read at. A frame whose key matches the
/// last one, with nothing written or resized since, keeps its spans.
type FrameKey = {
  type: "normal" | "alternate";
  length: number;
  top: number;
  cols: number;
  rows: number;
};

/// Masks a ghostty terminal by painting over its canvas.
///
/// The painter is the widget's `mask` paint layer: the widget calls it last
/// in every frame that repaints rows, after the cells, the selection, the
/// cursor, the scrollbar and every other layer, with the canvas clipped to
/// the rows it repainted. So the mask is on screen in the same frame as the
/// value under it, with no overlay element to lag a frame behind a scroll,
/// and the buffer, selection and copy are untouched. A row the frame did not
/// repaint keeps the mask an earlier frame gave it. The visible rows are
/// rescanned only when the viewport, the grid or the buffer changed, or the
/// widget reported a write or a resize; any other frame repaints the cached
/// spans, which is a few rectangles. A rescan that changes the spans of a
/// row the frame did not repaint (a wrapped value whose name changed rows
/// above it) asks the widget for a full repaint, which is the next frame.
/// Ghostty draws visible row r at r times the cell height whatever the
/// fraction of the viewport offset, so a fractional offset maps rows as its
/// floor does.
///
/// The layer is registered only while masking is on: adding or removing it
/// has the widget repaint every row at its next frame, which is how a
/// toggle draws or clears the masks.
///
/// Writes and resizes reach the painter through the widget's change event,
/// so a reflow rescans with no request from the tab.
export class GhosttySecretMasker {
  readonly #term: GhosttyMaskTerminal;
  readonly #matcher: SecretAssignmentMatcher;
  readonly #onError: (() => void) | null;
  #removeLayer: (() => void) | null = null;
  #changes: { dispose(): void } | null = null;
  #spans: SecretMaskSpan[] = [];
  #frame: FrameKey | null = null;
  #rescan = true;
  #enabled: boolean;
  #color: string;
  #disposed = false;

  constructor(
    term: GhosttyMaskTerminal,
    suffixes: readonly string[],
    color: string,
    enabled: boolean,
    onError?: () => void,
  ) {
    this.#term = term;
    this.#matcher = new SecretAssignmentMatcher(suffixes);
    this.#color = color;
    this.#enabled = enabled;
    this.#onError = onError ?? null;
    if (enabled) this.#install();
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /// Spans on the visible rows at the last frame that repainted rows.
  get maskCount(): number {
    return this.#spans.length;
  }

  setEnabled(enabled: boolean): void {
    if (this.#disposed || enabled === this.#enabled) return;
    this.#enabled = enabled;
    if (enabled) this.#install();
    else this.#uninstall();
  }

  /// The masks on screen are pixels of earlier frames, so a new colour
  /// takes a repaint of every row.
  setColor(color: string): void {
    if (this.#disposed || color === this.#color) return;
    this.#color = color;
    if (this.#removeLayer && this.#spans.length > 0) this.#term.refresh();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#uninstall();
  }

  #install(): void {
    if (this.#removeLayer) return;
    try {
      if (this.#term.getMetrics() === undefined) throw new Error("the terminal is not open");
      this.#removeLayer = this.#term.addPaintLayer({
        order: "mask",
        paint: (frame) => this.#paintFrame(frame),
      });
    } catch (error) {
      this.#fail("ghostty secret masking paint layer unavailable", error);
      return;
    }
    this.#changes = this.#term.onChange(() => {
      this.#rescan = true;
    });
    this.#rescan = true;
  }

  /// Drops the layer and every span; the widget's next frame redraws the
  /// rows they covered.
  #uninstall(): void {
    this.#removeLayer?.();
    this.#removeLayer = null;
    this.#changes?.dispose();
    this.#changes = null;
    this.#spans = [];
    this.#frame = null;
  }

  /// One frame's mask, over the rows the widget has just repainted. A
  /// failure is handled here: the widget rethrows what a layer throws.
  #paintFrame(frame: PaintFrame): void {
    // A layer removed while a frame paints is still called for that frame.
    if (!this.#enabled || !this.#removeLayer) return;
    let stale = false;
    try {
      stale = this.#refresh(frame);
    } catch (error) {
      this.#fail("ghostty secret masking scan failed", error);
      return;
    }
    if (this.#spans.length > 0) {
      try {
        this.#paint(frame);
      } catch (error) {
        this.#fail("ghostty secret masking paint failed", error);
        return;
      }
    }
    // Called from a paint callback, this requests a full next frame.
    if (stale) this.#term.refresh();
  }

  /// Brings the spans up to the frame. True when the spans of a row the
  /// frame did not repaint changed: the canvas there shows the old ones.
  #refresh(frame: PaintFrame): boolean {
    const { cols, rows } = frame;
    const active = this.#term.buffer.active;
    const key: FrameKey = {
      type: active.type,
      length: active.length,
      top: Math.max(0, active.length - rows - Math.max(0, Math.floor(frame.viewportOffset))),
      cols,
      rows,
    };
    const last = this.#frame;
    const unchanged =
      !this.#rescan &&
      last !== null &&
      last.type === key.type &&
      last.length === key.length &&
      last.top === key.top &&
      last.cols === key.cols &&
      last.rows === key.rows;
    if (unchanged) return false;
    const before = this.#spans;
    this.#rescan = false;
    this.#frame = key;
    this.#spans = this.#scan(active, key);
    if (frame.full) return false;
    const repainted = new Set(frame.changedRows);
    const kept = (spans: SecretMaskSpan[]) =>
      spans
        .filter((span) => !repainted.has(span.row))
        .map((span) => `${span.row}:${span.x}:${span.width}`)
        .join(",");
    return kept(before) !== kept(this.#spans);
  }

  /// The spans on the visible rows, read from the wrapped groups those rows
  /// belong to. A group reaches at most a screenful above the viewport and
  /// a screenful below it, so a frame's scan is bounded by the grid; a
  /// value wrapped over more than that masks on the rows the scan reaches.
  #scan(active: GhosttyMaskBuffer, key: FrameKey): SecretMaskSpan[] {
    const { top, rows, cols } = key;
    const bottom = Math.min(active.length, top + rows) - 1;
    if (bottom < top) return [];
    // Each line is read from the parser once per scan: a read copies the
    // row's cells out of wasm memory, and the wrap walk and the group
    // text both need the same lines.
    const lines = new Map<number, MaskLine | undefined>();
    const read = (row: number): MaskLine | undefined => {
      if (!lines.has(row)) lines.set(row, active.getLine(row));
      return lines.get(row);
    };
    const continues = (row: number): boolean => this.#continues(read, row, key);
    let start = top;
    while (start > 0 && start > top - rows && continues(start - 1)) start -= 1;
    let end = bottom;
    while (end + 1 < active.length && end < bottom + rows && continues(end)) end += 1;
    const spans: SecretMaskSpan[] = [];
    for (let groupStart = start; groupStart <= end; ) {
      let groupEnd = groupStart;
      while (groupEnd < end && continues(groupEnd)) groupEnd += 1;
      const group: MaskGroupLine[] = [];
      for (let row = groupStart; row <= groupEnd; row += 1) {
        const line = read(row);
        if (line) group.push({ row, line });
      }
      for (const span of findSecretMaskSpans(group, cols, this.#matcher)) {
        if (span.row < top || span.row > bottom) continue;
        spans.push({ row: span.row - top, x: span.x, width: span.width });
      }
      groupStart = groupEnd + 1;
    }
    return spans;
  }

  /// Whether the line after `row` continues it. A screen row carries the
  /// parser's wrap flag. ghostty-web's buffer reports none for a scrollback
  /// line (every scrollback line reads unwrapped), so a scrollback line filled
  /// to its last column is read as wrapping: a soft wrap always fills the
  /// row, and the cost of reading a full hard-ended line as wrapped is a
  /// mask that can reach into the next line's first word, where the cost
  /// of the opposite is a value's continuation in clear.
  #continues(read: (row: number) => MaskLine | undefined, row: number, key: FrameKey): boolean {
    const next = read(row + 1);
    if (!next) return false;
    const screenStart = key.length - key.rows;
    if (key.type === "alternate" || row + 1 >= screenStart) return next.isWrapped;
    const last = read(row)?.getCell(key.cols - 1);
    return last !== undefined && last.getWidth() > 0 && last.getChars() !== "";
  }

  #paint(frame: PaintFrame): void {
    // The widget saves the context's state around the layer and restores it.
    const { ctx, metrics } = frame;
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.#color;
    for (const span of this.#spans) {
      ctx.fillRect(
        span.x * metrics.width,
        span.row * metrics.height,
        span.width * metrics.width,
        metrics.height,
      );
    }
  }

  /// Masking that stops silently is the worst failure mode for a visual
  /// feature. Fail loud: drop every span, redraw the rows they covered,
  /// switch the masker off and notify so the UI can say so. Re-enabling
  /// (the per-tab toggle) retries from a clean scan.
  #fail(message: string, error?: unknown): void {
    console.error(message, error ?? "");
    this.#uninstall();
    this.#enabled = false;
    this.#onError?.();
  }
}
