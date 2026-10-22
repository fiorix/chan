// @vitest-environment jsdom

// The saved file's tree entry, which the Details card reads, follows the
// file's disk state as a save reports it: a live session's flush frame and
// snapshot (doc and scene) and a classic save's answer give the entry their
// modified time and size, since a save through a session sends no watch frame
// and only a listing writes the tree otherwise.

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../api/client";
import { setSocketFactory } from "../api/transport";
import type { TreeEntry } from "../api/types";
import { acquireDocSession, resetDocSyncForTests } from "./docSync.svelte";
import { acquireSceneSession, resetSceneSyncForTests } from "./sceneSync.svelte";
import { tree } from "./store.svelte";
import { saveTab, type FileTab } from "./tabs.svelte";
import { fileTab, readTab, resetLayout } from "../__tests__/tabs";

class FakeSocket {
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  frame(f: unknown): void {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

const sockets: FakeSocket[] = [];

const DOC = "notes/a.md";
const SCENE = "boards/b.excalidraw";
const LISTED = { mtime: 1_700_000_000, size: 5 };
const SNAP_NS = "1751234567890123456";
const SNAP_S = 1_751_234_567;
const FLUSH_NS = "1751234999000000001";
const FLUSH_S = 1_751_234_999;

const SCENE_BUFFER = JSON.stringify({
  type: "excalidraw",
  version: 2,
  source: "test",
  elements: [],
  appState: {},
  files: {},
});

function listed(path: string): TreeEntry {
  return { path, is_dir: false, kind: "document", ...LISTED };
}

function entryOf(path: string): TreeEntry | undefined {
  return tree.entries.find((e) => e.path === path);
}

/// Install `tab` alone in the layout and hand back the object the layout
/// holds, which is the one production hands a session or a save.
function installed(tab: FileTab): FileTab {
  resetLayout([tab]);
  return readTab(tab.id)!;
}

function docSnap(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "snapshot",
    path: DOC,
    version: 0,
    doc: "hello",
    dirty: false,
    conflicted: false,
    mtime_ns: SNAP_NS,
    size: 9,
    cursors: [],
    ...extra,
  };
}

function sceneSnap(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "snapshot",
    path: SCENE,
    version: 0,
    elements: [],
    appState: {},
    files: {},
    dirty: false,
    conflicted: false,
    mtime_ns: SNAP_NS,
    size: 263,
    cursors: [],
    ...extra,
  };
}

/// A doc session on a clean document tab, its socket open.
function docSocket(): FakeSocket {
  const tab = installed(fileTab({ id: "doc-tab", path: DOC, content: "hello", saved: "hello", mode: "source" }));
  expect(acquireDocSession(tab)).not.toBeNull();
  const sock = sockets[sockets.length - 1]!;
  sock.open();
  return sock;
}

/// A scene session on a clean drawing tab, its socket open.
function sceneSocket(): FakeSocket {
  const tab = installed(
    fileTab({
      id: "scene-tab",
      fileKind: "text",
      path: SCENE,
      content: SCENE_BUFFER,
      saved: SCENE_BUFFER,
      mode: "canvas",
    }),
  );
  expect(acquireSceneSession(tab)).not.toBeNull();
  const sock = sockets[sockets.length - 1]!;
  sock.open();
  return sock;
}

beforeEach(() => {
  localStorage.setItem("chan.docsync", "1");
  localStorage.setItem("chan.scenesync", "1");
  sockets.length = 0;
  setSocketFactory((url) => new FakeSocket(url) as unknown as WebSocket);
  tree.entries = [listed(DOC), listed(SCENE)];
});

afterEach(() => {
  resetDocSyncForTests();
  resetSceneSyncForTests();
  setSocketFactory(null);
  vi.restoreAllMocks();
  localStorage.clear();
  tree.entries = [];
});

test("a doc session's flush frame gives the entry the saved time and size", () => {
  const sock = docSocket();
  sock.frame(docSnap());
  sock.frame({ type: "flush", dirty: false, mtime_ns: FLUSH_NS, size: 12 });
  expect(entryOf(DOC), "the entry after the flush frame").toMatchObject({ mtime: FLUSH_S, size: 12 });
});

