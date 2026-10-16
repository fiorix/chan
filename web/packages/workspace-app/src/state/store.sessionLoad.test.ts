// @vitest-environment jsdom

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { GlobalConfig, TerminalRosterEntry } from "../api/types";
import { preferences, serveMeta } from "../__tests__/standalone";

const apiConfig = vi.fn<() => Promise<GlobalConfig>>();
const getSession = vi.fn<() => Promise<unknown>>();
const putSession = vi.fn<(payload: unknown) => Promise<void>>();
const deleteSession = vi.fn<() => Promise<void>>();
const workspace = vi.fn<() => Promise<unknown>>();
const terminalRoster = vi.fn<() => Promise<TerminalRosterEntry[]>>();
const socket = vi.hoisted(() => ({ ready: null as (() => void) | null }));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      config: () => apiConfig(),
      workspace: () => workspace(),
      list: () => Promise.resolve([]),
      indexStatus: () => new Promise(() => {}),
      extensions: () => Promise.resolve([]),
      health: () => Promise.resolve({ instance: "a" }),
      terminalRoster: () => terminalRoster(),
      getSession: () => getSession(),
      putSession: (payload: unknown) => putSession(payload),
      deleteSession: () => deleteSession(),
    },
    openWatchSocket: (_onEvent: unknown, _onStatus: unknown, onReady?: () => void) => {
      socket.ready = onReady ?? null;
      return Object.assign(() => {}, {
        subscribeDir() {},
        unsubscribeDir() {},
        reportTransfers() {},
      });
    },
  };
});

type Leaf = { k: "l"; t: { k: "t"; n: string; tsid?: string }[] };

/// The server's stored blob: a GET reads it and a PUT replaces it.
let stored: unknown = null;

function serveStored(blob: unknown): void {
  stored = blob;
  getSession.mockImplementation(async () => structuredClone(stored));
  putSession.mockImplementation(async (payload) => {
    stored = structuredClone(payload);
  });
}

function leaf(...tabs: [string, string | null][]): Leaf {
  return { k: "l", t: tabs.map(([n, tsid]) => (tsid ? { k: "t", n, tsid } : { k: "t", n })) };
}

function split(a: Leaf, b: Leaf) {
  return { k: "s", d: "r", a, b };
}

function storedIds(): string[] {
  const text = JSON.stringify(stored ?? null);
  return [...text.matchAll(/"tsid":"([^"]+)"/g)].map((m) => m[1]!);
}

function rosterEntry(id: string, name: string, windowId: string): TerminalRosterEntry {
  return { id, tab_name: name, tab_group: "default", window_id: windowId, broadcast: false };
}

/// The page's terminal tabs in tree order, both sides of every pane.
async function pageTerminals(): Promise<{ title: string; id: string | undefined }[]> {
  const { layout } = await import("./tabs.svelte");
  const out: { title: string; id: string | undefined }[] = [];
  const walk = (nodeId: string): void => {
    const node = layout.nodes[nodeId];
    if (!node) return;
    if (node.kind === "split") {
      walk(node.a);
      walk(node.b);
      return;
    }
    for (const tab of [...node.tabs, ...(node.bTabs ?? [])]) {
      if (tab.kind === "terminal") out.push({ title: tab.title, id: tab.terminalSessionId });
    }
  };
  walk(layout.rootId);
  return out;
}

async function pageIds(): Promise<(string | undefined)[]> {
  return (await pageTerminals()).map((t) => t.id);
}

function withHash(path: string, layout: unknown): string {
  return `${path}#s=${encodeURIComponent(JSON.stringify(layout))}`;
}

function reloadSnapshot(windowId: string, layout: unknown): void {
  sessionStorage.setItem(`chan.layout.reload:${windowId}`, JSON.stringify(layout));
}

/// The mark the page's previous document of this window left in its tab at
/// pagehide.
function ownReload(windowId: string): void {
  sessionStorage.setItem(`chan.layout.ownReload:${windowId}`, "1");
}

function pageshow(persisted: boolean): void {
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted }));
}

/// The page lifecycle listeners each test's store installs, removed after the
/// test so a later test's pagehide or pageshow reaches its own page alone.
const lifecycleListeners: [string, EventListenerOrEventListenerObject][] = [];

