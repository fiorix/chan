// @vitest-environment jsdom

import { afterEach, expect, test, vi } from "vitest";
import { preferences } from "../__tests__/standalone";
import type { SerNode, Tab } from "./tabs.svelte";

type Surface = "desktop" | "gateway";
type Kind = "terminal-live" | "terminal-fresh" | "file" | "browser" | "graph" | "dashboard" | "diagram" | "extension";
type SavedSession = { layout: SerNode; treeExpanded?: Record<string, boolean> };
type Store = typeof import("./store.svelte");

const WINDOW_ID = "w-layout-restore";
const kinds: Kind[] = ["terminal-live", "terminal-fresh", "file", "browser", "graph", "dashboard", "diagram", "extension"];
let disposePage: (() => void) | undefined;

afterEach(() => {
  disposePage?.();
});

async function bootPage(surface: Surface, saved: SavedSession | null) {
  disposePage?.();
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  document.head.querySelectorAll('meta[name^="chan-"]').forEach((meta) => meta.remove());
  const prefix = surface === "gateway" ? "/shared-workspace" : "";
  window.history.replaceState({}, "", `${prefix}/?w=${WINDOW_ID}`);
  if (prefix) {
    const meta = document.createElement("meta");
    meta.name = "chan-prefix";
    meta.content = prefix;
    document.head.appendChild(meta);
  }
  vi.stubGlobal("__TAURI__", undefined);
  vi.stubGlobal("__TAURI_INTERNALS__", surface === "desktop" ? {
    invoke: vi.fn(async () => null),
    metadata: { currentWindow: { label: WINDOW_ID }, currentWebview: { label: WINDOW_ID } },
  } : undefined);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

  const listeners: [string, EventListenerOrEventListenerObject][] = [];
  const addListener = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
    if (type === "pagehide" || type === "pageshow") listeners.push([type, listener]);
    addListener(type, listener, options);
  });
  let store: Store | undefined;
  disposePage = () => {
    store?.teardown();
    store?.__testResetSessionWrites();
    for (const [type, listener] of listeners) window.removeEventListener(type, listener);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.head.querySelectorAll('meta[name^="chan-"]').forEach((meta) => meta.remove());
    window.history.replaceState({}, "", "/");
    disposePage = undefined;
  };

  // Fresh exports matter: an importOriginal spread in a hoisted mock keeps
  // the first page's prefix even after resetModules creates the next page.
  const client = await import("../api/client");
  const transport = await import("../api/transport");
  const requests: { method: string; url: URL; body?: SavedSession }[] = [];
  let stored = saved === null ? null : structuredClone(saved);
  transport.setFetchImpl(async (input, init = {}) => {
    const url = new URL(input, window.location.href);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) as SavedSession : undefined;
    requests.push({ method, url, body });
    expect(url.pathname, "the real transport uses this page's tenant prefix").toBe(`${prefix}/api/session`);
    expect(url.searchParams.get("w")).toBe(WINDOW_ID);
    if (method === "GET") {
      return stored === null
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(stored), { headers: { "content-type": "application/json" } });
    }
    if (method === "PUT") {
      expect(body).toBeDefined();
      stored = structuredClone(body!);
      return new Response(null, { status: 204 });
    }
    expect(method).toBe("DELETE");
    stored = null;
    return new Response(null, { status: 204 });
  });
  vi.spyOn(client.api, "workspace").mockResolvedValue({
    root: "/ws", label: "workspace", metadata_key: null, preferences: preferences(), warnings: [],
  });
  vi.spyOn(client.api, "list").mockResolvedValue([]);
  vi.spyOn(client.api, "terminalRoster").mockResolvedValue([]);
  vi.spyOn(client.api, "extensions").mockResolvedValue([]);
  vi.spyOn(client.api, "indexStatus").mockImplementation(() => new Promise(() => {}));
  vi.spyOn(client.api, "readStream").mockImplementation(async (path) => ({
    path, content: "saved content", mtime: 1, mtime_ns: "1000000000", writable: true,
  }));
  let onEvent: ((event: unknown) => void) | undefined;
  vi.spyOn(client, "openWatchSocket").mockImplementation((receive) => {
    onEvent = receive;
    return Object.assign(() => {}, {
      subscribeDir() {}, unsubscribeDir() {}, reportTransfers() {}, probe() {}, close() {},
    });
  });

  store = await import("./store.svelte");
  const tabs = await import("./tabs.svelte");
  const harness = await import("../__tests__/tabs");
  const session = await import("./session.svelte");
  const desktop = await import("../api/desktop");
  const { windowCaps } = await import("./windowCaps");
  expect(desktop.isTauriDesktop()).toBe(surface === "desktop");
  expect(transport.apiPath("/api/session")).toBe(`${prefix}/api/session`);
  expect(windowCaps.workspace).toBe(true);
  expect(window.location.hash).toBe("");
  expect(client.sessionWindowId()).toBe(WINDOW_ID);

  await store.bootstrap();
  await (await import("./extensions.svelte")).loadExtensions();
  store.markLayoutPersistenceReady();
  expect(client.api.workspace).toHaveBeenCalledTimes(1);
  expect(store.ui.status ?? "").not.toMatch(/(?:restore|bootstrap) failed:/);
  expect(requests.map((request) => request.method), "boot reads exactly the stored blob").toEqual(["GET"]);
  expect(onEvent, "boot opened its watch socket").toBeDefined();
  // An origin-follower holding the leader slot may DELETE. Another leader
  // would suppress that write and conceal an empty restore in this arm.
  onEvent!({
    type: "session_roster",
    participants: [{
      window_id: WINDOW_ID, name: null, role: surface === "gateway" ? "follower" : "leader", status: "live",
    }],
    leader: WINDOW_ID,
  });
  expect(session.isFollower()).toBe(surface === "gateway");
  expect(session.sessionState.leader).toBe(WINDOW_ID);
  expect(session.selfParticipant()?.status).toBe("live");

  return { store, tabs, harness, requests, stored: () => stored };
}

