import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { GhosttyVt, VtCells, VtTerminal } from '../vt/ghosttyVt';
import { terminalInternals } from '../vt/internal';
import { selectionInternals } from './internal';
import type { SelectionManager } from './selection-manager';
import { Terminal } from './terminal';
import { CanvasRenderer } from './renderer';

type Anchor = { col: number; absoluteRow: number };
type Range = { start: Anchor; end: Anchor };
// Structural signatures let these checks compile against a widget without the API.
type SelectionAPI = {
  setSelection(range: Range | null): void;
  getSelectionRange(): Range | null;
  getScrollbackText(): string;
  getRangeText(range: Range): string;
  cellAt(x: number, y: number): { col: number; row: number; absoluteRow: number } | null;
};

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
  delete (navigator as { clipboard?: unknown }).clipboard;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function create(cols = 20, rows = 4, copy?: (text: string) => void, joinDrawnWraps?: () => boolean) {
  const ghostty = new GhosttyVt(await WebAssembly.instantiate(module, {}));
  const options = { ghostty, cols, rows, copy, joinDrawnWraps, scrollback: 100, cursorBlink: false, smoothScrollDuration: 0 };
  const term = new Terminal(options) as Terminal & SelectionAPI;
  terminals.push(term);
  return term;
}

async function open(input: string, cols = 20, rows = 4, copy?: (text: string) => void, joinDrawnWraps?: () => boolean) {
  const term = await create(cols, rows, copy, joinDrawnWraps);
  const host = document.createElement('div');
  document.body.append(host);
  term.open(host);
  const canvas = host.querySelector('canvas')!;
  const captured = new Set<number>();
  Object.assign(canvas, {
    setPointerCapture: (id: number) => captured.add(id),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => captured.delete(id),
  });
  const { width, height } = term.renderer!.getMetrics();
  const rect = vi.spyOn(canvas, 'getBoundingClientRect').mockImplementation(() => new DOMRect(53, 37, cols * width, rows * height));
  const clipboard = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } });
  term.write(input);
  const at = (col: number, row: number) => ({ clientX: 53 + col * width + 1, clientY: 37 + row * height + 1 });
  function pointer(type: string, col: number, row: number) {
    canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, isPrimary: true, pointerId: 7, pointerType: 'mouse',
      button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, ...at(col, row),
    }));
  }
  return {
    term, host, canvas, clipboard, rect, width, height, at, pointer,
    click(detail: number, col: number, row: number) {
      canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, detail, ...at(col, row) }));
    },
  };
}

const range = (a: number, b: number, c: number, d: number): Range => ({ start: { col: a, absoluteRow: b }, end: { col: c, absoluteRow: d } });

function trackedCells(term: Terminal) {
  return terminalInternals(term.wasmTerm!).trackedCells;
}

// The core prunes whole pages. Detect the real boundary instead of assuming
// the configured row limit is also a page boundary.
async function selectionAtPrune(select: (term: Terminal, last: number) => void) {
  const fixture = await open('', 80, 6);
  const { term } = fixture;
  for (let line = 0; line < 5000; line++) {
    const before = term.getScrollbackLength();
    if (before > 40) select(term, before + term.rows - 2);
    term.write(`line ${line}\r\n`);
    const after = term.getScrollbackLength();
    if (after < before) {
      expect(before - after, 'the fixture discarded multiple old rows').toBeGreaterThan(2);
      const first = term.buffer.active.getLine(0)!.translateToString(true);
      const firstLine = Number(/^line (\d+)$/.exec(first)![1]);
      expect(firstLine).toBeGreaterThan(0);
      return { ...fixture, line, firstLine };
    }
  }
  throw new Error('the bounded real-core fixture never pruned history');
}

