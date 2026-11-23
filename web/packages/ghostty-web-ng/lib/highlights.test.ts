import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { GhosttyVt } from '../vt/ghosttyVt';
import { HighlightsManager } from './highlights';
import type { ITheme } from './interfaces';
import { Terminal } from './terminal';

type Range = { start: { col: number; absoluteRow: number }; end: { col: number; absoluteRow: number } };
type Style = { background?: string; foreground?: string };
// Structural signatures keep the counterfactual runnable without the new API.
type HighlightAPI = {
  highlights: {
    set(name: string, ranges: readonly Range[], style?: Style): void;
    get(name: string): { ranges: Range[]; style: Style } | undefined;
    clear(name: string): boolean;
  };
};
type Fill = { color: string; x: number; y: number; width: number; height: number };
type Text = { color: string; text: string; x: number; y: number };

let module: WebAssembly.Module;
let nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
const terminals: Terminal[] = [];
const fills: Fill[] = [];
const texts: Text[] = [];
const strokes: string[] = [];

beforeAll(async () => {
  module = await WebAssembly.compile(readFileSync('vendor/ghostty-vt/ghostty-vt.wasm'));
});

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => {
    const state: Record<string, unknown> = { fillStyle: '', strokeStyle: '' };
    return new Proxy(state, {
      get: (target, key: string) => {
        if (key === 'measureText') return () => ({ width: 8, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 4 });
        if (key === 'fillRect') return (x: number, y: number, width: number, height: number) => {
          fills.push({ color: String(target.fillStyle), x, y, width, height });
        };
        if (key === 'fillText') return (text: string, x: number, y: number) => {
          texts.push({ color: String(target.fillStyle), text, x, y });
        };
        if (key === 'stroke') return () => strokes.push(String(target.strokeStyle));
        return target[key] ?? (() => undefined);
      },
    });
  }) as never);
});

afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose();
  frames.clear();
  clearPaint();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function clearPaint() {
  fills.length = texts.length = strokes.length = 0;
}

function frame() {
  clearPaint();
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(performance.now());
}

async function create(theme: ITheme = {}) {
  const ghostty = new GhosttyVt(await WebAssembly.instantiate(module, {}));
  const copy = vi.fn();
  const term = new Terminal({ ghostty, cols: 12, rows: 6, scrollback: 100, cursorBlink: false, smoothScrollDuration: 0, theme, copy }) as Terminal & HighlightAPI;
  terminals.push(term);
  return { term, copy };
}

async function open(input = 'abcdefghij', theme: ITheme = {}) {
  const fixture = await create(theme);
  const host = document.createElement('div');
  document.body.append(host);
  fixture.term.open(host);
  fixture.term.write(`\x1b[?25l${input}`);
  frame();
  const { width, height, baseline } = fixture.term.renderer!.getMetrics();
  return {
    ...fixture, host, width, height,
    background(col: number, row: number) {
      const x = (col + 0.5) * width;
      const y = (row + 0.5) * height;
      return fills.filter((fill) => x >= fill.x && x < fill.x + fill.width && y >= fill.y && y < fill.y + fill.height).at(-1)?.color;
    },
    glyph(col: number, row: number) {
      return texts.filter((text) => text.x === col * width && text.y === row * height + baseline).at(-1);
    },
  };
}

const range = (startRow: number, startCol: number, endRow: number, endCol: number): Range => ({
  start: { col: startCol, absoluteRow: startRow }, end: { col: endCol, absoluteRow: endRow },
});

