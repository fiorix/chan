import { describe, expect, test } from 'vitest';
import { HighlightsManager } from './highlights';

const range = (startRow: number, startCol: number, endRow: number, endCol: number) => ({
  start: { col: startCol, absoluteRow: startRow },
  end: { col: endCol, absoluteRow: endRow },
});

describe('the highlight layer', () => {
  test('a set layer reads back its ranges and style', () => {
    const highlights = new HighlightsManager();
    highlights.set('find', [range(5, 2, 5, 8)], { background: '#ff0000' });
    expect(highlights.get('find')).toEqual({
      ranges: [range(5, 2, 5, 8)],
      style: { background: '#ff0000' },
    });
  });

  test('clear drops the layer and reports whether it was there', () => {
    const highlights = new HighlightsManager();
    highlights.set('find', [range(5, 2, 5, 8)], {});
    expect(highlights.clear('find')).toBe(true);
    expect(highlights.get('find')).toBeUndefined();
    expect(highlights.clear('find')).toBe(false);
  });

  test('a set dirties its rows, a clear dirties the dropped rows', () => {
    const highlights = new HighlightsManager();
    highlights.set('a', [range(3, 0, 4, 5)], {});
    expect(highlights.getDirtyAbsoluteRows()).toEqual(new Set([3, 4]));
    highlights.clearDirtyAbsoluteRows();
    highlights.set('a', [range(4, 0, 6, 2)], {});
    // The replaced rows 3 and 4 repaint without the old layer, 5 and 6 with it.
    expect(highlights.getDirtyAbsoluteRows()).toEqual(new Set([3, 4, 5, 6]));
    highlights.clearDirtyAbsoluteRows();
    highlights.clear('a');
    expect(highlights.getDirtyAbsoluteRows()).toEqual(new Set([4, 5, 6]));
  });

  test('a backwards range normalizes to top-left first', () => {
    const highlights = new HighlightsManager();
    highlights.set('find', [range(7, 9, 5, 2)], {});
    expect(highlights.get('find')?.ranges).toEqual([range(5, 2, 7, 9)]);
  });

  test('an empty style is kept as given; the renderer falls back to the selection tint', () => {
    const highlights = new HighlightsManager();
    highlights.set('find', [range(1, 0, 1, 3)], {});
    expect(highlights.get('find')?.style).toEqual({});
  });
});