describe('tracked selection lifetime', () => {
  test('selectAll survives history pruning without selecting later output', async () => {
    const { term, line, firstLine } = await selectionAtPrune((term) => term.selectAll());
    // Select All includes the blank cursor row, which the next write fills.
    const expected = Array.from({ length: line - firstLine + 1 }, (_, i) => `line ${firstLine + i}`).join('\n');
    expect(term.getSelection()).toBe(expected);
    expect(term.hasSelection()).toBe(true);
    expect(term.getSelectionRange()!.start).toEqual({ col: 0, absoluteRow: 0 });
    term.write('later output\r\n');
    expect(term.getSelection()).toBe(expected);
  });

  test.each([false, true])('a pruned earlier endpoint clamps while the later endpoint survives (reverse %s)', async (reverse) => {
    const { term, line, firstLine } = await selectionAtPrune((term, last) => {
      const selected = range(3, 0, 79, last);
      term.setSelection(reverse ? { start: selected.end, end: selected.start } : selected);
    });
    const expected = Array.from({ length: line - firstLine }, (_, i) => `line ${firstLine + i}`).join('\n');
    expect(term.getSelection()).toBe(expected);
    const selected = term.getSelectionRange()!;
    expect(reverse ? selected.end : selected.start).toEqual({ col: 0, absoluteRow: 0 });
    expect(reverse ? selected.start : selected.end).toEqual({ col: 79, absoluteRow: line - firstLine - 1 });
    expect(trackedCells(term).size).toBe(2);
  });

  test('pruning the later endpoint clears the selection and releases both references', async () => {
    const { term } = await selectionAtPrune((term) => term.setSelection(range(0, 0, 4, 1)));
    expect(term.hasSelection()).toBe(false);
    expect(term.getSelectionRange()).toBeNull();
    expect(term.getSelection()).toBe('');
    expect(trackedCells(term).size).toBe(0);
  });

  test('narrowing and widening reflow preserve the selected text and endpoint columns', async () => {
    const { term } = await open('0123456789abcdefghijklmnopqrstuvwxyz', 20, 6);
    term.setSelection(range(2, 0, 7, 1));
    const expected = '23456789abcdefghijklmnopqr';
    expect(term.getSelection()).toBe(expected);
    term.resize(12, 6);
    expect(term.getSelection()).toBe(expected);
    expect(term.getSelectionRange()).toEqual(range(2, 0, 3, 2));
    term.resize(40, 6);
    expect(term.getSelection()).toBe(expected);
    expect(term.getSelectionRange()).toEqual(range(2, 0, 27, 0));
  });

  test('a pointer selection follows scrolling output and reflow', async () => {
    const { term, pointer } = await open('hello world', 20, 4);
    pointer('pointerdown', 6, 0);
    pointer('pointermove', 10, 0);
    pointer('pointerup', 10, 0);
    term.write('\r\none\r\ntwo\r\nthree\r\nfour');
    expect(term.getScrollbackLength()).toBeGreaterThan(0);
    expect(term.getSelection()).toBe('world');
    term.resize(8, 4);
    expect(term.getSelection()).toBe('world');
    expect(term.getSelectionRange()).toEqual(range(6, 0, 2, 1));
  });

  test.each([47, 1047, 1049])('screen mode %s clears selections in both directions before change observers', async (mode) => {
    const { term } = await open('normal');
    term.selectAll();
    const observations: Array<Range | null> = [];
    term.onChange(() => observations.push(term.getSelectionRange()));
    term.write(`\x1b[?${mode}h`);
    expect(term.wasmTerm!.isAlternateScreen()).toBe(true);
    expect(term.getSelectionRange()).toBeNull();
    expect(trackedCells(term).size).toBe(0);
    term.write('alternate');
    term.selectAll();
    term.write(`\x1b[?${mode}l`);
    expect(term.wasmTerm!.isAlternateScreen()).toBe(false);
    expect(term.getSelectionRange()).toBeNull();
    expect(trackedCells(term).size).toBe(0);
    expect(observations).toEqual([null, null, null]);
  });

  test('a screen round trip within one write preserves the normal-screen selection', async () => {
    const { term } = await open('normal');
    term.selectAll();
    const selected = term.getSelectionRange();
    const text = term.getSelection();
    expect(text).toBe('normal');
    term.write('\x1b[?1049halternate\x1b[?1049l');
    expect(term.wasmTerm!.isAlternateScreen()).toBe(false);
    // The normal-screen cells remain valid and hold the same text. A
    // screen switch observed between writes still clears the selection.
    expect(term.getSelectionRange()).toEqual(selected);
    expect(term.getSelection()).toBe(text);
  });

  test('replacement and repeated select/clear keep exactly two live references or none', async () => {
    const { term } = await open('hello world');
    const tracked = trackedCells(term);
    expect(tracked.size).toBe(0);
    for (let i = 0; i < 25; i++) {
      term.selectAll();
      expect(tracked.size).toBe(2);
      const previous = [...tracked];
      term.setSelection(range(1, 0, 3, 0));
      expect(previous.map((cell) => cell.point())).toEqual([null, null]);
      expect(tracked.size).toBe(2);
      term.clearSelection();
      expect(tracked.size).toBe(0);
    }
  });

  test('dispose releases the selection before the core is freed', async () => {
    const { term } = await open('hello');
    term.selectAll();
    const tracked = trackedCells(term);
    expect(tracked.size).toBe(2);
    const core = term.wasmTerm!;
    const free = core.free.bind(core);
    let atFree = -1;
    vi.spyOn(core, 'free').mockImplementation(() => { atFree = tracked.size; free(); });
    term.dispose();
    expect(atFree).toBe(0);
    expect(tracked.size).toBe(0);
  });

  test('a failed open releases selections made during initial rendering', async () => {
    const term = await create();
    const host = document.createElement('div');
    document.body.append(host);
    let selected = -1;
    let atFree = -1;
    vi.spyOn(CanvasRenderer.prototype, 'render').mockImplementationOnce(() => {
      term.selectAll();
      const core = term.wasmTerm!;
      const tracked = trackedCells(term);
      selected = tracked.size;
      const free = core.free.bind(core);
      vi.spyOn(core, 'free').mockImplementation(() => { atFree = tracked.size; free(); });
      throw new Error('initial render failed');
    });
    expect(() => term.open(host)).toThrow('initial render failed');
    expect(selected).toBe(2);
    expect(atFree).toBe(0);
    expect(term.getSelectionRange()).toBeNull();
  });

  test('find writes replace tracked endpoints, follow reflow and release on direct clear', async () => {
    const { term } = await open('0123456789abcdefghijklmnopqrstuvwxyz', 20, 6);
    term.selectAll();
    const tracked = trackedCells(term);
    const previous = [...tracked];
    const manager = selectionInternals((term as unknown as { selectionManager: SelectionManager }).selectionManager);
    manager.start = { col: 2, absoluteRow: 0 };
    manager.end = { col: 7, absoluteRow: 1 };
    expect(term.getSelection()).toBe('23456789abcdefghijklmnopqr');
    term.resize(12, 6);
    expect(term.getSelection()).toBe('23456789abcdefghijklmnopqr');
    expect(manager.end).toEqual({ col: 3, absoluteRow: 2 });
    expect(previous.map((cell) => cell.point())).toEqual([null, null]);
    expect(tracked.size).toBe(2);
    manager.start = null;
    manager.end = null;
    expect(term.getSelectionRange()).toBeNull();
    expect(tracked.size).toBe(0);
  });
});