type Page = Awaited<ReturnType<typeof bootPage>>;

function liveTab(page: Page): Tab {
  const root = page.tabs.layout.nodes[page.tabs.layout.rootId];
  expect(root?.kind).toBe("leaf");
  if (!root || root.kind !== "leaf") throw new Error("expected one leaf pane");
  expect(root.tabs).toHaveLength(1);
  expect(root.activeTabId).toBe(root.tabs[0]!.id);
  return root.tabs[0]!;
}

function populate(page: Page, kind: Kind): void {
  const { tabs, harness } = page;
  harness.resetLayout();
  if (kind === "terminal-live" || kind === "terminal-fresh") {
    harness.resetLayout([harness.terminalTab({
      title: "Build shell", group: "tools", profile: "development", inspectorOpen: true, inspectorWidth: 360,
      ...(kind === "terminal-live" ? { terminalSessionId: "shell-session", controlledTerminal: true } : {}),
    })]);
  } else if (kind === "file") {
    harness.resetLayout([harness.fileTab({
      path: "notes/saved.md", inspectorOpen: true, outlineOpen: true, inspectorWidth: 360, outlineWidth: 220,
      caret: { from: 3, to: 7 }, readMode: true, styleToolbarOpen: true,
    })]);
  } else if (kind === "diagram") {
    harness.resetLayout([harness.fileTab({
      path: "notes/sketch.excalidraw", fileKind: "text", mode: "canvas", inspectorOpen: true, inspectorWidth: 360,
    })]);
  } else if (kind === "browser") {
    tabs.openBrowserInActivePane({ select: "notes/saved.md" });
    const tab = liveTab(page);
    if (tab.kind !== "browser") throw new Error("expected a browser tab");
    Object.assign(tab, {
      directory: "notes", browserSort: "modified", browserDescending: true, selectedPaths: ["notes/saved.md"],
      expanded: ["notes"], scroll: 120, inspectorWidth: 360,
    });
  } else if (kind === "graph") {
    tabs.openGraphInActivePane({
      depth: 3, expanded: { notes: true }, pendingSelectId: "notes/saved.md",
      filters: { ...tabs.DEFAULT_GRAPH_FILTERS, tag: false },
    });
    const tab = liveTab(page);
    if (tab.kind !== "graph") throw new Error("expected a graph tab");
    tab.inspectorOpen = true;
    tab.inspectorWidth = 360;
  } else if (kind === "dashboard") {
    expect(tabs.openDashboardInActivePane({ slide: 1, autoRotate: false })).toBe(true);
    const tab = liveTab(page);
    if (tab.kind !== "dashboard") throw new Error("expected a dashboard tab");
    tab.indexingSelectedId = "directory:notes";
    tab.indexingExpanded = ["notes"];
    tab.disabledSlots = [2];
    tab.inspectorWidth = 360;
  } else {
    expect(tabs.openExtensionInActivePane("example", "Example extension")).not.toBeNull();
  }
}