test('incremental highlight blocks visit only visible ranges at either end of history', () => {
  const manager = new HighlightsManager(false);
  let visited = 0;
  const ranges = Array.from({ length: 10_000 }, (_, row) => ({
    get start() { visited++; return { absoluteRow: row, col: 2 }; },
    get end() { visited++; return { absoluteRow: row, col: 4 }; },
  }));
  for (let i = 0; i < ranges.length; i += 256) {
    manager.append('search-all', ranges.slice(i, i + 256), { background: '#123456' });
  }
  for (const top of [0, 5000, 9976]) {
    visited = 0;
    const frame = manager.frame(top, 24, 80);
    expect(frame.spans).toHaveLength(24);
    expect(frame.spans[0]).toMatchObject({ startRow: 0, endRow: 0, startCol: 2, endCol: 4 });
    expect(visited).toBeLessThan(2048);
  }
  expect(manager.get('search-all')?.ranges).toHaveLength(10_000);
  visited = 0;
  manager.clear('search-all');
  expect(visited).toBe(0);
  expect(manager.frame(9976, 24, 80).dirtyRows.size).toBe(24);
});

describe('named highlight snapshots', () => {
  test('the real core fixture produces text and canvas paint before assertions', async () => {
    const { term, glyph } = await open();
    expect(term.buffer.active.getLine(0)!.translateToString(true)).toBe('abcdefghij');
    expect(glyph(0, 0)?.text).toBe('a');
  });

  test.each([false, true])('copies normalized inputs and every returned snapshot (reverse %s)', async (reverse) => {
    const { term } = await open();
    const expected = range(0, 2, 2, 5);
    const source = reverse ? { start: { ...expected.end }, end: { ...expected.start } } : structuredClone(expected);
    const ranges = [source];
    const style = { background: '#123456', foreground: '#abcdef' };
    term.highlights.set('owned', ranges, style);
    source.start.col = source.end.absoluteRow = 99;
    ranges.length = 0;
    style.background = '#ffffff';
    const snapshot = term.highlights.get('owned')! as { ranges: Range[]; style: Style };
    expect(snapshot).toEqual({ ranges: [expected], style: { background: '#123456', foreground: '#abcdef' } });
    snapshot.ranges[0].start.col = 10;
    snapshot.ranges[0].end.absoluteRow = 11;
    snapshot.ranges.push(range(1, 1, 1, 2));
    snapshot.style.background = '#000000';
    expect(term.highlights.get('owned')).toEqual({ ranges: [expected], style: { background: '#123456', foreground: '#abcdef' } });
    term.highlights.set('owned', [range(0, 7, 0, 3)]);
    expect(term.highlights.get('owned')).toEqual({ ranges: [range(0, 3, 0, 7)], style: {} });
  });

  test('replaces and clears only the named layer without selection, copy or change events', async () => {
    const { term, copy } = await open();
    term.setSelection(range(0, 0, 0, 2));
    const selected = term.getSelectionRange();
    const change = vi.fn();
    term.onChange(change);
    term.highlights.set('first', [range(0, 4, 0, 5)]);
    term.highlights.set('second', [range(0, 6, 0, 7)]);
    term.highlights.set('first', []);
    expect(term.highlights.get('first')?.ranges).toEqual([]);
    expect(term.highlights.clear('first')).toBe(true);
    expect(term.highlights.clear('first')).toBe(false);
    expect(term.highlights.get('first')).toBeUndefined();
    expect(term.highlights.get('second')?.ranges).toEqual([range(0, 6, 0, 7)]);
    expect(term.getSelectionRange()).toEqual(selected);
    expect(term.getSelection()).toBe('abc');
    expect(copy).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalled();
    term.clearSelection();
    expect(term.highlights.get('second')?.ranges).toEqual([range(0, 6, 0, 7)]);
  });

  test.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('invalid coordinate %s refuses the entire replacement', async (bad) => {
    const { term } = await open();
    term.highlights.set('owned', [range(0, 1, 0, 2)], { background: '#123456' });
    const previous = term.highlights.get('owned');
    for (const endpoint of ['start', 'end'] as const) {
      for (const axis of ['col', 'absoluteRow'] as const) {
        const invalid = range(0, 3, 0, 5);
        invalid[endpoint][axis] = bad;
        expect(() => term.highlights.set('owned', [range(0, 7, 0, 8), invalid])).toThrow(RangeError);
        expect(term.highlights.get('owned')).toEqual(previous);
      }
    }
  });

  test('the stable facade is inert before open and after disposal, including invalid input', async () => {
    const { term } = await create();
    const api = term.highlights;
    expect(() => api.set('owned', [range(NaN, 0, Infinity, 0)])).not.toThrow();
    expect(api.get('owned')).toBeUndefined();
    expect(api.clear('owned')).toBe(false);
    const host = document.createElement('div');
    document.body.append(host);
    term.open(host);
    expect(term.highlights).toBe(api);
    expect(api.get('owned')).toBeUndefined();
    api.set('owned', [range(0, 0, 0, 2)]);
    expect(api.get('owned')).toBeDefined();
    term.dispose();
    expect(api.get('owned')).toBeUndefined();
    expect(api.clear('owned')).toBe(false);
    expect(() => api.set('owned', [range(NaN, 0, Infinity, 0)])).not.toThrow();
    api.set('owned', [range(0, 0, 0, 2)]);
    expect(api.get('owned')).toBeUndefined();
  });
});

