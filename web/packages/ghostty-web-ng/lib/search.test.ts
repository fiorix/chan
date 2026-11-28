import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { GhosttyVt, type MatchRange, VtSearch, VtTerminal, VtTrackedCell } from '../vt/ghosttyVt';
import { Terminal } from './terminal';

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
// Placement held at list entry `at`, its slice spent at each read that
// reaches it, as feeds that spend every frame's slice hold it, until
// `release`; `move` holds it at another entry from then on.
function placementHold(at: number) {
  let held: number | null = at;
  const read = VtSearch.prototype.readMatches;
  vi.spyOn(VtSearch.prototype, 'readMatches').mockImplementation(function (this: VtSearch, start: number, budget: number) {
    const batch = read.call(this, start, budget);
    if (held === null || start > held || batch.next <= held) return batch;
    now += 5;
    return { ranges: batch.ranges.slice(0, held - start), next: held, total: batch.total };
  });
  return {
    move: (to: number) => { held = to; },
    release: () => { held = null; },
  };
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
// with matches on the last 286 only, less `quiet` lines at the end of the
// page above the last: the screen, the last 24 rows, spans the boundary
// between the last two pages, both hold matches on it, and the `pages`
// pages above them hold none.
const screenPaged = (pages: number, quiet = 0) => Array.from({ length: 573 * (pages + 1) + 13 }, (_, i) =>
  (i >= 573 * pages + 300 && (i < 573 * (pages + 1) - quiet || i >= 573 * (pages + 1)) ? 'needle ' : 'plain ') + i).join('\r\n');
// The same rows with the page above the last ending in a match wrapped
// across the screen's first row, from 77 columns into the row above it.
const screenTopWrapped = (pages: number) => {
  const wrapped = 573 * (pages + 1) - 12;
  return Array.from({ length: 573 * (pages + 1) + 12 }, (_, i) => i === wrapped ? `${'x'.repeat(77)}needle ${i}`
    : (i >= 573 * pages + 300 && (i < wrapped || i >= 573 * (pages + 1) - 1) ? 'needle ' : 'plain ') + i).join('\r\n');
};
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

  test.each([
    { name: 'inside the screen', input: () => screenPaged(8), total: 286, start: 10, end: 10 },
    { name: "on the screen's first row", input: () => screenPaged(8, 10), total: 276, start: 0, end: 0 },
    { name: "across the screen's first row", input: () => screenTopWrapped(8), total: 275, start: -1, end: 0 },
  ])('where the screen spans two pages and nothing above them matches, find knows the index and a step lands at once, the first page ending $name', async ({ input, total, start, end }) => {
    const { term } = await create(input(), 80, 24, 10_000_000);
    const last = 573 * 9 + 12;
    const rows = coreRows(term, 'needle', total);
    expect(rows.slice(total - 13), 'the core lists the last page last, newest first').toEqual(Array.from({ length: 13 }, (_, i) => last - i));
    expect(rows.slice(0, total - 13).every((row, i) => row < last - 12 && (i === 0 || row < rows[i - 1])), 'after the page the screen starts in').toBe(true);
    const first = coreFirst(term, 'needle');
    const history = term.getScrollbackLength();
    expect({ start: first.startRow - history, end: first.endRow - history }, "that page's newest against the screen's first row").toEqual({ start, end });
    const search = searchOf(term);
    search.find('needle');
    frame();
    expect(search.state, 'the first frame places the matches and knows the index while the scan goes on').toEqual({ index: 1, total, partial: true });
    expect(active(term)).toEqual([range(last, 0)]);
    search.step('needle', 'older');
    expect(active(term), 'older lands in the call').toEqual([range(last - 1, 0)]);
    expect(search.state.index).toBe(2);
    settle(search);
    expect(active(term)).toEqual([range(last - 1, 0)]);
    expect(search.state).toEqual({ index: 2, total, partial: false });
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

  test('a first newer step with a new query waits for the oldest where the core lists a page ahead', async () => {
    const { term } = await create(paged(20), 200, 5, 10_000_000);
    batchPerFrame();
    const search = searchOf(term);
    search.step('needle', 'newer');
    expect(active(term), 'the listed newest is not for newer').toBeUndefined();
    for (let i = 0; i < 1000 && search.state.partial; i++) {
      frame();
      if (active(term)) expect(active(term), `frame ${i} activates only the oldest match`).toEqual([range(0, 0)]);
    }
    expect(active(term)).toEqual([range(0, 0)]);
    expect(search.state).toEqual({ index: 2400, total: 2400, partial: false });
  });

  test('where the core cannot place an entry the listing is read from, find follows the ordering rule', async () => {
    const { term } = await create(paged(20), 200, 5, 10_000_000);
    const newest = range(238, 133);
    batchPerFrame();
    vi.spyOn(VtSearch.prototype, 'matchAt').mockReturnValue(null);
    const search = searchOf(term);
    search.find('needle');
    frame();
    expect(all(term)?.length, "the first frame places a batch of the page above's matches").toBe(256);
    expect(active(term), 'and lands on none of them').toBeUndefined();
    for (let i = 0; i < 1000 && search.state.partial; i++) {
      frame();
      if (active(term)) expect(active(term), `frame ${i} activates only the newest match`).toEqual([newest]);
    }
    expect(active(term)).toEqual([newest]);
    expect(search.state).toEqual({ index: 1, total: 2400, partial: false });
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

  test('a window ends at the first page of the list being placed, not of a list placed before the output', async () => {
    const lines = threeStraddled.split('\r\n');
    const { term } = await create(lines.slice(0, 100).join('\r\n'), 200, 20, 10_000_000);
    const wrapped = range(230, 197, 231, 2);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    expect(active(term), "the first list's first entry, in what becomes the first listed page").toEqual([range(198, 0)]);
    term.write('\r\n' + lines.slice(100).join('\r\n'));
    settle(search);
    for (let i = 0; i < 18; i++) search.step('needle', 'newer');
    expect(active(term)).toEqual([range(232, 0)]);
    expect(search.state).toEqual({ index: 124, total: 241, partial: false });
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

  // The middle page's oldest match, 232:0, with placement held after the
  // active-area entries of three listed pages, so the placed list lacks
  // only the match wrapped across the first page boundary. The first listed
  // page is the page above: its newest entry, 230:0, ends above the screen,
  // so the rule waits for the entry after them. Reached either way, the
  // count it reads at the press is this listing's, not one read before the
  // output.
  test.each([
    { name: 'three listed pages throughout', before: 240, newer: 0, older: 123 },
    { name: 'one page listed in order before the output', before: 100, newer: 18, older: 0 },
  ])('after output, older from the middle page waits for the match wrapped across the first page boundary, $name', async ({ before, newer, older }) => {
    const lines = threeStraddled.split('\r\n');
    const { term } = await create(lines.slice(0, before).join('\r\n'), 200, 20, 10_000_000);
    const wrapped = range(230, 197, 231, 2);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    if (before < lines.length) {
      term.write('\r\n' + lines.slice(before).join('\r\n'));
      settle(search);
    }
    for (let i = 0; i < newer; i++) search.step('needle', 'newer');
    for (let i = 0; i < older; i++) search.step('needle', 'older');
    expect(active(term)).toEqual([range(232, 0)]);
    expect(search.state).toEqual({ index: 124, total: 241, partial: false });
    const raw = term.core!.createSearch();
    raw.setNeedle('needle');
    raw.feed();
    const head = raw.state().total;
    raw.free();
    expect(head, 'the active-area entries of the three listed pages').toBe(240);
    const { release } = placementHold(head);
    term.write('\x1b[m');
    frame();
    frame();
    expect(all(term), 'placement holds after the active-area entries').toHaveLength(head);
    expect(search.state, 'placement reached the active match').toEqual({ index: 124, total: 241, partial: true });
    search.step('needle', 'older');
    expect(active(term), 'the press waits for the wrapped match').toEqual([range(232, 0)]);
    for (let i = 0; i < 5; i++) {
      frame();
      expect([range(232, 0), wrapped], `frame ${i}: the press waits on its match or lands on its neighbour`).toContainEqual(active(term)?.[0]);
    }
    release();
    settle(search);
    expect(active(term)).toEqual([wrapped]);
    expect(search.state).toEqual({ index: 125, total: 241, partial: false });
  });

  // A newer press from no active match lands at its one-second cap on the
  // oldest match, with placement held at the three listed pages'
  // active-area entries. The press reads no ordering rule; where find ran
  // first, the rule was read and the list found not yet in position order.
  // Either way the next write takes a window the rule has not passed, and
  // placement places nothing after it, so newer presses walk the first
  // listed page, the page above, up to its newest entry, 230:0. That one's
  // neighbour is the match wrapped across the first page boundary, not yet
  // placed: the press waits for it rather than land on the middle page's
  // oldest, 232:0.
  test.each(['unread', 'read'])('a window taken after a press landed at its cap ends at the first listed page, the ordering rule %s', async (rule) => {
    const { term } = await create(threeStraddled, 200, 20, 10_000_000);
    const wrapped = range(230, 197, 231, 2);
    const hold = placementHold(240);
    const search = searchOf(term);
    if (rule === 'read') {
      search.find('needle');
      now += 16;
      frame();
      expect(search.state, 'placement holds at the active-area entries').toEqual({ index: null, total: 240, partial: true });
    }
    search.step('needle', 'newer');
    for (let i = 0; i < 200 && active(term)?.[0]?.start.absoluteRow !== 0; i++) {
      now += 16;
      frame();
    }
    expect(active(term), 'the press landed at its cap on the oldest match').toEqual([range(0, 0)]);
    expect(search.state).toEqual({ index: 240, total: 240, partial: true });
    hold.move(0);
    term.write('\x1b[m');
    const walk: (number | undefined)[] = [];
    for (let i = 0; i < 115; i++) {
      search.step('needle', 'newer');
      walk.push(active(term)?.[0]?.start.absoluteRow);
    }
    expect(walk, 'the placed first listed page, oldest to newest').toEqual(Array.from({ length: 115 }, (_, i) => 2 * (i + 1)));
    search.step('needle', 'newer');
    expect(active(term), 'the press waits for the wrapped match').toEqual([range(230, 0)]);
    expect(search.state, 'the press returned before placement').toEqual({ index: null, total: 240, partial: true });
    hold.release();
    for (let i = 0; i < 1000 && search.state.partial; i++) {
      frame();
      expect([range(230, 0), wrapped], `frame ${i}: the press waits on its match or lands on its neighbour`).toContainEqual(active(term)?.[0]);
      now += 16;
    }
    expect(active(term)).toEqual([wrapped]);
    expect(search.state).toEqual({ index: 125, total: 241, partial: false });
  });

  // A newer press from no active match that lands at its one-second cap
  // reads no ordering rule, so the count of entries it waits for is still
  // unread when the next write takes the window. The write has changed the
  // core's listing by then, and reading it feeds the core inside the
  // write, which at the largest history costs a frame's work.
  test.each([
    { name: 'a listing a page ahead, its scan running', input: () => paged(1, 4000), cols: 200, rows: 5, partial: true },
    { name: 'one page in order, its scan complete', input: () => numbered(20_000), cols: 40, rows: 6, partial: false },
  ])('a write that takes the window reads nothing of the core, $name', async ({ input, cols, rows, partial }) => {
    const { term } = await create(input(), cols, rows, 10_000_000);
    const feeds = vi.spyOn(VtSearch.prototype, 'feed');
    const reads = vi.spyOn(VtSearch.prototype, 'matchAt');
    const search = searchOf(term);
    search.step('needle', 'newer');
    for (let i = 0; i < 200 && !active(term); i++) {
      now += 16;
      frame();
    }
    expect(active(term), 'the press landed at its cap').toBeDefined();
    expect(search.state.partial).toBe(partial);
    expect(search.state.index, 'on a placed index, so the write takes a window').not.toBeNull();
    feeds.mockClear();
    reads.mockClear();
    term.write('\r\nneedle new');
    expect({ feeds: feeds.mock.calls.length, reads: reads.mock.calls.length }, 'inside the write').toEqual({ feeds: 0, reads: 0 });
    now += 16;
    frame();
    expect(feeds, 'the next frame feeds the write').toHaveBeenCalledTimes(1);
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

  test.each([
    { name: 'read from the listing', placeable: true },
    { name: 'where the core cannot place the entries the listing is read from', placeable: false },
  ])("find knows the newest's index once placement has read the entry after the active-area entries, $name", async ({ placeable }) => {
    const { term } = await create(straddled, 200, 5, 10_000_000);
    const raw = term.core!.createSearch();
    raw.setNeedle('needle');
    raw.feed();
    const head = raw.state().total;
    raw.free();
    placementStopsAt(head + 1);
    if (!placeable) vi.spyOn(VtSearch.prototype, 'matchAt').mockReturnValue(null);
    const search = searchOf(term);
    search.find('needle');
    frame();
    expect(all(term), 'the first frame places the active-area entries alone').toHaveLength(head);
    expect(active(term), 'find lands on the newest from the listing, or waits for the rule').toEqual(placeable ? [range(238, 0)] : undefined);
    expect(search.state.index, 'the index waits for the wrapped match').toBeNull();
    for (let i = 0; i < 100 && all(term)!.length === head; i++) {
      frame();
      if (all(term)!.length === head) expect(search.state.index, `frame ${i}: the index still waits`).toBeNull();
    }
    expect(all(term), 'the scan lists the wrapped match and placement stops after it').toHaveLength(head + 1);
    expect(active(term)).toEqual([range(238, 0)]);
    expect(search.state.index, 'the list placed so far is the head of the whole one').toBe(1);
    settle(search);
    expect(search.state).toEqual({ index: 1, total: 121, partial: false });
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

  test('a find listener that throws during a resize leaves the new size published and painted', async () => {
    const { term } = await create('needle\r\nneedle\r\n');
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    const sizes: string[] = [];
    term.onResize(({ cols, rows }) => sizes.push(`${cols}x${rows}`));
    const paint = vi.fn();
    term.addPaintLayer({ order: 0, paint });
    search.onChange(() => { throw new Error('find bar listener failed'); });
    const changes: string[] = [];
    term.onChange(({ kind }) => changes.push(kind));
    const reported: unknown[] = [];
    vi.stubGlobal('reportError', (failure: unknown) => reported.push(failure));
    expect(() => term.resize(30, 6), 'the caller sizing the terminal sees no error').not.toThrow();
    expect(changes, 'change listeners still hear the resize').toEqual(['resize']);
    expect(sizes, 'the PTY hears the new size').toEqual(['30x6']);
    expect(paint, 'the screen repaints at the new size').toHaveBeenCalled();
    expect(reported, "the listener's error is reported").toEqual([new Error('find bar listener failed')]);
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

  // A line feed at the bottom of a scroll region whose top row is a
  // wrapped match's second row drops that row; the core moves the end's
  // tracked cell to the row above at its own column and leaves the start's,
  // so the pair reads 2:37 to 2:2.
  test('output that leaves the active match ending before its start loses it in that write', async () => {
    const { term } = await create(`needle 0\r\nr1\r\n${'x'.repeat(37)}needle\r\nneedle 4\r\nr5`);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'older');
    expect(active(term)).toEqual([range(2, 37, 3, 2)]);
    const start = term.core!.trackCell(2, 37)!;
    const end = term.core!.trackCell(3, 2)!;
    term.write('\x1b[4;6r\x1b[6;1H\n');
    const moved = { start: start.point(), end: end.point() };
    start.free();
    end.free();
    expect(moved, 'not exercised: the core no longer moves one cell of the pair above the other here; ' +
      'after a core update, find a write that does, or this case guards nothing').toEqual({
      start: { row: 2, col: 37 }, end: { row: 2, col: 2 },
    });
    expect(active(term), 'find shows no active match and paints no band').toBeUndefined();
    expect(activeText(term), 'Copy reads nothing of it').toBeUndefined();
    expect(search.state.index, 'no active match has a position').toBeNull();
    search.step('needle', 'older');
    expect(active(term), 'older from no active match lands on the newest').toEqual([range(3, 0)]);
    expect(activeText(term)).toBe('needle');
    settle(search);
    expect(search.state).toEqual({ index: 1, total: 2, partial: false });
    expect(active(term)).toEqual([range(3, 0)]);
  });

  // A press made after output, whose neighbour was on the screen, waits on
  // the kept match; the feed outruns the press's placement slice, so it is
  // still waiting when the next write arrives.
  test('a press waiting on the active match when output leaves it ending before its start applies from no active match', async () => {
    const { term } = await create(`needle 0\r\nr1\r\n${'x'.repeat(37)}needle\r\nneedle 4\r\nr5`);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'older');
    expect(active(term)).toEqual([range(2, 37, 3, 2)]);
    slowFeed();
    term.write('\x1b[m');
    search.step('needle', 'older');
    expect(search.state.index, 'the press waits for placement').toBeNull();
    expect(active(term), 'on the wrapped match').toEqual([range(2, 37, 3, 2)]);
    term.write('\x1b[4;6r\x1b[6;1H\n');
    expect(active(term), 'the write loses the active match').toBeUndefined();
    frame();
    expect(active(term), 'the waiting older press lands on the newest, as from no active match').toEqual([range(3, 0)]);
    expect(activeText(term)).toBe('needle');
    settle(search);
    expect(search.state).toEqual({ index: 1, total: 2, partial: false });
    expect(active(term)).toEqual([range(3, 0)]);
  });

  test('a press waiting on the active match when pruning removes it applies from no active match', async () => {
    const { term } = await create('needle\r\n' + 'filler\r\n'.repeat(900) + 'needle', 80, 5, 1000);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'newer');
    expect(active(term)).toEqual([range(0, 0)]);
    slowFeed();
    term.write('\x1b[m');
    search.step('needle', 'newer');
    expect(search.state.index, 'the press waits for placement').toBeNull();
    expect(active(term), 'on the oldest match').toEqual([range(0, 0)]);
    term.write('\r\n' + 'filler\r\n'.repeat(600));
    expect(active(term), 'the write prunes the active match').toBeUndefined();
    settle(search);
    expect(search.state, 'the waiting newer press lands on the oldest, as from no active match').toEqual({
      index: 1, total: 1, partial: false,
    });
    expect(active(term)?.[0].start.absoluteRow).toBeLessThan(901);
    expect(activeText(term)).toBe('needle');
  });

  // The write that leaves the pair ending before its start also switches to
  // the alternate screen, which sets the primary's active match aside in
  // its cells unread; the switch back reads them.
  test('a set-aside active match left ending before its start is lost at the switch back', async () => {
    const { term } = await create(`needle 0\r\nr1\r\n${'x'.repeat(37)}needle\r\nneedle 4\r\nr5`);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'older');
    expect(active(term)).toEqual([range(2, 37, 3, 2)]);
    const start = term.core!.trackCell(2, 37)!;
    const end = term.core!.trackCell(3, 2)!;
    term.write('\x1b[4;6r\x1b[6;1H\n\x1b[?1049h');
    expect(active(term), 'the alternate screen shows no primary match').toBeUndefined();
    settle(search);
    term.write('\x1b[?1049l');
    const moved = { start: start.point(), end: end.point() };
    start.free();
    end.free();
    expect(moved, 'not exercised: the core no longer moves one cell of the pair above the other here; ' +
      'after a core update, find a write that does, or this case guards nothing').toEqual({
      start: { row: 2, col: 37 }, end: { row: 2, col: 2 },
    });
    expect(active(term), 'find shows no active match at the switch back').toBeUndefined();
    expect(activeText(term), 'Copy reads nothing of it').toBeUndefined();
    expect(search.state.index, 'no match is kept: the index reads zero of none counted yet').toBe(0);
    search.step('needle', 'older');
    expect(active(term), 'older from no active match lands on the newest').toEqual([range(3, 0)]);
    expect(activeText(term)).toBe('needle');
    settle(search);
    expect(search.state).toEqual({ index: 1, total: 2, partial: false });
    expect(active(term)).toEqual([range(3, 0)]);
  });

  // A narrowing resize while the alternate screen shows reflows the primary
  // screen: the set-aside pair's start, the last cells of a row still
  // marked wrapped, moves to the next row, and its end stays on the row
  // above.
  test('a set-aside active match that a resize leaves ending on a row above its start is lost at the switch back', async () => {
    const { term } = await create(`needle 0\r\nr1\r\n${'x'.repeat(37)}needle\r\nneedle 4\r\nr5`);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'older');
    expect(active(term)).toEqual([range(2, 37, 3, 2)]);
    const start = term.core!.trackCell(2, 37)!;
    const end = term.core!.trackCell(3, 2)!;
    term.write('\x1b[4;6r\x1b[6;1H\n\x1b[?1049h');
    settle(search);
    term.resize(37, 6);
    settle(search);
    term.write('\x1b[?1049l');
    const moved = { start: start.point(), end: end.point() };
    start.free();
    end.free();
    expect(moved, 'not exercised: the core no longer reflows the pair to end on a row above its start here; ' +
      'after a core update, find a resize that does, or this case guards nothing').toEqual({
      start: { row: 3, col: 0 }, end: { row: 2, col: 2 },
    });
    expect(active(term), 'find shows no active match at the switch back').toBeUndefined();
    expect(activeText(term), 'Copy reads nothing of it').toBeUndefined();
    search.step('needle', 'older');
    expect(active(term), 'older from no active match lands on the newest').toEqual([range(3, 3)]);
    expect(activeText(term)).toBe('needle');
    settle(search);
    expect(search.state).toEqual({ index: 1, total: 2, partial: false });
    expect(active(term)).toEqual([range(3, 3)]);
  });

  // A narrowing resize rewraps each history line in two rows, past the line
  // limit, so pruning takes the oldest rows and the active match with them.
  test('a press waiting on the active match when a resize prunes it applies from no active match', async () => {
    const { term } = await create('needle ' + 'x'.repeat(60) + '\r\n' + ('y'.repeat(60) + '\r\n').repeat(700) +
      'needle y\r\nneedle z', 80, 5, 1000);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'newer');
    expect(active(term), 'newer from the newest wraps to the oldest').toEqual([range(0, 0)]);
    slowFeed();
    term.write('\x1b[m');
    search.step('needle', 'newer');
    expect(search.state.index, 'the press waits for placement').toBeNull();
    expect(active(term), 'on the oldest match').toEqual([range(0, 0)]);
    const oldest = term.core!.trackCell(0, 0)!;
    term.resize(40, 5);
    const pruned = oldest.point();
    oldest.free();
    expect(pruned, 'not exercised: the core no longer prunes the oldest row at this resize; ' +
      'after a core update, find a resize that does, or this case guards nothing').toBeNull();
    expect(active(term), 'the resize prunes the active match').toBeUndefined();
    settle(search);
    expect(search.state, 'the waiting newer press lands on the oldest left, as from no active match').toEqual({
      index: 2, total: 2, partial: false,
    });
    expect(activeLine(term)).toBe('needle y');
  });

  // The switch sets the primary screen's active match aside, so the
  // alternate screen shows none.
  test('a press waiting on the active match at the switch to the alternate screen applies there from no active match', async () => {
    const { term } = await create('x needle\r\nyy needle');
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'older');
    expect(active(term)).toEqual([range(0, 2)]);
    slowFeed();
    term.write('\x1b[m');
    search.step('needle', 'newer');
    expect(search.state.index, 'the press waits for placement').toBeNull();
    expect(active(term), 'on the oldest match').toEqual([range(0, 2)]);
    term.write('\x1b[?1049h\x1b[Hneedle a\r\nneedle b');
    expect(active(term), 'the alternate screen shows no primary match').toBeUndefined();
    settle(search);
    expect(search.state, 'the waiting newer press lands on the oldest, as from no active match').toEqual({
      index: 2, total: 2, partial: false,
    });
    expect(active(term)).toEqual([range(0, 0)]);
    term.write('\x1b[?1049l');
    expect(active(term), 'the primary match returns with its screen').toEqual([range(0, 2)]);
    settle(search);
    expect(search.state).toEqual({ index: 2, total: 2, partial: false });
  });

  // The switch back drops the alternate screen's active match and returns
  // the primary's, which a press made at that moment steps from.
  test("a press waiting at the switch back from the alternate screen steps from the primary screen's returned match", async () => {
    const { term } = await create('x needle\r\nyy needle');
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'older');
    expect(active(term)).toEqual([range(0, 2)]);
    term.write('\x1b[?1049h\x1b[Hneedle a\r\nneedle b');
    settle(search);
    search.step('needle', 'older');
    expect(active(term), 'older from no active match lands on the newest').toEqual([range(1, 0)]);
    slowFeed();
    term.write('\x1b[m');
    search.step('needle', 'newer');
    expect(search.state.index, 'the press waits for placement').toBeNull();
    expect(active(term), "on the alternate screen's newest").toEqual([range(1, 0)]);
    term.write('\x1b[?1049l');
    expect(active(term), 'the primary match returns with its screen').toEqual([range(0, 2)]);
    settle(search);
    expect(search.state, 'the waiting newer press steps on from the returned oldest match').toEqual({
      index: 1, total: 2, partial: false,
    });
    expect(active(term)).toEqual([range(1, 3)]);
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

describe('press deadlines and reveals', () => {
  test('steps queued behind a capped step apply in order, each as the scan or its own cap allows', async () => {
    const { term } = await create(long());
    const search = searchOf(term);
    // Newer from no active match waits for the oldest; older 600 ms later
    // queues behind it with its own deadline.
    search.step('needle', 'newer');
    now = 600;
    search.step('needle', 'older');
    expect(active(term) ?? []).toEqual([]);
    now = 1000;
    frame();
    // The first press's cap ran out: it lands on the oldest found so far.
    // Older from there would wrap to the newest, and its own cap has 600 ms
    // to go, so it waits for the scan's next older match.
    const found = search.state.total;
    expect(found).toBeGreaterThan(1);
    expect(found).toBeLessThan(300);
    expect(search.state).toEqual({ index: found, total: found, partial: true });
    // The clock stays inside its cap: it lands as the scan finds the next
    // older match, and never wraps.
    for (let i = 0; search.state.index === found; i++) {
      if (i > 1000) throw new Error('the queued step never landed');
      frame();
    }
    expect(search.state.index).toBe(found + 1);
    expect(search.state.partial).toBe(true);
  });

  test('a queued step with nothing more found wraps at its own cap, not at the cap of the step before it', async () => {
    const { term } = await create(long());
    const search = searchOf(term);
    search.step('needle', 'newer');
    now = 600;
    search.step('needle', 'older');
    now = 1000;
    frame();
    const found = search.state.total;
    expect(search.state).toEqual({ index: found, total: found, partial: true });
    // The scan stalls: no frame finds another match.
    vi.mocked(VtSearch.prototype.step).mockImplementation(() => 'running');
    now = 1599;
    frame();
    expect(search.state.index, 'inside its own cap').toBe(found);
    now = 1600;
    frame();
    expect(search.state.index, 'wrapped to the newest at its cap').toBe(1);
  });

  test('a step that waited reveals its match when the selection is the one at its press', async () => {
    const { term } = await create(long());
    const search = searchOf(term);
    const reveal = vi.spyOn(term.viewport, 'reveal');
    const selected = range(2998, 0, 2998, 3);
    term.setSelection(selected);
    search.step('needle', 'newer');
    expect(active(term) ?? [], 'nothing moves while it waits').toEqual([]);
    settle(search);
    expect(active(term)).toEqual([range(5, 0)]);
    expect(reveal).toHaveBeenCalledExactlyOnceWith(5);
    expect(term.getSelectionRange()).toEqual(selected);
  });

  // The selection at the press, replaced while the step waits by one that
  // differs from it in a single coordinate.
  test.each([
    ['start row', range(2997, 0, 2998, 3)],
    ['start column', range(2998, 1, 2998, 3)],
    ['end row', range(2998, 0, 2999, 3)],
    ['end column', range(2998, 0, 2998, 4)],
  ])('a step that waited does not reveal its match when the selection at its press changed its %s', async (_, changed) => {
    const { term } = await create(long());
    const search = searchOf(term);
    const reveal = vi.spyOn(term.viewport, 'reveal');
    term.setSelection(range(2998, 0, 2998, 3));
    search.step('needle', 'newer');
    expect(active(term) ?? [], 'nothing moves while it waits').toEqual([]);
    term.setSelection(changed);
    expect(term.getSelectionRange(), 'the selection took the change').toEqual(changed);
    settle(search);
    expect(active(term)).toEqual([range(5, 0)]);
    expect(reveal).not.toHaveBeenCalled();
    expect(term.getSelectionRange()).toEqual(changed);
  });

  // 100 lines with needles on lines 10, 50 and 95, each 37 cells long, on
  // a 40x6 screen: narrowing to 20 columns wraps every line into two rows.
  const sparse = () => Array.from({ length: 100 }, (_, i) =>
    `row ${String(i).padStart(3, '0')} ${[10, 50, 95].includes(i) ? 'needle' : 'xxxxxx'} yyyyyyyyyyyyyy`).join('\r\n');
  const onScreen = (term: Terminal, row: number) => {
    const top = term.getScrollbackLength() - Math.floor(term.viewport.offset);
    return row >= top && row < top + term.rows;
  };

  test('a reflow that takes an active match on the screen off it reveals the match', async () => {
    const { term } = await create(sparse());
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    expect(onScreen(term, active(term)![0].start.absoluteRow)).toBe(true);
    const reveal = vi.spyOn(term.viewport, 'reveal');
    term.resize(20, 6);
    const kept = active(term)![0];
    expect(term.getRangeText(kept)).toBe('needle');
    expect(reveal).toHaveBeenCalledExactlyOnceWith(kept.start.absoluteRow);
    expect(onScreen(term, kept.start.absoluteRow)).toBe(true);
    settle(search);
    expect(onScreen(term, active(term)![0].start.absoluteRow)).toBe(true);
    expect(search.state).toEqual({ index: 1, total: 3, partial: false });
  });

  test('a reflow leaves the viewport where it is when the active match was off the screen', async () => {
    const { term } = await create(sparse());
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'older');
    term.viewport.scrollToBottom();
    frame();
    expect(onScreen(term, active(term)![0].start.absoluteRow)).toBe(false);
    const offset = term.viewport.offset;
    const reveal = vi.spyOn(term.viewport, 'reveal');
    term.resize(20, 6);
    settle(search);
    expect(reveal).not.toHaveBeenCalled();
    expect(term.viewport.offset).toBe(offset);
    expect(onScreen(term, active(term)![0].start.absoluteRow)).toBe(false);
    expect(search.state).toEqual({ index: 2, total: 3, partial: false });
  });

  test('a match below a scrolled-back screen is not revealed when the screen grows', async () => {
    const { term } = await create(numbered(200), 40, 10);
    const search = searchOf(term);
    search.find('needle 150');
    settle(search);
    expect(active(term)).toEqual([range(150, 0, 150, 9)]);
    // Scrolled back to where the match is the row just below the screen.
    term.viewport.scrollTo(term.getScrollbackLength() - 140);
    expect(onScreen(term, 149)).toBe(true);
    expect(onScreen(term, 150)).toBe(false);
    const reveal = vi.spyOn(term.viewport, 'reveal');
    term.resize(40, 14);
    settle(search);
    expect(reveal).not.toHaveBeenCalled();
    expect(active(term)).toEqual([range(150, 0, 150, 9)]);
  });
});

describe('the cost model', () => {
  // The owner's frame target and its costs assumed before any is measured
  // (`FRAME_BUDGET_MS`, `SCAN_BUDGET_MS`, `COST_PRIORS` in search.ts), per
  // cell read and per match times cell checked or completed.
  const FRAME_MS = 12;
  const SCAN_MS = 4;
  const PRIOR = { read: 4e-6, check: 2e-11, complete: 3e-11 };
  const COLS = 200;
  // At 200 columns and next to nothing held to check, a backlog of this
  // many rows predicts exactly the frame's budget at the assumed read.
  const LIMIT = FRAME_MS / (COLS * PRIOR.read);

  // A 200x10 terminal holding `lines`, with room for `scrollback` history
  // rows, its search for "needle" complete.
  async function settled(lines: string, scrollback = 60_000) {
    const { term } = await create(lines, COLS, 10, scrollback);
    const search = searchOf(term);
    search.find('needle');
    for (let i = 0; search.state.partial; i++) {
      if (i > 100_000) throw new Error('search did not complete');
      frame();
    }
    return { term, search };
  }
  const matching = (n: number) => Array.from({ length: n }, (_, i) => `needle ${i}`).join('\r\n');
  // A frame after `rows` filler rows are written; true when the owner
  // restarted its search instead of feeding it.
  function frameAfter(term: Terminal, rows: number): boolean {
    const restart = vi.spyOn(VtSearch.prototype, 'restart');
    restart.mockClear();
    term.write('filler\r\n'.repeat(rows));
    frame();
    return restart.mock.calls.length > 0;
  }
  // Each feed takes `cost.ms(rows)` on the test's clock, `rows` the history
  // rows added since the feed before it; the case changes `cost.ms`.
  function costly(term: Terminal, ms: (rows: number) => number) {
    if (vi.isMockFunction(VtSearch.prototype.feed)) vi.mocked(VtSearch.prototype.feed).mockRestore();
    const feed = VtSearch.prototype.feed;
    const cost = { ms };
    let history = term.getScrollbackLength();
    vi.spyOn(VtSearch.prototype, 'feed').mockImplementation(function (this: VtSearch) {
      now += cost.ms(term.getScrollbackLength() - history);
      history = term.getScrollbackLength();
      feed.call(this);
    });
    return cost;
  }
  // The budget the first scan step of the rescan is given after `rows`
  // filler rows restart a complete scan; the rescan keeps the count of
  // matches it held, which its completion is predicted from.
  function stepBudgetAfterRestart(term: Terminal, search: Search, rows: number) {
    const step = vi.mocked(VtSearch.prototype.step);
    step.mockClear();
    expect(frameAfter(term, rows), 'the complete scan restarts').toBe(true);
    for (let i = 0; step.mock.calls.length === 0; i++) {
      if (i > 100 || !search.state.partial) throw new Error('no scan step after the restart');
      frame();
    }
    return step.mock.calls[0][0];
  }
  // Each core scan unit, one per step call as everywhere in this file,
  // takes `ms` on a clock of its own, so the unit that completes a scan
  // measures `ms` (`completingUnitMs`) while the frame's clock stands;
  // without `ms` the units read the frame's clock again, as the file's
  // setup has them.
  function unitsTake(ms?: number) {
    vi.mocked(VtSearch.prototype.step).mockRestore();
    const step = VtSearch.prototype.step;
    let clock = 0;
    vi.spyOn(VtSearch.prototype, 'step').mockImplementation(function (this: VtSearch) {
      return step.call(this, 0, ms === undefined ? () => now : () => (clock += ms));
    });
  }

  test('a backlog predicted to fit the frame is fed, and one predicted over it restarts the scan', async () => {
    const under = await settled('needle a\r\nneedle b');
    expect(frameAfter(under.term, Math.floor(LIMIT) - 500)).toBe(false);
    const over = await settled('needle a\r\nneedle b');
    expect(frameAfter(over.term, Math.ceil(LIMIT) + 500)).toBe(true);
    expect(over.search.state.partial, 'the rescan has only begun').toBe(true);
    settle(over.search);
    expect(over.search.state).toEqual({ index: 1, total: 2, partial: false });
  });

  test('feeds measured cheaper than assumed do not lower the read under the assumed cost', async () => {
    const { term } = await settled('needle a');
    // A tenth of the assumed cost.
    costly(term, rows => rows * COLS * PRIOR.read / 10);
    for (let i = 0; i < 4; i++) expect(frameAfter(term, 1000), `cheap feed ${i}`).toBe(false);
    expect(frameAfter(term, Math.floor(LIMIT) - 500), 'under the threshold').toBe(false);
    expect(frameAfter(term, Math.ceil(LIMIT) + 500), 'over it, as at the assumed cost').toBe(true);
  });

  test('one feed that ran long raises the read estimate, by a quarter at most', async () => {
    // With nothing to check, 12,500 rows at 200 columns predict 10 ms at the
    // assumed read and 12.5 ms a quarter above it; 11,000 rows predict 11 ms
    // a quarter above it and 13.2 ms half above it.
    for (const [rows, restarts] of [[12_500, true], [11_000, false]] as const) {
      const { term } = await settled('needle a');
      const cost = costly(term, () => 100);
      expect(frameAfter(term, 1000), 'the long feed').toBe(false);
      cost.ms = () => 0.01;
      expect(frameAfter(term, rows), `${rows} rows`).toBe(restarts);
    }
  });

  test("a feed under the clock's grain, measured as no time, teaches nothing", async () => {
    // Three feeds of twice the budget raise the read to about 1.95 times its
    // assumed cost, where 10,000 rows at 200 columns predict 15.6 ms and
    // restart; four feeds the clock reads as no time leave it there, where
    // learned as cheap they would lower it back to the assumed 8 ms.
    const { term } = await settled('needle a');
    const cost = costly(term, () => 2 * FRAME_MS);
    for (let i = 0; i < 3; i++) expect(frameAfter(term, 1000), `slow feed ${i}`).toBe(false);
    cost.ms = () => 0;
    for (let i = 0; i < 4; i++) expect(frameAfter(term, 1000), `feed under the grain ${i}`).toBe(false);
    expect(frameAfter(term, 10_000)).toBe(true);
  });

  test("a complete scan's feed over the budget is fed, not restarted, where the rescan's completion would cost more", async () => {
    // 50,000 matches in a 50,000-line history at 200 columns: a feed's
    // check is assumed at about 11 ms and a completing unit's at about 16
    // once 4,700 rows more are held. Those rows read in 3.8 ms: the feed
    // predicts 14.7 ms, over the budget but under the completion, and is
    // fed. 10,000 rows read in 8 ms: the feed predicts 20 ms, dearer than
    // the completion's 18, and restarts.
    for (const [rows, restarts] of [[4_700, false], [10_000, true]] as const) {
      const { term } = await settled(matching(50_000), 80_000);
      expect(frameAfter(term, rows), `${rows} rows`).toBe(restarts);
    }
  });

  test('a running scan restarts for a read of a scan step or more whose completion would not fit, and feeds smaller ones', async () => {
    const { term, search } = await settled(matching(50_000), 80_000);
    expect(frameAfter(term, 10_000), 'the complete scan restarts').toBe(true);
    // 6,000 rows read in 4.8 ms at the assumed cost, a scan step's budget or
    // more, with the completion over the frame's budget.
    for (let i = 0; i < 2; i++) expect(frameAfter(term, 6_000), `big write ${i}`).toBe(true);
    // 100 rows read in 0.08 ms: a restart would throw the scan away to save
    // next to nothing.
    for (let i = 0; i < 3; i++) expect(frameAfter(term, 100), `small write ${i}`).toBe(false);
    settle(search);
    expect(search.state).toEqual({ index: 1, total: 50_000, partial: false });
  });

  test("the scan's step leaves room in the frame for the check of the unit that completes it", async () => {
    // 36,000 matches at 200 columns, and 8,000 rows that restart the scan:
    // a 44,000-row history, where the completing unit's check is assumed
    // at about 9.5 ms, leaving the step about 2.5 ms.
    const { term, search } = await settled(matching(36_000));
    const budget = stepBudgetAfterRestart(term, search, 8_000);
    const completion = 36_000 * term.getScrollbackLength() * COLS * PRIOR.complete;
    expect(completion).toBeGreaterThan(FRAME_MS - SCAN_MS);
    expect(completion).toBeLessThan(FRAME_MS - 1);
    expect(budget).toBeCloseTo(FRAME_MS - completion, 6);
  });

  test('with under a millisecond left beside the completion the scan step still gets one', async () => {
    // 41,000 matches and 6,000 rows that restart the scan: a 47,000-row
    // history, where the completing unit's check is assumed at about
    // 11.6 ms, leaving about 0.4 ms of the frame.
    const { term, search } = await settled(matching(41_000));
    const budget = stepBudgetAfterRestart(term, search, 6_000);
    const left = FRAME_MS - 41_000 * term.getScrollbackLength() * COLS * PRIOR.complete;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(1);
    expect(budget).toBe(1);
  });

  test('with the completion predicted over the budget the scan step runs its whole budget', async () => {
    // 50,000 matches and 10,000 rows that restart the scan: the completing
    // unit's check is assumed at about 18 ms.
    const { term, search } = await settled(matching(50_000), 80_000);
    expect(stepBudgetAfterRestart(term, search, 10_000)).toBe(SCAN_MS);
  });

  test('a frame that starts with found results unplaced places them and scans no further', async () => {
    // Ten matches a line, so a scan step finds more than one batch places.
    const { term } = await create(paged(10, 300), COLS, 10, 60_000);
    batchPerFrame();
    const read = vi.mocked(VtSearch.prototype.readMatches);
    const step = vi.mocked(VtSearch.prototype.step);
    const search = searchOf(term);
    search.find('needle');
    let draining = 0;
    for (let i = 0; search.state.partial; i++) {
      if (i > 1000) throw new Error('search did not complete');
      // Nothing runs the scan between frames, so the last read says what
      // the next frame starts with.
      const last = read.mock.results.at(-1)?.value;
      const steps = step.mock.calls.length;
      frame();
      if (last && last.next < last.total) {
        draining++;
        expect(step.mock.calls.length, `frame ${i} scans with results unplaced`).toBe(steps);
      }
    }
    expect(draining, 'the frames that start with results unplaced').toBeGreaterThan(1);
    expect(search.state.total).toBe(3_000);
  });

  test('small feeds of a complete scan that take long raise the check its next feed predicts', async () => {
    // 50,000 matches at 200 columns: with 4,700 rows more held a feed's
    // check is assumed at about 10.9 ms and a completing unit's at about
    // 16.4, and the rows read in 3.8 ms, so the feed predicts 14.7 ms, over
    // the budget but under the completion, and is fed. A 10-row feed that
    // takes 20 ms raises the check by a quarter, to about 13.7 ms, where the
    // same backlog predicts 17.4 ms, over the completion, and restarts.
    for (const slow of [false, true]) {
      const { term } = await settled(matching(50_000));
      if (slow) {
        const cost = costly(term, () => 20);
        expect(frameAfter(term, 10), 'the slow small feed').toBe(false);
        cost.ms = () => 0.01;
      }
      expect(frameAfter(term, 4_700), slow ? 'after the slow feed' : 'at the assumed check').toBe(slow);
    }
  });

  test('small feeds measured cheaper than assumed do not lower the check under its assumed cost', async () => {
    // 50,000 matches at 200 columns: 10,000 more rows predict 20 ms at the
    // assumed check, dearer than the completion's 18, and restart; with the
    // check learned down to next to nothing they would predict 8 and feed.
    const { term } = await settled(matching(50_000), 80_000);
    costly(term, () => 0.01);
    for (let i = 0; i < 6; i++) expect(frameAfter(term, 10), `small cheap feed ${i}`).toBe(false);
    expect(frameAfter(term, 10_000)).toBe(true);
  });

  test('a check under the learning floor is not learned: small slow feeds of next to nothing to check teach nothing', async () => {
    // 5,000 matches in a 10,000-line history at 200 columns: 1e10 matches
    // times cells, under the floor, a check assumed at 0.2 ms. Small feeds
    // of 20 ms would each raise it by a quarter, to about 14 ms by the
    // twentieth, which would restart; under the floor they do not.
    const lines = Array.from({ length: 10_000 }, (_, i) => i % 2 === 0 ? `needle ${i}` : `line ${i}`).join('\r\n');
    const { term } = await settled(lines, 20_000);
    costly(term, () => 20);
    for (let i = 0; i < 20; i++) expect(frameAfter(term, 10), `slow small feed ${i}`).toBe(false);
    expect(frameAfter(term, 100)).toBe(false);
  });

  test("a complete scan's feed over the budget is fed, not restarted, once a completing unit measured the completion dearer", async () => {
    // 50,000 matches at 200 columns: with 10,000 rows more held the feed
    // predicts 20 ms, over the budget and over the completion's assumed 18,
    // so it restarts. A completing unit of 30 ms raises the completion by a
    // quarter, to 22.5 ms, dearer than the feed, so it feeds.
    for (const slow of [false, true]) {
      if (slow) unitsTake(30);
      const { term } = await settled(matching(50_000), 80_000);
      unitsTake();
      expect(frameAfter(term, 10_000), slow ? 'the completion measured dearer' : 'at the assumed costs').toBe(!slow);
    }
  });

  test('completing units measured cheaper than assumed do not lower the completion under its assumed cost', async () => {
    // As the step's room beside the completion above, with every scan unit,
    // the completing one among them, measured at 0.01 ms: the completion
    // keeps its assumed 9.5 ms and the step its 2.5. Learned down to next
    // to nothing the completion would leave the step its whole budget.
    unitsTake(0.01);
    const { term, search } = await settled(matching(36_000));
    unitsTake();
    const budget = stepBudgetAfterRestart(term, search, 8_000);
    const completion = 36_000 * term.getScrollbackLength() * COLS * PRIOR.complete;
    expect(budget).toBeCloseTo(FRAME_MS - completion, 6);
  });

  test("a running scan's cheaper feeds do not lower what a complete scan's feed is predicted to cost", async () => {
    // A complete scan's feed of 1,000 rows takes twice the budget; a running
    // scan's, which drops nothing the output pruned, next to nothing.
    const { term, search } = await settled('needle a');
    const feed = VtSearch.prototype.feed;
    vi.spyOn(VtSearch.prototype, 'feed').mockImplementation(function (this: VtSearch) {
      now += this.caughtUp() ? 2 * FRAME_MS : 0.01;
      feed.call(this);
    });
    let frames = 0;
    while (!frameAfter(term, 1000)) if (++frames > 20) throw new Error('never restarted');
    // Backlogs of a scan step or less while the rescan runs are fed, each
    // one cheap.
    for (let i = 0; i < 6; i++) {
      expect(search.state.partial, `the rescan runs at feed ${i}`).toBe(true);
      expect(frameAfter(term, 100), `running feed ${i}`).toBe(false);
    }
    settle(search);
    expect(frameAfter(term, 1000), "the complete scan's cost is still the one measured").toBe(true);
  });

  test('a new query starts from the assumed costs again: how often the needle matches decides them', async () => {
    const { term, search } = await settled('needle a\r\nother b');
    costly(term, () => 2 * FRAME_MS);
    let frames = 0;
    while (!frameAfter(term, 1000)) if (++frames > 20) throw new Error('never restarted');
    settle(search);
    expect(frameAfter(term, 1000), '1,000 rows still cost what was measured').toBe(true);
    settle(search);
    search.find('other');
    settle(search);
    expect(frameAfter(term, 1000), 'at the assumed cost').toBe(false);
  });

  test('a backlog that spans the whole history is fed: the core starts its history search over by itself', async () => {
    // The 20,000-line history at 200 columns predicts over the budget when
    // read whole; a backlog past it leaves the backlog cell's row pruned.
    expect(20_000 * COLS * PRIOR.read).toBeGreaterThan(FRAME_MS);
    const { term, search } = await settled(`needle a\r\n${'filler\r\n'.repeat(20_000)}`, 20_000);
    expect(frameAfter(term, 25_000)).toBe(false);
    settle(search);
    expect(search.state).toEqual({ index: 0, total: 0, partial: false });
  });

  test('a running scan feeds a read of a scan step or more where its completion still fits the frame', async () => {
    // One match, so a completion of next to nothing: 16,000 rows read in
    // 12.8 ms restart the complete scan, and 6,000 rows read in 4.8 ms, a
    // scan step's budget or more, fit the frame beside the completion.
    const { term, search } = await settled('needle a');
    expect(frameAfter(term, 16_000), 'the complete scan restarts').toBe(true);
    expect(search.state.partial, 'the rescan runs').toBe(true);
    expect(frameAfter(term, 6_000)).toBe(false);
    settle(search);
    expect(search.state).toEqual({ index: 1, total: 1, partial: false });
  });
});

describe('a listed match whose end precedes its start', () => {
  const backwards = (r: Range) => r.end.absoluteRow < r.start.absoluteRow ||
    (r.end.absoluteRow === r.start.absoluteRow && r.end.col < r.start.col);
  const listedBackwards = (m: MatchRange) => m.endRow < m.startRow || (m.endRow === m.startRow && m.endCol < m.startCol);
  // The rows of threePaged's matches, each the first six cells of a line.
  const threePagedRows = Array.from({ length: 240 }, (_, i) => i).filter(i => i <= 220 || i >= 231).map(i => 2 * i);
  const byRow = (rows: number[]) => [...rows].sort((a, b) => a - b);

  // The core's listing with its match at `row`, column 0, read back with its
  // end on a row above its start, through both reads the owner makes of the
  // core's ranges, as the vendored core lists a needle wrapped across a page
  // boundary on the screen at some sizes; with `sameRow`, read back with its
  // two ends swapped on its own row. Counts each read that handed it to the
  // owner. `stopAt` stops placement as placementStopsAt does and `hold`
  // holds it as placementHold does, neither of which can wrap this stand-in.
  function listedInverted(row: number, sameRow = false) {
    const handed = { batch: 0, at: 0 };
    const stops: number[] = [];
    let held: number | null = null;
    const invert = (match: MatchRange) => match.startRow !== row || match.startCol !== 0 ? match
      : sameRow ? { ...match, startCol: match.endCol, endCol: match.startCol } : { ...match, endRow: row >> 1, endCol: 2 };
    const read = VtSearch.prototype.readMatches;
    vi.spyOn(VtSearch.prototype, 'readMatches').mockImplementation(function (this: VtSearch, start: number, budget: number) {
      const batch = read.call(this, start, budget);
      let ranges = batch.ranges.map(invert);
      let next = batch.next;
      const stop = stops[0];
      const cut = stop !== undefined && start <= stop && batch.next > stop ? stops.shift()
        : held !== null && start <= held && batch.next > held ? held : undefined;
      if (cut !== undefined) {
        now += 5;
        ranges = ranges.slice(0, cut - start);
        next = cut;
      }
      handed.batch += ranges.filter(listedBackwards).length;
      return { ranges, next, total: batch.total };
    });
    const at = VtSearch.prototype.matchAt;
    vi.spyOn(VtSearch.prototype, 'matchAt').mockImplementation(function (this: VtSearch, index: number) {
      const match = at.call(this, index);
      if (!match) return match;
      const listed = invert(match);
      if (listedBackwards(listed)) handed.at++;
      return listed;
    });
    return {
      handed,
      stopAt: (...at: number[]) => { stops.push(...at); },
      hold: (at: number | null) => { held = at; },
    };
  }

  // The active match is one of `rows`' matches, never the one at `skipped`,
  // and Copy reads that match's text.
  function expectActiveAmong(term: Terminal, rows: number[], skipped: number, label: string) {
    const ranges = active(term);
    if (!ranges) return;
    expect(ranges, label).toHaveLength(1);
    const row = ranges[0].start.absoluteRow;
    expect(ranges[0], label).toEqual(range(row, 0));
    expect(row, label).not.toBe(skipped);
    expect(rows, label).toContain(row);
    expect(activeText(term), label).toBe('needle');
  }

  test.each([
    { name: 'in the middle of a batch', row: 130, entry: 50, read: 'batch' as const },
    { name: 'as the newest match', row: 478, entry: 221, read: 'at' as const },
    { name: 'as the first active-area entry', row: 230, entry: 0, read: 'at' as const },
    { name: 'as the last active-area entry', row: 462, entry: 229, read: 'at' as const },
    { name: 'in a batch, ending on its own row', row: 130, entry: 50, read: 'batch' as const, sameRow: true },
  ])('find neither counts, highlights, steps to nor copies it, listed $name', async ({ row, entry, read, sameRow }) => {
    const { term } = await create(threePaged, 200, 20, 10_000_000);
    expect(coreRows(term, 'needle', 230)[entry], `the core lists row ${row} as entry ${entry}`).toBe(row);
    const kept = threePagedRows.filter(r => r !== row);
    const { handed } = listedInverted(row, sameRow);
    const search = searchOf(term);
    search.find('needle');
    for (let i = 0; i < 1000 && search.state.partial; i++) {
      frame();
      expectActiveAmong(term, kept, row, `frame ${i}`);
    }
    expect(handed[read], `the stand-in handed the owner the range through ${read === 'at' ? 'matchAt' : 'readMatches'}`).toBeGreaterThan(0);
    expect(search.state, 'the count leaves it out').toEqual({ index: 1, total: kept.length, partial: false });
    const painted = all(term)!;
    expect(painted.filter(r => backwards(r) || r.start.absoluteRow === row), 'the all-matches layer holds no such range').toEqual([]);
    expect(byRow(painted.map(r => r.start.absoluteRow))).toEqual(byRow(kept));
    for (const direction of ['older', 'newer'] as const) {
      const visited: number[] = [];
      for (let i = 0; i < kept.length; i++) {
        search.step('needle', direction);
        expectActiveAmong(term, kept, row, `${direction} step ${i}`);
        visited.push(active(term)![0].start.absoluteRow);
      }
      expect(byRow(visited), `${direction} visits every other match once`).toEqual(byRow(kept));
    }
  });

  // The middle page's newest match starts that page's entries. Read as a
  // page's first entry, a range the owner never places would leave a window
  // taken at a write with no end at that page, and a press would land past
  // the matches of the page being placed.
  test("a write after a press takes a window ended at the page above where the core lists that page's newest match ending before its start", async () => {
    const { term } = await create(threePaged, 200, 20, 10_000_000);
    expect(coreRows(term, 'needle', 230)[116], "the core lists the middle page's newest first among its entries").toBe(440);
    const listing = listedInverted(440);
    const search = searchOf(term);
    search.find('needle');
    settle(search);
    search.step('needle', 'older');
    search.step('needle', 'older');
    expect(active(term)).toEqual([range(474, 0)]);
    // Placement stops right after the active match's entry. A press then
    // places nothing more, reads the count of the active-area entries and
    // waits; the next write takes the window from that list, and the frame
    // after it places nothing.
    listing.stopAt(224, 224, 0);
    term.write('\x1b[m');
    frame();
    expect(search.state.index, 'placement reached the active match').toBe(3);
    search.step('needle', 'older');
    expect(active(term), 'the press waits').toEqual([range(474, 0)]);
    term.write('\x1b[m');
    for (let i = 0; i < 100 && search.state.partial; i++) {
      expect([474, 472], `frame ${i}: the press waits on its match or lands on its neighbour`).toContain(active(term)?.[0].start.absoluteRow);
      frame();
    }
    expect(listing.handed.batch, 'the stand-in handed the owner the range through readMatches').toBeGreaterThan(0);
    expect(active(term)).toEqual([range(472, 0)]);
    expect(search.state, 'the count leaves it out').toEqual({ index: 4, total: 229, partial: false });
  });

  // A window taken from a list not yet in position order also ends at the
  // list's first entry, the first listed page's newest match, since a match
  // wrapped across the boundary below that page is listed after every
  // page's entries. Read as that entry, a range the owner never places
  // would leave the window with no end there, and a press would step over
  // the wrapped match onto the middle page's oldest, 232:0.
  test('a write takes a window ended at the first listed page where the core lists its newest match ending before its start', async () => {
    const { term } = await create(threeStraddled, 200, 20, 10_000_000);
    expect(coreRows(term, 'needle', 1), "the core lists the first listed page's newest first").toEqual([230]);
    const wrapped = range(230, 197, 231, 2);
    const listing = listedInverted(230);
    listing.hold(240);
    const search = searchOf(term);
    search.step('needle', 'newer');
    for (let i = 0; i < 200 && active(term)?.[0]?.start.absoluteRow !== 0; i++) {
      now += 16;
      frame();
    }
    expect(active(term), 'the press landed at its cap on the oldest match').toEqual([range(0, 0)]);
    expect(search.state).toEqual({ index: 239, total: 239, partial: true });
    listing.hold(0);
    term.write('\x1b[m');
    const walk: (number | undefined)[] = [];
    for (let i = 0; i < 114; i++) {
      search.step('needle', 'newer');
      walk.push(active(term)?.[0]?.start.absoluteRow);
    }
    expect(walk, 'the placed first listed page, oldest to newest, without the range').toEqual(Array.from({ length: 114 }, (_, i) => 2 * (i + 1)));
    search.step('needle', 'newer');
    expect(active(term), 'the press waits for the wrapped match').toEqual([range(228, 0)]);
    expect(search.state, 'the press returned before placement').toEqual({ index: null, total: 239, partial: true });
    listing.hold(null);
    for (let i = 0; i < 1000 && search.state.partial; i++) {
      frame();
      expect([range(228, 0), wrapped], `frame ${i}: the press waits on its match or lands on its neighbour`).toContainEqual(active(term)?.[0]);
      now += 16;
    }
    expect(listing.handed.batch, 'the stand-in handed the owner the range through readMatches').toBeGreaterThan(0);
    expect(active(term)).toEqual([wrapped]);
    expect(search.state, 'the count leaves it out').toEqual({ index: 125, total: 240, partial: false });
  });

  // The other side of the order test: a one-cell needle's match ends where
  // it starts, and find keeps it.
  test('a one-cell match, ending where it starts, is counted, highlighted, stepped to and copied', async () => {
    const { term } = await create('q\r\nxxq\r\nxqx');
    const cells = [range(2, 1, 2, 1), range(1, 2, 1, 2), range(0, 0, 0, 0)];
    const search = searchOf(term);
    search.find('q');
    settle(search);
    expect(search.state).toEqual({ index: 1, total: 3, partial: false });
    expect(all(term)).toHaveLength(3);
    expect(all(term)).toEqual(expect.arrayContaining(cells));
    expect(active(term)).toEqual([cells[0]]);
    for (const cell of [cells[1], cells[2], cells[0]]) {
      search.step('q', 'older');
      expect(active(term)).toEqual([cell]);
      expect(activeText(term)).toBe('q');
    }
  });

  test('at 400 by 120 on the real core, find keeps every match the core lists forward and nothing outside one', async () => {
    // Every line wraps a needle across the end of its first row. At this
    // size, with 173 such lines, the vendored core lists the newest line's
    // match from row 344, column 397 to row 115, column 2, and the other
    // 172 forward.
    const { term } = await create('', 400, 120, 10_000_000);
    const line = 'plain '.padEnd(397, 'y') + 'needle' + 'z'.repeat(197);
    for (let i = 0; i < 173; i++) term.write(`${line}\r\n`);
    frame();
    const raw = term.core!.createSearch();
    raw.setNeedle('needle');
    for (let i = 0; raw.step(0) !== 'complete'; i++) if (i > 100_000) throw new Error('raw search did not complete');
    const listed = raw.matchesBetween(0, Number.MAX_SAFE_INTEGER, 1_000_000);
    raw.free();
    expect(listed.filter(listedBackwards), 'not exercised: the core lists no range whose end precedes its start here. ' +
      'After a core update this means no case reads the guard on the real core: find a size where it still lists one, ' +
      'or retire this case, and reread the sizes the README names').not.toEqual([]);
    const kept = new Map(listed.filter(m => !listedBackwards(m))
      .map(m => [`${m.startRow}:${m.startCol}:${m.endRow}:${m.endCol}`, range(m.startRow, m.startCol, m.endRow, m.endCol)]));
    expect(kept.size, 'the core lists the other 172 matches forward').toBe(172);
    const inside = (ranges: readonly Range[] | undefined, label: string) => {
      for (const r of ranges ?? []) {
        expect(backwards(r), `${label}: ${JSON.stringify(r)} ends before it starts`).toBe(false);
        expect(r.end.absoluteRow - r.start.absoluteRow, `${label}: ${JSON.stringify(r)} spans rows outside its match`).toBeLessThanOrEqual(1);
      }
    };
    const search = searchOf(term);
    search.find('needle');
    for (let i = 0; i < 1000 && search.state.partial; i++) {
      frame();
      inside(all(term), `frame ${i}, all matches`);
      inside(active(term), `frame ${i}, active`);
    }
    expect(search.state, 'find keeps the 172 matches the core lists forward').toEqual({ index: 1, total: 172, partial: false });
    const byStart = (ranges: readonly Range[]) => [...ranges].sort((a, b) => a.start.absoluteRow - b.start.absoluteRow || a.start.col - b.start.col);
    const painted = all(term)!;
    expect(byStart(painted), 'the all-matches layer holds each of them').toEqual(byStart([...kept.values()]));
    for (const r of painted) expect(term.getRangeText(r), JSON.stringify(r)).toBe('needle');
    for (const direction of ['older', 'newer'] as const) {
      for (let i = 0; i < kept.size; i++) {
        search.step('needle', direction);
        inside(active(term), `${direction} step ${i}`);
        expect(activeText(term), `${direction} step ${i}`).toBe('needle');
      }
    }
  });
});
