import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { GhosttyVt, VtCells } from '../vt/ghosttyVt';
import { terminalInternals } from '../vt/internal';
import type { ITerminalOptions } from './interfaces';
import { Terminal } from './terminal';

declare module 'node:fs' {
  export function writeFileSync(path: string, data: string): void;
}
declare const process: { env: { GHOSTTY_SCROLLBACK_MEASUREMENTS?: string } };

type Options = Partial<ITerminalOptions> & { scrollbackBytes?: number };
type Exports = {
  memory: WebAssembly.Memory;
  ghostty_type_json(): number;
  ghostty_wasm_alloc(size: number): number;
  ghostty_wasm_free(ptr: number, size: number): void;
  ghostty_terminal_get(handle: number, field: number, out: number): number;
};
type Field = { offset: number; type: string };
let module: WebAssembly.Module;
let data: Record<string, number>;
let memoryLayout: { size: number; fields: Record<string, Field> };
const terminals: Terminal[] = [];
const measurements: Record<string, number | string>[] = [];
const BUDGET = 2 * 1024 * 1024;
const ASCII = 'A'.repeat(80);
const CLUSTERS = ('\u754ce\u0301').repeat(26) + 'ab';

beforeAll(async () => {
  module = await WebAssembly.compile(readFileSync('vendor/ghostty-vt/ghostty-vt.wasm'));
  const { exports } = await WebAssembly.instantiate(module, {});
  const raw = exports as unknown as Exports;
  const ptr = raw.ghostty_type_json();
  const bytes = new Uint8Array(raw.memory.buffer);
  const types = JSON.parse(new TextDecoder().decode(bytes.subarray(ptr, bytes.indexOf(0, ptr)))).types;
  data = types.GhosttyTerminalData.values;
  expect(types.GhosttyTerminalData.keys.MEMORY_USAGE.type).toBe('GhosttyTerminalMemoryUsage');
  memoryLayout = types.GhosttyTerminalMemoryUsage;
  expect(memoryLayout.fields.primary_resident_bytes.type).toBe('u64');
});
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
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
afterAll(() => {
  const path = process.env.GHOSTTY_SCROLLBACK_MEASUREMENTS;
  if (path) writeFileSync(path, JSON.stringify(measurements, null, 2) + '\n');
});

async function open(options: Options = {}) {
  const instance = await WebAssembly.instantiate(module, {});
  const raw = instance.exports as unknown as Exports;
  const ghostty = new GhosttyVt(instance);
  const term = new Terminal({ ghostty, cols: 80, rows: 24, cursorBlink: false,
    smoothScrollDuration: 0, testHooks: { scrollbarOpacity: 0 }, ...options });
  terminals.push(term);
  const host = document.createElement('div');
  document.body.append(host);
  term.open(host);
  const handle = terminalInternals(term.wasmTerm!).handle;
  function read<T>(size: number, fn: (ptr: number) => T): T {
    const ptr = raw.ghostty_wasm_alloc(size);
    try { return fn(ptr); } finally { raw.ghostty_wasm_free(ptr, size); }
  }
  return {
    term,
    setting(name: 'SCROLLBACK_MAX_BYTES' | 'SCROLLBACK_MAX_LINES'): number | null {
      return read(4, ptr => {
        const result = raw.ghostty_terminal_get(handle, data[name], ptr);
        if (result === -4) return null;
        expect(result).toBe(0);
        return new DataView(raw.memory.buffer).getUint32(ptr, true);
      });
    },
    memory() {
      return read(memoryLayout.size, ptr => {
        new Uint8Array(raw.memory.buffer).fill(0, ptr, ptr + memoryLayout.size);
        new DataView(raw.memory.buffer).setUint32(ptr + memoryLayout.fields.size.offset, memoryLayout.size, true);
        expect(raw.ghostty_terminal_get(handle, data.MEMORY_USAGE, ptr)).toBe(0);
        const view = new DataView(raw.memory.buffer);
        const get = (name: string) => Number(view.getBigUint64(ptr + memoryLayout.fields[name].offset, true));
        return { pages: get('primary_pages'), resident: get('primary_resident_bytes'),
          virtual: get('primary_virtual_bytes'), compressed: get('primary_compressed_bytes'),
          alternate: get('alternate_resident_bytes') };
      });
    },
  };
}