describe('highlight lifetime', () => {
  test('writes, pruning and resizes retain numeric snapshots until the owner republishes', async () => {
    const { term } = await open();
    const ranges = [range(0, 1, 0, 2), range(3, 10, 3, 11)];
    term.highlights.set('owned', ranges, { background: '#123456' });
    const expected = term.highlights.get('owned');
    const observations: unknown[] = [];
    term.onChange(() => observations.push(term.highlights.get('owned')));
    term.write('\r\nmore');
    let pruned = false;
    for (let i = 0; i < 5000; i++) {
      const before = term.getScrollbackLength();
      term.write(`\r\nline ${i}`);
      if (term.getScrollbackLength() < before) { pruned = true; break; }
    }
    expect(pruned, 'the real core pruned history').toBe(true);
    term.resize(8, 4);
    term.resize(20, 6);
    expect(observations.length).toBeGreaterThan(3);
    expect(observations.every((value) => JSON.stringify(value) === JSON.stringify(expected))).toBe(true);
    expect(term.highlights.get('owned')).toEqual(expected);
    term.highlights.set('owned', [range(2, 2, 2, 4)]);
    expect(term.highlights.get('owned')?.ranges).toEqual([range(2, 2, 2, 4)]);
  });

  test.each([47, 1047, 1049])('an observed screen switch %s drops all layers before observers in both directions', async (mode) => {
    const { term } = await open();
    const seen: unknown[] = [];
    term.onChange(() => seen.push(term.highlights.get('owned')));
    term.highlights.set('owned', [range(0, 0, 0, 3)]);
    term.highlights.set('another', [range(0, 4, 0, 5)]);
    term.write(`\x1b[?${mode}h`);
    expect(term.wasmTerm!.isAlternateScreen()).toBe(true);
    expect(term.highlights.get('owned')).toBeUndefined();
    expect(term.highlights.get('another')).toBeUndefined();
    term.highlights.set('owned', [range(0, 0, 0, 3)]);
    term.write(`\x1b[?${mode}l`);
    expect(term.wasmTerm!.isAlternateScreen()).toBe(false);
    expect(term.highlights.get('owned')).toBeUndefined();
    expect(seen).toEqual([undefined, undefined]);
  });

  test('a screen round trip within one write retains the normal-screen layer', async () => {
    const { term } = await open();
    term.highlights.set('owned', [range(0, 1, 0, 3)]);
    const expected = term.highlights.get('owned');
    term.write('\x1b[?1049halternate\x1b[?1049l');
    expect(term.wasmTerm!.isAlternateScreen()).toBe(false);
    expect(term.highlights.get('owned')).toEqual(expected);
  });
});

