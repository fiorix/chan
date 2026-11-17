import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { GhosttyVt, type VtTerminal } from '../vt/ghosttyVt';
import { SelectionManager } from './selection-manager';
import { Terminal } from './terminal';

let module: WebAssembly.Module;

beforeAll(async () => {
  module = await WebAssembly.compile(readFileSync('vendor/ghostty-vt/ghostty-vt.wasm'));
});

/// A terminal with a real core and selection manager over a stub
/// renderer: the widget's selection API without a painted canvas.
async function terminal(input: string, cols = 20, rows = 4, copy?: (text: string) => void) {
  const ghostty = new GhosttyVt(await WebAssembly.instantiate(module, {}));
  const term = new Terminal({ ghostty, cols, rows, copy } as ConstructorParameters<typeof Terminal>[0]);
  const wasmTerm = ghostty.createTerminal(cols, rows, { scrollbackLimit: 100 });
  wasmTerm.write(input);
  const canvas = document.createElement('canvas');
  const textarea = document.createElement('textarea');
  const renderer = {
    render: vi.fn(),
    resize: vi.fn(),
    getMetrics: () => ({ width: 8, height: 16, baseline: 12 }),
    getCanvas: () => canvas,
    dispose: vi.fn(),
    setSelectionManager: vi.fn(),
  };
  Object.assign(term, { wasmTerm, renderer, canvas, isOpen: true });
  // The copy option rides the constructor into open(), which hands it to
  // the manager; the manual wiring here does the same explicitly.
  const manager = new SelectionManager(
    term,
    renderer as unknown as ConstructorParameters<typeof SelectionManager>[1],
    wasmTerm as unknown as ConstructorParameters<typeof SelectionManager>[2],
    textarea,
    copy,
  );
  (term as unknown as { selectionManager: SelectionManager }).selectionManager = manager;
  document.body.append(canvas, textarea);
  return { term, manager, wasmTerm: wasmTerm as unknown as VtTerminal, canvas };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const at = (col: number, row: number) => ({ clientX: col * 8 + 1, clientY: row * 16 + 1 });

describe('the widgets selection API', () => {
  test('setSelection writes anchors that getSelectionRange reads back', async () => {
    const { term } = await terminal('hello world\r\nsecond row');
    expect(term.getSelectionRange()).toBeNull();
    term.setSelection({ start: { col: 1, absoluteRow: 0 }, end: { col: 3, absoluteRow: 0 } });
    expect(term.getSelectionRange()).toEqual({ start: { col: 1, absoluteRow: 0 }, end: { col: 3, absoluteRow: 0 } });
    expect(term.getSelection()).toBe('ell');
    term.setSelection(null);
    expect(term.getSelectionRange()).toBeNull();
    expect(term.hasSelection()).toBe(false);
  });

  test('selectAll covers the history and the screen, and copies it as shown', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => `row ${i}`).join('\r\n');
    const { term, wasmTerm } = await terminal(rows);
    expect(wasmTerm.getScrollbackLength()).toBe(8);
    term.selectAll();
    expect(term.getSelectionRange()).toEqual({ start: { col: 0, absoluteRow: 0 }, end: { col: 19, absoluteRow: 11 } });
    expect(term.getSelection()).toBe(rows.replaceAll('\r\n', '\n'));
    expect(term.hasSelection()).toBe(true);
  });

  test('getSelection joins a soft-wrapped command as the one line it is', async () => {
    const command = '$ echo one two three four';
    const { term, wasmTerm } = await terminal(`${command}\r\nok`);
    expect(wasmTerm.isRowWrapped(1), 'the command wrapped on screen').toBe(true);
    term.setSelection({ start: { col: 0, absoluteRow: 0 }, end: { col: 19, absoluteRow: 2 } });
    expect(term.getSelection()).toBe(`${command}\nok`);
  });

  test('cellAt names the cell under a pixel, clamped to the grid', async () => {
    const { term } = await terminal('hello world\r\nsecond row');
    expect(term.cellAt(9, 1)).toEqual({ col: 1, row: 0, absoluteRow: 0 });
    expect(term.cellAt(9_999, 9_999)).toEqual({ col: 19, row: 3, absoluteRow: 3 });
  });

  test('a drag copies through the copy option', async () => {
    const writes: string[] = [];
    const { term, canvas } = await terminal('hello world\r\nsecond row', 20, 4, (text) => void writes.push(text));
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, ...at(0, 0) }));
    canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, ...at(4, 1) }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1, ...at(4, 1) }));
    expect(writes).toEqual(['hello world\nsecon']);
  });

  test('a double click selects the word across a soft wrap', async () => {
    const path = '/var/log/messages.1';
    const { term, canvas, wasmTerm } = await terminal(`$ cat ${path}\r\nok`);
    expect(wasmTerm.isRowWrapped(1), 'the command wrapped inside the word').toBe(true);
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2, clientX: 9 * 8 + 1, clientY: 1 }));
    expect(term.getSelection()).toBe(path);
  });

  test('a triple click selects the whole wrapped line', async () => {
    const command = '$ cat /var/log/messages.1';
    const { term, canvas } = await terminal(`${command}\r\nok`);
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 3, clientX: 1, clientY: 1 }));
    expect(term.getSelection()).toBe(command);
  });
});
