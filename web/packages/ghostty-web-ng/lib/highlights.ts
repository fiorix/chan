/**
 * Highlight layers: named sets of absolute-row ranges painted over a
 * cell's background and under its glyph, without touching the selection,
 * the clipboard or change events. Find's active match is one such layer;
 * part 5 will hold every match this way.
 */

/// One cell of a highlight: `absoluteRow` 0 is the oldest history row.
export type HighlightAnchor = { col: number; absoluteRow: number };

/// A range of cells, both corners included.
export type HighlightRange = { start: HighlightAnchor; end: HighlightAnchor };

/// How a layer paints. An unset background falls back to the theme's
/// selection tint; an unset foreground leaves the glyph its colour.
export type HighlightStyle = { background?: string; foreground?: string };

type HighlightLayer = { ranges: HighlightRange[]; style: HighlightStyle };

function ordered(range: HighlightRange): HighlightRange {
  const { start, end } = range;
  if (start.absoluteRow > end.absoluteRow || (start.absoluteRow === end.absoluteRow && start.col > end.col)) {
    return { start: end, end: start };
  }
  return { start: { ...start }, end: { ...end } };
}

function rowsOf(range: HighlightRange): number[] {
  const rows: number[] = [];
  for (let row = range.start.absoluteRow; row <= range.end.absoluteRow; row++) rows.push(row);
  return rows;
}

export class HighlightsManager {
  private layers = new Map<string, HighlightLayer>();
  private dirtyAbsoluteRows = new Set<number>();

  /// Replace the named layer. Ranges are stored ordered, corners included.
  set(name: string, ranges: HighlightRange[], style: HighlightStyle = {}): void {
    const previous = this.layers.get(name);
    if (previous) {
      for (const range of previous.ranges) {
        for (const row of rowsOf(range)) this.dirtyAbsoluteRows.add(row);
      }
    }
    const orderedRanges = ranges.map(ordered);
    this.layers.set(name, { ranges: orderedRanges, style: { ...style } });
    for (const range of orderedRanges) {
      for (const row of rowsOf(range)) this.dirtyAbsoluteRows.add(row);
    }
  }

  /// Drop the named layer, true when it was there. Its rows repaint clean.
  clear(name: string): boolean {
    const previous = this.layers.get(name);
    if (!previous) return false;
    for (const range of previous.ranges) {
      for (const row of rowsOf(range)) this.dirtyAbsoluteRows.add(row);
    }
    this.layers.delete(name);
    return true;
  }

  /// The named layer, if set. Find reads its own layer back through this.
  get(name: string): { ranges: HighlightRange[]; style: HighlightStyle } | undefined {
    return this.layers.get(name);
  }

  /// Every layer in the order it was set. The renderer paints the first
  /// span that covers a cell.
  entries(): { name: string; ranges: HighlightRange[]; style: HighlightStyle }[] {
    return [...this.layers.entries()].map(([name, layer]) => ({ name, ...layer }));
  }

  /// Absolute rows whose highlight changed since the last read.
  getDirtyAbsoluteRows(): Set<number> {
    return this.dirtyAbsoluteRows;
  }

  clearDirtyAbsoluteRows(): void {
    this.dirtyAbsoluteRows.clear();
  }

  dispose(): void {
    this.layers.clear();
    this.dirtyAbsoluteRows.clear();
  }
}