beforeEach(() => {
  const addListener = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
    if (type === "pagehide" || type === "pageshow") lifecycleListeners.push([type, listener]);
    addListener(type, listener, options);
  });
  vi.resetModules();
  getSession.mockReset().mockResolvedValue(null);
  putSession.mockReset().mockResolvedValue(undefined);
  deleteSession.mockReset().mockResolvedValue(undefined);
  workspace.mockReset();
  terminalRoster.mockReset().mockResolvedValue([]);
  apiConfig.mockResolvedValue({ revision: 1, preferences: preferences(), workspaces: [] });
  stored = null;
  sessionStorage.clear();
  localStorage.clear();
  serveMeta("chan-files", false);
  serveMeta("chan-drafts", false);
});

afterEach(() => {
  for (const [type, listener] of lifecycleListeners.splice(0)) window.removeEventListener(type, listener);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("a standalone window that loaded no blob sends no DELETE at its first save", async () => {
  window.history.replaceState({}, "", "/?kind=terminal&w=w-empty&seed=0");
  const store = await import("./store.svelte");
  await store.bootstrap();

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  store.scheduleSessionSave();
  await vi.advanceTimersByTimeAsync(750);
  expect(deleteSession).not.toHaveBeenCalled();
});

test("a failed session read sends no DELETE at the first empty save", async () => {
  window.history.replaceState({}, "", "/?kind=terminal&w=w-read-failed&seed=0");
  getSession.mockRejectedValueOnce(new Error("session unavailable"));
  const store = await import("./store.svelte");
  await store.bootstrap();
  expect(getSession).toHaveBeenCalledTimes(1);
  expect(store.ui.status).toBe("restore failed: session unavailable");

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  store.scheduleSessionSave();
  await vi.advanceTimersByTimeAsync(750);
  expect(deleteSession).not.toHaveBeenCalled();
});

test("a workspace boot stopped before its session read sends no DELETE at its first empty save", async () => {
  window.history.replaceState({}, "", "/?w=w-before-read");
  const store = await import("./store.svelte");
  const { ApiError } = await import("../api/errors");
  workspace.mockRejectedValue(new ApiError(401, "unauthorized"));
  await store.bootstrap();
  expect(workspace).toHaveBeenCalled();
  expect(getSession).not.toHaveBeenCalled();

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  store.scheduleSessionSave();
  await vi.advanceTimersByTimeAsync(750);
  expect(deleteSession).not.toHaveBeenCalled();
});

test("a standalone window that read a blob deletes it at its first empty save", async () => {
  window.history.replaceState({}, "", "/?kind=terminal&w=w-blob&seed=0");
  getSession.mockResolvedValueOnce({});
  const store = await import("./store.svelte");
  await store.bootstrap();
  expect(getSession).toHaveBeenCalledTimes(1);

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  store.scheduleSessionSave();
  await vi.advanceTimersByTimeAsync(750);
  expect(deleteSession).toHaveBeenCalledTimes(1);
});

test("a standalone window applies a layout a peer saved before its socket was ready", async () => {
  window.history.replaceState({}, "", "/?kind=terminal&w=w-read-back&seed=0");
  const store = await import("./store.svelte");
  await store.bootstrap();
  expect(getSession).toHaveBeenCalledTimes(1);

  getSession.mockResolvedValue({
    layout: { k: "s", d: "r", a: { k: "l", t: [] }, b: { k: "l", t: [] } },
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  socket.ready?.();
  await vi.advanceTimersByTimeAsync(250);
  expect(getSession).toHaveBeenCalledTimes(2);
  const { layout } = await import("./tabs.svelte");
  expect(Object.values(layout.nodes).filter((node) => node.kind === "leaf")).toHaveLength(2);

  store.scheduleSessionSave();
  await vi.advanceTimersByTimeAsync(750);
  expect(putSession).not.toHaveBeenCalled();
  expect(deleteSession).not.toHaveBeenCalled();
});

const workspaceInfo = { root: "/ws", label: "ws", metadata_key: null, preferences: preferences(), warnings: [] };

/// Boot a page, then let its socket come up with a save scheduled, as App's
/// layout effect schedules one once the boot has hydrated, and the first
/// ready's read run.
async function bootAndSettle(path: string, peerSave?: unknown): Promise<typeof import("./store.svelte")> {
  window.history.replaceState({}, "", path);
  const store = await import("./store.svelte");
  await store.bootstrap();
  if (peerSave !== undefined) stored = peerSave;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  store.scheduleSessionSave();
  socket.ready?.();
  await vi.advanceTimersByTimeAsync(1_250);
  return store;
}

// A second page of the window boots on the layout as the first page last saved
// it; the first page's save of a new tab lands after that read and before the
// second page's socket subscribes, so only the first ready's read can see it.
const twoTabs = () => ({ layout: leaf(["one", "s-1"], ["two", "s-2"]) });
const threeTabs = () => ({ layout: leaf(["one", "s-1"], ["two", "s-2"], ["cover", "s-3"]) });

test("a standalone page loading into a window keeps the tab a peer saved before its socket was ready", async () => {
  serveStored(twoTabs());
  await bootAndSettle("/?kind=terminal&w=w-coview&seed=0", threeTabs());

  expect(putSession, "the loading page writes back nothing it read").not.toHaveBeenCalled();
  expect(storedIds(), "the shared layout keeps the peer's tab").toEqual(["s-1", "s-2", "s-3"]);
  expect(await pageIds(), "the loading page shows the peer's tab").toEqual(["s-1", "s-2", "s-3"]);
});

test("a workspace page loading into a window keeps the tab a peer saved before its socket was ready", async () => {
  workspace.mockResolvedValue(workspaceInfo);
  serveStored(twoTabs());
  await bootAndSettle("/?w=w-coview-workspace", threeTabs());

  expect(putSession, "the loading page writes back nothing it read").not.toHaveBeenCalled();
  expect(storedIds(), "the shared layout keeps the peer's tab").toEqual(["s-1", "s-2", "s-3"]);
  expect(await pageIds(), "the loading page shows the peer's tab").toEqual(["s-1", "s-2", "s-3"]);
});

test("a page booted from the blob that changes nothing writes nothing at exit", async () => {
  window.history.replaceState({}, "", "/?kind=terminal&w=w-exit&seed=0");
  serveStored({ layout: leaf(["one", "s-1"]) });
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 204 }));
  const store = await import("./store.svelte");
  store.installSessionFlushHook();
  await store.bootstrap();

  window.dispatchEvent(new Event("pagehide"));

  const exitWrites = fetchSpy.mock.calls.filter(([, init]) => init?.method === "PUT" || init?.method === "DELETE");
  expect(exitWrites, "the server already holds the layout").toHaveLength(0);
});

test("a page booted from the blob writes its layout once it changes it", async () => {
  window.history.replaceState({}, "", "/?kind=terminal&w=w-change&seed=0");
  serveStored({ layout: leaf(["one", "s-1"]) });
  const store = await import("./store.svelte");
  await store.bootstrap();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { layout } = await import("./tabs.svelte");

  layout.focusColor = "green";
  store.scheduleSessionSave();
  await vi.advanceTimersByTimeAsync(750);

  expect(putSession).toHaveBeenCalledTimes(1);
  expect((stored as { layout: { wc?: string } }).layout.wc).toBe("g");
});

test("a page's own reload restores its hash over the blob and writes it", async () => {
  ownReload("w-own");
  serveStored({ layout: leaf(["one", "s-1"]) });
  await bootAndSettle(withHash("/?kind=terminal&w=w-own&seed=0", leaf(["one", null], ["two", null])));

  expect(await pageTerminals(), "the hash's tabs").toEqual([
    { title: "one", id: "s-1" },
    { title: "two", id: undefined },
  ]);
  expect(putSession, "the hash's layout is the page's, not the server's").toHaveBeenCalledTimes(1);
});

test("a workspace page's own reload restores its hash with the blob's tree expansion", async () => {
  workspace.mockResolvedValue(workspaceInfo);
  ownReload("w-own-tree");
  serveStored({ layout: leaf(["one", "s-1"]), treeExpanded: { notes: true } });
  window.history.replaceState({}, "", withHash("/?w=w-own-tree", leaf(["one", null], ["two", null])));
  const store = await import("./store.svelte");
  await store.bootstrap();

  expect(await pageIds(), "the hash's tabs").toEqual(["s-1", undefined]);
  expect(store.treeExpanded.map.notes, "the blob's tree expansion").toBe(true);
});

test("a copied URL over a window's blob opens the window as it is and writes nothing", async () => {
  // The copy holds two of the window's three terminals.
  serveStored(threeTabs());
  await bootAndSettle(withHash("/?kind=terminal&w=w-copy&seed=0", leaf(["one", null], ["two", null])));

  expect(putSession, "the copy writes nothing over the window").not.toHaveBeenCalled();
  expect(storedIds()).toEqual(["s-1", "s-2", "s-3"]);
  expect(await pageIds(), "the page shows the window's terminals").toEqual(["s-1", "s-2", "s-3"]);
});

test("a copied URL naming a terminal the window no longer has does not write the copy's layout", async () => {
  // The copy holds a terminal the window closed since: no source names it.
  serveStored(threeTabs());
  window.history.replaceState({}, "", withHash("/?kind=terminal&w=w-copy-gone&seed=0", leaf(["one", null], ["gone", null])));
  const store = await import("./store.svelte");
  await store.bootstrap();
  const { layout } = await import("./tabs.svelte");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // As the session frame of a tab that spawned a shell: the tab takes the new
  // session's id and schedules a save.
  for (const node of Object.values(layout.nodes)) {
    if (node.kind !== "leaf") continue;
    for (const tab of node.tabs) {
      if (tab.kind === "terminal" && tab.title === "gone") tab.terminalSessionId = "s-new";
    }
  }
  store.scheduleSessionSave();
  socket.ready?.();
  await vi.advanceTimersByTimeAsync(1_250);

  expect(putSession, "the copy's layout is not written over the window").not.toHaveBeenCalled();
  expect(storedIds()).toEqual(["s-1", "s-2", "s-3"]);
  expect(await pageTerminals(), "the window's layout, with no tab for the copy's terminal").toEqual([
    { title: "one", id: "s-1" },
    { title: "two", id: "s-2" },
    { title: "cover", id: "s-3" },
  ]);
});

test("a page that leaves marks its tab, so the next load of the window there is its own reload", async () => {
  const path = withHash("/?kind=terminal&w=w-mark&seed=0", leaf(["one", null], ["two", null]));
  window.history.replaceState({}, "", path);
  serveStored({ layout: leaf(["one", "s-1"]) });
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 204 }));
  const first = await import("./store.svelte");
  first.installSessionFlushHook();
  await first.bootstrap();
  window.dispatchEvent(new Event("pagehide"));

  vi.resetModules();
  putSession.mockClear();
  await bootAndSettle(path);

  expect(await pageTerminals(), "the reload restores its hash").toEqual([
    { title: "one", id: "s-1" },
    { title: "two", id: undefined },
  ]);
  expect(putSession, "and writes it").toHaveBeenCalledTimes(1);
});