describe('public selection ranges', () => {
  test('ranges are inclusive, reversible snapshots and programmatic changes never copy', async () => {
    const copy = vi.fn();
    const { term, clipboard } = await open('hello world\r\nsecond row', 20, 4, copy);
    expect(term.getSelectionRange()).toBeNull();
    const selected = range(3, 0, 1, 0);
    term.setSelection(selected);
    selected.start.col = 8;
    expect(term.getSelection()).toBe('ell');
    const snapshot = term.getSelectionRange()!;
    expect(snapshot).toEqual(range(3, 0, 1, 0));
    snapshot.end.absoluteRow = 3;
    expect(term.getSelectionRange()).toEqual(range(3, 0, 1, 0));
    term.setSelection(null);
    expect(term.getSelectionRange()).toBeNull();
    expect(term.hasSelection()).toBe(false);
    expect(term.getSelection()).toBe('');
    expect(copy).not.toHaveBeenCalled();
    expect(clipboard).not.toHaveBeenCalled();
  });

  test.each([NaN, Infinity, -Infinity, 0.5])('rejects %s in each endpoint component without changing the selection', async (invalid) => {
    const { term } = await open('hello');
    term.setSelection(range(0, 0, 4, 0));
    for (const endpoint of ['start', 'end'] as const) {
      for (const coordinate of ['col', 'absoluteRow'] as const) {
        const bad = range(0, 0, 4, 0);
        bad[endpoint][coordinate] = invalid;
        expect(() => term.setSelection(bad)).toThrow(RangeError);
        expect(term.getSelection()).toBe('hello');
      }
    }
  });

  test('clamps integer coordinates and clears ranges wholly beyond retained rows', async () => {
    const { term } = await open('hello\r\nworld');
    term.setSelection(range(-5, -2, 99, 99));
    expect(term.getSelectionRange()).toEqual(range(0, 0, 19, 3));
    expect(term.getSelection()).toBe('hello\nworld');
    term.setSelection(range(0, 10, 19, 11));
    expect(term.hasSelection()).toBe(false);
    term.selectAll();
    term.setSelection(range(0, -3, 19, -1));
    expect(term.getSelectionRange()).toBeNull();
  });

  test('selectAll includes history and screen regardless of viewport', async () => {
    const text = Array.from({ length: 12 }, (_, i) => `row ${i}`).join('\r\n');
    const { term } = await open(text);
    expect(term.getScrollbackLength()).toBe(8);
    term.viewport.scrollTo(3.5);
    term.selectAll();
    expect(term.getSelection()).toBe(text.replaceAll('\r\n', '\n'));
    expect(term.getSelectionRange()).toEqual(range(0, 0, 19, 11));
    term.viewport.scrollToBottom();
    expect(term.getSelection()).toBe(text.replaceAll('\r\n', '\n'));
  });

  test('select takes viewport rows, with history and with the view scrolled back', async () => {
    const text = Array.from({ length: 12 }, (_, i) => `row ${i}`).join('\r\n');
    const { term } = await open(text);
    expect(term.getScrollbackLength()).toBe(8);
    term.select(0, 1, 5);
    expect(term.getSelectionRange()).toEqual(range(0, 9, 4, 9));
    expect(term.getSelection()).toBe('row 9');
    term.viewport.scrollTo(3.5);
    // A length past the last column carries into the next viewport row.
    term.select(4, 0, 18);
    expect(term.getSelectionRange()).toEqual(range(4, 5, 1, 6));
    expect(term.getSelection()).toBe('5\nro');
    term.selectLines(0, 0);
    expect(term.getSelectionRange(), 'selectLines names the same row').toEqual(range(0, 5, 19, 5));
  });

  test.each([1, 2])('widens either half (%s) of a wide glyph and preserves clusters', async (col) => {
    const { term } = await open('a界e\u0301👩‍💻z');
    term.setSelection(range(col, 0, col, 0));
    expect(term.getSelectionRange()).toEqual(range(1, 0, 2, 0));
    expect(term.getSelection()).toBe('界');
    term.setSelection(range(5, 0, 1, 0));
    expect(term.getSelectionRange()).toEqual(range(5, 0, 1, 0));
    expect(term.getSelection()).toBe('界e\u0301👩‍💻');
  });

  test('wraps, wide cells and invisible-copy filtering apply to a pointer selection', async () => {
    const { term, pointer, clipboard } = await open('ab界e\u0301👩‍💻xyz\x7fq', 10, 4);
    expect(term.wasmTerm!.isRowWrapped(1)).toBe(true);
    pointer('pointerdown', 0, 0);
    pointer('pointermove', 9, 1);
    pointer('pointerup', 9, 1);
    expect(term.getSelection()).toBe('ab界e\u0301👩‍💻xyzq');
    expect(clipboard).toHaveBeenCalledExactlyOnceWith('ab界e\u0301👩‍💻xyzq');
  });

  test('idle paints do not read a selection\'s endpoint rows again, and a write refreshes them', async () => {
    const text = Array.from({ length: 12 }, (_, i) => `row ${i}`).join('\r\n');
    const { term } = await open(text);
    expect(term.getScrollbackLength()).toBe(8);
    // Both endpoints in history above the view: a paint draws no selected row.
    term.setSelection(range(1, 1, 3, 5));
    const paint = () => term.renderer!.render(term.wasmTerm!, false, term.viewport.offset, 0);
    paint();
    const fill = vi.spyOn(VtCells.prototype, 'fill');
    for (let i = 0; i < 5; i++) paint();
    expect(fill, 'row reads from the core in five idle paints').toHaveBeenCalledTimes(0);
    expect(term.getSelectionRange()).toEqual(range(1, 1, 3, 5));
    expect(fill).toHaveBeenCalledTimes(0);
    // Output changes what the endpoint cells may hold: the next read is fresh.
    term.write('\x1b[4;1Hmore');
    expect(term.getSelectionRange()).toEqual(range(1, 1, 3, 5));
    const endpointReads = () => fill.mock.calls.filter(([, history, row]) => history && (row === 1 || row === 5)).length;
    expect(endpointReads()).toBe(2);
    for (let i = 0; i < 5; i++) paint();
    expect(endpointReads()).toBe(2);
  });

  test('widening follows a glyph written under an endpoint after the range was read', async () => {
    const { term } = await open('abcdef');
    term.setSelection(range(1, 0, 4, 0));
    expect(term.getSelectionRange()).toEqual(range(1, 0, 4, 0));
    term.write('\x1b[1;4H\u754c');
    expect(term.getSelectionRange(), 'the end is the wide glyph\'s first half').toEqual(range(1, 0, 4, 0));
    term.setSelection(range(1, 0, 3, 0));
    expect(term.getSelectionRange()).toEqual(range(1, 0, 4, 0));
    term.write('\x1b[1;1H\u754c');
    expect(term.getSelectionRange(), 'the start is the wide glyph\'s second half').toEqual(range(0, 0, 4, 0));
    expect(term.getSelection()).toBe('\u754cc\u754c');
  });

  test('selection replacement and clear invalidate the old visible rows', async () => {
    const { term } = await open('first\r\nsecond\r\nthird');
    const manager = (term as unknown as { selectionManager: { getDirtySelectionRows(): Set<number>; clearDirtySelectionRows(): void } }).selectionManager;
    term.setSelection(range(0, 0, 3, 1));
    manager.clearDirtySelectionRows();
    term.setSelection(range(0, 2, 4, 2));
    expect([...manager.getDirtySelectionRows()]).toEqual([0, 1]);
    manager.clearDirtySelectionRows();
    term.clearSelection();
    expect([...manager.getDirtySelectionRows()]).toEqual([2]);
  });

  test('clearing a pending press also clears its unpainted anchors', async () => {
    const { term, pointer, clipboard } = await open('hello');
    pointer('pointerdown', 1, 0);
    term.setSelection(null);
    expect(term.getSelectionRange()).toBeNull();
    pointer('pointerup', 1, 0);
    expect(term.getSelection()).toBe('');
    expect(clipboard).not.toHaveBeenCalled();
  });

  test('find can still write and read plain anchors that paint and format', async () => {
    const { term } = await open('hello');
    const manager = (term as unknown as { selectionManager: SelectionManager }).selectionManager;
    const endpoints = selectionInternals(manager);
    endpoints.start = { col: 1, absoluteRow: 0 };
    endpoints.end = { col: 3, absoluteRow: 0 };
    expect(endpoints.start).toEqual({ col: 1, absoluteRow: 0 });
    expect(manager.getSelectionCoords()).toEqual({ startCol: 1, startRow: 0, endCol: 3, endRow: 0 });
    expect(term.getSelection()).toBe('ell');
  });
});

