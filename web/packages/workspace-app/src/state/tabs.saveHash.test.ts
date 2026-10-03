// @vitest-environment jsdom
//
// A file tab's save on the standalone Files surface, over the real request
// layer: the PUT carries the hash of the text the tab's last load or accepted
// save left it, so a write over bytes the tab did not load is refused though
// the file's token did not move, and the write Overwrite frees carries none.
// The fetch below answers as the standalone routes do: a read streams the
// file's text under its token, and a write whose token differs, or whose hash
// differs from the file's text, gets the route's conflict. No test here waits
// on a timer: a write held on the wire is released by the test.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  conflictDialog,
  dismissConflict,
  layout,
  liveFileTabById,
  moveTab,
  overwriteConflictedTab,
  registerClassicSaveWatch,
  reloadTabFromDisk,
  saveTab,
  type FileTab,
} from "./tabs.svelte";
import { fileTab, readTab, resetLayout } from "../__tests__/tabs";

// Node's WebCrypto and hash, typed here: the package declares no types for
// Node's modules, and jsdom's `crypto` has no `subtle`.
const { createHash, webcrypto } = await vi.importActual<{
  createHash(algorithm: string): { update(text: string, encoding: string): { digest(encoding: string): string } };
  webcrypto: Crypto;
}>("node:crypto");

const TAB = "hash-tab";
const PATH = "notes/a.md";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/// SHA-256 of "loaded", as the server's own vectors have it.
const SHA_LOADED = "2cab953f2b3607b36259abeb3703329d6b301b31277402ebf9f2b3b93e31dd53";

type Put = { token: string | null; sha: string | null; body: string };

const file = { text: "loaded", token: "100" };
let puts: Put[] = [];
/// Set by `holdNextWrite`: the next write waits on it once it is recorded.
let gate: { arrived: () => void; released: Promise<void> } | null = null;
let failNextRead = false;
/// What the watch this file registers answers for the tab.
let watchWaits = false;

registerClassicSaveWatch({
  waitsOnSave: (tabId) => watchWaits && tabId === TAB,
  saveEnded: () => {},
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function serveFile(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    if (!url.pathname.startsWith("/api/fs/")) return json(200, {});
    if ((init?.method ?? "GET") === "GET") {
      if (failNextRead) {
        failNextRead = false;
        return json(500, { error: "read failed" });
      }
      const frames = [
        { type: "meta", path: PATH, size: file.text.length, mtime: 1, mtime_ns: file.token, writable: true },
        { type: "chunk", content: file.text, bytes: file.text.length },
        { type: "done" },
      ];
      return new Response(frames.map((frame) => JSON.stringify(frame) + "\n").join(""), { status: 200 });
    }
    const put = {
      token: url.searchParams.get("expected_mtime_ns"),
      sha: url.searchParams.get("expected_sha256"),
      body: String(init?.body ?? ""),
    };
    puts.push(put);
    if (gate) {
      const held = gate;
      gate = null;
      held.arrived();
      await held.released;
    }
    const stale = put.token !== null && put.token !== file.token;
    if (stale || (put.sha !== null && put.sha !== sha256(file.text))) {
      return json(409, {
        error: "file changed on disk since it was read",
        code: "write_conflict",
        current_mtime: 1,
        current_mtime_ns: file.token,
        disk_conflicted: false,
      });
    }
    file.text = put.body;
    file.token = String(Number(file.token) + 1);
    return json(200, { mtime: 1, mtime_ns: file.token });
  });
}

/// Hold the next write on the wire. Resolves once that write is recorded,
/// with the function that lets it be answered.
function holdNextWrite(): Promise<() => void> {
  return new Promise((onTheWire) => {
    let release = (): void => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    gate = { arrived: () => onTheWire(release), released };
  });
}

function standaloneWindow(on: boolean): void {
  document.head.querySelector('meta[name="chan-files"]')?.remove();
  if (!on) {
    window.history.replaceState(null, "", "/?t=token&w=w-ws");
    return;
  }
  const meta = document.createElement("meta");
  meta.setAttribute("name", "chan-files");
  meta.setAttribute("content", "1");
  document.head.appendChild(meta);
  window.history.replaceState(null, "", "/?t=token&w=w-files&kind=terminal");
}

/// A tab in the layout that has read the file through the stream reader,
/// beside a second tab so a move leaves its side of the pane with one.
async function loadedTab(): Promise<FileTab> {
  const tab = fileTab({ id: TAB, path: PATH, content: "", saved: "", savedMtime: null, mode: "source" });
  resetLayout([tab, fileTab({ id: "other-tab", path: "notes/other.md" })]);
  await reloadTabFromDisk(tab.id);
  return readTab(tab.id)!;
}

function held(t: FileTab): { content: string; saved: string; token: string | null } {
  return { content: t.content, saved: t.saved, token: t.savedMtimeNs ?? null };
}