async function save(page: Page): Promise<void> {
  page.store.scheduleSessionSave();
  await vi.advanceTimersByTimeAsync(750);
}

async function fixture(kind: Kind): Promise<SavedSession> {
  const page = await bootPage("desktop", null);
  populate(page, kind);
  await save(page);
  expect(page.requests.map((request) => request.method)).toEqual(["GET", "PUT"]);
  const saved = page.stored();
  expect(saved?.layout, "the fixture is the real session serializer's PUT").toBeTruthy();
  expect(saved!.layout).toEqual(page.tabs.serializeLayout({ terminalSessions: true }));
  const result = structuredClone(saved!);
  disposePage?.();
  return result;
}

async function restored(surface: Surface, kind: Kind, saved: SavedSession): Promise<SerNode> {
  const page = await bootPage(surface, saved);
  const tab = liveTab(page);
  const expectedKind = kind.startsWith("terminal") ? "terminal" : kind === "diagram" ? "file" : kind;
  expect(tab.kind, `${surface}: ${kind} survived bootstrap`).toBe(expectedKind);
  if (tab.kind === "terminal") {
    expect(tab.terminalSessionId).toBe(kind === "terminal-live" ? "shell-session" : undefined);
  }
  if (tab.kind === "file") {
    expect(tab.error).toBeNull();
    expect(tab.loading).toBe(false);
    expect(tab.mode).toBe(kind === "diagram" ? "canvas" : "wysiwyg");
  }
  const layout = page.tabs.serializeLayout({ terminalSessions: true });
  expect(layout, `${surface}: retained a nonempty layout`).not.toBeNull();
  expect(layout, `${surface}: restored the complete saved view state`).toEqual(saved.layout);
  await save(page);
  expect(page.requests.filter((request) => request.method === "DELETE"), `${surface}: first save keeps the blob`).toEqual([]);
  expect(page.requests.filter((request) => request.method === "PUT"), `${surface}: an unchanged restored blob deduplicates`).toEqual([]);
  expect(page.stored()).toEqual(saved);
  const result = JSON.parse(JSON.stringify(layout)) as SerNode;
  disposePage?.();
  return result;
}

test.each(kinds)("%s restores and retains the same layout on desktop and gateway", async (kind) => {
  const saved = await fixture(kind);
  const desktop = await restored("desktop", kind, saved);
  const gateway = await restored("gateway", kind, saved);
  expect(gateway).toEqual(desktop);
});

test.each(["desktop", "gateway"] as const)("%s can delete a restored layout emptied before its first save", async (surface) => {
  const saved = await fixture("file");
  const page = await bootPage(surface, saved);
  expect(liveTab(page).kind).toBe("file");
  page.harness.resetLayout();
  expect(page.tabs.serializeLayout({ terminalSessions: true })).toBeNull();
  await save(page);
  expect(page.requests.map((request) => request.method)).toEqual(["GET", "DELETE"]);
  expect(page.stored()).toBeNull();
});
