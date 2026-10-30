import type { CanvasRenderer, IRenderable } from "ghostty-web";
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

/// What the painter reads of a ghostty terminal: the active buffer, the
/// viewport offset ghostty renders at, and the renderer it paints behind.
export type GhosttyMaskTerminal = {
  readonly buffer: { readonly active: GhosttyMaskBuffer };
  readonly renderer?: Pick<CanvasRenderer, "getMetrics" | "render">;
  getViewportY(): number;
};

type GhosttyMaskRenderer = Pick<CanvasRenderer, "getMetrics"> & {
  ctx?: CanvasRenderingContext2D;
  render?: (
    buffer: IRenderable,
    forceAll?: boolean,
    viewportY?: number,
    scrollbackProvider?: unknown,
    scrollbarOpacity?: number,
  ) => void;
};

/// The state a frame's spans were read at. A frame whose key matches the
/// last one, with no row the parser marked dirty, keeps its spans.
type FrameKey = {
  type: "normal" | "alternate";
  length: number;
  top: number;
  cols: number;
  rows: number;
};

/// Masks a ghostty terminal by painting over its canvas.
///
/// ghostty-web has no decorations or markers and its onRender event never
/// fires in the pinned build, so the painter wraps the renderer's render
/// (the guarded private-hook pattern of ghosttyCompat.ts) and fills each
/// span onto the canvas in the frame that draws the content under it: the
/// mask is on screen in the same frame as the value, with no overlay
/// element to lag a frame behind a scroll, and the buffer, selection and
/// copy are untouched. The visible rows are rescanned only when the
/// viewport, the grid, the buffer or a row the parser marked dirty
/// changed; an idle frame repaints the cached spans, which is a few
/// rectangles. Ghostty draws visible row r at r times the cell height
/// whatever the fraction of the viewport offset, so a fractional offset
/// maps rows as its floor does.
///
/// Writes reach the painter through the parser's dirty rows, so the write
/// hooks the xterm masker needs are no-ops here; scanAll and scanViewport
/// force a rescan at the next frame.
export class GhosttySecretMasker {
  readonly #term: GhosttyMaskTerminal;
  readonly #matcher: SecretAssignmentMatcher;
  readonly #onError: (() => void) | null;
  #renderer: GhosttyMaskRenderer | null = null;
  #originalRender: NonNullable<GhosttyMaskRenderer["render"]> | null = null;
  #hook: NonNullable<GhosttyMaskRenderer["render"]> | null = null;
  #spans: SecretMaskSpan[] = [];
  #frame: FrameKey | null = null;
  #rescan = true;
  #repaintAll = false;
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
    this.#install();
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /// Spans painted on the visible rows at the last frame.
  get maskCount(): number {
    return this.#spans.length;
  }

  setEnabled(enabled: boolean): void {
    if (this.#disposed || enabled === this.#enabled) return;
    this.#enabled = enabled;
    if (enabled) {
      this.#rescan = true;
      if (!this.#hook) this.#install();
    } else {
      this.clear();
    }
  }

  setColor(color: string): void {
    if (this.#disposed || color === this.#color) return;
    this.#color = color;
  }

  captureWrite(): null {
    return null;
  }

  scanWrite(_snapshot: unknown): void {}

  scanAll(): void {
    if (this.#disposed || !this.#enabled) return;
    this.#rescan = true;
  }

  scanViewport(): void {
    this.scanAll();
  }

  /// Drop every span; the next frame redraws the rows they covered.
  clear(): void {
    this.#spans = [];
    this.#frame = null;
    this.#repaintAll = true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#spans = [];
    const renderer = this.#renderer;
    if (renderer && this.#hook && renderer.render === this.#hook && this.#originalRender) {
      renderer.render = this.#originalRender;
    }
    this.#renderer = null;
    this.#hook = null;
    this.#originalRender = null;
  }

  #install(): void {
    const renderer = this.#term.renderer as GhosttyMaskRenderer | undefined;
    const original = renderer?.render;
    if (
      !renderer ||
      !renderer.ctx ||
      typeof original !== "function" ||
      typeof renderer.getMetrics !== "function"
    ) {
      this.#fail("ghostty secret masking render hook unavailable");
      return;
    }
    const hook: NonNullable<GhosttyMaskRenderer["render"]> = (
      buffer,
      forceAll,
      viewportY,
      scrollbackProvider,
      scrollbarOpacity,
    ) => {
      this.#renderFrame(buffer, forceAll === true, viewportY ?? 0, () =>
        original.call(renderer, buffer, forceAll === true || this.#takeRepaint(), viewportY, scrollbackProvider, scrollbarOpacity),
      );
    };
    this.#renderer = renderer;
    this.#originalRender = original;
    this.#hook = hook;
    renderer.render = hook;
  }

  #takeRepaint(): boolean {
    const repaint = this.#repaintAll;
    this.#repaintAll = false;
    return repaint;
  }

  #renderFrame(buffer: IRenderable, forceAll: boolean, viewportY: number, draw: () => void): void {
    let paint = false;
    if (this.#enabled && !this.#disposed) {
      try {
        this.#refresh(buffer, viewportY, forceAll);
        paint = true;
      } catch (error) {
        this.#fail("ghostty secret masking scan failed", error);
      }
    }
    draw();
    if (!paint || this.#spans.length === 0) return;
    try {
      this.#paint();
    } catch (error) {
      this.#fail("ghostty secret masking paint failed", error);
    }
  }

  #refresh(buffer: IRenderable, viewportY: number, forceAll: boolean): void {
    const { cols, rows } = buffer.getDimensions();
    const active = this.#term.buffer.active;
    const key: FrameKey = {
      type: active.type,
      length: active.length,
      top: Math.max(0, active.length - rows - Math.floor(viewportY)),
      cols,
      rows,
    };
    const last = this.#frame;
    const unchanged =
      !forceAll &&
      !this.#rescan &&
      last !== null &&
      last.type === key.type &&
      last.length === key.length &&
      last.top === key.top &&
      last.cols === key.cols &&
      last.rows === key.rows &&
      !buffer.needsFullRedraw?.() &&
      !this.#visibleRowDirty(buffer, rows);
    if (unchanged) return;
    this.#rescan = false;
    this.#frame = key;
    this.#spans = this.#scan(active, key);
  }

  #visibleRowDirty(buffer: IRenderable, rows: number): boolean {
    for (let row = 0; row < rows; row += 1) {
      if (buffer.isRowDirty(row)) return true;
    }
    return false;
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
  /// parser's wrap flag. A scrollback line keeps none in the pinned build
  /// (every scrollback line reads unwrapped), so a scrollback line filled
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

  #paint(): void {
    const renderer = this.#renderer;
    const ctx = renderer?.ctx;
    if (!renderer || !ctx) return;
    const metrics = renderer.getMetrics();
    ctx.save();
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
    ctx.restore();
  }

  /// Masking that stops silently is the worst failure mode for a visual
  /// feature. Fail loud: drop every span, redraw the rows they covered,
  /// switch the masker off and notify so the UI can say so. Re-enabling
  /// (the per-tab toggle) retries from a clean scan.
  #fail(message: string, error?: unknown): void {
    console.error(message, error ?? "");
    this.clear();
    this.#enabled = false;
    this.#onError?.();
  }
}