test("a live page holds no mark, so a tab duplicated from it opens the window as it is", async () => {
  const path = withHash("/?kind=terminal&w=w-duplicate&seed=0", leaf(["one", null], ["two", null]));
  ownReload("w-duplicate");
  serveStored({ layout: leaf(["one", "s-1"]) });
  await bootAndSettle(path);
  expect(putSession, "setup: the reload writes its hash").toHaveBeenCalledTimes(1);

  // A duplicated tab copies this live page's session storage.
  vi.useRealTimers();
  vi.resetModules();
  socket.ready = null;
  putSession.mockClear();
  serveStored({ layout: leaf(["one", "s-1"], ["cover", "s-3"]) });
  await bootAndSettle(path);

  expect(putSession, "the duplicate writes nothing over the window").not.toHaveBeenCalled();
  expect(await pageIds()).toEqual(["s-1", "s-3"]);
});

/// Leave the page as App does at pagehide, its layout written to the hash
/// first, then load the window again in the same tab.
async function leaveAndReload(store: typeof import("./store.svelte")): Promise<void> {
  store.persistLayoutToHash();
  window.dispatchEvent(new Event("pagehide"));
  vi.useRealTimers();
  vi.resetModules();
  socket.ready = null;
  putSession.mockClear();
  await bootAndSettle(window.location.href);
}

