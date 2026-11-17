import { afterEach, describe, expect, test, vi } from 'vitest';
import type { GhosttyVt } from '../vt/ghosttyVt';
import { Terminal } from './terminal';

const terms: Terminal[] = [];

afterEach(() => {
  for (const term of terms.splice(0)) term.dispose();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// A terminal wired as open() wires it, without the canvas stack: focus()
// only needs the element and the open flag.
function focusedTerminal(attached: boolean): { term: Terminal; host: HTMLElement } {
  const term = new Terminal({ ghostty: undefined as unknown as GhosttyVt });
  const host = document.createElement('div');
  host.setAttribute('tabindex', '0');
  if (attached) document.body.append(host);
  Object.assign(term, { element: host, isOpen: true });
  terms.push(term);
  return { term, host };
}

function field(): HTMLInputElement {
  const input = document.createElement('input');
  document.body.append(input);
  return input;
}

describe("the ghostty widget's focus without a timer", () => {
  test('focus() leaves focus where it put it with no timer', () => {
    const { term, host } = focusedTerminal(true);
    const other = field();
    vi.useFakeTimers();
    try {
      term.focus();
      expect(document.activeElement, 'focus() takes the keyboard at once').toBe(host);
      other.focus();
      vi.advanceTimersByTime(100);
      expect(document.activeElement, 'no retry takes the keyboard back').toBe(other);
    } finally {
      vi.useRealTimers();
    }
  });

  test('focus() on a terminal that is not open does nothing', () => {
    const term = new Terminal({ ghostty: undefined as unknown as GhosttyVt });
    terms.push(term);
    const host = document.createElement('div');
    host.setAttribute('tabindex', '0');
    document.body.append(host);
    Object.assign(term, { element: host, isOpen: false });
    const other = field();
    other.focus();
    term.focus();
    expect(document.activeElement).toBe(other);
  });

  test('focus() on an element not yet attached does nothing, even after it attaches', () => {
    const { term, host } = focusedTerminal(false);
    const other = field();
    other.focus();
    vi.useFakeTimers();
    try {
      term.focus();
      expect(document.activeElement, 'the detached press is dropped').toBe(other);
      document.body.append(host);
      vi.advanceTimersByTime(100);
      expect(document.activeElement, 'no retry fires after the attach').toBe(other);
    } finally {
      vi.useRealTimers();
    }
  });
});
