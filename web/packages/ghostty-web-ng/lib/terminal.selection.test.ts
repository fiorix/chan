import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { GhosttyVt } from '../vt/ghosttyVt';
import { Terminal } from './terminal';

type Anchor = { col: number; absoluteRow: number };
type Range = { start: Anchor; end: Anchor };
// Structural signatures let these checks compile against a widget without the API.
type SelectionAPI = {
  setSelection(range: Range | null): void;
  getSelectionRange(): Range | null;
  getScrollbackText(): string;
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
    const manager = (term as unknown as { selectionManager: { selectionStart: Anchor; selectionEnd: Anchor; getSelectionCoords(): unknown } }).selectionManager;
    manager.selectionStart = { col: 1, absoluteRow: 0 };
    manager.selectionEnd = { col: 3, absoluteRow: 0 };
    expect(manager.selectionStart).toEqual({ col: 1, absoluteRow: 0 });
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
    expect(term.cellAt(1, 1)).toBeNull();
  });
});
