import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { GhosttyVt, VtCells, VtSearch, VtTerminal, VtTrackedCell } from '../vt/ghosttyVt';
import { Terminal } from './terminal';

// A structural contract keeps the same test runnable on the pre-facade widget.
type Core = Readonly<Pick<VtTerminal, 'beforeResize' | 'cols' | 'getScrollbackLength' | 'getDimensions' |
  'plainText' | 'readRow' | 'readHistoryRow' | 'isRowWrapped' | 'isScrollbackRowWrapped' | 'encodePaste'>> & {
  createSearch(): Readonly<Pick<VtSearch, keyof VtSearch>>;
  trackCell(row: number, col: number): Readonly<Pick<VtTrackedCell, keyof VtTrackedCell>> | null;
};
const members = ['beforeResize', 'createSearch', 'trackCell', 'cols', 'getScrollbackLength', 'getDimensions',
  'plainText', 'readRow', 'readHistoryRow', 'isRowWrapped', 'isScrollbackRowWrapped', 'encodePaste'];
const searchMembers = ['setNeedle', 'restart', 'step', 'feed', 'selectNext', 'selectPrev', 'caughtUp',
  'state', 'matchesBetween', 'indexOfMatchAt', 'free', 'completingUnitMs'];
let module: WebAssembly.Module;
const terminals: Terminal[] = [];

beforeAll(async () => {
  module = await WebAssembly.compile(readFileSync('vendor/ghostty-vt/ghostty-vt.wasm'));
});
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => new Proxy({}, {
    get: (_, key) => key === 'measureText'
      ? () => ({ width: 8, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 4 })
      : () => undefined,
    set: () => true,
  })) as never);
});
afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function unopened() {
  const ghostty = new GhosttyVt(await WebAssembly.instantiate(module, {}));
  const create = vi.spyOn(ghostty, 'createTerminal');
  const term = new Terminal({ ghostty, cols: 10, rows: 3, scrollback: 100, cursorBlink: false, smoothScrollDuration: 0 });
  terminals.push(term);
  const host = document.createElement('div');
  document.body.append(host);
  return { term, host, create };
}
async function open() {
  const rig = await unopened();
  rig.term.open(rig.host);
  return rig;
}
function coreOf(term: Terminal): Core | undefined {
  return (term as Terminal & { readonly core?: Core }).core;
}
function core(term: Terminal): Core {
  const value = coreOf(term);
  expect(value, 'open widget exposes a core facade').toBeDefined();
  return value!;
}
function text(cells: VtCells): string {
  return Array.from({ length: cells.length }, (_, x) => {
    const cell = cells.at(x)!;
    return cell.cluster ?? (cell.codepoint ? String.fromCodePoint(cell.codepoint) : ' ');
  }).join('').trimEnd();
}

