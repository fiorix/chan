import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { GhosttyVt, VtSearch, VtTerminal, VtTrackedCell } from '../vt/ghosttyVt';
import { Terminal } from './terminal';

// Structural contract lets the same assertions run on a widget without search.
type Count = Readonly<{ index: number | null; total: number; partial: boolean }>;
type Search = {
  find(query: string): void;
  step(query: string, direction: 'older' | 'newer'): void;
  close(): void;
  readonly state: Count;
  onChange(listener: (state: Count) => void): { dispose(): void };
};
type Range = { start: { absoluteRow: number; col: number }; end: { absoluteRow: number; col: number } };
const range = (row: number, col: number, endRow = row, endCol = col + 5): Range => ({
  start: { absoluteRow: row, col }, end: { absoluteRow: endRow, col: endCol },
});
let module: WebAssembly.Module;
let now = 0;
let nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
const terminals: Terminal[] = [];
const fills: { color: string; x: number; y: number; w: number; h: number }[] = [];

beforeAll(async () => {
  module = await WebAssembly.compile(readFileSync('vendor/ghostty-vt/ghostty-vt.wasm'));
});
beforeEach(() => {
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => {
    frames.set(++nextFrame, run);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  // One genuine core scan unit per frame, independent of machine speed.
  const step = VtSearch.prototype.step;
  vi.spyOn(VtSearch.prototype, 'step').mockImplementation(function (this: VtSearch) {
    return step.call(this, 0, () => now);
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => {
    const state: Record<string, unknown> = { fillStyle: '' };
    return new Proxy(state, {
      get: (target, key: string) => {
        if (key === 'measureText') return () => ({ width: 8, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 4 });
        if (key === 'fillRect') return (x: number, y: number, w: number, h: number) => {
          fills.push({ color: String(target.fillStyle), x, y, w, h });
        };
        return target[key] ?? (() => undefined);
      },
    });
  }) as never);
});
afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose();
  frames.clear();
  fills.length = 0;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function frame() {
  for (const [id, callback] of [...frames]) {
    if (!frames.delete(id)) continue;
    callback(now);
  }
}
function searchOf(term: Terminal): Search {
  const search = (term as Terminal & { search?: Search }).search;
  expect(search, 'Terminal exposes its search owner').toBeDefined();
  return search!;
}
function settle(search: Search) {
  for (let i = 0; i < 1000; i++) {
    frame();
    if (!search.state.partial) return;
  }
  throw new Error('search did not complete');
}
async function create(input = '', cols = 40, rows = 6, scrollback = 5000, opened = true) {
  const ghostty = new GhosttyVt(await WebAssembly.instantiate(module, {}));
  const copy = vi.fn();
  const term = new Terminal({ ghostty, cols, rows, scrollback, cursorBlink: false, smoothScrollDuration: 0, copy });
  terminals.push(term);
  const host = document.createElement('div');
  document.body.append(host);
  if (opened) {
    term.open(host);
    term.write(`\x1b[?25l${input}`);
    frame();
  }
  return { term, host, copy };
}
const all = (term: Terminal) => term.highlights.get('search-all')?.ranges;
const active = (term: Terminal) => term.highlights.get('search-active')?.ranges;
const activeText = (term: Terminal) => {
  const ranges = active(term);
  return ranges?.length === 1 ? term.getRangeText(ranges[0]) : undefined;
};
const activeLine = (term: Terminal) => {
  const row = active(term)?.[0]?.start.absoluteRow;
  return row === undefined ? undefined : term.getRangeText({ start: { absoluteRow: row, col: 0 }, end: { absoluteRow: row, col: term.cols - 1 } }).trimEnd();
};
// Placement of one batch per frame: each read spends more than a frame.
function slowPlacement() {
  const read = VtSearch.prototype.readMatches;
  vi.spyOn(VtSearch.prototype, 'readMatches').mockImplementation(function (this: VtSearch, ...args) {
    const batch = read.apply(this, args);
    now += 600;
    return batch;
  });
}
const long = () => Array.from({ length: 3000 }, (_, i) => i % 10 === 5 ? `needle ${i}` : `line ${i}`).join('\r\n');

const wraps = [
  { name: 'split needle', first: 'x'.repeat(37) + 'needle', needle: 'needle', expected: range(0, 37, 1, 2) },
  { name: 'last column', first: 'x'.repeat(34) + 'needleX', needle: 'needle', expected: range(0, 34, 0, 39) },
  { name: 'wide before split', first: 'x'.repeat(37) + '\u754cneedle', needle: 'needle', expected: range(0, 39, 1, 4) },
  { name: 'wide past last column', first: 'x'.repeat(39) + '\u754cneedle', needle: '\u754cneedle', expected: range(1, 0, 1, 7) },
  { name: 'inside first row', first: 'needle' + 'x'.repeat(35), needle: 'needle', expected: range(0, 0) },
  { name: 'inside second row', first: 'x'.repeat(40) + 'needle', needle: 'needle', expected: range(1, 0) },
];

describe('widget search', () => {
  test('fixture writes and paints through the real widget before search assertions', async () => {
    const { term } = await create('needle');
    expect(term.getScrollbackText()).toBe('needle');
    expect(fills.length).toBeGreaterThan(0);
  });

  test('starts newest, highlights all results, and steps both ways through the same count', async () => {
    const { term, copy } = await create('needle a\r\nplain\r\nneedle b\r\nneedle c');
    term.setSelection(range(1, 0, 1, 4));
    const selected = term.getSelectionRange();
    const change = vi.fn();
    term.onChange(change);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    expect(all(term)).toEqual([range(3, 0), range(2, 0), range(0, 0)]);
    expect(active(term)).toEqual([range(3, 0)]);
    expect(search.state).toEqual({ index: 1, total: 3, partial: false });
    search.step('needle', 'older');
    expect(search.state.index).toBe(2);
    expect(active(term)).toEqual([range(2, 0)]);
    search.step('needle', 'newer');
    search.step('needle', 'newer');
    expect(search.state.index).toBe(3);
    expect(active(term)).toEqual([range(0, 0)]);
    search.step('needle', 'older');
    expect(search.state.index).toBe(1);
    expect(term.getSelectionRange()).toEqual(selected);
    expect(term.getSelection()).toBe('plain');
    expect(copy).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalled();
  });

  test('all-match and active paint are distinct, with the user selection above both', async () => {
    const { term } = await create('needle needle');
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    fills.length = 0;
    term.refresh();
    const color = (col: number) => {
      const x = (col + 0.5) * term.getMetrics()!.width;
      const y = term.getMetrics()!.height / 2;
      return fills.filter(f => x >= f.x && x < f.x + f.w && y >= f.y && y < f.y + f.h).at(-1)?.color;
    };
    expect(color(0)).toBeTruthy();
    expect(color(0)).not.toBe(color(7));
    term.setSelection(range(0, 7));
    term.refresh();
    expect(color(7)).toBe('#d4d4d4');
    expect(term.getSelection()).toBe('needle');
  });

  test.each(wraps)('deduplicates the complete $name range for count, navigation and paint', async ({ first, needle, expected }) => {
    const { term } = await create(first + '\r\n' + '\n'.repeat(1130) + 'x'.repeat(41) + '\r\n', 40, 2, 2000);
    const raw = term.core!.createSearch();
    raw.setNeedle(needle);
    for (let i = 0; raw.step(0) !== 'complete'; i++) if (i > 100) throw new Error('raw search did not complete');
    expect(raw.state().total, 'unchanged core reproduces the duplicate').toBe(2);
    raw.free();
    const search = searchOf(term);
    search.find(needle);
    settle(search);
    expect(search.state).toEqual({ index: 1, total: 1, partial: false });
    expect(all(term)).toEqual([expected]);
    expect(active(term)).toEqual([expected]);
    for (const direction of ['older', 'newer', 'older'] as const) {
      search.step(needle, direction);
      expect(search.state).toEqual({ index: 1, total: 1, partial: false });
      expect(active(term)).toEqual([expected]);
    }
  });

  test('keeps genuine overlapping matches in newest-first order', async () => {
    const { term } = await create('aaaa');
    const search = searchOf(term);
    search.find('aa');
    settle(search);
    expect(all(term)).toEqual([range(0, 2, 0, 3), range(0, 1, 0, 2), range(0, 0, 0, 1)]);
    expect(search.state.total).toBe(3);
    search.step('aa', 'older');
    expect(active(term)).toEqual([range(0, 1, 0, 2)]);
  });

  test('settled navigation and repaint reuse placed results, including the oldest match', async () => {
    const { term } = await create(long());
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    const read = vi.spyOn(VtSearch.prototype, 'readMatches');
    const whole = vi.spyOn(VtSearch.prototype, 'matchesBetween');
    search.step('needle', 'newer');
    frame();
    expect(search.state.index).toBe(300);
    expect(active(term)).toEqual([range(5, 0)]);
    term.refresh();
    search.step('needle', 'older');
    expect(search.state.index).toBe(1);
    expect(read).not.toHaveBeenCalled();
    expect(whole).not.toHaveBeenCalled();
    expect(all(term)).toHaveLength(300);
  });

  test('ordinary output retains the tracked oldest result while incremental placement is delayed', async () => {
    const { term } = await create('needle\r\n'.repeat(2000));
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'newer');
    expect(active(term)).toEqual([range(0, 0)]);
    const read = VtSearch.prototype.readMatches;
    vi.spyOn(VtSearch.prototype, 'readMatches').mockImplementation(function (this: VtSearch, ...args) {
      const batch = read.apply(this, args);
      now += 600;
      return batch;
    });
    term.write('more');
    frame();
    settle(search);
    expect(search.state).toEqual({ index: 2000, total: 2000, partial: false });
    expect(active(term)).toEqual([range(0, 0)]);
    search.step('needle', 'newer');
    expect(search.state).toEqual({ index: 1999, total: 2000, partial: false });
    expect(active(term)).toEqual([range(1, 0)]);
  });

  test('each paint after a write shows the refreshed all-match layer, also under steady output', async () => {
    const { term } = await create('needle a\r\nplain\r\nneedle b\r\nneedle c');
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    expect(all(term)).toHaveLength(3);
    const painted: (number | undefined)[] = [];
    term.addPaintLayer({ order: 0, paint: () => painted.push(all(term)?.length) });
    frame();
    painted.length = 0;
    const feed = vi.spyOn(VtSearch.prototype, 'feed');
    for (let i = 0; i < 5; i++) {
      term.write(`\r\nline ${i}`);
      frame();
    }
    expect(painted.length).toBeGreaterThanOrEqual(5);
    expect(painted.every(count => count === 3), `painted with ${painted} matches`).toBe(true);
    expect(feed, 'one feed a frame').toHaveBeenCalledTimes(5);
    expect(search.state).toEqual({ index: 1, total: 3, partial: false });
  });

  test('the echo paint inside a write shows the refreshed all-match layer', async () => {
    const { term } = await create('needle a\r\nneedle b');
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    const painted: (number | undefined)[] = [];
    term.addPaintLayer({ order: 0, paint: () => painted.push(all(term)?.length) });
    frame();
    painted.length = 0;
    term.input('x', true);
    term.write('x');
    expect(painted, 'the write painted its echo').toEqual([2]);
  });

  test('a write keeps the last total as a partial count until the refreshed results replace it', async () => {
    const { term } = await create('needle a\r\nplain\r\nneedle b\r\nneedle c');
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    const counts: Count[] = [];
    search.onChange(count => counts.push(count));
    term.write('\r\nmore');
    expect(search.state).toEqual({ index: null, total: 3, partial: true });
    term.write('\r\nneedle d');
    expect(search.state).toEqual({ index: null, total: 3, partial: true });
    frame();
    expect(search.state).toEqual({ index: 2, total: 4, partial: false });
    // Output that erases matches: the kept total is a claim only until the
    // rescan ends.
    term.write('\x1b[3J\x1b[2J\x1b[H');
    expect(search.state).toEqual({ index: null, total: 4, partial: true });
    settle(search);
    expect(search.state).toEqual({ index: 0, total: 0, partial: false });
    expect(counts.filter(count => count.partial).map(count => count.total), 'no zero between a write and its frame').toEqual([3, 4]);
    expect(all(term) ?? []).toEqual([]);
  });

  test('a step from the middle of a large list after a write waits for its index and steps from it', async () => {
    const { term } = await create('needle\r\n'.repeat(2000));
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'newer');
    for (let i = 0; i < 499; i++) search.step('needle', 'newer');
    expect(search.state).toEqual({ index: 1501, total: 2000, partial: false });
    expect(active(term)).toEqual([range(499, 0)]);
    const read = VtSearch.prototype.readMatches;
    vi.spyOn(VtSearch.prototype, 'readMatches').mockImplementation(function (this: VtSearch, ...args) {
      const batch = read.apply(this, args);
      now += 600;
      return batch;
    });
    term.write('more');
    frame();
    search.step('needle', 'older');
    expect(search.state.index).toBeNull();
    now += 1000;
    frame();
    expect(search.state.partial).toBe(true);
    expect(search.state.index, 'the press outlives its deadline rather than restart from the newest match').toBeNull();
    expect(active(term)).toEqual([range(499, 0)]);
    settle(search);
    expect(search.state).toEqual({ index: 1502, total: 2000, partial: false });
    expect(active(term)).toEqual([range(498, 0)]);
  });

  test('a queued step at the oldest match waits for placement of its index, past its deadline, before it wraps', async () => {
    const { term } = await create('needle\r\n'.repeat(2000));
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'newer');
    const read = VtSearch.prototype.readMatches;
    vi.spyOn(VtSearch.prototype, 'readMatches').mockImplementation(function (this: VtSearch, ...args) {
      const batch = read.apply(this, args);
      now += 600;
      return batch;
    });
    term.write('more');
    frame();
    search.step('needle', 'older');
    expect(search.state.index).toBeNull();
    expect(active(term)).toEqual([range(0, 0)]);
    now += 1000;
    frame();
    expect(search.state.partial).toBe(true);
    expect(search.state.index).toBeNull();
    expect(active(term)).toEqual([range(0, 0)]);
    settle(search);
    expect(search.state).toEqual({ index: 1, total: 2000, partial: false });
    expect(active(term)).toEqual([range(1999, 0)]);
  });

  test('a step waiting on a match that output erased starts over once the rescan ends', async () => {
    const { term } = await create('needle a\r\nneedle b\r\nneedle c');
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'older');
    expect(active(term)).toEqual([range(1, 0)]);
    const read = VtSearch.prototype.readMatches;
    // A read that spends its whole slice and places nothing; the clock must
    // advance, since the owner reads until its deadline.
    const slow = vi.spyOn(VtSearch.prototype, 'readMatches').mockImplementation(() => {
      now += 600;
      return { ranges: [], next: 0, total: 0 };
    });
    term.write('\x1b[2;1H\x1b[2K');
    search.step('needle', 'older');
    now += 1000;
    frame();
    expect(search.state.index, 'the index is still unplaced').toBeNull();
    slow.mockImplementation(read);
    settle(search);
    expect(search.state).toEqual({ index: 1, total: 2, partial: false });
    expect(active(term)).toEqual([range(2, 0)]);
  });

  test('under output every frame, a step from an unplaced deep match lands on its neighbour at once', async () => {
    const { term } = await create('needle\r\n'.repeat(2000));
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    for (let i = 0; i < 500; i++) search.step('needle', 'newer');
    expect(active(term)).toEqual([range(499, 0)]);
    slowPlacement();
    const stream = () => { term.write('tick\r\n'); frame(); };
    stream();
    search.step('needle', 'older');
    expect(active(term), 'the press lands before placement reaches the kept match').toEqual([range(498, 0)]);
    for (let i = 0; i < 20; i++) stream();
    expect(active(term)).toEqual([range(498, 0)]);
    search.step('needle', 'older');
    search.step('needle', 'older');
    expect(active(term), 'queued presses step on from where the last landed').toEqual([range(496, 0)]);
    expect(search.state.partial).toBe(true);
    settle(search);
    expect(search.state).toEqual({ index: 1504, total: 2000, partial: false });
  });

  test('a neighbour step under output every frame follows history pruned since the kept match was placed', async () => {
    const { term } = await create(Array.from({ length: 2900 }, (_, i) => `needle ${i}`).join('\r\n'), 80, 5, 3000);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'newer');
    for (let i = 0; activeLine(term) !== 'needle 1000'; i++) {
      if (i > 1000) throw new Error('needle 1000 not reached');
      search.step('needle', 'newer');
    }
    const placedAt = active(term)![0].start.absoluteRow;
    slowPlacement();
    for (let i = 0; i < 40 && active(term)![0].start.absoluteRow === placedAt; i++) {
      term.write('filler\r\n'.repeat(40));
      frame();
    }
    expect(active(term)![0].start.absoluteRow, 'output pruned history above the kept match').toBeLessThan(placedAt);
    expect(activeLine(term)).toBe('needle 1000');
    expect(search.state.index, 'placement has not reached the kept match').toBeNull();
    search.step('needle', 'older');
    expect(activeLine(term)).toBe('needle 999');
    search.step('needle', 'newer');
    search.step('needle', 'newer');
    expect(activeLine(term)).toBe('needle 1001');
  });

  test('under output every frame, a step whose neighbour was on the screen waits no longer than its cap', async () => {
    const { term } = await create('needle\r\n'.repeat(2000));
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'older');
    expect(active(term)).toEqual([range(1998, 0)]);
    slowPlacement();
    // Erase the kept match and its newer neighbour, both on the screen.
    term.write('\x1b[4;1H\x1b[2K\x1b[5;1H\x1b[2K');
    frame();
    search.step('needle', 'newer');
    const pressed = now;
    while (now - pressed < 1000) {
      expect(active(term), 'the press waits within its cap').toEqual([range(1998, 0)]);
      term.write('\x1b[1;1H');
      frame();
    }
    term.write('\x1b[1;1H');
    frame();
    expect(active(term)).toHaveLength(1);
    expect(active(term), 'the press went through at its cap').not.toEqual([range(1998, 0)]);
    expect(activeText(term)).toBe('needle');
  });

  test('publishes partial results and queues wrapping steps in press order', async () => {
    const { term } = await create(long());
    const search = searchOf(term);
    const counts: Count[] = [];
    search.onChange(s => counts.push(s));
    search.step('needle', 'newer');
    search.step('needle', 'newer');
    search.step('needle', 'newer');
    search.step('needle', 'older');
    expect(active(term) ?? []).toEqual([]);
    frame();
    expect(search.state.partial).toBe(true);
    expect(search.state.total).toBeGreaterThan(0);
    expect(search.state.total).toBeLessThan(300);
    expect(all(term)?.length).toBe(search.state.total);
    settle(search);
    expect(search.state).toEqual({ index: 299, total: 300, partial: false });
    expect(active(term)).toEqual([range(15, 0)]);
    expect(counts.some(c => c.partial && c.total > 0)).toBe(true);
  });

  test('older at the oldest discovered match waits for the next older result', async () => {
    const { term } = await create(long());
    const search = searchOf(term);
    search.find('needle');
    frame();
    const found = search.state.total;
    expect(found).toBeGreaterThan(0);
    expect(search.state.partial).toBe(true);
    for (let i = 1; i < found; i++) search.step('needle', 'older');
    search.step('needle', 'older');
    expect(search.state.index).toBe(found);
    settle(search);
    expect(search.state.index).toBe(found + 1);
  });

  test('a waiting wrap applies at its one-second cap even while the scan is partial', async () => {
    const { term } = await create(long());
    const search = searchOf(term);
    search.step('needle', 'newer');
    now = 999;
    frame();
    expect(search.state.index).toBeNull();
    now = 1000;
    frame();
    expect(search.state.partial).toBe(true);
    expect(search.state.index).toBe(search.state.total);
    expect(active(term)?.length).toBe(1);
  });

  test('replacement and close discard waiting steps and only the search layers', async () => {
    const { term } = await create(long() + '\r\nunique');
    const search = searchOf(term);
    term.highlights.set('consumer', [range(0, 0)]);
    search.step('needle', 'newer');
    search.find('unique');
    settle(search);
    expect(search.state).toEqual({ index: 1, total: 1, partial: false });
    expect(active(term)).toEqual([range(3000, 0)]);
    const selected = range(3000, 0, 3000, 2);
    term.setSelection(selected);
    search.close();
    frame();
    expect(search.state).toEqual({ index: 0, total: 0, partial: false });
    expect(all(term)).toBeUndefined();
    expect(active(term)).toBeUndefined();
    expect(term.highlights.get('consumer')?.ranges).toEqual([range(0, 0)]);
    expect(term.getSelectionRange()).toEqual(selected);
    search.find('unique');
    settle(search);
    search.find('');
    expect(active(term)).toBeUndefined();
  });

  test('coalesces writes and follows the active text without selecting the new newest result', async () => {
    const { term } = await create('needle a');
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    const feed = vi.spyOn(VtSearch.prototype, 'feed');
    term.write('\r\nneedle b');
    term.write('\r\nneedle c');
    expect(feed).not.toHaveBeenCalled();
    frame();
    expect(feed).toHaveBeenCalledTimes(1);
    settle(search);
    expect(search.state).toEqual({ index: 3, total: 3, partial: false });
    expect(active(term)).toEqual([range(0, 0)]);
  });

  test('reflows the tracked active highlight before paint and restores its index before queued steps', async () => {
    const { term } = await create('first needle\r\n' + 'x'.repeat(17) + 'needle\r\nneedle last', 20, 6);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'older');
    expect(active(term)).toEqual([range(1, 17, 2, 2)]);
    const paint = vi.fn(() => active(term));
    term.addPaintLayer({ order: 0, paint });
    term.resize(12, 6);
    expect(paint.mock.results.at(-1)?.value).toEqual([range(2, 5, 2, 10)]);
    expect(search.state.partial).toBe(true);
    search.step('needle', 'older');
    settle(search);
    expect(search.state).toEqual({ index: 3, total: 3, partial: false });
    expect(active(term)).toEqual([range(0, 6, 0, 11)]);
  });

  test('resize restoration waits at most one second and then leaves no active result', async () => {
    const { term } = await create(long());
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'newer');
    expect(active(term)).toEqual([range(5, 0)]);
    term.resize(41, 6);
    now = 1000;
    frame();
    expect(active(term)).toBeUndefined();
    settle(search);
    expect(search.state).toEqual({ index: null, total: 300, partial: false });
    search.step('needle', 'older');
    expect(search.state.index).toBe(1);
  });

  test('a resize result first rediscovered at the deadline does not restore the active match', async () => {
    const { term } = await create('needle');
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    term.resize(41, 6);
    now = 1000;
    settle(search);
    expect(search.state).toEqual({ index: null, total: 1, partial: false });
    expect(active(term)).toBeUndefined();
  });

  test('a delayed ordinary output feed keeps the active match without a restoration deadline', async () => {
    const { term } = await create('needle');
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    term.write(' more');
    now = 2000;
    settle(search);
    expect(search.state).toEqual({ index: 1, total: 1, partial: false });
    expect(active(term)).toEqual([range(0, 0)]);
  });

  test('a user selection made while a step waits prevents a delayed viewport jump', async () => {
    const { term } = await create(long());
    const search = searchOf(term);
    search.step('needle', 'newer');
    const selected = range(2998, 0, 2998, 3);
    term.setSelection(selected);
    const offset = term.viewport.offset;
    settle(search);
    expect(search.state).toEqual({ index: 300, total: 300, partial: false });
    expect(active(term)).toEqual([range(5, 0)]);
    expect(term.getSelectionRange()).toEqual(selected);
    expect(term.viewport.offset).toBe(offset);
    search.step('needle', 'newer');
    expect(term.viewport.offset).toBeGreaterThan(offset);
    expect(term.getSelectionRange()).toEqual(selected);
  });

  test('an active match cropped by alternate-screen resize is lost', async () => {
    const { term } = await create('\x1b[?1049h' + 'x'.repeat(17) + 'needle', 24, 4);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    term.resize(20, 4);
    settle(search);
    expect(search.state).toEqual({ index: 0, total: 0, partial: false });
    expect(active(term)).toBeUndefined();
  });

  test('a screen switch removes stale results synchronously and never restores the other screen active match', async () => {
    const { term } = await create('needle');
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    term.write('\x1b[?1049hneedle alt');
    expect(active(term)).toBeUndefined();
    expect(all(term)).toBeUndefined();
    settle(search);
    expect(search.state).toEqual({ index: null, total: 1, partial: false });
    search.step('needle', 'older');
    term.write('\x1b[?1049l');
    settle(search);
    expect(search.state).toEqual({ index: null, total: 1, partial: false });
    expect(active(term)).toBeUndefined();
  });

  test('the primary screen active match returns with the primary screen after an alternate screen', async () => {
    const { term } = await create('x needle\r\nyy needle');
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'older');
    expect(active(term)).toEqual([range(0, 2)]);
    term.write('\x1b[?1049h');
    expect(active(term)).toBeUndefined();
    term.write('\x1b[2J\x1b[Hneedle alt\r\n\r\n\r\nalt needle');
    settle(search);
    search.step('needle', 'older');
    expect(active(term)).toEqual([range(3, 4)]);
    term.write('\x1b[?1049l');
    expect(active(term), 'the primary match is highlighted before the rescan').toEqual([range(0, 2)]);
    settle(search);
    expect(search.state).toEqual({ index: 2, total: 2, partial: false });
    expect(active(term)).toEqual([range(0, 2)]);
    search.step('needle', 'older');
    expect(active(term), 'a step goes on from the returned match').toEqual([range(1, 3)]);
  });

  test('pruning discards the active match instead of reusing its old coordinates', async () => {
    const { term } = await create('needle\r\n' + 'filler\r\n'.repeat(900) + 'needle', 80, 5, 1000);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'newer');
    expect(active(term)).toEqual([range(0, 0)]);
    term.write('\r\n' + 'filler\r\n'.repeat(600));
    settle(search);
    expect(search.state).toEqual({ index: null, total: 1, partial: false });
    expect(active(term)).toBeUndefined();
    search.step('needle', 'older');
    expect(search.state.index).toBe(1);
    expect(active(term)?.[0].start.absoluteRow).toBeLessThan(901);
  });

  test('a predicted expensive feed restarts the scan and preserves the kept match', async () => {
    const { term } = await create('needle\r\n' + 'filler\r\n'.repeat(20_000), 200, 5, 60_000);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    const restart = vi.spyOn(VtSearch.prototype, 'restart');
    term.write('filler\r\n'.repeat(16_000));
    frame();
    expect(restart).toHaveBeenCalledOnce();
    expect(search.state.partial).toBe(true);
    expect(active(term)).toEqual([range(0, 0)]);
    settle(search);
    expect(search.state).toEqual({ index: 1, total: 1, partial: false });
  });

  test('snapshots and notifications are immutable, unsubscribable and permit closing in a listener', async () => {
    const { term } = await create('needle');
    const search = searchOf(term);
    const changed = vi.fn();
    const sub = search.onChange(changed);
    search.find('needle');
    settle(search);
    const snapshot = search.state;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Reflect.set(snapshot, 'total', 900)).toBe(false);
    expect(search.state.total).toBe(1);
    sub.dispose();
    changed.mockClear();
    search.close();
    expect(changed).not.toHaveBeenCalled();
    search.onChange(s => { if (s.total > 0) search.close(); });
    search.find('needle');
    frame();
    expect(search.state).toEqual({ index: 0, total: 0, partial: false });
    expect(active(term)).toBeUndefined();
  });

  test('replacing, closing and disposing free each search and tracked reference', async () => {
    const searches = vi.spyOn(VtTerminal.prototype, 'createSearch');
    const tracked = vi.spyOn(VtTerminal.prototype, 'trackCell');
    const { term } = await create('needle other');
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    const first = searches.mock.results[0].value as VtSearch;
    const cells = tracked.mock.results.filter(r => r.value).map(r => r.value as VtTrackedCell);
    expect(cells).toHaveLength(3);
    search.find('other');
    expect(first.state()).toEqual({ total: 0, index: null, active: null, complete: true });
    for (const cell of cells) expect(cell.point()).toBeNull();
    settle(search);
    search.close();
    for (const result of tracked.mock.results) if (result.value) expect(result.value.point()).toBeNull();
    search.find('needle');
    settle(search);
    const changed = vi.fn();
    search.onChange(changed);
    term.dispose();
    changed.mockClear();
    search.find('needle');
    search.step('needle', 'older');
    search.close();
    frame();
    expect(changed).not.toHaveBeenCalled();
    expect(search.state).toEqual({ index: 0, total: 0, partial: false });
    for (const result of tracked.mock.results) if (result.value) expect(result.value.point()).toBeNull();
  });

  test('a stable frozen facade does not retain requests or listeners before open', async () => {
    const { term, host } = await create('', 40, 6, 100, false);
    const search = searchOf(term);
    const changed = vi.fn();
    const sub = search.onChange(changed);
    search.find('needle');
    search.step('needle', 'newer');
    search.close();
    expect(search.state).toEqual({ index: 0, total: 0, partial: false });
    term.open(host);
    term.write('needle');
    frame();
    expect(searchOf(term)).toBe(search);
    expect(Object.isFrozen(search)).toBe(true);
    expect(all(term)).toBeUndefined();
    search.find('needle');
    settle(search);
    expect(changed).not.toHaveBeenCalled();
    sub.dispose();
  });
});
