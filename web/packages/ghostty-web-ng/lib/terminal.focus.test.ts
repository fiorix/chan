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

  test('a press, a tap and a context menu on the canvas focus without scrolling the page', async () => {
    const { host, textarea } = await open();
    const canvas = host.querySelector('canvas')!;
    const hostFocus = vi.spyOn(host, 'focus');
    const inputFocus = vi.spyOn(textarea, 'focus');
    const quiet = [{ preventScroll: true }];
    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    expect(inputFocus.mock.calls).toEqual([quiet]);
    expect(hostFocus.mock.calls).toEqual([quiet]);
    expect(document.activeElement).toBe(host);
    canvas.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
    expect(inputFocus.mock.calls).toEqual([quiet, quiet]);
    expect(document.activeElement).toBe(textarea);
    host.focus({ preventScroll: true });
    canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    expect(inputFocus.mock.calls).toEqual([quiet, quiet, quiet]);
    expect(document.activeElement).toBe(textarea);
    expect(hostFocus.mock.calls).toEqual([quiet, quiet]);
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

const tabIndexes = (host: HTMLElement) =>
  [host.getAttribute('tabindex'), host.querySelector('textarea')?.getAttribute('tabindex')];

// Every tabindex the host and its input held while attached during run(),
// oldest first: each mutation record's old value, then the value at the end.
// The input's first value is the one it was attached with.
function heldTabIndexes(host: HTMLElement, run: () => void) {
  const observer = new MutationObserver(() => {});
  observer.observe(host, { subtree: true, attributes: true, attributeFilter: ['tabindex'], attributeOldValue: true });
  run();
  const records = observer.takeRecords();
  observer.disconnect();
  const held = (element: Element) =>
    [...records.filter((record) => record.target === element).map((record) => record.oldValue), element.getAttribute('tabindex')];
  return { host: held(host), input: held(host.querySelector('textarea')!) };
}

describe('sequential focus navigation', () => {
  test('false takes the host and the input out of the Tab order and true puts them back', async () => {
    const { term, host, textarea } = await open();
    expect(tabIndexes(host), 'unused, both are in the Tab order').toEqual(['0', '0']);
    term.setSequentiallyFocusable(false);
    expect(tabIndexes(host)).toEqual(['-1', '-1']);
    expect([host.tabIndex, textarea.tabIndex]).toEqual([-1, -1]);
    term.setSequentiallyFocusable(true);
    expect(tabIndexes(host)).toEqual(['0', '0']);

    const embedder = document.createElement('div');
    embedder.setAttribute('tabindex', '-1');
    document.body.append(embedder);
    (await terminal()).open(embedder);
    expect(tabIndexes(embedder), 'unused, the host keeps the tabindex it was given').toEqual(['-1', '0']);
  });

  test('a value asked before open() is applied by open() with no moment in the Tab order, and none after disposal', async () => {
    const term = await terminal();
    term.setSequentiallyFocusable(true);
    term.setSequentiallyFocusable(false);
    const host = document.createElement('div');
    document.body.append(host);
    const held = heldTabIndexes(host, () => term.open(host));
    expect(held.input, 'the input is attached out of the Tab order').toEqual(['-1']);
    expect(tabIndexes(host)).toEqual(['-1', '-1']);

    term.dispose();
    expect(() => term.setSequentiallyFocusable(true)).not.toThrow();
    expect(host.getAttribute('tabindex'), 'nothing is written after disposal').toBe('-1');
  });

  test('taking a terminal out or in moves no focus, and focus() and a press or tap still give it the keyboard', async () => {
    const { term, host, textarea } = await open();
    term.focus();
    term.setSequentiallyFocusable(false);
    expect(document.activeElement, 'the focused host keeps focus').toBe(host);
    textarea.focus();
    term.setSequentiallyFocusable(true);
    term.setSequentiallyFocusable(false);
    expect(document.activeElement, 'the focused input keeps focus').toBe(textarea);
    const input = field();
    term.setSequentiallyFocusable(true);
    term.setSequentiallyFocusable(false);
    expect(document.activeElement, 'focus outside stays put').toBe(input);

    expect(tabIndexes(host)).toEqual(['-1', '-1']);
    term.focus();
    expect(document.activeElement).toBe(host);
    input.focus();
    const canvas = host.querySelector('canvas')!;
    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    expect(host.contains(document.activeElement), 'a press gives it the keyboard').toBe(true);
    input.focus();
    canvas.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
    expect(document.activeElement, 'a tap gives it the keyboard').toBe(textarea);
  });

  test('a terminal opened where a disposed one was applies its own value to its new input', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const first = await terminal();
    first.setSequentiallyFocusable(false);
    first.open(host);
    first.dispose();
    expect(host.getAttribute('tabindex'), 'the disposed terminal left the host out').toBe('-1');

    const second = await terminal();
    second.setSequentiallyFocusable(true);
    second.open(host);
    expect(tabIndexes(host)).toEqual(['0', '0']);
    second.dispose();

    const third = await terminal();
    third.setSequentiallyFocusable(false);
    const held = heldTabIndexes(host, () => third.open(host));
    expect(held.input).toEqual(['-1']);
    expect(tabIndexes(host)).toEqual(['-1', '-1']);
  });

  test('disposal takes the tabindex the widget wrote, so the next unused terminal opens in the Tab order', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const out = await terminal();
    out.setSequentiallyFocusable(false);
    out.open(host);
    out.dispose();
    expect(host.hasAttribute('tabindex'), 'a value asked before open() goes with the terminal').toBe(false);

    const unused = await terminal();
    unused.open(host);
    expect(tabIndexes(host)).toEqual(['0', '0']);
    unused.dispose();
    expect(host.hasAttribute('tabindex'), "open()'s own '0' goes with the terminal").toBe(false);
  });

  test("disposal keeps an embedder's tabindex the widget never wrote and takes one it wrote over", async () => {
    const host = document.createElement('div');
    host.setAttribute('tabindex', '-1');
    document.body.append(host);
    const unused = await terminal();
    unused.open(host);
    unused.dispose();
    expect(host.getAttribute('tabindex'), "the embedder's value stays").toBe('-1');

    const later = await terminal();
    later.open(host);
    later.setSequentiallyFocusable(true);
    expect(tabIndexes(host)).toEqual(['0', '0']);
    later.dispose();
    expect(host.hasAttribute('tabindex'), 'a value written after open() goes with the terminal').toBe(false);

    host.setAttribute('tabindex', '0');
    const asked = await terminal();
    asked.setSequentiallyFocusable(false);
    asked.open(host);
    expect(tabIndexes(host), "a value asked before open() replaces the embedder's").toEqual(['-1', '-1']);
    asked.dispose();
    expect(host.hasAttribute('tabindex'), 'and goes with the terminal').toBe(false);
  });

  test('an open() that fails takes the tabindex it wrote', async () => {
    const ghostty = new GhosttyVt(await WebAssembly.instantiate(module, {}));
    vi.spyOn(ghostty, 'createTerminal').mockImplementation(() => {
      throw new Error('no memory for the terminal');
    });
    const term = new Terminal({ ghostty, cols: 40, rows: 6, cursorBlink: false, smoothScrollDuration: 0 });
    terminals.push(term);
    const host = document.createElement('div');
    document.body.append(host);
    expect(() => term.open(host)).toThrow('no memory for the terminal');
    expect(host.hasAttribute('tabindex')).toBe(false);
  });

  test("open() asked out puts no '0' on the host, from its own default or the input handler's", async () => {
    const term = await terminal();
    term.setSequentiallyFocusable(false);
    const host = document.createElement('div');
    document.body.append(host);
    const held = heldTabIndexes(host, () => term.open(host));
    expect(held.host).not.toContain('0');
    expect(held.host.at(-1)).toBe('-1');
  });
});
