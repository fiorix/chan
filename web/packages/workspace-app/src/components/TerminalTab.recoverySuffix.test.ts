// @vitest-environment jsdom

// The lossy normal-screen recovery suffix must not move xterm.js's cursor.
// xterm.js's ?1049l handler restores unconditionally
// (resetModePrivate case 1049 in @xterm/xterm src/common/InputHandler.ts,
// restoreCursor reading the saved slot or 0,0), so a suffix without a prior
// save jumps the resumed prompt to a stale position while DECSC beforehand
// (ESC 7, same file's Esc handler) keeps it where the replay ended.
// Drives a real xterm.js Terminal and reads its buffer cursor, the same
// parser the tab writes recovery bytes into.

import { Terminal } from "@xterm/xterm";
import { afterEach, expect, test, vi } from "vitest";

const terms: Terminal[] = [];
afterEach(() => {
  for (const term of terms.splice(0)) term.dispose();
});

function model(): Terminal {
  const term = new Terminal({ allowProposedApi: true, cols: 80, rows: 24, scrollback: 0 });
  terms.push(term);
  return term;
}

async function drain(term: Terminal): Promise<void> {
  let done = false;
  term.write("", () => {
    done = true;
  });
  await vi.advanceTimersByTimeAsync(20);
  expect(done, "xterm parsed every queued write").toBe(true);
}

function cursor(term: Terminal): { x: number; y: number } {
  const active = term.buffer.active;
  return { x: active.cursorX, y: active.cursorY };
}

async function cursorAfter(prefix: string, suffix: string): Promise<{ x: number; y: number }> {
  vi.useFakeTimers();
  try {
    const term = model();
    term.write(prefix);
    await drain(term);
    const before = cursor(term);
    expect(before).toEqual({ x: 39, y: 23 });
    term.write(suffix);
    await drain(term);
    return cursor(term);
  } finally {
    vi.useRealTimers();
  }
}

const PROMPT_AT_24_40 = "\x1b[24;40H";
const OLD_HEAD = "\x18\x1b[?1049;1047;47l";
const NEW_HEAD = "\x18\x1b7\x1b[?1049;1047;47l";

test("the old suffix moves the resumed cursor to the stale saved slot", async () => {
  expect(await cursorAfter(PROMPT_AT_24_40, OLD_HEAD)).toEqual({ x: 0, y: 0 });
});

test("the DECSC-prefixed suffix keeps the resumed cursor", async () => {
  expect(await cursorAfter(PROMPT_AT_24_40, NEW_HEAD)).toEqual({ x: 39, y: 23 });
});
