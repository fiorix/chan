import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

// vitest's jsdom env here doesn't ship localStorage (window exists but
// window.localStorage is undefined). Inline a minimal in-memory Storage
// polyfill so the tests exercise the real buffer module against the
// same shape the browser provides.
beforeAll(() => {
  if (typeof globalThis.localStorage !== "undefined") return;
  let map = new Map<string, string>();
  const storage: Storage = {
    get length() { return map.size; },
    clear() { map = new Map(); },
    getItem(key: string) { return map.get(key) ?? null; },
    key(i: number) { return Array.from(map.keys())[i] ?? null; },
    removeItem(key: string) { map.delete(key); },
    setItem(key: string, value: string) { map.set(key, value); },
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
});
import {
  bufferKey,
  cancelPendingBufferWrite,
  clearEditorBuffer,
  divergentBufferOrNull,
  flushPendingBufferWrites,
  pruneEditorBuffers,
  queueBufferWrite,
  readEditorBuffer,
  SESSION_ID,
  writeEditorBuffer,
} from "./editorBuffer";
import { workspace } from "./workspace.svelte";
import type { WorkspaceInfo } from "../api/types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Hand-craft a buffer that looks like it came from a different page
// load. The recovery banner is only ever offered for foreign-session
// buffers, so most divergence tests need one of these.
function writeForeignBuffer(
  key: string,
  content: string,
  path: string,
  updatedAt: number = Date.now(),
): void {
  localStorage.setItem(
    bufferKey(key),
    JSON.stringify({ content, updatedAt, path, sessionId: "previous-load" }),
  );
}

beforeEach(() => {
  // Fresh localStorage per test so prior entries don't bleed into
  // eviction counts or reads.
  if (typeof localStorage !== "undefined") {
    localStorage.clear();
  }
});

afterEach(() => {
  vi.useRealTimers();
});

describe("editorBuffer roundtrip", () => {
  test("write + read returns the buffer stamped with the session id", () => {
    writeEditorBuffer("notes/a.md", "hello", "notes/a.md");
    const buf = readEditorBuffer("notes/a.md");
    expect(buf).not.toBeNull();
    expect(buf!.content).toBe("hello");
    expect(buf!.path).toBe("notes/a.md");
    expect(buf!.sessionId).toBe(SESSION_ID);
    expect(typeof buf!.updatedAt).toBe("number");
  });

  test("read returns null when no entry", () => {
    expect(readEditorBuffer("notes/missing.md")).toBeNull();
  });

  test("clear removes the entry", () => {
    writeEditorBuffer("notes/a.md", "hello", "notes/a.md");
    clearEditorBuffer("notes/a.md");
    expect(readEditorBuffer("notes/a.md")).toBeNull();
  });

  test("bufferKey uses the expected namespace prefix", () => {
    expect(bufferKey("notes/a.md")).toBe("chan:editor-buffer:notes/a.md");
  });
});

describe("editorBuffer workspace namespacing", () => {
  afterEach(() => {
    workspace.info = null;
  });

  test("namespaces the key by workspace root so a same-relpath file in two workspaces does not collide", () => {
    workspace.info = { root: "/ws-a" } as unknown as WorkspaceInfo;
    const a = bufferKey("README.md");
    workspace.info = { root: "/ws-b" } as unknown as WorkspaceInfo;
    const b = bufferKey("README.md");
    expect(a).not.toBe(b);
    expect(a).toBe("chan:editor-buffer:/ws-a:README.md");
    expect(b).toBe("chan:editor-buffer:/ws-b:README.md");
  });

  test("falls back to the un-namespaced key when no workspace is mounted", () => {
    workspace.info = null;
    expect(bufferKey("README.md")).toBe("chan:editor-buffer:README.md");
  });
});

describe("editorBuffer malformed-entry recovery", () => {
  test("read returns null + clears entry when JSON is malformed", () => {
    localStorage.setItem(bufferKey("bad"), "not-json");
    expect(readEditorBuffer("bad")).toBeNull();
    expect(localStorage.getItem(bufferKey("bad"))).toBeNull();
  });

  test("read returns null + clears entry when a field has the wrong type", () => {
    localStorage.setItem(
      bufferKey("bad"),
      JSON.stringify({ content: "ok", updatedAt: "not-a-number", path: "x.md", sessionId: "s" }),
    );
    expect(readEditorBuffer("bad")).toBeNull();
    expect(localStorage.getItem(bufferKey("bad"))).toBeNull();
  });

  test("read returns null + clears entry when sessionId is missing", () => {
    localStorage.setItem(
      bufferKey("bad"),
      JSON.stringify({ content: "ok", updatedAt: Date.now(), path: "x.md" }),
    );
    expect(readEditorBuffer("bad")).toBeNull();
    expect(localStorage.getItem(bufferKey("bad"))).toBeNull();
  });
});

describe("editorBuffer TTL eviction in pruneEditorBuffers", () => {
  test("entries older than 7 days are evicted", () => {
    const eightDaysAgo = Date.now() - 8 * MS_PER_DAY;
    writeForeignBuffer("stale", "old", "x.md", eightDaysAgo);
    writeEditorBuffer("fresh", "new", "y.md");

    const evicted = pruneEditorBuffers();
    expect(evicted).toBe(1);
    expect(readEditorBuffer("stale")).toBeNull();
    expect(readEditorBuffer("fresh")).not.toBeNull();
  });

  test("entries within TTL are kept", () => {
    writeEditorBuffer("recent", "fresh", "x.md");
    const evicted = pruneEditorBuffers();
    expect(evicted).toBe(0);
    expect(readEditorBuffer("recent")).not.toBeNull();
  });

  test("non-buffer localStorage entries are not touched", () => {
    localStorage.setItem("unrelated-key", "value");
    writeEditorBuffer("recent", "fresh", "x.md");
    pruneEditorBuffers();
    expect(localStorage.getItem("unrelated-key")).toBe("value");
  });
});

describe("divergentBufferOrNull recovery decision", () => {
  test("returns null when no buffer exists", () => {
    expect(divergentBufferOrNull("notes/a.md", "notes/a.md", "disk")).toBeNull();
  });

  test("returns null when buffer content matches disk (clean state)", () => {
    writeForeignBuffer("notes/a.md", "same", "notes/a.md");
    expect(divergentBufferOrNull("notes/a.md", "notes/a.md", "same")).toBeNull();
  });

  test("returns null for the user's own current-session buffer even when it diverges", () => {
    // The false-banner bug: a buffer written this session is the live
    // edit (already in the editor), not a crashed prior session.
    writeEditorBuffer("notes/a.md", "my unsaved edit", "notes/a.md");
    expect(divergentBufferOrNull("notes/a.md", "notes/a.md", "disk")).toBeNull();
  });

  test("returns the buffer when a different session's content diverges", () => {
    writeForeignBuffer("notes/a.md", "recovered", "notes/a.md");
    const buf = divergentBufferOrNull("notes/a.md", "notes/a.md", "disk");
    expect(buf).not.toBeNull();
    expect(buf!.content).toBe("recovered");
  });

  test("clears + returns null when the buffer's path doesn't match the tab", () => {
    writeForeignBuffer("notes/a.md", "from-other-file", "notes/old.md");
    expect(divergentBufferOrNull("notes/a.md", "notes/new.md", "disk")).toBeNull();
    expect(readEditorBuffer("notes/a.md")).toBeNull();
  });

  test("returns a diverging buffer however long ago it was stamped, and leaves it stored", () => {
    writeForeignBuffer("notes/a.md", "older work", "notes/a.md", Date.now() - MS_PER_DAY);
    expect(divergentBufferOrNull("notes/a.md", "notes/a.md", "disk")?.content).toBe("older work");
    expect(readEditorBuffer("notes/a.md")?.content).toBe("older work");
  });
});

describe("editorBuffer queued-write debounce + flush", () => {
  test("queueBufferWrite delays the actual localStorage write", () => {
    vi.useFakeTimers();
    queueBufferWrite("notes/a.md", "draft", "notes/a.md");
    expect(readEditorBuffer("notes/a.md")).toBeNull();
    vi.advanceTimersByTime(500);
    const buf = readEditorBuffer("notes/a.md");
    expect(buf).not.toBeNull();
    expect(buf!.content).toBe("draft");
  });

  test("queueBufferWrite latest call wins when called repeatedly", () => {
    vi.useFakeTimers();
    queueBufferWrite("notes/a.md", "first", "notes/a.md");
    queueBufferWrite("notes/a.md", "second", "notes/a.md");
    queueBufferWrite("notes/a.md", "third", "notes/a.md");
    vi.advanceTimersByTime(500);
    expect(readEditorBuffer("notes/a.md")!.content).toBe("third");
  });

  test("cancelPendingBufferWrite cancels the in-flight timer", () => {
    vi.useFakeTimers();
    queueBufferWrite("notes/a.md", "draft", "notes/a.md");
    cancelPendingBufferWrite("notes/a.md");
    vi.advanceTimersByTime(500);
    expect(readEditorBuffer("notes/a.md")).toBeNull();
  });

  test("flushPendingBufferWrites synchronously persists all in-flight writes", () => {
    vi.useFakeTimers();
    queueBufferWrite("notes/a.md", "draft-1", "notes/a.md");
    queueBufferWrite("notes/b.md", "draft-2", "notes/b.md");
    queueBufferWrite("notes/c.md", "draft-3", "notes/c.md");
    expect(readEditorBuffer("notes/a.md")).toBeNull();
    const flushed = flushPendingBufferWrites();
    expect(flushed).toBe(3);
    expect(readEditorBuffer("notes/a.md")!.content).toBe("draft-1");
    expect(readEditorBuffer("notes/b.md")!.content).toBe("draft-2");
    expect(readEditorBuffer("notes/c.md")!.content).toBe("draft-3");
  });

  test("flushPendingBufferWrites is idempotent: second call returns 0", () => {
    vi.useFakeTimers();
    queueBufferWrite("notes/a.md", "draft", "notes/a.md");
    expect(flushPendingBufferWrites()).toBe(1);
    expect(flushPendingBufferWrites()).toBe(0);
  });
});

describe("editorBuffer path-keyed buffers survive a reload", () => {
  test("a buffer written under a path key is readable by the same path after reload", () => {
    // Path keys are stable across reloads (tab ids are not), so the
    // remounted tab passes the same key and the lookup matches.
    writeEditorBuffer("notes/a.md", "draft", "notes/a.md");
    expect(readEditorBuffer("notes/a.md")?.content).toBe("draft");
  });
});

// Walk the create -> type -> autosave -> save -> remount -> reload
// lifecycle through the same calls FileEditorTab makes, asserting the
// banner verdict at each step. It holds the banner to one rule: the
// user's own edits never raise it, a crashed prior session does.
describe("editorBuffer draft lifecycle", () => {
  test("own-session edits never raise the banner; a prior session does", () => {
    vi.useFakeTimers();
    const path = ".Drafts/untitled-1.md";
    const seed = "# Draft\n";

    // Freshly seeded draft: editor matches disk, nothing persisted.
    expect(divergentBufferOrNull(path, path, seed)).toBeNull();

    // User types; autosave fires after the debounce.
    queueBufferWrite(path, "# Draft\nhello", path);
    vi.advanceTimersByTime(500);

    // Remount in the SAME session (tab swap / component remount): the
    // edit is live, not a recovery candidate.
    expect(divergentBufferOrNull(path, path, seed)).toBeNull();

    // Save: disk now matches the editor, so even a divergence check
    // against the new disk content yields nothing.
    expect(divergentBufferOrNull(path, path, "# Draft\nhello")).toBeNull();

    // A crash + force-reload strands a buffer from a previous load that
    // postdates the seed-era save: that is a genuine recovery.
    writeForeignBuffer(path, "# Draft\nrecovered work", path);
    const buf = divergentBufferOrNull(path, path, seed);
    expect(buf).not.toBeNull();
    expect(buf!.content).toBe("# Draft\nrecovered work");
  });
});
