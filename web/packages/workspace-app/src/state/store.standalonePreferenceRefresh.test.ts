// @vitest-environment jsdom

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DemoGraph } from "../demo/graph";
import { MockReports } from "../demo/report";
import { createDemoFetch } from "../demo/router";
import { MockWorkspaceStore } from "../demo/store";

type Store = typeof import("./store.svelte");
type Keymap = typeof import("./keymapOverrides.svelte");
type Client = typeof import("../api/client");
type Transport = typeof import("../api/transport");
type Writer = typeof import("../api/preferenceWrite");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function heldRequest() {
  const started = deferred();
  const released = deferred();
  releases.push(released.resolve);
  return { started, released };
}

let store: Store;
let keymap: Keymap;
let client: Client;
let transport: Transport;
let writer: Writer;
let heldRead: ReturnType<typeof heldRequest> | null;
let heldPatch: ReturnType<typeof heldRequest> | null;
let releases: Array<() => void>;
let configReads: number;
let patchCount: number;

beforeEach(async () => {
  window.history.replaceState({}, "", "/?w=standalone&kind=terminal");
  localStorage.clear();
  sessionStorage.clear();
  document.head.querySelectorAll('meta[name^="chan-"]').forEach((meta) => meta.remove());
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  heldRead = null;
  heldPatch = null;
  releases = [];
  configReads = 0;
  patchCount = 0;
  client = await import("../api/client");
  transport = await import("../api/transport");
  writer = await import("../api/preferenceWrite");
  const demoStore = new MockWorkspaceStore({
    metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1, fileCount: 1, textCount: 1 },
    files: [{ path: "note.md", kind: "text", size: 5, mtime: 1, content: "hello" }],
  });
  const demoFetch = createDemoFetch(demoStore, new DemoGraph(demoStore), new MockReports([]), {
    shortcuts: { "app.settings.open": { web: "Mod+Alt+J", macos: "Cmd+Alt+K" } },
  });
  transport.setFetchImpl(async (input, init) => {
    expect(new URL(input, window.location.href).pathname).toBe("/api/config");
    const method = init?.method ?? "GET";
    if (method === "GET") {
      configReads += 1;
      if (heldRead) {
        const hold = heldRead;
        heldRead = null;
        // Capture a real routed response before the concurrent write lands.
        const response = await demoFetch(input, init);
        hold.started.resolve();
        await hold.released.promise;
        return response;
      }
    }
    if (method === "PATCH" && heldPatch) {
      const hold = heldPatch;
      heldPatch = null;
      hold.started.resolve();
      await hold.released.promise;
    }
    const response = await demoFetch(input, init);
    if (method === "PATCH") patchCount += 1;
    return response;
  });
  store = await import("./store.svelte");
  keymap = await import("./keymapOverrides.svelte");
  const { windowCaps } = await import("./windowCaps");
  expect(windowCaps.workspace).toBe(false);
  store.workspace.info = null;
  const initial = (await client.api.config()).preferences;
  store.__testSetStandalonePreferences(initial);
  keymap.hydrateOverrides(initial.shortcuts);
  configReads = 0;
});