test("a page that heard of a peer's save it has not read leaves no mark, so its reload opens the window as it is", async () => {
  serveStored(twoTabs());
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 204 }));
  const first = await bootAndSettle("/?kind=terminal&w=w-peer-unread&seed=0");
  first.installSessionFlushHook();
  // The peer's save lands and its frame arrives; the page's read of it waits.
  stored = threeTabs();
  first.onWatchEvent({ kind: "session_changed", w: "w-peer-unread", client: "peer" });

  await leaveAndReload(first);

  expect(putSession, "the reload writes nothing over the peer's save").not.toHaveBeenCalled();
  expect(storedIds()).toEqual(["s-1", "s-2", "s-3"]);
  expect(await pageIds(), "the reload shows the window as it is").toEqual(["s-1", "s-2", "s-3"]);
});

test("a page that read a peer's save before it left marks its tab, so its reload restores its own hash", async () => {
  serveStored(twoTabs());
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 204 }));
  const first = await bootAndSettle("/?kind=terminal&w=w-peer-read&seed=0");
  first.installSessionFlushHook();
  stored = threeTabs();
  first.onWatchEvent({ kind: "session_changed", w: "w-peer-read", client: "peer" });
  await vi.advanceTimersByTimeAsync(250);
  expect(await pageIds(), "setup: the page took the peer's save in").toEqual(["s-1", "s-2", "s-3"]);

  await leaveAndReload(first);

  expect(await pageIds(), "the reload restores its hash").toEqual(["s-1", "s-2", "s-3"]);
  expect(putSession, "and writes it, as its own").toHaveBeenCalledTimes(1);
});

