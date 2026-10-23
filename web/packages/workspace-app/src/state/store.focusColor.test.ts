// @vitest-environment jsdom

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { GlobalConfig, TerminalRosterEntry } from "../api/types";
import { preferences, serveMeta } from "../__tests__/standalone";

const apiConfig = vi.fn<() => Promise<GlobalConfig>>();
const getSession = vi.fn<() => Promise<unknown>>();
const putSession = vi.fn<(payload: unknown) => Promise<void>>();
const terminalRoster = vi.fn<() => Promise<TerminalRosterEntry[]>>();
const setLocalColor = vi.fn<(hex: string) => Promise<void>>();

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      config: () => apiConfig(),
      terminalRoster: () => terminalRoster(),
      getSession: () => getSession(),
      putSession: (payload: unknown) => putSession(payload),
      setLocalColor: (hex: string) => setLocalColor(hex),
    },
    openWatchSocket: () => Object.assign(() => {}, {
      close() {},
      subscribeDir() {},
      unsubscribeDir() {},
      reportTransfers() {},
    }),
  };
});

const lifecycleListeners: [string, EventListenerOrEventListenerObject][] = [];

beforeEach(() => {
  const addListener = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
    if (type === "pagehide" || type === "pageshow") lifecycleListeners.push([type, listener]);
    addListener(type, listener, options);
  });
  vi.resetModules();
  apiConfig.mockReset().mockResolvedValue({ revision: 1, preferences: preferences(), workspaces: [] });
  getSession.mockReset().mockResolvedValue(null);
  putSession.mockReset().mockResolvedValue(undefined);
  terminalRoster.mockReset().mockResolvedValue([]);
  setLocalColor.mockReset().mockResolvedValue(undefined);
  sessionStorage.clear();
  serveMeta("chan-files", false);
  serveMeta("chan-drafts", false);
  window.history.replaceState({}, "", "/?kind=terminal&w=w-focus-choice&seed=0");
});