describe('copy operations and click extents', () => {
  test('release, explicit copy, double and triple click use the same callback', async () => {
    const copy = vi.fn();
    const { term, pointer, click, clipboard } = await open('hello world', 20, 4, copy);
    pointer('pointerdown', 0, 0);
    pointer('pointermove', 4, 0);
    pointer('pointerup', 4, 0);
    expect(copy).toHaveBeenCalledExactlyOnceWith('hello');
    expect(term.copySelection()).toBe(true);
    click(2, 7, 0);
    click(3, 7, 0);
    expect(copy.mock.calls.map(([text]) => text)).toEqual(['hello', 'hello', 'world', 'hello world']);
    expect(clipboard).not.toHaveBeenCalled();
    term.clearSelection();
    expect(term.copySelection()).toBe(false);
    term.setSelection(range(0, 3, 19, 3));
    expect(term.copySelection()).toBe(false);
  });

  test.each([2, 3])('click %s crosses a true wrap at the history/screen boundary', async (detail) => {
    const copy = vi.fn();
    const command = '$ cat /var/log/messages.1';
    const { term, click } = await open(`${command}\r\nok`, 20, 2, copy);
    expect(term.getScrollbackLength()).toBe(1);
    expect(term.wasmTerm!.isRowWrapped(0)).toBe(true);
    click(detail, 1, 0);
    expect(term.getSelection()).toBe(detail === 2 ? '/var/log/messages.1' : command);
    expect(copy).toHaveBeenCalledExactlyOnceWith(term.getSelection());
  });

  test('scrollback text uses the current policy without changing selection or copying', async () => {
    let drawn = true;
    const policy = vi.fn(() => drawn);
    const copy = vi.fn();
    const { term } = await open('abcdefghij\r\nklmnop\r\nlast', 10, 2, copy, policy);
    term.setSelection(range(0, 2, 3, 2));
    expect(term.getScrollbackText()).toBe('abcdefghijklmnop\nlast');
    expect(policy).toHaveBeenCalledTimes(1);
    drawn = false;
    expect(term.getScrollbackText()).toBe('abcdefghij\nklmnop\nlast');
    expect(term.getSelectionRange()).toEqual(range(0, 2, 3, 2));
    expect(copy).not.toHaveBeenCalled();
  });

  test('scrollback text is one core read that joins a wrapped command and leaves out what is not drawn', async () => {
    const { term } = await open('$ ab\x7fcdefghijkl\r\nnext', 10, 4);
    const plainText = vi.spyOn(VtTerminal.prototype, 'plainText');
    const rows = [vi.spyOn(VtTerminal.prototype, 'readRow'), vi.spyOn(VtTerminal.prototype, 'readHistoryRow')];
    expect(term.getScrollbackText()).toBe('$ abcdefghijkl\nnext');
    expect(plainText).toHaveBeenCalledTimes(1);
    for (const read of rows) expect(read).not.toHaveBeenCalled();
  });

  test('a range reads as its selection would, without selecting or copying', async () => {
    let drawn = false;
    const copy = vi.fn();
    const rows = ['abcdefghij', 'klmnop', 'a界b', 'x\x7fy', '0123456789ABCD'];
    const { term, clipboard } = await open(rows.join('\r\n'), 10, 3, copy, () => drawn);
    expect(term.getScrollbackLength()).toBe(3);
    const users = range(0, 5, 3, 5);
    term.setSelection(users);
    const cases: Array<[Range, string]> = [
      [range(2, 0, 4, 0), 'cde'],
      // Either direction, from history into the screen.
      [range(1, 1, 8, 0), 'ij\nkl'],
      // Either half of a wide glyph reads the whole glyph.
      [range(2, 2, 2, 2), '界'],
      [range(1, 2, 1, 2), '界'],
      // An undrawn control is filtered and a core soft wrap joins.
      [range(0, 3, 2, 3), 'xy'],
      [range(8, 4, 1, 5), '89AB'],
      // Columns and rows clamp to the retained grid.
      [range(-4, 4, 99, 99), '0123456789ABCD'],
    ];
    for (const [read, text] of cases) {
      expect(term.getRangeText(read), JSON.stringify(read)).toBe(text);
      term.setSelection(read);
      expect(term.getSelection(), 'the same text as a selection of it').toBe(text);
      term.setSelection(users);
    }
    expect(term.getRangeText(range(0, 0, 9, 1))).toBe('abcdefghij\nklmnop');
    drawn = true;
    expect(term.getRangeText(range(0, 0, 9, 1)), 'the drawn-wrap policy is asked at each read').toBe('abcdefghijklmnop');
    expect(term.getRangeText(range(0, 40, 9, 41)), 'wholly beyond the retained rows').toBe('');
    expect(term.getRangeText(range(0, -3, 9, -1))).toBe('');
    for (const invalid of [NaN, Infinity, 0.5]) {
      expect(() => term.getRangeText(range(0, 0, invalid, 0))).toThrow(RangeError);
      expect(() => term.getRangeText(range(0, invalid, 3, 0))).toThrow(RangeError);
    }
    expect(term.getSelectionRange()).toEqual(users);
    expect(copy).not.toHaveBeenCalled();
    expect(clipboard).not.toHaveBeenCalled();
  });

  test('the range reader takes the row fallback when the core cannot format', async () => {
    const { term } = await open('ab界e\u0301👩‍💻xyz\x7fq', 10, 4);
    vi.spyOn(term.wasmTerm!, 'plainText').mockReturnValue(null);
    expect(term.getRangeText(range(1, 0, 9, 1))).toBe('b界e\u0301👩‍💻xyzq');
  });

  test('the policy changes word and line extents and explicit copies after open', async () => {
    let drawn = true;
    const copy = vi.fn();
    const { term, click } = await open('abcdefghij\r\nklmnop', 10, 4, copy, () => drawn);
    click(2, 2, 1);
    expect(term.getSelection()).toBe('abcdefghijklmnop');
    drawn = false;
    expect(term.copySelection()).toBe(true);
    expect(copy).toHaveBeenLastCalledWith('abcdefghij\nklmnop');
    click(2, 2, 1);
    expect(term.getSelection()).toBe('klmnop');
    drawn = true;
    click(3, 2, 1);
    expect(term.getSelection()).toBe('abcdefghijklmnop');
    drawn = false;
    click(3, 2, 0);
    expect(term.getSelection()).toBe('abcdefghij');
  });

  test('the row fallback keeps complete clusters, soft wraps and copy filtering', async () => {
    const { term } = await open('ab界e\u0301👩‍💻xyz\x7fq', 10, 4);
    term.selectAll();
    vi.spyOn(term.wasmTerm!, 'plainText').mockReturnValue(null);
    expect(term.getSelection()).toBe('ab界e\u0301👩‍💻xyzq');
    expect(term.getScrollbackText()).toBe('ab界e\u0301👩‍💻xyzq');
  });

  test('all text readers filter undrawn controls but preserve visible cluster parts', async () => {
    const { term } = await open('x\x7fe\u0301👩‍💻\ue0b0');
    term.selectAll();
    expect(term.getSelection()).toBe('xe\u0301👩‍💻\ue0b0');
    expect(term.getScrollbackText()).toBe('xe\u0301👩‍💻\ue0b0');
  });
});

