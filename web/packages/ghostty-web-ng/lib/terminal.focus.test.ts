import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { GhosttyVt } from '../vt/ghosttyVt';
import { Terminal } from './terminal';

let module: WebAssembly.Module;
const terminals: Terminal[] = [];

beforeAll(async () => {
  module = await WebAssembly.compile(readFileSync('vendor/ghostty-vt/ghostty-vt.wasm'));
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  // Focus uses the real widget and core; canvas pixels are outside this check.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => new Proxy({}, {
    get: (_, key) => key === 'measureText'
      ? () => ({ width: 8, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 4 })
      : () => undefined,
    set: () => true,
  })) as never);
});

afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose();
  vi.useRealTimers();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function terminal() {
  const ghostty = new GhosttyVt(await WebAssembly.instantiate(module, {}));
  const term = new Terminal({ ghostty, cols: 40, rows: 6, cursorBlink: false, smoothScrollDuration: 0 });
  terminals.push(term);
  return term;
}

async function open(attached = true) {
  const term = await terminal();
  const host = document.createElement('div');
  if (attached) document.body.append(host);
  term.open(host);
  return { term, host, textarea: host.querySelector('textarea')! };
}

function field() {
  const input = document.createElement('input');
  document.body.append(input);
  input.focus();
  return input;
}

describe('synchronous terminal focus', () => {
  test('open() leaves the current field focused without even a transient blur', async () => {
    const input = field();
    const blur = vi.fn();
    input.addEventListener('blur', blur);
    await open();
    expect(document.activeElement).toBe(input);
    vi.advanceTimersByTime(100);
    expect(document.activeElement).toBe(input);
    expect(blur).not.toHaveBeenCalled();
  });

  test('focus() calls the connected element synchronously with preventScroll', async () => {
    const { term, host } = await open();
    const focus = vi.spyOn(host, 'focus');
    term.focus();
    expect(document.activeElement).toBe(host);
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  test('focus() schedules no timer or animation frame', async () => {
    const { term, host } = await open();
    // Isolate widget scheduling from jsdom's own deferred selectionchange event.
    const focus = vi.spyOn(host, 'focus').mockImplementation(() => {});
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    vi.mocked(requestAnimationFrame).mockClear();
    term.focus();
    expect(timeout).not.toHaveBeenCalled();
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  test.each(['input', 'menu'])('a later %s focus is never reclaimed', async (owner) => {
    const { term, host } = await open();
    const other = document.createElement(owner === 'input' ? 'input' : 'button');
    if (owner === 'menu') other.setAttribute('role', 'menuitem');
    document.body.append(other);
    term.focus();
    expect(document.activeElement).toBe(host);
    other.focus();
    vi.advanceTimersByTime(100);
    expect(document.activeElement, 'no retry takes the keyboard back').toBe(other);
  });

  test('focus() before open is dropped, including after open', async () => {
    const term = await terminal();
    const input = field();
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    term.focus();
    const host = document.createElement('div');
    document.body.append(host);
    term.open(host);
    vi.advanceTimersByTime(100);
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });

  test('focus() never calls a detached element', async () => {
    const { term, host } = await open(false);
    const input = field();
    const focus = vi.spyOn(host, 'focus');
    term.focus();
    expect(document.activeElement).toBe(input);
    // jsdom cannot focus detached nodes, so activeElement alone misses this guard.
    expect(focus).not.toHaveBeenCalled();
  });

  test('a detached focus request cannot land after attachment', async () => {
    const { term, host } = await open(false);
    const input = field();
    term.focus();
    document.body.append(host);
    vi.advanceTimersByTime(100);
    expect(document.activeElement, 'the detached request stays dropped').toBe(input);
    const focus = vi.spyOn(host, 'focus');
    term.focus();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(host);
  });

  test('blur() immediately after focus releases the host with no later reclaim', async () => {
    const { term, host } = await open();
    term.focus();
    expect(document.activeElement).toBe(host);
    term.blur();
    expect(document.activeElement).toBe(document.body);
    vi.advanceTimersByTime(100);
    expect(document.activeElement).toBe(document.body);
  });

  test('blur() releases the hidden textarea', async () => {
    const { term, textarea } = await open();
    textarea.focus();
    expect(document.activeElement).toBe(textarea);
    term.blur();
    expect(document.activeElement).toBe(document.body);
    vi.advanceTimersByTime(100);
    expect(document.activeElement).toBe(document.body);
  });

  test('blur() leaves focus outside the terminal untouched', async () => {
    const { term } = await open();
    const input = field();
    const blur = vi.spyOn(input, 'blur');
    term.blur();
    vi.advanceTimersByTime(100);
    expect(blur).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });

  test('focus() and blur() after disposal leave the keyboard owner alone', async () => {
    const { term, host } = await open();
    term.focus();
    term.dispose();
    const input = field();
    const focus = vi.spyOn(host, 'focus');
    const blur = vi.spyOn(input, 'blur');
    expect(() => { term.focus(); term.blur(); }).not.toThrow();
    vi.advanceTimersByTime(100);
    expect(focus).not.toHaveBeenCalled();
    expect(blur).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });
});
