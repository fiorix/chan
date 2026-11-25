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
// A feed that outruns a press's placement slice, as on a large history, so
// the press returns with the active match's index unplaced.
function slowFeed() {
  const feed = VtSearch.prototype.feed;
  vi.spyOn(VtSearch.prototype, 'feed').mockImplementation(function (this: VtSearch) {
    feed.call(this);
    now += 5;
  });
}
// A feed that spends a frame's placement slice, as one does on the largest
// history, so a frame that follows a write places nothing.
function feedSpendsSlice() {
  const feed = VtSearch.prototype.feed;
  vi.spyOn(VtSearch.prototype, 'feed').mockImplementation(function (this: VtSearch) {
    feed.call(this);
    now += 9;
  });
}
// One placement batch per frame, far inside the one-second wait cap.
function batchPerFrame() {
  const read = VtSearch.prototype.readMatches;
  vi.spyOn(VtSearch.prototype, 'readMatches').mockImplementation(function (this: VtSearch, ...args) {
    const batch = read.apply(this, args);
    now += 5;
    return batch;
  });
}
// Placement stopped once at each list entry of `at` in turn, with its
// slice spent, as a deadline falling there stops it.
function placementStopsAt(...at: number[]) {
  const read = VtSearch.prototype.readMatches;
  vi.spyOn(VtSearch.prototype, 'readMatches').mockImplementation(function (this: VtSearch, start: number, budget: number) {
    const batch = read.call(this, start, budget);
    const cut = at[0];
    if (cut === undefined || start > cut || batch.next <= cut) return batch;
    at.shift();
    now += 5;
    return { ranges: batch.ranges.slice(0, cut - start), next: cut, total: batch.total };
  });
}
const long = () => Array.from({ length: 3000 }, (_, i) => i % 10 === 5 ? `needle ${i}` : `line ${i}`).join('\r\n');
const numbered = (n: number) => Array.from({ length: n }, (_, i) => `needle ${i}`).join('\r\n');
// Needles on irregular rows and columns, so a wrong row or a wrong entry
// cannot land on a needle by accident.
const irregular = (n: number) => Array.from({ length: n }, (_, i) =>
  i % 7 === 0 || i % 7 === 3 ? `${' '.repeat(i % 5)}needle ${i}` : `line ${i}`).join('\r\n');
// The active ranges of the next `count` older steps, stepping back after.
function olderRanges(term: Terminal, search: Search, count: number) {
  const out: ReturnType<typeof active>[] = [];
  for (let i = 0; i < count; i++) {
    search.step('needle', 'older');
    out.push(active(term));
  }
  for (let i = 0; i < count; i++) search.step('needle', 'newer');
  return out;
}
// Lines of 300 cells at 200 columns, two rows each, with `needles`
// matches at the start of each line's first row, 7 cells apart: the last
// page of the core's history opens on a wrapped row, the second of line
// 115, so its active-area search takes in the page above and lists that
// page's matches first.
const paged = (needles: number, lines = 120) => Array.from({ length: lines }, () => 'needle '.repeat(needles).padEnd(300, 'x')).join('\r\n');
// 240 such lines with one match each on a 20-row screen: the screen spans
// the last two pages (rows 460 to 479, the last page opens at row 462) and
// the page above them soft-wraps into them, so the core lists three pages,
// oldest first. Lines 221 to 230 hold no needle, so the middle page's
// newest match, row 440, is in the history.
const threePaged = Array.from({ length: 240 }, (_, i) => (i <= 220 || i >= 231 ? 'needle ' : 'plain ').padEnd(300, 'x')).join('\r\n');
// The same three pages with a match on every line, and line 115 wrapping a
// second needle across the boundary between the first listed page (rows up
// to 230) and the middle one (from row 231), at 230:197 to 231:2.
const threeStraddled = Array.from({ length: 240 }, (_, i) => i === 115
  ? 'needle '.padEnd(197, 'y') + 'needle' + 'z'.repeat(97) : 'needle '.padEnd(300, 'x')).join('\r\n');
// Lines of one row at 80 columns, 573 to a page of the core's history,
// with matches on the last 286 only: the screen spans the boundary between
// the last two pages, both hold matches on it, and the `pages` pages above
// them hold none.
const screenPaged = (pages: number) => Array.from({ length: 573 * (pages + 1) + 13 }, (_, i) =>
  (i >= 573 * pages + 300 ? 'needle ' : 'plain ') + i).join('\r\n');