describe('hit testing and lifetime', () => {
  test('client CSS coordinates ignore backing scale and use the floored viewport', async () => {
    const { term, canvas, at } = await open(Array.from({ length: 12 }, (_, i) => `row ${i}`).join('\r\n'));
    term.viewport.scrollTo(3.5);
    canvas.width *= 2;
    canvas.height *= 2;
    const p = at(1, 2);
    expect(term.cellAt(p.clientX, p.clientY)).toEqual({ col: 1, row: 2, absoluteRow: 7 });
    expect(term.cellAt(-100, -100)).toEqual({ col: 0, row: 0, absoluteRow: 5 });
    expect(term.cellAt(9999, 9999)).toEqual({ col: 19, row: 3, absoluteRow: 8 });
  });

  test('unavailable or invalid geometry returns null', async () => {
    const { term, host, rect } = await open('hello');
    expect(term.cellAt(NaN, 0)).toBeNull();
    expect(term.cellAt(0, Infinity)).toBeNull();
    rect.mockReturnValue(new DOMRect(0, 0, 0, 0));
    expect(term.cellAt(0, 0)).toBeNull();
    host.remove();
    expect(term.cellAt(0, 0)).toBeNull();
  });

  test.each(['before open', 'after dispose'])('selection operations are inert %s', async (state) => {
    const term = await create();
    if (state === 'after dispose') {
      const host = document.createElement('div');
      document.body.append(host);
      term.open(host);
      term.write('hello');
      term.selectAll();
      term.dispose();
    }
    term.setSelection(range(NaN, 0, 3, 0));
    term.selectAll();
    term.clearSelection();
    expect(term.getSelection()).toBe('');
    expect(term.getSelectionRange()).toBeNull();
    expect(term.hasSelection()).toBe(false);
    expect(term.copySelection()).toBe(false);
    expect(term.getScrollbackText()).toBe('');
    expect(term.getRangeText(range(0, 0, 4, 0))).toBe('');
    expect(term.getRangeText(range(NaN, 0, 4, 0))).toBe('');
    expect(term.cellAt(1, 1)).toBeNull();
  });
});