test("a page whose socket opened again leaves no mark, since a peer may have saved while it was down", async () => {
  serveStored(twoTabs());
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 204 }));
  const first = await bootAndSettle("/?kind=terminal&w=w-peer-missed&seed=0");
  first.installSessionFlushHook();
  // The peer saves while the page's socket is down, so its frame reaches no
  // socket of this page; the socket then opens again.
  stored = threeTabs();
  socket.ready?.();
  await vi.advanceTimersByTimeAsync(1_250);
  expect(await pageIds(), "setup: the page has not read the save").toEqual(["s-1", "s-2"]);

  await leaveAndReload(first);

  expect(putSession, "the reload writes nothing over the peer's save").not.toHaveBeenCalled();
  expect(storedIds()).toEqual(["s-1", "s-2", "s-3"]);
});

test("a peer's frame heard while a read is out keeps its save unread after that read", async () => {
  serveStored(twoTabs());
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 204 }));
  const first = await bootAndSettle("/?kind=terminal&w=w-peer-overtaken&seed=0");
  first.installSessionFlushHook();
  stored = threeTabs();
  let answer: ((blob: unknown) => void) | undefined;
  getSession.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
  first.onWatchEvent({ kind: "session_changed", w: "w-peer-overtaken", client: "peer" });
  await vi.advanceTimersByTimeAsync(250);
  expect(typeof answer, "setup: the read's GET is out").toBe("function");
  // The GET is answered with the blob as it stood before the peer's second
  // save, whose frame arrives while the GET is out.
  const answered = structuredClone(stored);
  stored = { layout: leaf(["one", "s-1"], ["two", "s-2"], ["cover", "s-3"], ["four", "s-4"]) };
  first.onWatchEvent({ kind: "session_changed", w: "w-peer-overtaken", client: "peer" });
  answer!(answered);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  expect(await pageIds(), "setup: the read applied the first save").toEqual(["s-1", "s-2", "s-3"]);

  await leaveAndReload(first);

  expect(putSession, "the reload writes nothing over the second save").not.toHaveBeenCalled();
  expect(storedIds()).toEqual(["s-1", "s-2", "s-3", "s-4"]);
});

test("a page restored from the back-forward cache holds no mark, so a tab duplicated from it opens the window as it is", async () => {
  const path = withHash("/?kind=terminal&w=w-bfcache&seed=0", leaf(["one", null], ["two", null]));
  ownReload("w-bfcache");
  serveStored({ layout: leaf(["one", "s-1"]) });
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 204 }));
  const first = await bootAndSettle(path);
  first.installSessionFlushHook();
  // The page is suspended into the cache and restored from it.
  window.dispatchEvent(new Event("pagehide"));
  pageshow(true);

  // A duplicated tab copies this live page's session storage.
  vi.useRealTimers();
  vi.resetModules();
  socket.ready = null;
  putSession.mockClear();
  serveStored({ layout: leaf(["one", "s-1"], ["cover", "s-3"]) });
  await bootAndSettle(path);

  expect(putSession, "the duplicate writes nothing over the window").not.toHaveBeenCalled();
  expect(await pageIds()).toEqual(["s-1", "s-3"]);
});

