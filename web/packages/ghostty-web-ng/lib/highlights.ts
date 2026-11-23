import type { TerminalHighlights } from './interfaces';
import type { SelectionRange } from './selection-manager';

/** Inclusive cells in the selection's absolute-row coordinate system. */
export type HighlightRange = SelectionRange;

/** Omitted background uses the selection tint; omitted foreground keeps the glyph color. */
export type HighlightStyle = { background?: string; foreground?: string };

type HighlightLayer = { ranges: HighlightRange[]; style: HighlightStyle };
type RowInterval = { start: number; end: number };

export type HighlightSpan = {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  style: Readonly<HighlightStyle>;
};

function ordered(range: HighlightRange): HighlightRange {
  for (const anchor of [range.start, range.end]) {
    if (!Number.isSafeInteger(anchor.col) || !Number.isSafeInteger(anchor.absoluteRow) ||
        anchor.col < 0 || anchor.absoluteRow < 0) {
      throw new RangeError('Highlight coordinates must be nonnegative safe integers');
    }
  }
  const { start, end } = range;
  const reverse = start.absoluteRow > end.absoluteRow ||
    (start.absoluteRow === end.absoluteRow && start.col > end.col);
  return reverse ? { start: { ...end }, end: { ...start } } : { start: { ...start }, end: { ...end } };
}

/** Internal storage and paint bookkeeping; the terminal exposes only its facade. */
export class HighlightsManager implements TerminalHighlights {
  private readonly layers = new Map<string, HighlightLayer>();
  private dirty: RowInterval[] = [];

  constructor(private alternateScreen: boolean) {}

  set(name: string, ranges: readonly HighlightRange[], style: HighlightStyle = {}): void {
    // Validate and copy the whole replacement before changing any state.
    const next = { ranges: ranges.map(ordered), style: { ...style } };
    this.invalidate(this.layers.get(name));
    this.layers.set(name, next);
    this.invalidate(next);
  }

  clear(name: string): boolean {
    const layer = this.layers.get(name);
    if (!layer) return false;
    this.invalidate(layer);
    return this.layers.delete(name);
  }

  get(name: string): HighlightLayer | undefined {
    const layer = this.layers.get(name);
    return layer && {
      ranges: layer.ranges.map(({ start, end }) => ({ start: { ...start }, end: { ...end } })),
      style: { ...layer.style },
    };
  }

  observeScreen(alternate: boolean): void {
    if (alternate === this.alternateScreen) return;
    for (const layer of this.layers.values()) this.invalidate(layer);
    this.layers.clear();
    this.alternateScreen = alternate;
  }

  private invalidate(layer: HighlightLayer | undefined): void {
    for (const range of layer?.ranges ?? []) {
      this.dirty.push({ start: range.start.absoluteRow, end: range.end.absoluteRow });
    }
  }

  /** Work scales with ranges and visible rows, never with a range's row count. */
  frame(top: number, rows: number, cols: number): { spans: HighlightSpan[]; dirtyRows: Set<number> } {
    const dirtyRows = new Set<number>();
    for (const interval of this.dirty) {
      const first = Math.max(0, interval.start - top);
      const last = Math.min(rows - 1, interval.end - top);
      for (let row = first; row <= last; row++) dirtyRows.add(row);
    }
    this.dirty = [];

    const spans: HighlightSpan[] = [];
    const append = (layer: HighlightLayer | undefined) => {
      if (!layer) return;
      for (const { start, end } of layer.ranges) {
        const startRow = start.absoluteRow - top;
        const endRow = end.absoluteRow - top;
        if (endRow < 0 || startRow >= rows) continue;
        spans.push({
          startRow: Math.max(0, startRow),
          endRow: Math.min(rows - 1, endRow),
          // A clipped boundary is an interior row, not an endpoint row.
          startCol: startRow < 0 ? 0 : start.col,
          endCol: endRow >= rows ? cols - 1 : end.col,
          style: layer.style,
        });
      }
    };
    // Find owns these names. Other layers use stable registration order;
    // replacing a layer does not change its position among its peers.
    append(this.layers.get('search-all'));
    for (const [name, layer] of this.layers) {
      if (name !== 'search-all' && name !== 'search-active') append(layer);
    }
    append(this.layers.get('search-active'));
    return { spans, dirtyRows };
  }

  dispose(): void {
    this.layers.clear();
    this.dirty = [];
  }
}
