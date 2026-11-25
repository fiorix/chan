import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { sweepTerminalSnapshots } from "./snapshotCache";

const SNAPSHOT_KEYS = [
  "chan:term-snapshot:term_a",
  "chan:term-snapshot:term_b",
  "chan:term-snapshot:ctl_session",
  "chan:term-snapshot:term_d",
];

// Keys the sweep must leave: other chan stores, a key that holds the prefix
// past its start, and the hand-set renderer key.
const OTHER_KEYS = {
  "chan:editor-buffer:notes.md": "editor",
  "chan:caret-index:notes.md": "caret",
  "chan:terminal-webgl": "0",
  "x-chan:term-snapshot:term_e": "not the prefix",
};

function seed(): void {
  const snapshot = (ansi: string) =>
    JSON.stringify({ ansi, generation: 1, lastSeq: 42, cols: 80, rows: 24, updatedAt: Date.now() });
  // Adjacent entries, so a sweep that removed while it walked would skip one.
  localStorage.setItem(SNAPSHOT_KEYS[0]!, snapshot("\x1b[2J\x1b[Hhello"));
  localStorage.setItem(SNAPSHOT_KEYS[1]!, "not-json");
  localStorage.setItem(SNAPSHOT_KEYS[2]!, snapshot("connect...\r\nCHAN_DEVSERVER_TOKEN=tok_leaked\r\n$ "));
  localStorage.setItem(SNAPSHOT_KEYS[3]!, snapshot("fresh and well formed"));
  for (const [key, value] of Object.entries(OTHER_KEYS)) localStorage.setItem(key, value);
  sessionStorage.setItem("chan:term-snapshot:term_f", "session store");
}

function localKeys(): string[] {
  return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).sort();
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("sweepTerminalSnapshots", () => {
  test("removes every snapshot entry and no other key", () => {
    seed();
    sweepTerminalSnapshots();
    expect(localKeys()).toEqual(Object.keys(OTHER_KEYS).sort());
    for (const [key, value] of Object.entries(OTHER_KEYS)) expect(localStorage.getItem(key), key).toBe(value);
    expect(sessionStorage.getItem("chan:term-snapshot:term_f"), "sessionStorage is not swept").toBe("session store");
  });

  test("a store with no snapshot entry is left as it was", () => {
    for (const [key, value] of Object.entries(OTHER_KEYS)) localStorage.setItem(key, value);
    sweepTerminalSnapshots();
    expect(localKeys()).toEqual(Object.keys(OTHER_KEYS).sort());
  });
});

// A blocked or broken store must not break the app's load: the sweep runs in
// its first mount.
describe("sweepTerminalSnapshots over a store that fails", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  function replaceStore(store: Partial<Storage> | undefined): void {
    Object.defineProperty(globalThis, "localStorage", { value: store, configurable: true, writable: true });
  }

  test("a missing store", () => {
    replaceStore(undefined);
    expect(() => sweepTerminalSnapshots()).not.toThrow();
  });

  test("a store whose read throws", () => {
    Object.defineProperty(globalThis, "localStorage", {
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
      configurable: true,
    });
    expect(() => sweepTerminalSnapshots()).not.toThrow();
  });

  test("a walk that throws part way removes what it collected", () => {
    const keys = [SNAPSHOT_KEYS[0]!, SNAPSHOT_KEYS[1]!, "chan:terminal-webgl"];
    const removed: string[] = [];
    replaceStore({
      length: keys.length + 1,
      key(i: number) {
        if (i >= keys.length) throw new DOMException("gone", "InvalidStateError");
        return keys[i]!;
      },
      removeItem(key: string) {
        removed.push(key);
      },
    });
    expect(() => sweepTerminalSnapshots()).not.toThrow();
    expect(removed).toEqual([SNAPSHOT_KEYS[0], SNAPSHOT_KEYS[1]]);
  });

  test("a key that fails to go does not stop the others", () => {
    const removed: string[] = [];
    replaceStore({
      length: SNAPSHOT_KEYS.length,
      key: (i: number) => SNAPSHOT_KEYS[i] ?? null,
      removeItem(key: string) {
        if (key === SNAPSHOT_KEYS[1]) throw new DOMException("refused", "QuotaExceededError");
        removed.push(key);
      },
    });
    expect(() => sweepTerminalSnapshots()).not.toThrow();
    expect(removed).toEqual([SNAPSHOT_KEYS[0], SNAPSHOT_KEYS[2], SNAPSHOT_KEYS[3]]);
  });
});