test("a page's pageshow at its load leaves the mark to its boot", async () => {
  const path = withHash("/?kind=terminal&w=w-load-show&seed=0", leaf(["one", null], ["two", null]));
  ownReload("w-load-show");
  serveStored({ layout: leaf(["one", "s-1"]) });
  window.history.replaceState({}, "", path);
  const store = await import("./store.svelte");
  store.installSessionFlushHook();
  pageshow(false);
  await store.bootstrap();

  expect(await pageTerminals(), "the reload restores its hash").toEqual([
    { title: "one", id: "s-1" },
    { title: "two", id: undefined },
  ]);
});

// The graft: a hash carries no session ids, so a restored terminal takes the
// id its name holds in the page's own reload snapshot, then in the blob, then
// in this window's roster.

async function reloadInto(
  windowId: string,
  hash: unknown,
  sources: { snapshot?: unknown; blob?: unknown; roster?: TerminalRosterEntry[] },
): Promise<(string | undefined)[]> {
  window.history.replaceState({}, "", withHash(`/?kind=terminal&w=${windowId}&seed=0`, hash));
  ownReload(windowId);
  if (sources.snapshot !== undefined) reloadSnapshot(windowId, sources.snapshot);
  serveStored(sources.blob === undefined ? null : { layout: sources.blob });
  if (sources.roster) terminalRoster.mockResolvedValue(sources.roster);
  const store = await import("./store.svelte");
  await store.bootstrap();
  return pageIds();
}

test("a reload takes each terminal's id by its name from a blob that holds them in another order", async () => {
  expect(await reloadInto("w-swap", leaf(["one", null], ["cover", null]), {
    blob: leaf(["cover", "s-3"], ["one", "s-1"]),
  })).toEqual(["s-1", "s-3"]);
});

test("a shorter blob in another order re-homes nothing", async () => {
  expect(await reloadInto("w-shorter", leaf(["one", null], ["two", null], ["cover", null]), {
    blob: leaf(["two", "s-2"], ["one", "s-1"]),
  })).toEqual(["s-1", "s-2", undefined]);
});

test("a reload finds a terminal's id in another pane than the hash's", async () => {
  expect(await reloadInto("w-moved", split(leaf(["one", null]), leaf(["cover", null])), {
    snapshot: leaf(["one", "s-1"], ["cover", "s-3"]),
    blob: leaf(["one", "s-1"]),
  })).toEqual(["s-1", "s-3"]);
});

test("a reload takes the id its own snapshot holds over the blob's", async () => {
  expect(await reloadInto("w-priority", leaf(["one", null]), {
    snapshot: leaf(["one", "s-1"]),
    blob: leaf(["one", "s-7"]),
  })).toEqual(["s-1"]);
});

test("a reload takes the ids of its own snapshot when the blob lags", async () => {
  expect(await reloadInto("w-lag", leaf(["one", null], ["two", null], ["cover", null]), {
    snapshot: leaf(["one", "s-1"], ["two", "s-2"], ["cover", "s-3"]),
    blob: leaf(["one", "s-1"], ["two", "s-2"]),
  })).toEqual(["s-1", "s-2", "s-3"]);
});

test("a reload takes each name from the source that holds it", async () => {
  expect(await reloadInto("w-mixed", leaf(["one", null], ["two", null]), {
    snapshot: leaf(["other", "s-9"], ["two", "s-8"]),
    blob: leaf(["one", "s-1"], ["two", "s-2"]),
  })).toEqual(["s-1", "s-8"]);
});

test("a reload re-attaches a tab without an id to the session this window holds under its name", async () => {
  expect(await reloadInto("w-noid", leaf(["one", null], ["two", null], ["cover", null]), {
    snapshot: leaf(["one", "s-1"], ["two", "s-2"], ["cover", null]),
    blob: leaf(["one", "s-1"], ["two", "s-2"]),
    roster: [rosterEntry("s-1", "one", "w-noid"), rosterEntry("s-2", "two", "w-noid"), rosterEntry("s-3", "cover", "w-noid")],
  })).toEqual(["s-1", "s-2", "s-3"]);
});