afterEach(async () => {
  store.stopWorkspaceRefresh();
  for (const release of releases) release();
  await writer.waitForPreferenceWrites();
  await vi.advanceTimersByTimeAsync(0);
  store.teardown();
  store.__testSetStandalonePreferences(null);
  keymap.hydrateOverrides({});
  transport.setFetchImpl(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

test("a refresh during a pending assignment preserves a subsequent reset click", async () => {
  const patch = heldPatch = heldRequest();
  keymap.assignOverride("app.search.toggle", "Ctrl+Alt+L", "web");
  await patch.started.promise;
  const reads = configReads;

  store.scheduleWorkspaceRefresh();
  await vi.advanceTimersByTimeAsync(0);
  expect.soft(configReads).toBe(reads);
  expect.soft(keymap.overrideChordForSlot("app.search.toggle", "web")).toBe("Ctrl+Alt+L");
  keymap.clearOverride("app.search.toggle", "web");
  patch.released.resolve();
  await writer.waitForPreferenceWrites();
  await vi.advanceTimersByTimeAsync(0);

  expect((await client.api.config()).preferences.shortcuts?.["app.search.toggle"]).toBeUndefined();
  expect(keymap.overrideChordForSlot("app.search.toggle", "web")).toBeUndefined();
  expect(patchCount).toBe(2);
});

test("a response captured before an assignment cannot swallow the subsequent reset click", async () => {
  const read = heldRead = heldRequest();
  store.scheduleWorkspaceRefresh();
  await read.started.promise;
  const patch = heldPatch = heldRequest();
  keymap.assignOverride("app.search.toggle", "Ctrl+Alt+L", "web");
  await patch.started.promise;

  read.released.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect.soft(keymap.overrideChordForSlot("app.search.toggle", "web")).toBe("Ctrl+Alt+L");
  keymap.clearOverride("app.search.toggle", "web");
  patch.released.resolve();
  await writer.waitForPreferenceWrites();
  await vi.advanceTimersByTimeAsync(0);

  expect((await client.api.config()).preferences.shortcuts?.["app.search.toggle"]).toBeUndefined();
  expect(keymap.overrideChordForSlot("app.search.toggle", "web")).toBeUndefined();
  expect(patchCount).toBe(2);
});

test("a refresh waits for a pending reset instead of restoring the removed binding", async () => {
  const patch = heldPatch = heldRequest();
  keymap.clearOverride("app.settings.open", "web");
  await patch.started.promise;
  const reads = configReads;

  store.scheduleWorkspaceRefresh();
  await vi.advanceTimersByTimeAsync(0);
  expect.soft(configReads).toBe(reads);
  expect.soft(keymap.overrideChordForSlot("app.settings.open", "web")).toBeUndefined();
  patch.released.resolve();
  await writer.waitForPreferenceWrites();
  await vi.advanceTimersByTimeAsync(0);

  expect(store.currentPreferences()?.shortcuts?.["app.settings.open"]).toEqual({ macos: "Cmd+Alt+K" });
  expect(keymap.overrideChordForSlot("app.settings.open", "web")).toBeUndefined();
  expect(patchCount).toBe(1);
});

test("a no-op reset invalidates an older response and refreshes without a config event", async () => {
  const read = heldRead = heldRequest();
  store.scheduleWorkspaceRefresh();
  await read.started.promise;
  const current = await client.api.config();
  await client.api.updateConfig({
    expected_revision: current.revision,
    preferences: { shortcuts: { "app.settings.open": { macos: "Cmd+Alt+K" } } },
  });
  patchCount = 0;
  keymap.clearOverride("app.settings.open", "web");
  await writer.waitForPreferenceWrites();
  expect(patchCount).toBe(0);

  read.released.resolve();
  await vi.advanceTimersByTimeAsync(0);

  expect.soft(store.currentPreferences()?.shortcuts?.["app.settings.open"]).toEqual({ macos: "Cmd+Alt+K" });
  expect.soft(keymap.overrideChordForSlot("app.settings.open", "web")).toBeUndefined();
  expect(patchCount).toBe(0);
});

test("stopping a refresh waiting for a write prevents its config read", async () => {
  const patch = heldPatch = heldRequest();
  keymap.clearOverride("app.settings.open", "web");
  await patch.started.promise;
  const reads = configReads;
  const previous = store.currentPreferences();

  store.scheduleWorkspaceRefresh();
  store.stopWorkspaceRefresh();
  patch.released.resolve();
  await writer.waitForPreferenceWrites();
  await vi.advanceTimersByTimeAsync(0);

  expect.soft(configReads).toBe(reads);
  expect.soft(store.currentPreferences()).toBe(previous);
  expect(keymap.overrideChordForSlot("app.settings.open", "web")).toBeUndefined();
});

test("stopping a refresh with a response in flight prevents preference application", async () => {
  const previous = store.currentPreferences();
  const current = await client.api.config();
  await client.api.updateConfig({ expected_revision: current.revision, preferences: { editor_font_size: 24 } });
  const read = heldRead = heldRequest();
  store.scheduleWorkspaceRefresh();
  await read.started.promise;

  store.stopWorkspaceRefresh();
  read.released.resolve();
  await vi.advanceTimersByTimeAsync(0);

  expect.soft(store.currentPreferences()).toBe(previous);
  expect.soft(store.currentPreferences()?.editor_font_size).not.toBe(24);
  store.scheduleWorkspaceRefresh();
  await vi.advanceTimersByTimeAsync(0);
  expect(store.currentPreferences()?.editor_font_size).toBe(24);
});
