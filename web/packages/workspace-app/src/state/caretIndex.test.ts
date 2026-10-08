import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

// jsdom here doesn't ship localStorage; inline the same minimal in-memory
// polyfill editorBuffer.test.ts uses so the tests exercise the real module.
beforeAll(() => {
  if (typeof globalThis.localStorage !== "undefined") return;
  let map = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return map.size;
    },
    clear() {
      map = new Map();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(i: number) {
      return Array.from(map.keys())[i] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
});

import {
  clearCaretsUnder,
  pruneCaretIndex,
  readCaret,
  recordCaret,
  rekeyCaret,
} from "./caretIndex";
import { draftClientPath } from "../api/fileIdentity";
import { workspace } from "./workspace.svelte";
import type { WorkspaceInfo } from "../api/types";

const PREFIX = "chan:caret-index:";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function setRoot(root: string | null): void {
  workspace.info = root === null ? null : ({ root } as unknown as WorkspaceInfo);
}

/// Write an entry directly (bypassing the debounce) for read/clear/rekey/prune.
function putEntry(
  root: string,
  path: string,
  from: number,
  to: number,
  updatedAt: number = Date.now(),
): void {
  localStorage.setItem(
    `${PREFIX}${root}:${path}`,
    JSON.stringify({ from, to, updatedAt, path }),
  );
}

beforeEach(() => {
  if (typeof localStorage !== "undefined") localStorage.clear();
  setRoot("/ws");
});

afterEach(() => {
  vi.useRealTimers();
  setRoot(null);
});

describe("recordCaret + readCaret roundtrip", () => {
  test("a debounced record lands and reads back", () => {
    vi.useFakeTimers();
    recordCaret("notes/a.md", 5, 9);
    expect(readCaret("notes/a.md")).toBeNull(); // not flushed yet
    vi.advanceTimersByTime(400);
    expect(readCaret("notes/a.md")).toEqual({ from: 5, to: 9 });
  });

  test("rapid records coalesce to the latest position", () => {
    vi.useFakeTimers();
    recordCaret("notes/a.md", 1, 1);
    recordCaret("notes/a.md", 2, 2);
    recordCaret("notes/a.md", 7, 7);
    vi.advanceTimersByTime(400);
    expect(readCaret("notes/a.md")).toEqual({ from: 7, to: 7 });
  });

  test("read returns null when there is no entry", () => {
    expect(readCaret("notes/missing.md")).toBeNull();
  });

  test("an entry whose stored path differs from the key is rejected", () => {
    // Key reuse guard: a stored path that no longer matches the requested
    // path must not land one file's caret in another.
    localStorage.setItem(
      `${PREFIX}/ws:notes/a.md`,
      JSON.stringify({ from: 3, to: 3, updatedAt: Date.now(), path: "notes/other.md" }),
    );
    expect(readCaret("notes/a.md")).toBeNull();
  });
});

describe("workspace scoping", () => {
  test("no caret persists or reads when no workspace is mounted", () => {
    vi.useFakeTimers();
    setRoot(null);
    recordCaret("notes/a.md", 4, 4);
    vi.advanceTimersByTime(400);
    expect(readCaret("notes/a.md")).toBeNull();
  });

  test("two workspaces with the same relative path keep separate carets", () => {
    putEntry("/ws-a", "README.md", 10, 10);
    putEntry("/ws-b", "README.md", 20, 20);
    setRoot("/ws-a");
    expect(readCaret("README.md")).toEqual({ from: 10, to: 10 });
    setRoot("/ws-b");
    expect(readCaret("README.md")).toEqual({ from: 20, to: 20 });
  });
});

describe("clearCaretsUnder", () => {
  test("drops a single file's caret", () => {
    putEntry("/ws", "notes/a.md", 1, 1);
    clearCaretsUnder("notes/a.md");
    expect(readCaret("notes/a.md")).toBeNull();
  });

  test("drops a directory and its descendants, sparing prefix-siblings", () => {
    putEntry("/ws", "dir/a.md", 2, 2);
    putEntry("/ws", "dir/sub/b.md", 3, 3);
    putEntry("/ws", "dirsibling.md", 4, 4); // shares the "dir" prefix but not "dir/"
    clearCaretsUnder("dir");
    expect(readCaret("dir/a.md")).toBeNull();
    expect(readCaret("dir/sub/b.md")).toBeNull();
    expect(readCaret("dirsibling.md")).toEqual({ from: 4, to: 4 });
  });
});

describe("rekeyCaret", () => {
  test("moves a single file's caret to the new path", () => {
    putEntry("/ws", "old.md", 5, 5);
    rekeyCaret("old.md", "new.md");
    expect(readCaret("old.md")).toBeNull();
    expect(readCaret("new.md")).toEqual({ from: 5, to: 5 });
  });

  test("moves a directory subtree, rewriting descendant paths", () => {
    putEntry("/ws", "old/a.md", 1, 1);
    putEntry("/ws", "old/sub/b.md", 2, 2);
    rekeyCaret("old", "new");
    expect(readCaret("old/a.md")).toBeNull();
    expect(readCaret("new/a.md")).toEqual({ from: 1, to: 1 });
    expect(readCaret("new/sub/b.md")).toEqual({ from: 2, to: 2 });
  });
});

describe("pruneCaretIndex", () => {
  test("evicts entries past the 30-day TTL, keeps fresh ones", () => {
    putEntry("/ws", "stale.md", 1, 1, Date.now() - 31 * MS_PER_DAY);
    putEntry("/ws", "fresh.md", 2, 2, Date.now());
    expect(pruneCaretIndex()).toBeGreaterThanOrEqual(1);
    expect(readCaret("stale.md")).toBeNull();
    expect(readCaret("fresh.md")).toEqual({ from: 2, to: 2 });
  });

  test("returns 0 when under the size cap", () => {
    putEntry("/ws", "a.md", 1, 1);
    expect(pruneCaretIndex()).toBe(0);
  });

  test("evicts oldest-first when over the 256KB size cap", () => {
    // Inflate each entry with a long path so a few dozen exceed the cap.
    const longPath = (i: number) => `dir/${"x".repeat(12000)}-${i}.md`;
    for (let i = 0; i < 30; i++) {
      putEntry("/ws", longPath(i), 0, 0, Date.now() + i); // ascending age
    }
    expect(pruneCaretIndex()).toBeGreaterThan(0);
    expect(readCaret(longPath(29))).not.toBeNull(); // newest survives
    expect(readCaret(longPath(0))).toBeNull(); // oldest evicted
  });
});

describe("a draft's caret", () => {
  const MARK = String.fromCharCode(0);
  const draft = draftClientPath({ path: "untitled/draft.md", draft_id: "v1:abc" });
  const draftKey = "chan:caret-index-draft:/ws:v1%3Aabc:untitled/draft.md";

  function keys(): string[] {
    return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!);
  }

  test("is kept under a key of its own that holds no mark", () => {
    vi.useFakeTimers();
    recordCaret(draft, 3, 5);
    recordCaret("untitled/draft.md", 8, 8);
    vi.advanceTimersByTime(400);

    expect(keys().some((key) => key.includes(MARK)), "a key holding the mark").toBe(false);
    expect(keys().sort(), "the two keys").toEqual([
      draftKey,
      "chan:caret-index:/ws:untitled/draft.md",
    ]);
    expect(readCaret(draft), "the draft's caret").toEqual({ from: 3, to: 5 });
    expect(readCaret("untitled/draft.md"), "the user file's caret").toEqual({ from: 8, to: 8 });
  });

  test("ages out with the sweep that evicts a workspace file's", () => {
    localStorage.setItem(
      draftKey,
      JSON.stringify({ from: 1, to: 1, updatedAt: Date.now() - 31 * MS_PER_DAY, path: "x" }),
    );

    expect(pruneCaretIndex(), "evicted").toBe(1);
    expect(localStorage.length, "keys left").toBe(0);
  });

  test("is not touched by a workspace folder's clear or rename", () => {
    vi.useFakeTimers();
    recordCaret(draft, 3, 5);
    vi.advanceTimersByTime(400);

    clearCaretsUnder("untitled");
    rekeyCaret("untitled", "renamed");

    expect(readCaret(draft), "the draft's caret").toEqual({ from: 3, to: 5 });
  });
});