test("a reload re-attaches a session under its name that a co-viewer also shows", async () => {
  // The co-viewer's save of the session landed; this page's own snapshot
  // holds no id for it.
  expect(await reloadInto("w-noid-coview", leaf(["one", null], ["cover", null]), {
    snapshot: leaf(["one", "s-1"], ["cover", null]),
    blob: leaf(["cover", "s-3"], ["one", "s-1"]),
    roster: [rosterEntry("s-1", "one", "w-noid-coview"), rosterEntry("s-3", "cover", "w-noid-coview")],
  })).toEqual(["s-1", "s-3"]);
});

test("a session under the tab's name bound to another window is not taken", async () => {
  expect(await reloadInto("w-noid-other", leaf(["one", null], ["cover", null]), {
    snapshot: leaf(["one", "s-1"], ["cover", null]),
    blob: leaf(["one", "s-1"]),
    roster: [rosterEntry("s-1", "one", "w-noid-other"), rosterEntry("s-3", "cover", "w-elsewhere")],
  })).toEqual(["s-1", undefined]);
});

test("a session a restored tab holds is not taken by a second tab of the same name", async () => {
  expect(await reloadInto("w-noid-held", leaf(["one", null], ["one", null]), {
    snapshot: leaf(["one", "s-1"], ["one", null]),
    blob: leaf(["one", "s-1"]),
    roster: [rosterEntry("s-1", "one", "w-noid-held")],
  })).toEqual(["s-1", undefined]);
});

test("a blob's terminal without an id takes the session this window holds under its name", async () => {
  window.history.replaceState({}, "", "/?kind=terminal&w=w-blob-noid&seed=0");
  serveStored({ layout: leaf(["one", "s-1"], ["cover", null]) });
  terminalRoster.mockResolvedValue([rosterEntry("s-1", "one", "w-blob-noid"), rosterEntry("s-3", "cover", "w-blob-noid")]);
  const store = await import("./store.svelte");
  await store.bootstrap();

  expect(await pageIds()).toEqual(["s-1", "s-3"]);
});

test("a blob's terminal without an id does not take a session another restored tab holds", async () => {
  window.history.replaceState({}, "", "/?kind=terminal&w=w-blob-held&seed=0");
  serveStored({ layout: leaf(["one", "s-1"], ["one", null]) });
  terminalRoster.mockResolvedValue([rosterEntry("s-1", "one", "w-blob-held")]);
  const store = await import("./store.svelte");
  await store.bootstrap();

  expect(await pageIds()).toEqual(["s-1", undefined]);
});

test("a reload snapshot's terminal without an id takes the session this window holds under its name", async () => {
  window.history.replaceState({}, "", "/?kind=terminal&w=w-snapshot-noid&seed=0");
  reloadSnapshot("w-snapshot-noid", leaf(["one", "s-1"], ["cover", null]));
  terminalRoster.mockResolvedValue([rosterEntry("s-1", "one", "w-snapshot-noid"), rosterEntry("s-3", "cover", "w-snapshot-noid")]);
  const store = await import("./store.svelte");
  await store.bootstrap();

  expect(await pageIds()).toEqual(["s-1", "s-3"]);
});

test("the roster is read beside the session read", async () => {
  window.history.replaceState({}, "", withHash("/?kind=terminal&w=w-parallel&seed=0", leaf(["cover", null])));
  ownReload("w-parallel");
  let answer!: (blob: unknown) => void;
  getSession.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
  terminalRoster.mockResolvedValue([rosterEntry("s-3", "cover", "w-parallel")]);
  const store = await import("./store.svelte");
  const booted = store.bootstrap();
  await vi.waitFor(() => expect(getSession).toHaveBeenCalled());

  expect(terminalRoster, "the roster read is out with the session read").toHaveBeenCalled();
  answer(null);
  await booted;
  expect(await pageIds()).toEqual(["s-3"]);
});

test("a failed roster read restores the layout without its sessions", async () => {
  window.history.replaceState({}, "", withHash("/?kind=terminal&w=w-roster-failed&seed=0", leaf(["one", null], ["cover", null])));
  ownReload("w-roster-failed");
  serveStored({ layout: leaf(["one", "s-1"]) });
  terminalRoster.mockRejectedValue(new Error("roster unavailable"));
  const store = await import("./store.svelte");
  await store.bootstrap();

  expect(store.ui.status ?? "", "the restore stands").not.toContain("restore failed");
  expect(await pageIds()).toEqual(["s-1", undefined]);
});