afterEach(() => {
  for (const [type, listener] of lifecycleListeners.splice(0)) window.removeEventListener(type, listener);
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function chooseColor(color: "blue" | "orange" | "green" | "pink"): Promise<void> {
  await import("./commands/panes");
  const { allCommands } = await import("./commands");
  const command = allCommands().find((entry) => entry.id === `app.pane.focusColor.${color}`);
  expect(command).toBeDefined();
  command!.run();
}

async function chooseOrange(): Promise<void> {
  await chooseColor("orange");
}

function markAppReady(store: typeof import("./store.svelte")): void {
  if ("markLayoutPersistenceReady" in store) store.markLayoutPersistenceReady();
}

const savedPinkSplit = { layout: { k: "s", d: "r", a: { k: "l", t: [] }, b: { k: "l", t: [] }, wc: "p" } };
const savedNamedSplit = { layout: { k: "s", d: "r", a: { k: "l", t: [{ k: "t", n: "left" }] }, b: { k: "l", t: [{ k: "t", n: "right" }] }, wc: "p" } };

async function mockWorkspace(): Promise<void> {
  const client = await import("../api/client");
  vi.spyOn(client.api, "workspace").mockResolvedValue({ root: "/work", label: "work", metadata_key: "work", preferences: preferences(), warnings: [] });
  vi.spyOn(client.api, "list").mockResolvedValue([]);
  vi.spyOn(client.api, "health").mockResolvedValue({ instance: "same" } as never);
  vi.spyOn(client.api, "extensions").mockResolvedValue([]);
}

function setSavedAddress(path: string): void {
  const hash = new URLSearchParams();
  hash.set("s", JSON.stringify(savedPinkSplit.layout));
  window.history.replaceState({}, "", `${path}#${hash.toString()}`);
}

test.each(["blue", "orange", "green", "pink"] as const)("a chosen %s survives pagehide over a stale saved colour", async (color) => {
  const stale = color === "pink" ? "g" : "p";
  getSession.mockResolvedValue({
    layout: { k: "s", d: "r", a: { k: "l", t: [] }, b: { k: "l", t: [] }, wc: stale },
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
  const store = await import("./store.svelte");
  await store.bootstrap();
  markAppReady(store);
  store.installSessionFlushHook();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

  await chooseColor(color);
  const address = window.location.href;
  const hashLayout = new URLSearchParams(new URL(address).hash.slice(1)).get("s");
  expect(JSON.parse(hashLayout ?? "null")).toMatchObject({ wc: { blue: "b", orange: "o", green: "g", pink: "p" }[color] });
  expect(putSession, "the address is written before the server responds").not.toHaveBeenCalled();
  window.dispatchEvent(new Event("pagehide"));
  expect(sessionStorage.getItem("chan.layout.ownReload:w-focus-choice")).toBe("1");
  vi.resetModules();
  const reloaded = await import("./store.svelte");
  await reloaded.bootstrap();
  const { layout } = await import("./tabs.svelte");
  expect(layout.focusColor, "the next load restores the choice").toBe(color);
});

test("an orange choice writes the address before a server save and schedules that save", async () => {
  getSession.mockResolvedValue(savedPinkSplit);
  const store = await import("./store.svelte");
  await store.bootstrap();
  markAppReady(store);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await chooseOrange();
  expect(JSON.parse(new URLSearchParams(window.location.hash.slice(1)).get("s") ?? "null")).toMatchObject({ wc: "o" });
  expect(putSession).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(749);
  expect(putSession).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(putSession.mock.calls.at(-1)?.[0]).toMatchObject({ layout: { wc: "o" } });
});

test("an immediate reload restores orange while the server still holds no layout", async () => {
  const store = await import("./store.svelte");
  await store.bootstrap();
  markAppReady(store);
  store.installSessionFlushHook();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await chooseOrange();
  expect(getSession).toHaveBeenCalledTimes(1);
  expect(putSession).not.toHaveBeenCalled();
  expect(JSON.parse(new URLSearchParams(window.location.hash.slice(1)).get("s") ?? "null")).toMatchObject({ wc: "o" });
  window.dispatchEvent(new Event("pagehide"));
  vi.resetModules();
  const reloaded = await import("./store.svelte");
  await reloaded.bootstrap();
  const { layout } = await import("./tabs.svelte");
  expect(layout.focusColor).toBe("orange");
});

test("blue on a single empty pane clears orange from the address without saving a blue blob", async () => {
  const store = await import("./store.svelte");
  await store.bootstrap();
  markAppReady(store);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await chooseOrange();
  expect(JSON.parse(new URLSearchParams(window.location.hash.slice(1)).get("s") ?? "null")).toMatchObject({ wc: "o" });
  await chooseColor("blue");
  expect(window.location.hash).toBe("");
  await vi.advanceTimersByTimeAsync(750);
  expect(putSession).not.toHaveBeenCalled();
});

test("a choice during a held initial read paints but writes neither address nor session", async () => {
  setSavedAddress("/?kind=terminal&w=w-focus-choice");
  let release!: (value: unknown) => void;
  getSession.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; })).mockResolvedValue(null);
  const store = await import("./store.svelte");
  const boot = store.bootstrap();
  await vi.waitFor(() => expect(getSession).toHaveBeenCalledTimes(1));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const address = window.location.href;

  await chooseOrange();
  const { layout } = await import("./tabs.svelte");
  expect(layout.focusColor).toBe("orange");
  expect(window.location.href).toBe(address);
  await vi.advanceTimersByTimeAsync(750);
  expect(putSession).not.toHaveBeenCalled();
  release(null);
  await boot;
  const next = await import("./tabs.svelte");
  expect(Object.values(next.layout.nodes).filter((node) => node.kind === "leaf")).toHaveLength(2);
  expect(next.layout.focusColor).toBe("pink");
  expect(window.location.href).toBe(address);
});

test.each(["workspace description", "workspace tree", "standalone preferences", "standalone files context", "standalone root tree", "standalone home ancestor"] as const)(
  "a choice while %s loads leaves the saved address and session untouched",
  async (phase) => {
    const workspaceWindow = phase.startsWith("workspace");
    const filesWindow = phase === "standalone files context" || phase === "standalone root tree" || phase === "standalone home ancestor";
    if (filesWindow) serveMeta("chan-files", true);
    setSavedAddress(workspaceWindow ? "/work/?w=w-focus-choice" : "/?kind=terminal&w=w-focus-choice");
    const client = await import("../api/client");
    let started!: () => void;
    let release!: (value: unknown) => void;
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    const held = <T,>(): Promise<T> => {
      started();
      return new Promise<T>((resolve) => { release = resolve as (value: unknown) => void; });
    };
    if (workspaceWindow) await mockWorkspace();
    if (phase === "workspace description") vi.spyOn(client.api, "workspace").mockImplementationOnce(held);
    if (phase === "workspace tree") vi.spyOn(client.api, "list").mockImplementationOnce(held);
    if (phase === "standalone preferences") apiConfig.mockImplementationOnce(held);
    if (filesWindow) {
      const context = { home: "/home/ubuntu", drafts_dir: null } as never;
      vi.spyOn(client.api, "fsContext").mockResolvedValue(context);
      if (phase === "standalone files context") vi.spyOn(client.api, "fsContext").mockImplementationOnce(held);
      vi.spyOn(client.api, "list").mockImplementation((dir) => {
        if (phase === "standalone root tree" && dir === "") return held<Awaited<ReturnType<typeof client.api.list>>>();
        if (phase === "standalone home ancestor" && dir === "home") return held<Awaited<ReturnType<typeof client.api.list>>>();
        return Promise.resolve([]);
      });
    }
    getSession.mockResolvedValue(null);
    const store = await import("./store.svelte");
    const boot = store.bootstrap();
    await requestStarted;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const address = window.location.href;

    await chooseOrange();
    expect(window.location.href).toBe(address);
    await vi.advanceTimersByTimeAsync(750);
    expect(putSession).not.toHaveBeenCalled();
    if (phase === "workspace description") release({ root: "/work", label: "work", metadata_key: "work", preferences: preferences(), warnings: [] });
    if (phase === "workspace tree") release([]);
    if (phase === "standalone preferences") release({ revision: 1, preferences: preferences(), workspaces: [] });
    if (phase === "standalone files context") release({ home: "/home/ubuntu", drafts_dir: null });
    if (phase === "standalone root tree" || phase === "standalone home ancestor") release([]);
    await boot;
    const next = await import("./tabs.svelte");
    expect(Object.values(next.layout.nodes).filter((node) => node.kind === "leaf")).toHaveLength(2);
    expect(next.layout.focusColor).toBe(phase === "standalone root tree" || phase === "standalone home ancestor" ? "orange" : "pink");
    expect(window.location.href).toBe(address);
  },
);

test("a choice after the store read but before app readiness does not publish the layout", async () => {
  setSavedAddress("/work/?w=w-focus-choice");
  await mockWorkspace();
  const store = await import("./store.svelte");
  await store.bootstrap();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const address = window.location.href;
  await chooseOrange();
  expect(window.location.href).toBe(address);
  await vi.advanceTimersByTimeAsync(750);
  expect(putSession).not.toHaveBeenCalled();
  const next = await import("./tabs.svelte");
  expect(Object.values(next.layout.nodes).filter((node) => node.kind === "leaf")).toHaveLength(2);
  expect(next.layout.focusColor).toBe("orange");
});

test("a choice after a failed initial read uses the ordinary write path", async () => {
  getSession.mockRejectedValueOnce(new Error("constructed read failure")).mockResolvedValue(savedPinkSplit);
  vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
  const store = await import("./store.svelte");
  await store.bootstrap();
  markAppReady(store);
  store.installSessionFlushHook();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

  await chooseOrange();
  const hashLayout = new URLSearchParams(window.location.hash.slice(1)).get("s");
  expect(JSON.parse(hashLayout ?? "null")).toMatchObject({ wc: "o" });
  window.dispatchEvent(new Event("pagehide"));
  vi.resetModules();
  const reloaded = await import("./store.svelte");
  await reloaded.bootstrap();
  const { layout } = await import("./tabs.svelte");
  expect(layout.focusColor).toBe("orange");
});

test("a no-choice load restores saved panes and colour", async () => {
  getSession.mockResolvedValue(savedNamedSplit);
  const store = await import("./store.svelte");
  await store.bootstrap();
  const { layout } = await import("./tabs.svelte");
  expect(Object.values(layout.nodes).filter((node) => node.kind === "leaf")).toHaveLength(2);
  expect(layout.focusColor).toBe("pink");
  expect(putSession).not.toHaveBeenCalled();
});

test("a failed no-choice load keeps its ordinary first-ready recovery", async () => {
  const client = await import("../api/client");
  let ready: (() => void) | undefined;
  vi.spyOn(client, "openWatchSocket").mockImplementation((_event, _status, onReady) => {
    ready = onReady;
    return Object.assign(() => {}, { close() {}, subscribeDir() {}, unsubscribeDir() {}, reportTransfers() {}, probe() {} });
  });
  getSession.mockRejectedValueOnce(new Error("constructed read failure")).mockResolvedValue(savedNamedSplit);
  const store = await import("./store.svelte");
  await store.bootstrap();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  expect(ready).toBeTypeOf("function");
  ready!();
  await vi.advanceTimersByTimeAsync(250);
  const { layout } = await import("./tabs.svelte");
  expect(getSession).toHaveBeenCalledTimes(2);
  expect(Object.values(layout.nodes).filter((node) => node.kind === "leaf")).toHaveLength(2);
  expect(layout.focusColor).toBe("pink");
  store.teardown();
});