describe('the widget core facade', () => {
  test('fixture drives the real core through the widget', async () => {
    const { term } = await open();
    term.write('real core');
    expect(term.getScrollbackText()).toBe('real core');
  });

  test('exists only while open and is one object through writes, resizes and VT reset', async () => {
    const { term, host, create } = await unopened();
    expect(coreOf(term)).toBeUndefined();
    term.open(host);
    const saved = core(term);
    term.write('before');
    term.resize(12, 4);
    term.write('\x1bcafter');
    expect(coreOf(term)).toBe(saved);
    expect(saved.plainText()).toBe('after');
    expect(saved.getDimensions()).toEqual({ cols: 12, rows: 4 });
    expect(create).toHaveBeenCalledTimes(1);
    expect('reset' in term).toBe(false);
    term.dispose();
    expect(coreOf(term)).toBeUndefined();
    expect(() => term.open(host)).toThrow('disposed');
  });

  test('exposes exactly the frozen readers and allocators, without a raw core', async () => {
    const { term, create } = await open();
    const saved = core(term);
    expect(saved).not.toBe(create.mock.results[0].value);
    expect(saved).not.toBeInstanceOf(VtTerminal);
    expect(Reflect.ownKeys(saved).sort()).toEqual([...members].sort());
    expect(Object.isFrozen(saved)).toBe(true);
    for (const name of ['write', 'resize', 'free', 'setColors', 'beginFrame', 'endFrame', 'readResponse', 'wasm', 'handle']) {
      expect(name in saved, name).toBe(false);
    }
    expect(Reflect.set(saved, 'cols', 900)).toBe(false);
    expect(Reflect.set(saved, 'plainText', () => 'forged')).toBe(false);
    expect(term.cols).toBe(10);
  });

  test('forwards dimensions, rows, formatter ranges and wrap flags without consuming paint dirtiness', async () => {
    const { term } = await open();
    const saved = core(term);
    term.write('ABCDEFGHIJKL\r\nsecond\r\nthird\r\nfourth');
    expect(saved.cols).toBe(10);
    expect(saved.getDimensions()).toEqual({ cols: 10, rows: 3 });
    const dimensions = saved.getDimensions();
    dimensions.cols = 90;
    expect(saved.cols).toBe(10);
    expect(saved.getScrollbackLength()).toBe(2);
    expect(saved.plainText()).toBe('ABCDEFGHIJKL\nsecond\nthird\nfourth');
    expect(saved.plainText({ startRow: 0, startCol: 2, endRow: 1, endCol: 1 })).toBe('CDEFGHIJKL');
    const cells = new VtCells();
    const fill = vi.spyOn(cells, 'fill');
    expect(saved.readHistoryRow(0, cells)).toBe(true);
    expect(fill.mock.calls[0][0]).not.toBeInstanceOf(VtTerminal);
    expect(Object.keys(fill.mock.calls[0][0])).toEqual([]);
    expect(text(cells)).toBe('ABCDEFGHIJ');
    expect(saved.isScrollbackRowWrapped(1)).toBe(true);
    expect(saved.readRow(1, cells)).toBe(true);
    expect(text(cells)).toBe('third');
    cells.at(0)!.codepoint = 88;
    expect(saved.readRow(1, cells)).toBe(true);
    expect(text(cells)).toBe('third');
    expect(saved.isRowWrapped(1)).toBe(false);
    expect(saved.readRow(30, cells)).toBe(false);
    expect(saved.readHistoryRow(30, cells)).toBe(false);
    const paint = vi.fn();
    term.addPaintLayer({ order: 0, paint });
    term.refresh();
    paint.mockClear();
    term.write('!');
    saved.readRow(2, cells);
    saved.readHistoryRow(0, cells);
    saved.plainText();
    // Package-local observation distinguishes a reader from endFrame().
    expect(term.wasmTerm!.beginFrame()).not.toBe(0);
  });

  test('resize subscribers see the old grid and can stop independently', async () => {
    const { term } = await open();
    const saved = core(term);
    const observed: unknown[] = [];
    const stop = saved.beforeResize(from => observed.push({ from, size: saved.getDimensions(), cols: saved.cols }));
    term.resize(14, 4);
    expect(observed).toEqual([{ from: { cols: 10, rows: 3 }, size: { cols: 10, rows: 3 }, cols: 10 }]);
    expect(saved.cols).toBe(14);
    stop();
    stop();
    term.resize(15, 4);
    expect(observed).toHaveLength(1);
    term.dispose();
    expect(stop).not.toThrow();
  });

  test('paste encoding preserves bracket framing while sanitizing a pasted end marker', async () => {
    const { term } = await open();
    const saved = core(term);
    const sent: string[] = [];
    term.onData(data => sent.push(data));
    term.write('\x1b[?2004h');
    term.input(saved.encodePaste('a\x1b[201~b'), true);
    expect(sent).toEqual(['\x1b[200~a [201~b\x1b[201~']);
    term.write('\x1b[?2004l');
    expect(saved.encodePaste('a\x00b')).toBe('a b');
  });

  test('search handles forward incremental scans without changing widget selection or viewport', async () => {
    const { term } = await open();
    const saved = core(term);
    term.write('needle\r\nother\r\nneedle\r\nlast');
    term.setSelection({ start: { absoluteRow: 1, col: 0 }, end: { absoluteRow: 1, col: 4 } });
    term.viewport.scrollTo(1);
    const before = { selection: term.getSelectionRange(), offset: term.viewport.offset };
    const search = saved.createSearch();
    expect(Reflect.ownKeys(search).sort()).toEqual([...searchMembers].sort());
    expect(Object.isFrozen(search)).toBe(true);
    expect(search).not.toBeInstanceOf(VtSearch);
    expect(Reflect.set(search, 'completingUnitMs', 900)).toBe(false);
    search.setNeedle('needle');
    for (let i = 0; i < 100 && search.step(10) !== 'complete'; i++);
    expect(search.caughtUp()).toBe(true);
    expect(search.state().total).toBe(2);
    expect(search.selectNext()).toBe(true);
    expect(search.state().active).toEqual({ startRow: 2, startCol: 0, endRow: 2, endCol: 5 });
    expect(search.indexOfMatchAt(2, 0)).toBe(0);
    expect(search.matchesBetween(0, 3, 20)).toHaveLength(2);
    expect(search.selectPrev()).toBe(true);
    expect(search.state().active?.startRow).toBe(0);
    search.restart();
    search.feed();
    for (let i = 0; i < 100 && search.step(10) !== 'complete'; i++);
    expect(search.state().total).toBe(2);
    expect(search.completingUnitMs).not.toBeNull();
    expect({ selection: term.getSelectionRange(), offset: term.viewport.offset }).toEqual(before);
    search.free();
    search.free();
    expect(search.state()).toEqual({ total: 0, index: null, active: null, complete: true });
  });

  test('tracked handles move only their own cell and follow widget writes and reflow', async () => {
    const { term } = await open();
    const saved = core(term);
    term.write('abcdefghij');
    const cell = saved.trackCell(0, 8)!;
    expect(cell).not.toBeNull();
    expect(Reflect.ownKeys(cell).sort()).toEqual(['free', 'moveTo', 'point']);
    expect(Object.isFrozen(cell)).toBe(true);
    expect(cell).not.toBeInstanceOf(VtTrackedCell);
    const snapshot = cell.point()!;
    snapshot.col = 0;
    expect(cell.point()).toEqual({ row: 0, col: 8 });
    term.resize(5, 3);
    expect(cell.point()).toEqual({ row: 1, col: 3 });
    expect(cell.moveTo(0, 1)).toBe(true);
    expect(cell.point()).toEqual({ row: 0, col: 1 });
    expect(cell.moveTo(-1, 0)).toBe(false);
    expect(saved.trackCell(-1, 0)).toBeNull();
    term.write('\r\nmore\r\nlast');
    expect(cell.point()).toEqual({ row: 0, col: 1 });
    cell.free();
    cell.free();
    expect(cell.point()).toBeNull();
    expect(cell.moveTo(0, 0)).toBe(false);
  });

  test.each(members)('retained facade member %s throws the same named error after dispose', async name => {
    const { term } = await open();
    const saved = core(term);
    term.dispose();
    const calls: Record<string, () => unknown> = {
      beforeResize: () => saved.beforeResize(() => {}), createSearch: () => saved.createSearch(),
      trackCell: () => saved.trackCell(0, 0), cols: () => saved.cols,
      getScrollbackLength: () => saved.getScrollbackLength(), getDimensions: () => saved.getDimensions(),
      plainText: () => saved.plainText(), readRow: () => saved.readRow(0, new VtCells()),
      readHistoryRow: () => saved.readHistoryRow(0, new VtCells()), isRowWrapped: () => saved.isRowWrapped(0),
      isScrollbackRowWrapped: () => saved.isScrollbackRowWrapped(0), encodePaste: () => saved.encodePaste('x'),
    };
    expect(calls[name]).toThrowError(expect.objectContaining({ name: 'TerminalCoreDisposedError' }));
  });

  test('dispose releases outstanding searches, cells and resize subscriptions exactly once', async () => {
    const { term, create } = await open();
    const saved = core(term);
    term.write('needle');
    const freeSearch = vi.spyOn(VtSearch.prototype, 'free');
    const freeCell = vi.spyOn(VtTrackedCell.prototype, 'free');
    const raw = create.mock.results[0].value as VtTerminal;
    const beforeResize = raw.beforeResize.bind(raw);
    const stops: ReturnType<typeof vi.fn>[] = [];
    vi.spyOn(raw, 'beforeResize').mockImplementation(listener => {
      const stop = vi.fn(beforeResize(listener));
      stops.push(stop);
      return stop;
    });
    const closed = saved.createSearch();
    const search = saved.createSearch();
    const cell = saved.trackCell(0, 0)!;
    const stop = saved.beforeResize(() => {});
    closed.free();
    expect(freeSearch).toHaveBeenCalledTimes(1);
    term.dispose();
    term.dispose();
    expect(freeSearch).toHaveBeenCalledTimes(2);
    expect(freeCell).toHaveBeenCalledTimes(1);
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(search.state()).toEqual({ total: 0, index: null, active: null, complete: true });
    expect(search.step(1)).toBe('complete');
    expect(search.selectNext()).toBe(false);
    expect(search.selectPrev()).toBe(false);
    expect(search.matchesBetween(0, 10, 10)).toEqual([]);
    expect(search.indexOfMatchAt(0, 0)).toBeNull();
    expect(search.caughtUp()).toBe(true);
    expect(search.completingUnitMs).toBeNull();
    search.setNeedle('ignored');
    search.restart();
    search.feed();
    expect(cell.point()).toBeNull();
    expect(cell.moveTo(0, 0)).toBe(false);
    search.free();
    closed.free();
    cell.free();
    stop();
    expect(freeSearch).toHaveBeenCalledTimes(2);
    expect(freeCell).toHaveBeenCalledTimes(1);
    expect(stops[0]).toHaveBeenCalledTimes(1);
  });

  test('failed open revokes its captured core and releases its handles', async () => {
    const { term, host } = await unopened();
    let captured: Core | undefined;
    let search: ReturnType<Core['createSearch']> | undefined;
    const free = vi.spyOn(VtSearch.prototype, 'free');
    vi.spyOn(host, 'appendChild').mockImplementation(() => {
      captured = core(term);
      search = captured.createSearch();
      throw new Error('canvas setup fails');
    });
    expect(() => term.open(host)).toThrow('canvas setup fails');
    expect(coreOf(term)).toBeUndefined();
    expect(() => captured!.plainText()).toThrowError(expect.objectContaining({ name: 'TerminalCoreDisposedError' }));
    expect(free).toHaveBeenCalledTimes(1);
    expect(search!.state().total).toBe(0);
  });

  test('the sole core takes the theme held before open without warnings', async () => {
    const { term, host, create } = await unopened();
    const warn = vi.spyOn(console, 'warn');
    const theme = { foreground: '#abcdef', background: '#203040' };
    term.options.theme = theme;
    term.open(host);
    const saved = core(term);
    term.write('x');
    const cells = new VtCells();
    expect(saved.readRow(0, cells)).toBe(true);
    expect(cells.at(0)?.fg).toBe(0xabcdef);
    expect(cells.at(0)?.bg).toBe(0x203040);
    expect(term.options.theme).toEqual(theme);
    expect(warn).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });
});
