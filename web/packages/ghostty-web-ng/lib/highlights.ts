import type { TerminalHighlights } from './interfaces';
import type { SelectionRange } from './selection-manager';

/** Inclusive cells in the selection's absolute-row coordinate system. */
export type HighlightRange = SelectionRange;

/** Omitted background uses the selection tint; omitted foreground keeps the glyph color. */
export type HighlightStyle = { background?: string; foreground?: string };

type HighlightLayer = { ranges: HighlightRange[]; style: HighlightStyle };
type RowInterval = { start: number; end: number };
type Block = RowInterval & { size: number; ranges?: HighlightRange[]; left?: Block; right?: Block };
type StoredLayer = { blocks: Block[]; style: HighlightStyle; bounds: RowInterval };

function block(ranges: HighlightRange[]): Block {
  let start = Infinity;
  let end = -Infinity;
  for (const range of ranges) {
    start = Math.min(start, range.start.absoluteRow);
    end = Math.max(end, range.end.absoluteRow);
  }
  return { start, end, size: 1, ranges };
}

function appendBlock(layer: StoredLayer, next: Block): void {
  layer.bounds.start = Math.min(layer.bounds.start, next.start);
  layer.bounds.end = Math.max(layer.bounds.end, next.end);
  // Equal-size blocks form a balanced forest in insertion order. Appending
  // search results never sorts or copies the previously published ranges.
  while (layer.blocks.at(-1)?.size === next.size) {
    const left = layer.blocks.pop()!;
    next = { start: Math.min(left.start, next.start), end: Math.max(left.end, next.end),
      size: left.size + next.size, left, right: next };
  }
  layer.blocks.push(next);
}

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
  private readonly layers = new Map<string, StoredLayer>();
  private dirty: RowInterval = { start: Infinity, end: -Infinity };

  constructor(private alternateScreen: boolean) {}

  set(name: string, ranges: readonly HighlightRange[], style: HighlightStyle = {}): void {
    // Validate and copy the whole replacement before changing any state.
    const copied = ranges.map(ordered);
    const next: StoredLayer = { blocks: [], style: { ...style }, bounds: { start: Infinity, end: -Infinity } };
    for (let i = 0; i < copied.length; i += 256) appendBlock(next, block(copied.slice(i, i + 256)));
    this.invalidate(this.layers.get(name));
    this.layers.set(name, next);
    this.invalidate(next);
  }

  /** Takes ownership of internal, normalized ranges; public callers use set. */
  append(name: string, ranges: HighlightRange[], style: HighlightStyle): void {
    let layer = this.layers.get(name);
    if (!layer) {
      layer = { blocks: [], style: { ...style }, bounds: { start: Infinity, end: -Infinity } };
      this.layers.set(name, layer);
    }
    for (let i = 0; i < ranges.length; i += 256) {
      const next = block(ranges.length <= 256 ? ranges : ranges.slice(i, i + 256));
      this.dirty.start = Math.min(this.dirty.start, next.start);
      this.dirty.end = Math.max(this.dirty.end, next.end);
      appendBlock(layer, next);
    }
  }

  /** Replaces a layer's style, keeping its ranges and its place; internal, for find's theme colours. */
  restyle(name: string, style: HighlightStyle): void {
    const layer = this.layers.get(name);
    if (!layer) return;
    layer.style = { ...style };
    this.invalidate(layer);
  }

  clear(name: string): boolean {
    const layer = this.layers.get(name);
    if (!layer) return false;
    this.invalidate(layer);
    return this.layers.delete(name);
  }

  get(name: string): HighlightLayer | undefined {
    const layer = this.layers.get(name);
    if (!layer) return undefined;
    const ranges: HighlightRange[] = [];
    const visit = (node: Block) => {
      if (node.ranges) {
        for (const { start, end } of node.ranges) ranges.push({ start: { ...start }, end: { ...end } });
      } else {
        visit(node.left!);
        visit(node.right!);
      }
    };
    layer.blocks.forEach(visit);
    return { ranges, style: { ...layer.style } };
  }

  observeScreen(alternate: boolean): void {
    if (alternate === this.alternateScreen) return;
    for (const layer of this.layers.values()) this.invalidate(layer);
    this.layers.clear();
    this.alternateScreen = alternate;
  }

  private invalidate(layer: StoredLayer | undefined): void {
    if (!layer) return;
    this.dirty.start = Math.min(this.dirty.start, layer.bounds.start);
    this.dirty.end = Math.max(this.dirty.end, layer.bounds.end);
  }

  /** Reject offscreen blocks before visiting their ranges; never expand history rows. */
  frame(top: number, rows: number, cols: number): { spans: HighlightSpan[]; dirtyRows: Set<number> } {
    const dirtyRows = new Set<number>();
    const first = Math.max(0, this.dirty.start - top);
    const last = Math.min(rows - 1, this.dirty.end - top);
    for (let row = first; row <= last; row++) dirtyRows.add(row);
    this.dirty = { start: Infinity, end: -Infinity };

    const spans: HighlightSpan[] = [];
    const append = (layer: StoredLayer | undefined) => {
      if (!layer) return;
      const visit = (node: Block) => {
        if (node.end < top || node.start >= top + rows) return;
        if (!node.ranges) {
          visit(node.left!);
          visit(node.right!);
          return;
        }
        for (const { start, end } of node.ranges) {
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
      layer.blocks.forEach(visit);
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
    this.dirty = { start: Infinity, end: -Infinity };
  }
}