function writeLines(term: Terminal, line: string, count: number) {
  for (let written = 0; written < count; written += 256) {
    term.write((line + '\r\n').repeat(Math.min(256, count - written)));
  }
}

describe('construction scrollback limits', () => {
  test.each([undefined, 37, 0])('preserves the line limit %s when bytes are omitted', async scrollback => {
    const rig = await open({ scrollback });
    expect(rig.setting('SCROLLBACK_MAX_BYTES')).toBeNull();
    expect(rig.setting('SCROLLBACK_MAX_LINES')).toBe(scrollback === 0 ? null : scrollback ?? 10000);
    writeLines(rig.term, 'retained', 100);
    expect(rig.term.getScrollbackText()).toContain('retained');
  });

  test.each([undefined, 1, 0, 100000])('a byte budget replaces the line limit %s', async scrollback => {
    const rig = await open({ scrollback, scrollbackBytes: BUDGET });
    expect(rig.setting('SCROLLBACK_MAX_BYTES')).toBe(BUDGET);
    expect(rig.setting('SCROLLBACK_MAX_LINES')).toBeNull();
    writeLines(rig.term, ASCII, 2000);
    expect(rig.term.core!.getScrollbackLength()).toBe(2000 - 23);
  });

  test.each([0, -1, 1.5, NaN, Infinity, -Infinity])('invalid byte budget %s falls back to the line option', async scrollbackBytes => {
    const rig = await open({ scrollback: 37, scrollbackBytes });
    expect(rig.setting('SCROLLBACK_MAX_BYTES')).toBeNull();
    expect(rig.setting('SCROLLBACK_MAX_LINES')).toBe(37);
  });

  test.each([0xffff_fffe, 0xffff_ffff, 0x1_0000_0000, Number.MAX_VALUE])('large byte budget %s saturates below the unlimited sentinel', async scrollbackBytes => {
    const rig = await open({ scrollbackBytes });
    expect(rig.setting('SCROLLBACK_MAX_BYTES')).toBe(0xffff_fffe);
    expect(rig.setting('SCROLLBACK_MAX_LINES')).toBeNull();
  });

  test('option mutation, theme changes and resize do not change the constructed budget', async () => {
    const rig = await open({ scrollbackBytes: BUDGET });
    (rig.term.options as Options).scrollbackBytes = 1;
    rig.term.options.scrollback = 1;
    rig.term.setTheme({ background: '#000000', foreground: '#ffffff' });
    rig.term.resize(60, 20);
    expect(rig.setting('SCROLLBACK_MAX_BYTES')).toBe(BUDGET);
    expect(rig.setting('SCROLLBACK_MAX_LINES')).toBeNull();
    writeLines(rig.term, 'retained', 2000);
    expect(rig.term.core!.getScrollbackLength()).toBe(2000 - 19);
  });
});