beforeEach(() => {
  Object.assign(file, { text: "loaded", token: "100" });
  puts = [];
  gate = null;
  failNextRead = false;
  watchWaits = false;
  standaloneWindow(true);
  vi.stubGlobal("crypto", webcrypto);
  serveFile();
});

afterEach(() => {
  dismissConflict();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.head.querySelector('meta[name="chan-files"]')?.remove();
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
});

describe("a standalone tab's save carries the hash of the text it loaded", () => {
  test("a save over bytes the tab did not load is refused though the token did not move", async () => {
    const t = await loadedTab();
    expect(held(t)).toEqual({ content: "loaded", saved: "loaded", token: "100" });
    // Another writer replaces the file's text and its token stays.
    file.text = "theirs";
    t.content = "loaded and mine";
    await saveTab(t);

    expect(puts).toEqual([{ token: "100", sha: SHA_LOADED, body: "loaded and mine" }]);
    expect({ prompt: conflictDialog.open, promptTab: conflictDialog.tabId, file: file.text, ...held(t) }).toEqual({
      prompt: true,
      promptTab: TAB,
      file: "theirs",
      content: "loaded and mine",
      saved: "loaded",
      token: "100",
    });
  });

  test("Overwrite's write carries the conflict's token and no hash, and the save after it the hash of what it wrote", async () => {
    const t = await loadedTab();
    Object.assign(file, { text: "theirs", token: "150" });
    t.content = "loaded and mine";
    await saveTab(t);
    expect({ prompt: conflictDialog.open, current: conflictDialog.currentMtimeNs }).toEqual({
      prompt: true,
      current: "150",
    });
    await overwriteConflictedTab();
    expect({ prompt: conflictDialog.open, file: file.text, ...held(t) }).toEqual({
      prompt: false,
      file: "loaded and mine",
      content: "loaded and mine",
      saved: "loaded and mine",
      token: "151",
    });
    t.content = "loaded and mine, again";
    await saveTab(t);

    expect(puts).toEqual([
      { token: "100", sha: SHA_LOADED, body: "loaded and mine" },
      { token: "150", sha: null, body: "loaded and mine" },
      { token: "151", sha: sha256("loaded and mine"), body: "loaded and mine, again" },
    ]);
    expect(file.text).toBe("loaded and mine, again");
  });

  test("the write Overwrite frees carries no hash when another save is on the wire at the click", async () => {
    const t = await loadedTab();
    file.text = "theirs";
    t.content = "loaded and mine";
    await saveTab(t);
    expect(conflictDialog.open, "the first save is refused").toBe(true);

    const onTheWire = holdNextWrite();
    const second = saveTab(t);
    const release = await onTheWire;
    const overwrite = overwriteConflictedTab();
    release();
    await Promise.all([second, overwrite]);

    // The save on the wire carried the hash and is refused as the first one
    // was; the write that follows it is Overwrite's.
    expect(puts.slice(1)).toEqual([
      { token: "100", sha: SHA_LOADED, body: "loaded and mine" },
      { token: "100", sha: null, body: "loaded and mine" },
    ]);
    expect({ file: file.text, ...held(t) }).toEqual({
      file: "loaded and mine",
      content: "loaded and mine",
      saved: "loaded and mine",
      token: "101",
    });
  });

  test("a move between Overwrite's click and its write changes nothing of that write", async () => {
    const t = await loadedTab();
    Object.assign(file, { text: "theirs", token: "150" });
    t.content = "loaded and mine";
    await saveTab(t);
    expect(conflictDialog.open, "the first save is refused").toBe(true);

    const onTheWire = holdNextWrite();
    const second = saveTab(t);
    const release = await onTheWire;
    const overwrite = overwriteConflictedTab();
    moveTab(layout.activePaneId, TAB, layout.activePaneId, 0, { fromSide: "a", toSide: "b" });
    release();
    await Promise.all([second, overwrite]);

    const pane = layout.nodes[layout.activePaneId];
    if (pane?.kind !== "leaf") throw new Error("expected a leaf pane");
    const moved = liveFileTabById(TAB)!;
    expect({ a: pane.tabs.map((tab) => tab.id), b: (pane.bTabs ?? []).map((tab) => tab.id) }).toEqual({
      a: ["other-tab"],
      b: [TAB],
    });
    expect(puts.slice(1)).toEqual([
      { token: "100", sha: SHA_LOADED, body: "loaded and mine" },
      { token: "150", sha: null, body: "loaded and mine" },
    ]);
    expect({ file: file.text, ...held(moved) }).toEqual({
      file: "loaded and mine",
      content: "loaded and mine",
      saved: "loaded and mine",
      token: "151",
    });

    moved.content = "loaded and mine, again";
    await saveTab(moved);
    expect(puts.at(-1)).toEqual({ token: "151", sha: sha256("loaded and mine"), body: "loaded and mine, again" });
  });

  test("the write that follows Overwrite's in the same run carries the hash of what Overwrite wrote", async () => {
    const t = await loadedTab();
    Object.assign(file, { text: "theirs", token: "150" });
    t.content = "loaded and mine";
    await saveTab(t);
    expect(conflictDialog.open, "the first save is refused").toBe(true);

    const onTheWire = holdNextWrite();
    const overwrite = overwriteConflictedTab();
    const release = await onTheWire;
    // Typed and saved while Overwrite's write is on the wire.
    t.content = "loaded and mine, more";
    const again = saveTab(t);
    release();
    await Promise.all([overwrite, again]);

    expect(puts.slice(1)).toEqual([
      { token: "150", sha: null, body: "loaded and mine" },
      { token: "151", sha: sha256("loaded and mine"), body: "loaded and mine, more" },
    ]);
    expect({ file: file.text, ...held(t) }).toEqual({
      file: "loaded and mine, more",
      content: "loaded and mine, more",
      saved: "loaded and mine, more",
      token: "152",
    });
  });

  test("an Overwrite whose run sent no write of its own frees none later", async () => {
    const t = await loadedTab();
    file.text = "theirs";
    t.content = "loaded and mine";
    await saveTab(t);
    expect(conflictDialog.open, "the first save is refused").toBe(true);

    // The other writer puts the loaded text back, so the save on the wire at
    // the click is accepted and leaves the tab nothing to write.
    file.text = "loaded";
    const onTheWire = holdNextWrite();
    const second = saveTab(t);
    const release = await onTheWire;
    const overwrite = overwriteConflictedTab();
    release();
    await Promise.all([second, overwrite]);
    expect({ file: file.text, ...held(t) }).toEqual({
      file: "loaded and mine",
      content: "loaded and mine",
      saved: "loaded and mine",
      token: "101",
    });

    // A later change that keeps the token is refused as any other.
    file.text = "theirs again";
    t.content = "loaded and mine, more";
    await saveTab(t);
    expect(puts.slice(1)).toEqual([
      { token: "100", sha: SHA_LOADED, body: "loaded and mine" },
      { token: "101", sha: sha256("loaded and mine"), body: "loaded and mine, more" },
    ]);
    expect({ prompt: conflictDialog.open, file: file.text, ...held(t) }).toEqual({
      prompt: true,
      file: "theirs again",
      content: "loaded and mine, more",
      saved: "loaded and mine",
      token: "101",
    });
  });

  test("the refusal of a save that carried the loaded text opens the prompt though a watch waits on that save", async () => {
    const t = await loadedTab();
    file.text = "theirs";
    t.content = "loaded and mine";
    watchWaits = true;
    await saveTab(t);

    expect(puts).toEqual([{ token: "100", sha: SHA_LOADED, body: "loaded and mine" }]);
    expect({ prompt: conflictDialog.open, promptTab: conflictDialog.tabId, file: file.text, ...held(t) }).toEqual({
      prompt: true,
      promptTab: TAB,
      file: "theirs",
      content: "loaded and mine",
      saved: "loaded",
      token: "100",
    });
  });

  // Guards: each holds with or without the hash.
  test("a tab whose load failed holds no token and sends no hash", async () => {
    failNextRead = true;
    const t = await loadedTab();
    expect({ failed: t.error !== null, token: t.savedMtimeNs ?? null }).toEqual({ failed: true, token: null });
    t.content = "typed over a failed load";
    await saveTab(t);
    expect(puts).toEqual([{ token: null, sha: null, body: "typed over a failed load" }]);
  });

  test("a tab that never loaded a file holds no token and sends no hash", async () => {
    const tab = fileTab({ id: TAB, path: PATH, content: "new", saved: "", savedMtime: null, mode: "source" });
    resetLayout([tab]);
    await saveTab(readTab(tab.id)!);
    expect(puts).toEqual([{ token: null, sha: null, body: "new" }]);
  });

  test("a workspace window's save sends no hash", async () => {
    const t = await loadedTab();
    standaloneWindow(false);
    t.content = "loaded and mine";
    await saveTab(t);
    expect(puts).toEqual([{ token: "100", sha: null, body: "loaded and mine" }]);
  });

  test("a workspace window's refused save opens no prompt while a watch waits on it", async () => {
    const t = await loadedTab();
    standaloneWindow(false);
    Object.assign(file, { text: "theirs", token: "150" });
    t.content = "loaded and mine";
    watchWaits = true;
    await saveTab(t);
    expect(puts).toEqual([{ token: "100", sha: null, body: "loaded and mine" }]);
    expect({ prompt: conflictDialog.open, file: file.text, ...held(t) }).toEqual({
      prompt: false,
      file: "theirs",
      content: "loaded and mine",
      saved: "loaded",
      token: "100",
    });
  });
});