describe('highlight painting on the real widget', () => {
  test.each([false, true])('selection paints above active above all, regardless of registration (active first %s)', async (activeFirst) => {
    const fixture = await open('abcdefghij', { selectionBackground: '#334455', selectionForeground: '#ddeeff' });
    const { term, background, glyph } = fixture;
    const all = () => term.highlights.set('search-all', [range(0, 0, 0, 9)], { background: '#112233', foreground: '#aabbcc' });
    const active = () => term.highlights.set('search-active', [range(0, 2, 0, 6)], { background: '#667788', foreground: '#99aabb' });
    if (activeFirst) { active(); all(); } else { all(); active(); }
    term.setSelection(range(0, 4, 0, 5));
    frame();
    expect(background(1, 0)).toBe('#112233');
    expect(glyph(1, 0)?.color).toBe('#aabbcc');
    expect(background(3, 0)).toBe('#667788');
    expect(glyph(3, 0)?.color).toBe('#99aabb');
    expect(background(4, 0)).toBe('#334455');
    expect(glyph(4, 0)?.color).toBe('#ddeeff');
    all();
    frame();
    expect(background(3, 0)).toBe('#667788');
    term.highlights.clear('search-active');
    frame();
    expect(background(3, 0)).toBe('#112233');
    expect(background(4, 0)).toBe('#334455');
  });

  test('selection without a foreground keeps the glyph color above a highlight foreground', async () => {
    const { term, glyph } = await open('\x1b[38;2;12;34;56mabcdef');
    term.highlights.set('owned', [range(0, 0, 0, 5)], { foreground: '#ffffff' });
    term.setSelection(range(0, 2, 0, 3));
    frame();
    expect(glyph(1, 0)?.color).toBe('#ffffff');
    expect(glyph(2, 0)?.color).toBe('rgb(12, 34, 56)');
  });

  test('ordinary layers retain registration order on replacement', async () => {
    const { term, background } = await open();
    term.highlights.set('first', [range(0, 0, 0, 3)], { background: '#111111' });
    term.highlights.set('second', [range(0, 0, 0, 3)], { background: '#222222' });
    term.highlights.set('first', [range(0, 0, 0, 3)], { background: '#333333' });
    frame();
    expect(background(0, 0)).toBe('#222222');
    term.highlights.clear('second');
    frame();
    expect(background(0, 0)).toBe('#333333');
  });

  test('moving, restyling, empty replacement and clearing repaint old and new rows', async () => {
    const { term, background, glyph } = await open('top\r\none\r\ntwo\r\nthree\r\nfour\r\nbottom');
    term.highlights.set('owned', [range(0, 0, 0, 2)], { background: '#112233' });
    frame();
    expect(background(0, 0)).toBe('#112233');
    term.highlights.set('owned', [range(5, 0, 5, 2)], { background: '#112233' });
    frame();
    expect(background(0, 0)).toBe('#1e1e1e');
    expect(background(0, 5)).toBe('#112233');
    term.highlights.set('owned', [range(5, 0, 5, 2)], { background: '#445566', foreground: '#abcdef' });
    frame();
    expect(background(0, 5)).toBe('#445566');
    expect(glyph(0, 5)?.color).toBe('#abcdef');
    term.highlights.set('owned', []);
    frame();
    expect(background(0, 5)).toBe('#1e1e1e');
    term.highlights.set('owned', [range(0, 0, 0, 2)]);
    frame();
    expect(background(0, 0)).toBe('#d4d4d4');
    term.highlights.clear('owned');
    frame();
    expect(background(0, 0)).toBe('#1e1e1e');
  });

  test('multiple edits before a frame invalidate intermediate coverage too', async () => {
    const { term, background } = await open();
    term.highlights.set('owned', [range(0, 0, 0, 1)]);
    frame();
    term.highlights.set('owned', [range(5, 0, 5, 1)]);
    term.highlights.clear('owned');
    frame();
    expect(background(0, 0)).toBe('#1e1e1e');
    expect(background(0, 5)).toBe('#1e1e1e');
  });

  test('a huge range clips both ends to whole visible rows without expanding its row count', async () => {
    const { term, background } = await open(Array.from({ length: 16 }, (_, i) => `line${i}`).join('\r\n'));
    expect(term.getScrollbackLength()).toBeGreaterThan(0);
    term.highlights.set('owned', [range(0, 8, Number.MAX_SAFE_INTEGER, 1)], { background: '#123456' });
    frame();
    for (let row = 0; row < term.rows; row++) {
      expect(background(0, row)).toBe('#123456');
      expect(background(term.cols - 1, row)).toBe('#123456');
    }
    term.highlights.clear('owned');
    frame();
    expect(background(0, 0)).toBe('#1e1e1e');
    expect(background(term.cols - 1, term.rows - 1)).toBe('#1e1e1e');
  });

  test('scrollback and one-row viewport clipping preserve real endpoint columns', async () => {
    const { term, background, width, height } = await open(Array.from({ length: 16 }, (_, i) => `line${i}`).join('\r\n'));
    term.viewport.scrollTo(term.getScrollbackLength() - 2 + 0.5);
    term.highlights.set('owned', [range(0, 8, 2, 3)], { background: '#123456' });
    frame();
    expect(background(0, 0)).toBe('#123456');
    expect(background(3, 0)).toBe('#123456');
    expect(background(4, 0)).toBe('#1e1e1e');
    term.highlights.set('owned', [range(7, 8, 15, 1)], { background: '#123456' });
    frame();
    expect(background(7, 5)).toBe('#1e1e1e');
    expect(background(8, 5)).toBe('#123456');
    // The scrollbar paints over the rightmost cell after the text pass.
    expect(fills).toContainEqual({ color: '#123456', x: 11 * width, y: 5 * height, width, height });
  });

  test('whole wide glyphs and combining clusters keep their text and foreground', async () => {
    const { term, background, glyph, width, height } = await open('\u754ce\u0301z');
    term.highlights.set('owned', [range(0, 1, 0, 2)], { background: '#123456', foreground: '#abcdef' });
    frame();
    expect(background(0, 0)).toBe('#123456');
    expect(background(1, 0)).toBe('#123456');
    expect(fills).toContainEqual({ color: '#123456', x: 0, y: 0, width: width * 2, height });
    expect(glyph(0, 0)).toMatchObject({ text: '\u754c', color: '#abcdef' });
    expect(glyph(2, 0)).toMatchObject({ text: 'e\u0301', color: '#abcdef' });
    expect(glyph(3, 0)?.text).toBe('z');
  });

  test('clearing highlights restores explicit black and the transparent default independently', async () => {
    const { term, background } = await open('\x1b[48;2;0;0;0mA\x1b[49mB', { background: 'transparent' });
    term.highlights.set('owned', [range(0, 0, 0, 1)], { background: '#000000' });
    frame();
    expect(background(0, 0)).toBe('#000000');
    expect(background(1, 0)).toBe('#000000');
    term.highlights.clear('owned');
    frame();
    expect(background(0, 0)).toBe('rgb(0, 0, 0)');
    expect(background(1, 0)).toBe('transparent');
  });

  test('the default highlight uses selection tint but leaves the glyph and link underline intact', async () => {
    const { term, host, background, glyph } = await open('\x1b[38;2;12;34;56mhttps://x.io', { selectionBackground: '#123456' });
    const canvas = host.querySelector('canvas')!;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 96, 108));
    term.highlights.set('owned', [range(0, 0, 0, 10)]);
    host.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 1, clientY: 1 }));
    await vi.waitFor(() => expect(canvas.style.cursor).toBe('pointer'));
    frame();
    expect(background(0, 0)).toBe('#123456');
    expect(glyph(0, 0)?.color).toBe('rgb(12, 34, 56)');
    expect(strokes).toContain('#4A90E2');
  });
});