// The first match the core itself lists, in its own order.
function coreFirst(term: Terminal, needle: string) {
  const raw = term.core!.createSearch();
  raw.setNeedle(needle);
  for (let i = 0; raw.step(0) !== 'complete'; i++) if (i > 100_000) throw new Error('raw search did not complete');
  const first = raw.matchesBetween(0, Number.MAX_SAFE_INTEGER, 1)[0];
  raw.free();
  return first;
}
// The start rows of the first `count` matches the core lists, in its own order.
function coreRows(term: Terminal, needle: string, count: number) {
  const raw = term.core!.createSearch();
  raw.setNeedle(needle);
  for (let i = 0; raw.step(0) !== 'complete'; i++) if (i > 100_000) throw new Error('raw search did not complete');
  const rows = raw.matchesBetween(0, Number.MAX_SAFE_INTEGER, count).map(match => match.startRow);
  raw.free();
  return rows;
}

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

  test('counts, steps and highlights in position order where the core lists a page ahead of the screen', async () => {
    const { term } = await create(paged(1), 200, 5, 10_000_000);
    expect(coreFirst(term, 'needle').startRow, 'unchanged core lists a match above the newest first').toBeLessThan(238);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    expect(search.state).toEqual({ index: 1, total: 120, partial: false });
    expect(active(term), 'the newest match is the bottom-most').toEqual([range(238, 0)]);
    for (let line = 118; line >= 0; line--) {
      search.step('needle', 'older');
      expect(active(term), `older lands on line ${line}`).toEqual([range(2 * line, 0)]);
      expect(search.state.index).toBe(120 - line);
    }
    search.step('needle', 'older');
    expect(active(term), 'older wraps from the oldest to the newest').toEqual([range(238, 0)]);
    search.step('needle', 'newer');
    search.step('needle', 'newer');
    expect(active(term)).toEqual([range(2, 0)]);
    expect(search.state).toEqual({ index: 119, total: 120, partial: false });
    const painted = [...all(term)!].sort((a, b) => a.start.absoluteRow - b.start.absoluteRow);
    expect(painted).toEqual(Array.from({ length: 120 }, (_, line) => range(2 * line, 0)));
  });

  test("find's first activation lands on the newest at once where the core lists a page ahead", async () => {
    const { term } = await create(paged(20), 200, 5, 10_000_000);
    const newest = range(238, 133);
    expect(coreFirst(term, 'needle'), 'unchanged core lists a match above the newest first').not.toEqual({
      startRow: newest.start.absoluteRow, startCol: newest.start.col, endRow: newest.end.absoluteRow, endCol: newest.end.col,
    });
    batchPerFrame();
    const search = searchOf(term);
    search.find('needle');
    frame();
    expect(active(term), 'the first frame lands, before placement reaches the match').toEqual([newest]);
    expect(search.state.index, 'its index waits for the matches placed ahead of it').toBeNull();
    for (let i = 0; i < 1000 && search.state.partial; i++) {
      frame();
      expect(active(term), `frame ${i} keeps only the newest match`).toEqual([newest]);
      expect([null, 1], `frame ${i}: the index is unknown or the newest's`).toContain(search.state.index);
    }
    expect(search.state).toEqual({ index: 1, total: 2400, partial: false });
    expect(active(term)).toEqual([newest]);
  });

  test('find lands on the newest where the core lists three pages, from inside the middle one', async () => {
    const { term } = await create(threePaged, 200, 20, 10_000_000);
    const rows = coreRows(term, 'needle', 230);
    expect(rows.slice(0, 116).every(row => row <= 230), 'the core lists the first page first').toBe(true);
    expect(rows.slice(116, 221).every(row => row >= 232 && row <= 440), 'then the page the screen starts in').toBe(true);
    expect(rows.slice(221), 'then the last page, newest first').toEqual([478, 476, 474, 472, 470, 468, 466, 464, 462]);
    // Placement stops inside the middle page's entries.
    placementStopsAt(200);
    const search = searchOf(term);
    search.find('needle');
    frame();
    expect(active(term), 'the first frame lands on the last page\'s first entry').toEqual([range(478, 0)]);
    expect(search.state.index, 'placement has not reached the match').toBeNull();
    settle(search);
    expect(active(term)).toEqual([range(478, 0)]);
    expect(search.state).toEqual({ index: 1, total: 230, partial: false });
  });

  test('where the screen spans two pages and nothing above them matches, find knows the index and a step lands at once', async () => {
    const pages = 8;
    const { term } = await create(screenPaged(pages), 80, 24, 10_000_000);
    const last = 573 * (pages + 1) + 12;
    const rows = coreRows(term, 'needle', 286);
    expect(rows.slice(0, 273), 'the core lists the page the screen starts in first').toEqual(Array.from({ length: 273 }, (_, i) => last - 13 - i));
    expect(rows[0], "that page's newest is on the screen").toBeGreaterThanOrEqual(term.getScrollbackLength());
    expect(rows.slice(273), 'then the last page, newest first').toEqual(Array.from({ length: 13 }, (_, i) => last - i));
    const search = searchOf(term);
    search.find('needle');
    frame();
    expect(search.state, 'the first frame places the matches and knows the index while the scan goes on').toEqual({ index: 1, total: 286, partial: true });
    expect(active(term)).toEqual([range(last, 0)]);
    search.step('needle', 'older');
    expect(active(term), 'older lands in the call').toEqual([range(last - 1, 0)]);
    expect(search.state.index).toBe(2);
    settle(search);
    expect(active(term)).toEqual([range(last - 1, 0)]);
    expect(search.state).toEqual({ index: 2, total: 286, partial: false });
  });

  test("a resize right after find's first activation keeps the unplaced newest until the rescan places it", async () => {
    const { term } = await create(paged(20), 200, 5, 10_000_000);
    const newest = range(238, 133);
    batchPerFrame();
    const search = searchOf(term);
    search.find('needle');
    frame();
    expect(active(term)).toEqual([newest]);
    expect(search.state.index, 'placement has not reached the match').toBeNull();
    term.resize(200, 6);
    expect(coreFirst(term, 'needle'), 'the resized core still lists a match above the newest first').not.toEqual({
      startRow: newest.start.absoluteRow, startCol: newest.start.col, endRow: newest.end.absoluteRow, endCol: newest.end.col,
    });
    for (let i = 0; i < 1000 && search.state.partial; i++) {
      frame();
      expect(active(term), `frame ${i} keeps only the newest match`).toEqual([newest]);
      expect([null, 1], `frame ${i}: the index is unknown or the newest's`).toContain(search.state.index);
    }
    expect(search.state).toEqual({ index: 1, total: 2400, partial: false });
  });

  test('a first step with a new query lands on the newest where the core lists a page ahead', async () => {
    const { term } = await create(paged(20), 200, 5, 10_000_000);
    const newest = range(238, 133);
    expect(coreFirst(term, 'needle').startRow, 'unchanged core lists a match above the newest first').toBeLessThan(238);
    batchPerFrame();
    const search = searchOf(term);
    search.step('needle', 'older');
    for (let i = 0; i < 1000 && search.state.partial; i++) {
      if (active(term)) expect(active(term), `frame ${i} activates only the newest match`).toEqual([newest]);
      frame();
    }
    expect(search.state).toEqual({ index: 1, total: 2400, partial: false });
    expect(active(term)).toEqual([newest]);
  });

  test('a wrap to the newest during a restarted scan lands on the bottom-most match', async () => {
    const { term } = await create(paged(20), 200, 5, 10_000_000);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'newer');
    expect(active(term)).toEqual([range(0, 0)]);
    const restart = vi.spyOn(VtSearch.prototype, 'restart');
    term.write('\r\n' + paged(20, 7623));
    const lastRow = term.getScrollbackLength() + term.rows - 1;
    const newest = range(lastRow - 1, 133);
    expect(coreFirst(term, 'needle').startRow, 'unchanged core lists a match above the newest first').toBeLessThan(newest.start.absoluteRow);
    batchPerFrame();
    frame();
    expect(restart, 'the feed was predicted too expensive').toHaveBeenCalledOnce();
    search.step('needle', 'older');
    for (let i = 0; i < 3000 && search.state.partial; i++) {
      if (active(term) && active(term)![0].start.absoluteRow !== 0) expect(active(term), `frame ${i}: the wrap lands only on the newest`).toEqual([newest]);
      frame();
    }
    expect(active(term)).toEqual([newest]);
    expect(search.state.index).toBe(1);
  });

  test("output right after find's first activation keeps the unplaced newest until placement reaches it", async () => {
    const { term } = await create(paged(20), 200, 5, 10_000_000);
    const newest = range(238, 133);
    batchPerFrame();
    const search = searchOf(term);
    search.find('needle');
    frame();
    expect(active(term)).toEqual([newest]);
    expect(search.state.index, 'placement has not reached the match').toBeNull();
    term.write('x');
    for (let i = 0; i < 1000 && search.state.partial; i++) {
      frame();
      expect(active(term), `frame ${i} keeps only the newest match`).toEqual([newest]);
      expect([null, 1], `frame ${i}: the index is unknown or the newest's`).toContain(search.state.index);
    }
    expect(search.state).toEqual({ index: 1, total: 2400, partial: false });
    expect(active(term)).toEqual([newest]);
  });

  test('after output, older from the oldest match wraps to the bottom-most match where the core lists a page ahead', async () => {
    const { term } = await create(paged(20), 200, 5, 10_000_000);
    const newest = range(238, 133);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'newer');
    expect(active(term)).toEqual([range(0, 0)]);
    batchPerFrame();
    term.write('x');
    frame();
    search.step('needle', 'older');
    expect(active(term), 'the wrap lands at once, before placement reaches the match').toEqual([newest]);
    for (let i = 0; i < 1000 && search.state.partial; i++) {
      expect(active(term), `frame ${i}: the wrap stays on the newest`).toEqual([newest]);
      expect([null, 1], `frame ${i}: the index is unknown or the newest's`).toContain(search.state.index);
      frame();
    }
    expect(search.state).toEqual({ index: 1, total: 2400, partial: false });
    expect(active(term)).toEqual([newest]);
  });

  test("under output every frame, find lands on the newest past the one-second cap", async () => {
    const { term } = await create(paged(20), 200, 5, 10_000_000);
    const newest = range(238, 133);
    batchPerFrame();
    const search = searchOf(term);
    search.find('needle');
    // Each write empties the list again, so placement never passes the
    // core's active-area entries while the output lasts.
    for (let i = 0; i < 100; i++) {
      term.write('x');
      now += 11;
      frame();
      if (active(term)) expect(active(term), `frame ${i} at ${now} ms activates only the newest match`).toEqual([newest]);
    }
    expect(now, 'the output outlasted the cap').toBeGreaterThan(1000);
    settle(search);
    expect(active(term)).toEqual([newest]);
    expect(search.state).toEqual({ index: 1, total: 2400, partial: false });
  });

  test('under output every frame, older from the oldest wraps to the newest past the one-second cap', async () => {
    const { term } = await create(paged(20), 200, 5, 10_000_000);
    const newest = range(238, 133);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'newer');
    expect(active(term)).toEqual([range(0, 0)]);
    batchPerFrame();
    term.write('x');
    frame();
    search.step('needle', 'older');
    const pressed = now;
    for (let i = 0; i < 100; i++) {
      term.write('x');
      now += 11;
      frame();
      if (active(term)) expect(active(term), `frame ${i} at ${now - pressed} ms: the wrap lands only on the newest`).toEqual([newest]);
    }
    expect(now - pressed, 'the output outlasted the cap').toBeGreaterThan(1000);
    settle(search);
    expect(active(term)).toEqual([newest]);
    expect(search.state).toEqual({ index: 1, total: 2400, partial: false });
  });

  test('under output every frame, find lands on the newest at once where the core lists one page and no frame places a match', async () => {
    const { term } = await create(numbered(100), 40, 6, 10_000_000);
    const newest = range(99, 0);
    expect(coreFirst(term, 'needle').startRow, 'the core lists its active area in order').toBe(99);
    feedSpendsSlice();
    const search = searchOf(term);
    search.find('needle');
    for (let i = 0; i < 120; i++) {
      term.write('x');
      now += 11;
      frame();
      expect(active(term), `frame ${i}: find has landed on the newest`).toEqual([newest]);
    }
    expect(all(term) ?? [], 'no frame of the output placed a match').toHaveLength(0);
    settle(search);
    expect(active(term)).toEqual([newest]);
    expect(search.state).toEqual({ index: 1, total: 100, partial: false });
  });

  test('under output every frame, older from the oldest wraps at once where the core lists one page and no frame places a match', async () => {
    const { term } = await create(numbered(100), 40, 6, 10_000_000);
    const newest = range(99, 0);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'newer');
    expect(active(term)).toEqual([range(0, 0)]);
    feedSpendsSlice();
    term.write('x');
    search.step('needle', 'older');
    expect(active(term), 'the wrap lands in the call').toEqual([newest]);
    for (let i = 0; i < 120; i++) {
      term.write('x');
      now += 11;
      frame();
      expect(active(term), `frame ${i}: the wrap stays on the newest`).toEqual([newest]);
    }
    expect(all(term) ?? [], 'no frame of the output placed a match').toHaveLength(0);
    settle(search);
    expect(active(term)).toEqual([newest]);
    expect(search.state).toEqual({ index: 1, total: 100, partial: false });
  });

  test('a search that lists nothing reads no active-area count while output arrives every frame', async () => {
    const { term } = await create(Array.from({ length: 20000 }, (_, i) => `line ${i}`).join('\r\n'), 40, 6, 10_000_000);
    const searches = vi.spyOn(VtTerminal.prototype, 'createSearch');
    const search = searchOf(term);
    search.find('absent');
    expect(searches).toHaveBeenCalledOnce();
    let partial = 0;
    for (let i = 0; i < 20; i++) {
      term.write('x');
      now += 11;
      frame();
      if (search.state.partial) partial++;
    }
    expect(partial, 'find waited on the scan for most of the output').toBeGreaterThan(10);
    expect(searches, 'and made no search beside its own').toHaveBeenCalledOnce();
  });

  test("after output, a step waits while the screen page's matches are placed behind the page above", async () => {
    const { term } = await create(paged(1), 200, 5, 10_000_000);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'older');
    expect(active(term)).toEqual([range(236, 0)]);
    const rows = coreRows(term, 'needle', 118);
    expect(rows.slice(0, 116).every(row => row <= 230), 'the core lists the page above first').toBe(true);
    expect(rows.slice(116), 'then the screen page, newest first').toEqual([238, 236]);
    // Placement stops right after the active match's entry, ahead of 234.
    placementStopsAt(118);
    term.write('\x1b[m');
    search.step('needle', 'older');
    for (let i = 0; i < 100 && search.state.partial; i++) {
      expect([236, 234], `frame ${i}: the press waits on its match or lands on its neighbour`).toContain(active(term)?.[0].start.absoluteRow);
      frame();
    }
    expect(active(term)).toEqual([range(234, 0)]);
    expect(search.state).toEqual({ index: 3, total: 120, partial: false });
  });

  test("after output, a step from the last placed active-area entry waits for the next one", async () => {
    const { term } = await create(paged(1), 200, 5, 10_000_000);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'older');
    search.step('needle', 'older');
    expect(active(term)).toEqual([range(234, 0)]);
    const rows = coreRows(term, 'needle', 120);
    expect(rows.slice(116), 'the active-area entries end with the screen page, newest first').toEqual([238, 236, 234, 232]);
    // Placement stops one entry short of the end of the active-area entries.
    placementStopsAt(119);
    term.write('\x1b[m');
    search.step('needle', 'older');
    for (let i = 0; i < 100 && search.state.partial; i++) {
      expect([234, 232], `frame ${i}: the press waits on its match or lands on its neighbour`).toContain(active(term)?.[0].start.absoluteRow);
      frame();
    }
    expect(active(term)).toEqual([range(232, 0)]);
    expect(search.state).toEqual({ index: 4, total: 120, partial: false });
  });

  test('after output that makes the core list a page ahead, a press reads the new active-area count', async () => {
    const { term } = await create(numbered(2000), 40, 6, 10_000_000);
    batchPerFrame();
    const search = searchOf(term);
    search.find('needle');
    frame();
    expect(active(term), 'the core lists its active area in order, so find lands at once').toEqual([range(1999, 0, 1999, 5)]);
    settle(search);
    search.step('needle', 'newer');
    expect(active(term)).toEqual([range(0, 0, 0, 5)]);
    term.write('\r\n' + Array.from({ length: 60 }, (_, i) => `needle ${i} `.padEnd(300, 'x')).join('\r\n'));
    const newest = range(2472, 0, 2472, 5);
    expect(coreFirst(term, 'needle').startRow, 'the core now lists a match above the newest first').toBeLessThan(2472);
    search.step('needle', 'older');
    for (let i = 0; i < 1000 && search.state.partial; i++) {
      if (active(term)) expect(active(term), `frame ${i}: the wrap lands only on the newest`).toEqual([newest]);
      frame();
    }
    expect(active(term)).toEqual([newest]);
    expect(search.state.index).toBe(1);
  });

  test("after output, a window taken while the screen page's matches are placed behind the page above ends at the page above", async () => {
    const { term } = await create(paged(1), 200, 5, 10_000_000);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'older');
    expect(active(term)).toEqual([range(236, 0)]);
    // Placement stops right after the active match's entry, ahead of 234,
    // and the next write takes the window from that list.
    placementStopsAt(118);
    term.write('\x1b[m');
    frame();
    expect(search.state.index, 'placement reached the active match').toBe(2);
    term.write('\x1b[m');
    slowFeed();
    search.step('needle', 'older');
    expect(search.state.index, 'the press returned before placement').toBeNull();
    for (let i = 0; i < 100 && search.state.partial; i++) {
      expect([236, 234], `frame ${i}: the press waits on its match or lands on its neighbour`).toContain(active(term)?.[0].start.absoluteRow);
      frame();
    }
    expect(active(term)).toEqual([range(234, 0)]);
    expect(search.state).toEqual({ index: 3, total: 120, partial: false });
  });

  test('a window taken after a page above longer than one placement batch also ends at that page', async () => {
    const { term } = await create(paged(3), 200, 5, 10_000_000);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    for (let i = 0; i < 5; i++) search.step('needle', 'older');
    expect(active(term)).toEqual([range(236, 0)]);
    const rows = coreRows(term, 'needle', 360);
    expect(rows.slice(0, 348).every(row => row <= 230), 'the core lists the page above first, past one batch').toBe(true);
    expect(rows.slice(348, 354), 'then the screen page, newest first').toEqual([238, 238, 238, 236, 236, 236]);
    placementStopsAt(354);
    term.write('\x1b[m');
    frame();
    expect(search.state.index, 'placement reached the active match').toBe(6);
    term.write('\x1b[m');
    slowFeed();
    search.step('needle', 'older');
    for (let i = 0; i < 100 && search.state.partial; i++) {
      expect([236, 234], `frame ${i}: the press waits on its match or lands on its neighbour`).toContain(active(term)?.[0].start.absoluteRow);
      frame();
    }
    expect(active(term)).toEqual([range(234, 14)]);
    expect(search.state).toEqual({ index: 7, total: 360, partial: false });
  });

  test('a window taken inside the third listed page ends at the middle page, not the first', async () => {
    const { term } = await create(threePaged, 200, 20, 10_000_000);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'older');
    search.step('needle', 'older');
    expect(active(term)).toEqual([range(474, 0)]);
    expect(coreRows(term, 'needle', 230).slice(221), 'the core lists the last page last').toEqual([478, 476, 474, 472, 470, 468, 466, 464, 462]);
    // Placement stops right after the active match's entry, ahead of 472,
    // and the next write takes the window from that list.
    placementStopsAt(224);
    term.write('\x1b[m');
    frame();
    expect(search.state.index, 'placement reached the active match').toBe(3);
    term.write('\x1b[m');
    slowFeed();
    search.step('needle', 'older');
    for (let i = 0; i < 100 && search.state.partial; i++) {
      expect([474, 472], `frame ${i}: the press waits on its match or lands on its neighbour`).toContain(active(term)?.[0].start.absoluteRow);
      frame();
    }
    expect(active(term)).toEqual([range(472, 0)]);
    expect(search.state).toEqual({ index: 4, total: 230, partial: false });
  });

  test('a window taken inside the third listed page also ends above the match wrapped across the first page boundary', async () => {
    const { term } = await create(threeStraddled, 200, 20, 10_000_000);
    const wrapped = range(230, 197, 231, 2);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    for (let i = 0; i < 123; i++) search.step('needle', 'older');
    expect(active(term)).toEqual([range(232, 0)]);
    expect(search.state).toEqual({ index: 124, total: 241, partial: false });
    const rows = coreRows(term, 'needle', 241);
    expect(rows.slice(0, 116).every(row => row <= 230), 'the core lists the first page first').toBe(true);
    expect(rows.slice(116, 231).every(row => row >= 232 && row <= 460), 'then the middle page').toBe(true);
    expect(rows.slice(231), 'then the last page, newest first, then the wrapped match').toEqual([478, 476, 474, 472, 470, 468, 466, 464, 462, 230]);
    // Placement stops inside the last page's entries, and the next write
    // takes the window from that list.
    placementStopsAt(236);
    term.write('\x1b[m');
    frame();
    expect(search.state.index, 'placement reached the active match').not.toBeNull();
    term.write('\x1b[m');
    slowFeed();
    search.step('needle', 'older');
    for (let i = 0; i < 100 && search.state.partial; i++) {
      expect([range(232, 0), wrapped], `frame ${i}: the press waits on its match or lands on its neighbour`).toContainEqual(active(term)?.[0]);
      frame();
    }
    expect(active(term)).toEqual([wrapped]);
    expect(search.state).toEqual({ index: 125, total: 241, partial: false });
  });

  test.each([
    { name: 'two', input: () => paged(1), rows: 5, steps: 1, from: 236, cut: 118, want: 234, index: 3, total: 120 },
    { name: 'three', input: () => threePaged, rows: 20, steps: 2, from: 474, cut: 224, want: 472, index: 4, total: 230 },
  ])('a write after a press that read the active-area count takes a window ended at the page above, $name listed pages', async ({ input, rows, steps, from, cut, want, index, total }) => {
    const { term } = await create(input(), 200, rows, 10_000_000);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    for (let i = 0; i < steps; i++) search.step('needle', 'older');
    expect(active(term)).toEqual([range(from, 0)]);
    // Placement stops right after the active match's entry. A press then
    // places nothing more, reads the count of the active-area entries and
    // waits; the next write takes the window from that list, and the frame
    // after it places nothing.
    placementStopsAt(cut, cut, 0);
    term.write('\x1b[m');
    frame();
    expect(search.state.index, 'placement reached the active match').toBe(index - 1);
    search.step('needle', 'older');
    expect(active(term), 'the press waits').toEqual([range(from, 0)]);
    term.write('\x1b[m');
    for (let i = 0; i < 100 && search.state.partial; i++) {
      expect([from, want], `frame ${i}: the press waits on its match or lands on its neighbour`).toContain(active(term)?.[0].start.absoluteRow);
      frame();
    }
    expect(active(term)).toEqual([range(want, 0)]);
    expect(search.state).toEqual({ index, total, partial: false });
  });

  // Line 115 wraps a needle across the boundary between the page above
  // (rows up to 230) and the screen page (from row 231); the core lists
  // that match first in its history, right after its active-area entries.
  const straddled = Array.from({ length: 120 }, (_, i) => i === 115
    ? 'needle '.padEnd(197, 'y') + 'needle' + 'z'.repeat(97) : 'needle '.padEnd(300, 'x')).join('\r\n');
  test.each([
    { name: 'older from row 232', from: range(232, 0), direction: 'older' as const, steps: 3, index: 5 },
    { name: 'newer from row 230', from: range(230, 0), direction: 'newer' as const, steps: 5, index: 5 },
  ])('after output, $name waits for the match wrapped across the page boundary', async ({ from, direction, steps, index }) => {
    const { term } = await create(straddled, 200, 5, 10_000_000);
    const wrapped = range(230, 197, 231, 2);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    for (let i = 0; i < steps; i++) search.step('needle', 'older');
    expect(active(term)).toEqual([from]);
    const raw = term.core!.createSearch();
    raw.setNeedle('needle');
    raw.feed();
    const head = raw.state().total;
    raw.free();
    expect(coreRows(term, 'needle', head + 1).slice(head - 4), 'the screen page ends the active-area entries, then the wrapped match').toEqual([238, 236, 234, 232, 230]);
    // Placement stops right after the active-area entries.
    placementStopsAt(head);
    term.write('\x1b[m');
    search.step('needle', direction);
    for (let i = 0; i < 100 && search.state.partial; i++) {
      const at = active(term)?.[0];
      expect([from, wrapped], `frame ${i}: the press waits on its match or lands on its neighbour`).toContainEqual(at);
      frame();
    }
    expect(active(term)).toEqual([wrapped]);
    expect(search.state).toEqual({ index, total: 121, partial: false });
  });

  test.each([117, 118, 119])("after output, newer from the page above's newest waits for the screen page's oldest, placement stopped at entry %i", async cut => {
    const { term } = await create(paged(1), 200, 5, 10_000_000);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    for (let i = 0; i < 4; i++) search.step('needle', 'older');
    expect(active(term)).toEqual([range(230, 0)]);
    expect(coreRows(term, 'needle', 120).slice(115), 'the page above ends at 0 and the screen page follows').toEqual([0, 238, 236, 234, 232]);
    // Placement stops inside the screen page's entries, so the placed list
    // holds the page above's newest with an index but not 232 below it.
    placementStopsAt(cut);
    term.write('\x1b[m');
    search.step('needle', 'newer');
    for (let i = 0; i < 100 && search.state.partial; i++) {
      expect([230, 232], `frame ${i}: the press waits on its match or lands on its neighbour`).toContain(active(term)?.[0].start.absoluteRow);
      frame();
    }
    expect(active(term)).toEqual([range(232, 0)]);
    expect(search.state).toEqual({ index: 4, total: 120, partial: false });
  });

  test("a window whose active match is the page above's newest serves no newer step across the unplaced screen page", async () => {
    const { term } = await create(paged(1), 200, 5, 10_000_000);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    for (let i = 0; i < 4; i++) search.step('needle', 'older');
    expect(active(term)).toEqual([range(230, 0)]);
    // Placement stops one entry short of the screen page's last, 232, and
    // the next write takes the window from that list.
    placementStopsAt(119);
    term.write('\x1b[m');
    frame();
    expect(search.state.index, 'the write finds the index placed and takes a window').not.toBeNull();
    term.write('\x1b[m');
    slowFeed();
    search.step('needle', 'newer');
    expect(search.state.index, 'the press returned before placement').toBeNull();
    for (let i = 0; i < 100 && search.state.partial; i++) {
      expect([230, 232], `frame ${i}: the press waits on its match or lands on its neighbour`).toContain(active(term)?.[0].start.absoluteRow);
      frame();
    }
    expect(active(term)).toEqual([range(232, 0)]);
    expect(search.state).toEqual({ index: 4, total: 120, partial: false });
  });

  test('a window ended at the page above still serves a step on the side of the active match', async () => {
    const { term } = await create(paged(1), 200, 5, 10_000_000);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    for (let i = 0; i < 3; i++) search.step('needle', 'older');
    expect(active(term)).toEqual([range(232, 0)]);
    expect(coreRows(term, 'needle', 121), 'the core lists the page above again after the active-area entries').toHaveLength(121);
    // Placement stops right after the active-area entries; with their count
    // unknown the next write's window still ends at the page above.
    placementStopsAt(120);
    term.write('\x1b[m');
    frame();
    expect(search.state.index, 'placement reached the active match').toBe(4);
    term.write('\x1b[m');
    slowFeed();
    search.step('needle', 'newer');
    expect(active(term), 'newer lands at once on its history neighbour in the window').toEqual([range(234, 0)]);
    expect(search.state.index, 'before placement').toBeNull();
    settle(search);
    expect(search.state).toEqual({ index: 3, total: 120, partial: false });
  });

  test("a resize leaves the active match's index unknown while the screen page's matches are placed behind the page above", async () => {
    const { term } = await create(paged(1), 200, 5, 10_000_000);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    for (let i = 0; i < 6; i++) search.step('needle', 'older');
    expect(active(term)).toEqual([range(226, 0)]);
    expect(search.state).toEqual({ index: 7, total: 120, partial: false });
    term.resize(200, 6);
    const rows = coreRows(term, 'needle', 120);
    const screenPage = rows.findIndex((row, i) => i > 0 && row > rows[i - 1]);
    expect(screenPage, 'the resized core still lists the page above first').toBeGreaterThan(3);
    placementStopsAt(screenPage);
    frame();
    expect(active(term), 'the match is kept').toEqual([range(226, 0)]);
    expect(search.state.index, 'its index waits for the matches below it').toBeNull();
    settle(search);
    expect(active(term)).toEqual([range(226, 0)]);
    expect(search.state).toEqual({ index: 7, total: 120, partial: false });
  });

  test('steps in position order across chunks after the screen page is inserted ahead of the page above', async () => {
    const { term } = await create(paged(28, 127), 200, 5, 10_000_000);
    expect(coreFirst(term, 'needle').startRow, 'unchanged core lists a match above the newest first').toBeLessThan(252);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    expect(search.state).toEqual({ index: 1, total: 3556, partial: false });
    // Entry i is needle 27 - i % 28 of line 126 - i / 28: the screen page's
    // 308 matches inserted ahead of the 3,248 of the page above, more than
    // a chunk holds.
    const expected = (i: number) => range(2 * (126 - Math.floor(i / 28)), 7 * (27 - i % 28));
    expect(active(term)).toEqual([expected(0)]);
    for (let i = 1; i < 1200; i++) {
      search.step('needle', 'older');
      expect(active(term), `entry ${i}`).toEqual([expected(i)]);
      expect(search.state.index).toBe(i + 1);
    }
    search.step('needle', 'newer');
    expect(active(term)).toEqual([expected(1198)]);
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

  test('a step from the middle of a large list after a write steps from the kept match before its index is placed', async () => {
    const { term } = await create('needle\r\n'.repeat(2000));
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'newer');
    for (let i = 0; i < 499; i++) search.step('needle', 'newer');
    expect(search.state).toEqual({ index: 1501, total: 2000, partial: false });
    expect(active(term)).toEqual([range(499, 0)]);
    slowPlacement();
    term.write('more');
    frame();
    search.step('needle', 'older');
    expect(search.state.index, 'the index waits for placement').toBeNull();
    expect(active(term), 'the press lands from the kept match, not from the newest').toEqual([range(498, 0)]);
    now += 1000;
    frame();
    expect(search.state.partial).toBe(true);
    expect(active(term)).toEqual([range(498, 0)]);
    settle(search);
    expect(search.state).toEqual({ index: 1502, total: 2000, partial: false });
    expect(active(term)).toEqual([range(498, 0)]);
  });

  test('a step at the oldest match after a write wraps to the newest at once when the list was complete', async () => {
    const { term } = await create('needle\r\n'.repeat(2000));
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'newer');
    expect(active(term)).toEqual([range(0, 0)]);
    slowPlacement();
    term.write('more');
    frame();
    search.step('needle', 'older');
    expect(search.state).toEqual({ index: 1, total: 2000, partial: true });
    expect(active(term)).toEqual([range(1999, 0)]);
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

  test('a step from a match that scrolled under a fixed top row lands on its history neighbour', async () => {
    const lines = Array.from({ length: 94 }, (_, i) => `needle ${i}`).concat(['HEADER', 'aaa', 'bbb', 'needle X', 'ccc', 'ddd']);
    const { term } = await create(lines.join('\r\n'));
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    expect(activeLine(term)).toBe('needle X');
    slowFeed();
    const history = term.getScrollbackLength();
    // Two lines scroll the region below the first screen row: the active
    // match moves up two rows and nothing enters or leaves the history.
    term.write('\x1b[2;6r\x1b[6;1H\n\n');
    expect(term.getScrollbackLength(), 'nothing was pruned or added').toBe(history);
    expect(activeLine(term)).toBe('needle X');
    search.step('needle', 'older');
    expect(search.state.index, 'the press returned before placement').toBeNull();
    expect(activeLine(term), 'the press lands on the real neighbour').toBe('needle 93');
    settle(search);
    expect(activeLine(term)).toBe('needle 93');
    expect(search.state).toEqual({ index: 2, total: 95, partial: false });
  });

  test('window steps follow irregular matches, and a write after placed steps takes a new window', async () => {
    const { term } = await create(irregular(6000), 40, 6, 9000);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    for (let i = 0; i < 700; i++) search.step('needle', 'older');
    const first = olderRanges(term, search, 3);
    const start = active(term);
    slowPlacement();
    const stream = () => { term.write('tick\r\n'); frame(); };
    for (const expected of first) {
      stream();
      search.step('needle', 'older');
      expect(search.state.index, 'the index is unplaced').toBeNull();
      expect(active(term)).toEqual(expected);
    }
    expect(active(term)).not.toEqual(start);
    // Placement catches up, placed steps move on, and the next write takes
    // a new window around the match they reached.
    vi.mocked(VtSearch.prototype.readMatches).mockRestore();
    settle(search);
    for (let i = 0; i < 5; i++) search.step('needle', 'older');
    const second = olderRanges(term, search, 2);
    slowPlacement();
    stream();
    search.step('needle', 'older');
    expect(search.state.index, 'the index is unplaced again').toBeNull();
    expect(active(term)).toEqual(second[0]);
    search.step('needle', 'older');
    expect(active(term)).toEqual(second[1]);
  });

  test('a window step counts only the history pruned since its list was placed', async () => {
    const { term } = await create(numbered(2900), 80, 5, 3000);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    for (let i = 0; i < 1899; i++) search.step('needle', 'older');
    expect(activeLine(term)).toBe('needle 1000');
    const placedAt = active(term)![0].start.absoluteRow;
    // Output prunes the history, and the list is placed again after it.
    for (let i = 0; i < 40 && active(term)![0].start.absoluteRow === placedAt; i++) term.write('filler\r\n'.repeat(40));
    expect(active(term)![0].start.absoluteRow, 'output pruned history above the kept match').toBeLessThan(placedAt);
    settle(search);
    expect(search.state.index).toBe(1900);
    slowPlacement();
    term.write('tick\r\n');
    frame();
    search.step('needle', 'older');
    expect(search.state.index, 'the index is unplaced').toBeNull();
    expect(activeLine(term)).toBe('needle 999');
  });

  test('a window step onto the oldest history row lands at once', async () => {
    const { term } = await create(numbered(2000));
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'newer');
    search.step('needle', 'newer');
    expect(activeLine(term)).toBe('needle 1');
    slowPlacement();
    term.write('tick\r\n');
    frame();
    search.step('needle', 'older');
    expect(search.state.index, 'the index is unplaced').toBeNull();
    expect(active(term), 'the press lands on row 0').toEqual([range(0, 0, 0, 5)]);
  });

  test('a newer neighbour on the first screen row of its list waits', async () => {
    const { term } = await create(numbered(2000));
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    for (let i = 0; i < 6; i++) search.step('needle', 'older');
    // The last history row; its newer neighbour is the first screen row.
    expect(activeLine(term)).toBe('needle 1993');
    expect(active(term)![0].start.absoluteRow).toBe(term.getScrollbackLength() - 1);
    slowFeed();
    term.write('\x1b[1;1H\x1b[2K');
    search.step('needle', 'newer');
    expect(search.state.index).toBeNull();
    expect(activeLine(term), 'the press waits: the screen row was rewritten').toBe('needle 1993');
  });

  test('a window step lands on a neighbour placement has reached with its index', async () => {
    const { term } = await create(numbered(2000));
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    for (let i = 0; i < 512; i++) search.step('needle', 'older');
    expect(activeLine(term)).toBe('needle 1487');
    slowPlacement();
    term.write('tick\r\n');
    frame();
    // The press places the second batch, which ends at the newer neighbour.
    search.step('needle', 'newer');
    expect(activeLine(term)).toBe('needle 1488');
    expect(search.state.index, 'the landed neighbour is placed').toBe(512);
  });

  test('a press after a write and a resize waits for the reflowed list', async () => {
    const { term } = await create(Array.from({ length: 2000 }, (_, i) => `needle ${i} `.padEnd(36, 'x')).join('\r\n'));
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    for (let i = 0; i < 999; i++) search.step('needle', 'older');
    expect(activeLine(term)).toMatch(/^needle 1000 x+$/);
    slowPlacement();
    term.write('tick\r\n');
    frame();
    term.resize(30, 6);
    search.step('needle', 'older');
    expect(search.state.index).toBeNull();
    expect(activeLine(term), 'the press waits for placement').toMatch(/^needle 1000 x+$/);
  });

  test('older onto a neighbour pruned since the list was placed waits, then wraps', async () => {
    const lines = Array.from({ length: 2900 }, (_, i) => i === 5 ? 'needle A' : i === 1500 ? 'needle B' : i === 2890 ? 'needle C' : `line ${i}`);
    const { term } = await create(lines.join('\r\n'), 80, 5, 3000);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'older');
    expect(activeLine(term)).toBe('needle B');
    const placedAt = active(term)![0].start.absoluteRow;
    slowFeed();
    for (let i = 0; i < 40 && active(term)![0].start.absoluteRow === placedAt; i++) term.write('filler\r\n'.repeat(40));
    expect(active(term)![0].start.absoluteRow).toBeLessThan(placedAt);
    expect(term.getScrollbackText().includes('needle A'), 'the older neighbour was pruned').toBe(false);
    search.step('needle', 'older');
    expect(activeLine(term), 'the press waits').toBe('needle B');
    now += 1000;
    frame();
    settle(search);
    expect(activeLine(term)).toBe('needle C');
  });

  test('older from the last placed entry of a partial list waits', async () => {
    const { term } = await create(numbered(2000));
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    for (let i = 0; i < 255; i++) search.step('needle', 'older');
    expect(activeLine(term)).toBe('needle 1744');
    slowPlacement();
    slowFeed();
    term.write('tick\r\n');
    frame();
    expect(search.state).toEqual({ index: 256, total: 2000, partial: true });
    term.write('tick\r\n');
    search.step('needle', 'older');
    expect(activeLine(term), 'the press waits for the unplaced neighbour').toBe('needle 1744');
  });

  test('presses step from one window up to 1,024 matches away, and the next waits its second', async () => {
    const { term } = await create(numbered(4000), 40, 6, 9000);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    for (let i = 0; i < 1500; i++) search.step('needle', 'older');
    expect(activeLine(term)).toBe('needle 2499');
    slowPlacement();
    for (let i = 1; i <= 1024; i++) {
      term.write('tick\r\n');
      frame();
      search.step('needle', 'older');
      if (activeLine(term) !== `needle ${2499 - i}`) throw new Error(`press ${i} read ${activeLine(term)}`);
    }
    term.write('tick\r\n');
    frame();
    const pressed = now;
    search.step('needle', 'older');
    expect(activeLine(term), 'press 1,025 waits').toBe('needle 1475');
    expect(now - pressed).toBeLessThan(1000);
    while (now - pressed < 1000) {
      term.write('tick\r\n');
      frame();
    }
    term.write('tick\r\n');
    frame();
    expect(activeLine(term), 'then it applies from no active match').toMatch(/^needle 399\d/);
  });

  test('a neighbour rewritten on the screen and then scrolled into history waits', async () => {
    const { term } = await create('needle\r\n'.repeat(2000));
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'older');
    search.step('needle', 'older');
    expect(active(term)).toEqual([range(1997, 0)]);
    slowFeed();
    // Erase the newer neighbour on the screen, then scroll the screen away.
    term.write('\x1b[4;1H\x1b[2K\x1b[6;1H' + 'x\r\n'.repeat(8));
    expect(term.getScrollbackLength()).toBeGreaterThan(1998);
    expect(active(term)).toEqual([range(1997, 0)]);
    search.step('needle', 'newer');
    expect(active(term), 'the press waits: the neighbour was on the screen when its list was read').toEqual([range(1997, 0)]);
    settle(search);
    expect(activeText(term)).toBe('needle');
  });

  test('after the scrollback is erased, a screen neighbour is not taken for history', async () => {
    const { term } = await create('needle\r\n'.repeat(2000));
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    term.write('\x1b[3J');
    settle(search);
    expect(term.getScrollbackLength()).toBe(0);
    search.step('needle', 'older');
    search.step('needle', 'older');
    const kept = active(term);
    expect(kept).toEqual([range(2, 0)]);
    slowFeed();
    term.write('\x1b[2;1H\x1b[2K');
    search.step('needle', 'older');
    expect(active(term), 'the press waits: its neighbour is on the screen').toEqual(kept);
  });

  test('a history neighbour erased with the scrollback waits for placement', async () => {
    const { term } = await create(numbered(2000));
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    for (let i = 0; i < 5; i++) search.step('needle', 'older');
    // The oldest match on the screen, whose older neighbour is in history.
    expect(activeLine(term)).toBe('needle 1994');
    expect(active(term)![0].start.absoluteRow).toBe(term.getScrollbackLength());
    slowFeed();
    term.write('\x1b[3J');
    expect(term.getScrollbackLength()).toBe(0);
    expect(activeLine(term), 'the active match stays on the screen').toBe('needle 1994');
    search.step('needle', 'older');
    expect(search.state.index).toBeNull();
    expect(activeLine(term), 'the press waits: its neighbour went with the history').toBe('needle 1994');
    settle(search);
    expect(activeLine(term), 'placed, the press wraps from the oldest match left').toBe('needle 1999');
    expect(search.state).toEqual({ index: 1, total: 6, partial: false });
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

  test('a resize keeps a deep active match highlighted until the rescan places it, past one second', async () => {
    const { term } = await create('needle\r\n'.repeat(2000));
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'newer');
    expect(active(term)).toEqual([range(0, 0)]);
    slowPlacement();
    term.resize(41, 6);
    frame();
    frame();
    expect(now, 'placement has run past one second').toBeGreaterThan(1000);
    expect(search.state).toEqual({ index: null, total: 2000, partial: true });
    expect(active(term), 'the tracked match stays highlighted').toEqual([range(0, 0)]);
    settle(search);
    expect(search.state).toEqual({ index: 2000, total: 2000, partial: false });
    expect(active(term)).toEqual([range(0, 0)]);
    search.step('needle', 'newer');
    expect(active(term), 'a step goes on from the kept match').toEqual([range(1, 0)]);
  });

  test('a resize result first rediscovered after one second restores the active match', async () => {
    const { term } = await create('needle');
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    term.resize(41, 6);
    now = 1000;
    settle(search);
    expect(search.state).toEqual({ index: 1, total: 1, partial: false });
    expect(active(term)).toEqual([range(0, 0)]);
  });

  test('a press after a resize waits for the deep active match no longer than its own second', async () => {
    const { term } = await create('needle\r\n'.repeat(2000));
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'newer');
    slowPlacement();
    term.resize(41, 6);
    frame();
    search.step('needle', 'newer');
    const pressed = now;
    expect(search.state.index, 'the index waits for placement').toBeNull();
    expect(active(term), 'the press waits on the kept match').toEqual([range(0, 0)]);
    while (now - pressed < 1000) {
      expect(active(term)).toEqual([range(0, 0)]);
      frame();
    }
    // At its cap the press applies from no active match: newer lands on
    // the oldest match placed by then.
    const placed = all(term)!.length;
    expect(placed).toBeLessThan(2000);
    expect(active(term)).toEqual([range(2000 - placed, 0)]);
  });

  test('a press during a restarted scan steps from the list placed before the output', async () => {
    const { term } = await create('needle\r\n'.repeat(300) + 'filler\r\n'.repeat(20_000), 200, 5, 60_000);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    for (let i = 0; i < 10; i++) search.step('needle', 'older');
    expect(active(term)).toEqual([range(289, 0)]);
    const restart = vi.spyOn(VtSearch.prototype, 'restart');
    term.write('filler\r\n'.repeat(16_000));
    frame();
    expect(restart).toHaveBeenCalledOnce();
    expect(search.state.index, 'the rescan has not placed the kept match').toBeNull();
    search.step('needle', 'older');
    expect(active(term), 'the press lands on the neighbour at once').toEqual([range(288, 0)]);
    settle(search);
    expect(search.state).toEqual({ index: 12, total: 300, partial: false });
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

  test('a screen switch removes stale results synchronously and the switch back keeps only the primary match', async () => {
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
    expect(search.state).toEqual({ index: 1, total: 1, partial: false });
    expect(active(term)).toEqual([range(0, 0)]);
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

  test('the count reads an unknown index, not zero, while a returned match waits for its rescan', async () => {
    const { term } = await create('x needle\r\nyy needle');
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'older');
    const counts: Count[] = [];
    search.onChange(count => counts.push(count));
    term.write('\x1b[?1049h');
    term.write('\x1b[?1049l');
    expect(active(term)).toEqual([range(0, 2)]);
    expect(search.state, 'a match is highlighted, at an unknown index').toEqual({ index: null, total: 0, partial: true });
    settle(search);
    expect(search.state).toEqual({ index: 2, total: 2, partial: false });
    expect(counts.slice(0, 2), 'the alternate screen has no match; the return has one').toEqual([
      { index: 0, total: 0, partial: true }, { index: null, total: 0, partial: true },
    ]);
  });

  test('a step after an alternate screen excursion steps from the list placed before it', async () => {
    const { term } = await create(Array.from({ length: 2000 }, (_, i) => `needle ${i}`).join('\r\n'));
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    for (let i = 0; i < 999; i++) search.step('needle', 'older');
    expect(activeLine(term)).toBe('needle 1000');
    slowPlacement();
    term.write('\x1b[?1049h');
    term.write('alt text');
    frame();
    term.write('\x1b[?1049l');
    expect(activeLine(term), 'the primary match returns with its screen').toBe('needle 1000');
    search.step('needle', 'older');
    expect(search.state.index, 'the rescan has not placed the returned match').toBeNull();
    expect(activeLine(term), 'the press lands on the neighbour at once').toBe('needle 999');
    search.step('needle', 'newer');
    search.step('needle', 'newer');
    expect(activeLine(term)).toBe('needle 1001');
    settle(search);
    expect(search.state).toEqual({ index: 999, total: 2000, partial: false });
  });

  test('a step after a resize on the alternate screen waits for the reflowed list', async () => {
    // Lines that rewrap when narrowed, so the rows before the resize are wrong after it.
    const { term } = await create(Array.from({ length: 2000 }, (_, i) => `needle ${i} `.padEnd(36, 'x')).join('\r\n'));
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    for (let i = 0; i < 999; i++) search.step('needle', 'older');
    expect(activeLine(term)).toMatch(/^needle 1000 x+$/);
    slowPlacement();
    term.write('\x1b[?1049h');
    term.resize(30, 6);
    term.write('\x1b[?1049l');
    expect(activeLine(term), 'the primary match returns reflowed').toMatch(/^needle 1000 x+$/);
    search.step('needle', 'older');
    expect(search.state.index).toBeNull();
    expect(activeLine(term), 'the press waits for placement').toMatch(/^needle 1000 x+$/);
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

  test('a press that reads the count of the active-area entries frees the search it reads it from', async () => {
    const searches = vi.spyOn(VtTerminal.prototype, 'createSearch');
    const frees = vi.spyOn(VtSearch.prototype, 'free');
    const { term } = await create(paged(1), 200, 5, 10_000_000);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'newer');
    placementStopsAt(100);
    term.write('x');
    // From the oldest, older applies from no active match and reads the
    // count the write made unknown.
    search.step('needle', 'older');
    expect(searches, 'the press made a second search').toHaveBeenCalledTimes(2);
    expect(frees.mock.contexts, 'and freed it before returning').toContain(searches.mock.results[1].value);
    expect(frees.mock.contexts).not.toContain(searches.mock.results[0].value);
    search.close();
    expect(frees.mock.contexts, 'the close frees the find search').toContain(searches.mock.results[0].value);
  });

  test('find frees the history cells of its windows when it replaces them and when it closes', async () => {
    const tracked = vi.spyOn(VtTerminal.prototype, 'trackCell');
    const { term } = await create(numbered(100));
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'older');
    for (let i = 0; i < 3; i++) {
      term.write('\r\ntick');
      settle(search);
    }
    const cells = tracked.mock.results.filter(r => r.value).map(r => r.value as VtTrackedCell);
    expect(cells.filter(c => c.point() !== null), 'the active pair, the backlog cell, the list cell and one window cell').toHaveLength(5);
    search.close();
    for (const cell of cells) expect(cell.point()).toBeNull();
  });

  test.each(['query', 'close', 'dispose'] as const)('a %s frees the set-aside primary cells and window', async how => {
    const tracked = vi.spyOn(VtTerminal.prototype, 'trackCell');
    const { term } = await create('x needle\r\n' + 'filler\r\n'.repeat(8) + 'yy needle other');
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'older');
    expect(active(term)![0].start.absoluteRow, 'the active match is in the history').toBeLessThan(term.getScrollbackLength());
    term.write('\x1b[?1049h');
    term.write('alt text');
    settle(search);
    const cells = tracked.mock.results.filter(r => r.value).map(r => r.value as VtTrackedCell);
    expect(cells.filter(c => c.point() !== null), 'the set-aside pair, its window cell and the backlog cell').toHaveLength(4);
    if (how === 'query') search.find('other');
    else if (how === 'close') search.close();
    else term.dispose();
    for (const cell of cells) expect(cell.point()).toBeNull();
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
