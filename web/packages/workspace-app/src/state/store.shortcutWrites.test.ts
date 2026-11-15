// @vitest-environment jsdom

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ConfigPatchRequest, GlobalConfig } from "../api/types";
import { preferences } from "../__tests__/standalone";
import type { OverrideSlot } from "./keymapOverrides.svelte";

type Store = typeof import("./store.svelte");
let server: GlobalConfig;
let beforePatch: (() => Promise<void>) | undefined;
const writes: { window: string; body: ConfigPatchRequest; accepted: boolean }[] = [];
const stores: Store[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

beforeEach(() => {
  server = { revision: 1, preferences: preferences(), workspaces: [] };
  beforePatch = undefined;
  writes.length = 0;
  localStorage.clear();
  sessionStorage.clear();
  document.head.querySelectorAll('meta[name^="chan-"]').forEach((meta) => meta.remove());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  for (const store of stores.splice(0)) store.teardown();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

// Each import graph owns its override table and config-write chain, as two
// pages do. Both real preference writers reach the same revisioned server.
async function newWindow(name: string, standalone = false) {
  window.history.replaceState({}, "", `/?w=${name}${standalone ? "&kind=terminal" : ""}`);
  vi.resetModules();
  const client = await import("../api/client");
  const transport = await import("../api/transport");
  const keymap = await import("./keymapOverrides.svelte");
  let ready: (() => void) | undefined;
  vi.spyOn(client, "openWatchSocket").mockImplementation((_event, _status, onReady) => {
    ready = onReady;
    return Object.assign(() => {}, {
      subscribeDir() {}, unsubscribeDir() {}, reportTransfers() {}, probe() {}, close() {},
    });
  });
  const workspace = vi.spyOn(client.api, "workspace").mockImplementation(async () => ({
    root: "/ws", label: "workspace", metadata_key: null, warnings: [],
    preferences: structuredClone(server.preferences),
  }));
  vi.spyOn(client.api, "terminalRoster").mockResolvedValue([]);
  vi.spyOn(client.api, "extensions").mockResolvedValue([]);
  vi.spyOn(client.api, "list").mockResolvedValue([]);
  vi.spyOn(client.api, "getSession").mockResolvedValue(null);
  vi.spyOn(client.api, "health").mockResolvedValue({ instance: "same-server" });
  transport.setFetchImpl(async (input, init = {}) => {
    expect(new URL(input, window.location.href).pathname).toBe("/api/config");
    if ((init.method ?? "GET") === "GET") return json(server);
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(String(init.body)) as ConfigPatchRequest;
    const concurrent = beforePatch;
    beforePatch = undefined;
    await concurrent?.();
    const accepted = body.expected_revision === server.revision;
    writes.push({ window: name, body, accepted });
    if (!accepted) return json({ code: "config_conflict", current: server }, 409);
    server = { ...server, revision: server.revision + 1,
      preferences: { ...server.preferences, ...body.preferences } };
    return json(server);
  });
  const store = await import("./store.svelte");
  stores.push(store);
  const initial = structuredClone(server.preferences);
  if (standalone) {
    store.__testSetStandalonePreferences(initial);
    keymap.hydrateOverrides(initial.shortcuts);
  } else {
    store.workspace.info = { root: "/ws", label: "workspace", metadata_key: null,
      warnings: [], preferences: initial };
    store.applyServerPreferences();
  }
  const { windowCaps } = await import("./windowCaps");
  expect(windowCaps.workspace).toBe(!standalone);
  return {
    keymap, store, workspace,
    // A no-op write joins this window's actual serial chain after its edit.
    flush: () => store.updateGlobalConfigSerial(() => null),
    async reconnect() {
      store.resumeWatcher();
      expect(ready).toBeDefined();
      ready!();
      await vi.advanceTimersByTimeAsync(300);
    },
  };
}

test.each([
  ["app.search.toggle", "web"],
  ["app.settings.open", "linux"],
  ["app.settings.open", "windows"],
] as const)("a stale second window preserves the first edit while assigning %s/%s", async (id, slot) => {
  const first = await newWindow("first");
  const second = await newWindow("second");
  first.keymap.assignOverride("app.settings.open", "Cmd+Alt+J", "macos");
  await first.flush();
  const firstSaved = structuredClone(server.preferences.shortcuts!);
  expect(second.keymap.serializeOverrides()).toEqual({});
  second.keymap.assignOverride(id, "Ctrl+Alt+K", slot);
  await second.flush();

  expect(server.preferences.shortcuts).toEqual({
    ...firstSaved, [id]: { ...firstSaved[id], [slot]: "Ctrl+Alt+K" },
  });
  expect(writes.every(({ body }) => Object.keys(body.preferences).join() === "shortcuts")).toBe(true);
});

test("clearing a stale binding preserves new slots and other commands", async () => {
  const first = await newWindow("first");
  first.keymap.assignOverride("app.settings.open", "Mod+Alt+J", "web");
  await first.flush();
  const second = await newWindow("second");
  first.keymap.assignOverride("app.settings.open", "Cmd+Alt+J", "macos");
  first.keymap.assignOverride("app.search.toggle", "Ctrl+Alt+K", "windows");
  await first.flush();
  second.keymap.clearOverride("app.settings.open", "web");
  await second.flush();

  expect(server.preferences.shortcuts).toEqual({
    "app.settings.open": { macos: "Cmd+Alt+J" },
    "app.search.toggle": { windows: "Ctrl+Alt+K" },
  });
});

test("assigning the server's current binding sends no patch", async () => {
  server.preferences.shortcuts = {
    "app.settings.open": { web: "Mod+Alt+J", macos: "Cmd+Alt+K" },
    "app.search.toggle": { windows: "Ctrl+Alt+L" },
  };
  const initial = structuredClone(server);
  const first = await newWindow("first");
  first.keymap.assignOverride("app.settings.open", "Mod+Alt+J", "web");
  await first.flush();

  expect(writes).toEqual([]);
  expect(server).toEqual(initial);
});

test.each([false, true])("resetting a binding already removed on the server sends no patch (sibling=%s)", async (sibling) => {
  server.preferences.shortcuts = {
    "app.settings.open": { web: "Mod+Alt+J", ...(sibling ? { macos: "Cmd+Alt+K" } : {}) },
    "app.search.toggle": { windows: "Ctrl+Alt+L" },
  };
  const first = await newWindow("first");
  const second = await newWindow("second");
  first.keymap.clearOverride("app.settings.open", "web");
  await first.flush();
  const initial = structuredClone(server);
  writes.length = 0;
  second.keymap.clearOverride("app.settings.open", "web");
  await second.flush();

  expect(writes).toEqual([]);
  expect(server).toEqual(initial);
});

test("a conflict retry sends no patch when the other window already saved the same binding", async () => {
  const first = await newWindow("first");
  const second = await newWindow("second");
  beforePatch = async () => {
    first.keymap.assignOverride("app.settings.open", "Mod+Alt+J", "web");
    await first.flush();
  };
  second.keymap.assignOverride("app.settings.open", "Mod+Alt+J", "web");
  await second.flush();

  const attempts = writes.filter((write) => write.window === "second");
  expect(attempts.map(({ accepted, body }) => [accepted, body.expected_revision])).toEqual([[false, 1]]);
  expect(server.revision).toBe(2);
  expect(server.preferences.shortcuts).toEqual({ "app.settings.open": { web: "Mod+Alt+J" } });
});

test("the conflict retry merges the same edit over the other window's accepted write", async () => {
  const first = await newWindow("first");
  const second = await newWindow("second");
  beforePatch = async () => {
    first.keymap.assignOverride("app.settings.open", "Cmd+Alt+J", "macos");
    await first.flush();
  };
  second.keymap.assignOverride("app.search.toggle", "Ctrl+Alt+K", "web");
  await second.flush();

  const attempts = writes.filter((write) => write.window === "second");
  expect(attempts.map(({ accepted, body }) => [accepted, body.expected_revision])).toEqual([[false, 1], [true, 2]]);
  expect(server.preferences.shortcuts).toEqual({
    "app.settings.open": { macos: "Cmd+Alt+J" },
    "app.search.toggle": { web: "Ctrl+Alt+K" },
  });
});

test("queued edits keep their binding identity when a slot is assigned then cleared", async () => {
  const first = await newWindow("first");
  const second = await newWindow("second");
  first.keymap.assignOverride("app.settings.open", "Cmd+Alt+J", "macos");
  await first.flush();
  second.keymap.assignOverride("app.search.toggle", "Ctrl+Alt+K", "web");
  second.keymap.clearOverride("app.search.toggle", "web");
  await second.flush();

  const accepted = writes.filter((write) => write.window === "second" && write.accepted);
  expect(accepted).toHaveLength(2);
  expect(accepted[0]!.body.preferences.shortcuts?.["app.search.toggle"]).toEqual({ web: "Ctrl+Alt+K" });
  expect(server.preferences.shortcuts).toEqual({ "app.settings.open": { macos: "Cmd+Alt+J" } });
});

test.each([false, true])("a reconnect refreshes missed preferences (standalone=%s)", async (standalone) => {
  const first = await newWindow("first");
  const second = await newWindow("second", standalone);
  await second.reconnect();
  const slot: OverrideSlot = "web";
  first.keymap.assignOverride("app.settings.open", "Mod+Alt+J", slot);
  await first.flush();
  await first.store.updateGlobalConfigSerial(() => ({ editor_font_size: 24 }));
  expect(second.keymap.serializeOverrides()).toEqual({});
  expect(second.store.currentPreferences()?.editor_font_size).not.toBe(24);
  await second.reconnect();

  expect(second.keymap.serializeOverrides()).toEqual(server.preferences.shortcuts);
  expect(second.store.currentPreferences()?.editor_font_size).toBe(24);
  if (standalone) expect(second.workspace).not.toHaveBeenCalled();
});