test("a doc session's snapshot gives the entry the authority's time and size", () => {
  const sock = docSocket();
  sock.frame(docSnap());
  expect(entryOf(DOC), "the entry after the snapshot").toMatchObject({ mtime: SNAP_S, size: 9 });
});

test("a scene session's flush frame gives the entry the saved time and size", () => {
  const sock = sceneSocket();
  sock.frame(sceneSnap());
  sock.frame({ type: "flush", dirty: false, mtime_ns: FLUSH_NS, size: 301 });
  expect(entryOf(SCENE), "the entry after the flush frame").toMatchObject({ mtime: FLUSH_S, size: 301 });
});

test("a scene session's snapshot gives the entry the authority's time and size", () => {
  const sock = sceneSocket();
  sock.frame(sceneSnap());
  expect(entryOf(SCENE), "the entry after the snapshot").toMatchObject({ mtime: SNAP_S, size: 263 });
});

test("a classic save's answer gives the entry its time and the UTF-8 bytes written", async () => {
  // Seven UTF-16 code units, ten UTF-8 bytes on disk.
  const tab = installed(fileTab({ id: "classic-tab", path: DOC, content: "h\u00e9llo \u2713", saved: "old" }));
  const write = vi.spyOn(api, "write").mockResolvedValue({ mtime: FLUSH_S, mtime_ns: FLUSH_NS });
  await saveTab(tab);
  expect(write).toHaveBeenCalledOnce();
  expect(entryOf(DOC), "the entry after the answer").toMatchObject({ mtime: FLUSH_S, size: 10 });
});

test("a classic save a live session took gives the entry its time and leaves the size", async () => {
  // The session writes its own file form, whose size the answer cannot know.
  const tab = installed(fileTab({ id: "diverted-tab", path: DOC, content: "hello there", saved: "old" }));
  vi.spyOn(api, "write").mockResolvedValue({ mtime: FLUSH_S, mtime_ns: FLUSH_NS, authority_version: 4 });
  await saveTab(tab);
  expect(entryOf(DOC), "the entry after the diverted answer").toMatchObject({ mtime: FLUSH_S, size: LISTED.size });
});

test("a flush frame without a size leaves the entry's size", () => {
  const sock = docSocket();
  sock.frame(docSnap({ size: undefined }));
  sock.frame({ type: "flush", dirty: false, mtime_ns: FLUSH_NS });
  expect(entryOf(DOC)?.size, "the size after a sizeless flush frame").toBe(LISTED.size);
});

test("a frame with no token leaves the entry", () => {
  const sock = docSocket();
  sock.frame(docSnap({ mtime_ns: null, size: undefined }));
  expect(entryOf(DOC), "the entry after a tokenless snapshot").toMatchObject(LISTED);
});

test("a conflicted doc session's frames leave the entry", () => {
  const sock = docSocket();
  // The token and size of a conflicted authority are its last flush's, not
  // the disk's the conflict found.
  sock.frame(docSnap({ conflicted: true }));
  expect(entryOf(DOC), "the entry after a conflicted snapshot").toMatchObject(LISTED);
  // A reattach across a conflict restates it ahead of the flush frame.
  sock.frame({ type: "conflict", active: true, disk_mtime_ns: "1751235555000000000" });
  sock.frame({ type: "flush", dirty: true, mtime_ns: SNAP_NS, size: 9 });
  expect(entryOf(DOC), "the entry after a flush frame in a conflict").toMatchObject(LISTED);
});

test("a conflicted scene session's snapshot leaves the entry", () => {
  const sock = sceneSocket();
  // A scene session restates its conflict in every snapshot, its only
  // frame to a window that attaches.
  sock.frame(sceneSnap({ conflicted: true }));
  expect(entryOf(SCENE), "the entry after a conflicted snapshot").toMatchObject(LISTED);
});

test("a frame for a file the tree does not hold changes no entry", () => {
  tree.entries = [listed(SCENE)];
  const sock = docSocket();
  sock.frame(docSnap());
  sock.frame({ type: "flush", dirty: false, mtime_ns: FLUSH_NS, size: 12 });
  expect(tree.entries, "the tree after frames for an unlisted file").toEqual([listed(SCENE)]);
});
