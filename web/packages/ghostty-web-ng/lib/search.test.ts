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
    search.step('needle', 'newer');
    settle(search);
    expect(search.state).toEqual({ index: 1999, total: 2000, partial: false });
    expect(active(term)).toEqual([range(1, 0)]);
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