describe('real core byte pruning', () => {
  test('bounds page memory and retains fewer wide/cluster rows than ASCII', async () => {
    const retained: number[] = [];
    for (const [shape, line] of [['ascii', ASCII], ['clusters', CLUSTERS]]) {
      const rig = await open({ scrollbackBytes: BUDGET, scrollback: 0 });
      writeLines(rig.term, line, 23);
      const baseline = rig.memory();
      expect(baseline.pages).toBe(1);
      let maxResident = baseline.resident;
      let previous = 0;
      let prunes = 0;
      for (let written = 0; written < 12032; written += 256) {
        writeLines(rig.term, line, 256);
        rig.term.refresh();
        const rows = rig.term.core!.getScrollbackLength();
        if (rows < previous + 256) prunes++;
        previous = rows;
        const memory = rig.memory();
        expect(memory.compressed).toBe(0);
        expect(memory.alternate).toBe(0);
        expect(memory.virtual).toBe(memory.resident);
        // Whole-page pruning allows a page of slack. Subtract the warmed
        // live page; the fixture's grown cluster page supplies its delta.
        expect(memory.resident - baseline.resident).toBeLessThanOrEqual(BUDGET + baseline.resident);
        maxResident = Math.max(maxResident, memory.resident);
      }
      expect(prunes).toBeGreaterThan(2);
      expect(previous).toBeGreaterThan(0);
      expect(previous).toBeLessThan(12032);
      retained.push(previous);
      measurements.push({ shape, budget: BUDGET, baseline: baseline.resident,
        maxResident, historyBound: BUDGET + baseline.resident, retained: previous, prunes });
    }
    expect(retained[1]).toBeLessThan(retained[0]);
  });

  test.each([ASCII, CLUSTERS])('a one-byte budget keeps a readable live grid within page granularity (%#)', async line => {
    const rig = await open({ scrollbackBytes: 1, scrollback: 0 });
    writeLines(rig.term, line, 23);
    const baseline = rig.memory();
    writeLines(rig.term, line, 4000);
    const memory = rig.memory();
    expect(memory.resident - baseline.resident).toBeLessThanOrEqual(1 + baseline.resident);
    expect(rig.term.core!.getScrollbackLength()).toBeLessThan(4000);
    expect(rig.term.core!.plainText()).toContain(line);
    measurements.push({ shape: line === ASCII ? 'ascii' : 'clusters', budget: 1,
      baseline: baseline.resident, resident: memory.resident, retained: rig.term.core!.getScrollbackLength() });
  });

  test('history stays contiguous and readable through narrow and wide reflow after pruning', async () => {
    const rig = await open({ scrollbackBytes: BUDGET, scrollback: 0 });
    const { term } = rig;
    const line = (n: number) => `row-${String(n).padStart(5, '0')}:` + 'x'.repeat(50);
    for (let start = 0; start < 8000; start += 256) {
      term.write(Array.from({ length: Math.min(256, 8000 - start) }, (_, i) => line(start + i) + '\r\n').join(''));
    }
    let previousFirst = -1;
    for (const cols of [80, 40, 100, 80]) {
      term.resize(cols, 24);
      term.refresh();
      const core = term.core!;
      const history = core.getScrollbackLength();
      expect(history).toBe(term.getScrollbackLength());
      expect(term.buffer.active.length).toBe(history + term.rows);
      const rows = new VtCells();
      expect(core.readHistoryRow(history - 1, rows)).toBe(true);
      expect(core.readHistoryRow(history, rows)).toBe(false);
      const text = core.plainText()!;
      expect(text).not.toBeNull();
      const first = Number(/row-(\d+):/.exec(text)![1]);
      expect(first).toBeGreaterThan(0);
      expect(first).toBeGreaterThanOrEqual(previousFirst);
      previousFirst = first;
      // A boundary page may cut the first wrapped line; every complete
      // surviving logical line must still be present in order.
      expect(text.slice(text.indexOf(`row-${String(first).padStart(5, '0')}:`)).trimEnd())
        .toBe(Array.from({ length: 8000 - first }, (_, i) => line(first + i)).join('\n'));
      expect(history).toBeGreaterThan(0);
      measurements.push({ cols, retained: history, first, resident: rig.memory().resident });
    }
  });

  test.each(['forward', 'backward', 'both'] as const)('selection endpoints follow byte pruning: %s', async direction => {
    const { term } = await open({ scrollbackBytes: 1, scrollback: 0, rows: 6 });
    for (let line = 0; line < 3000; line++) {
      const before = term.core!.getScrollbackLength();
      if (before > 40) {
        const start = { col: 3, absoluteRow: 0 };
        const end = { col: 79, absoluteRow: direction === 'both' ? 1 : before + term.rows - 2 };
        term.setSelection(direction === 'backward' ? { start: end, end: start } : { start, end });
      }
      term.write(`line ${line}\r\n`);
      const after = term.core!.getScrollbackLength();
      if (after >= before) continue;
      expect(before - after).toBeGreaterThan(2);
      const first = Number(/^line (\d+)$/.exec(term.buffer.active.getLine(0)!.translateToString(true))![1]);
      expect(first).toBeGreaterThan(0);
      if (direction === 'both') {
        expect(term.getSelectionRange()).toBeNull();
        expect(term.getSelection()).toBe('');
      } else {
        const selected = term.getSelectionRange()!;
        expect(direction === 'backward' ? selected.end : selected.start).toEqual({ col: 0, absoluteRow: 0 });
        expect(direction === 'backward' ? selected.start : selected.end)
          .toEqual({ col: 79, absoluteRow: line - first - 1 });
        expect(term.getSelection()).toBe(Array.from({ length: line - first }, (_, i) => `line ${first + i}`).join('\n'));
      }
      return;
    }
    throw new Error('the byte budget never pruned history');
  });
});
