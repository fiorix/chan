// @vitest-environment jsdom

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { preferences, serveMeta } from "../__tests__/standalone";

const getSession = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const putSession = vi.hoisted(() => vi.fn<(payload: unknown) => Promise<void>>());

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      config: () => Promise.resolve({ revision: 1, preferences: preferences(), workspaces: [] }),
      health: () => Promise.resolve({ instance: "a" }),
      terminalRoster: () => Promise.resolve({ sessions: [] }),
      getSession: () => getSession(),
      putSession: (payload: unknown) => putSession(payload),
      deleteSession: () => Promise.resolve(),
    },
    openWatchSocket: () => Object.assign(() => {}, {
      subscribeDir() {},
      unsubscribeDir() {},
      reportTransfers() {},
    }),
  };
});

async function app() {
  const store = await import("./store.svelte");
  const tabs = await import("./tabs.svelte");
  const { resetLayout, terminalTab } = await import("../__tests__/tabs");
  const { sessionWindowId } = await import("../api/client");
  return { store, tabs, resetLayout, terminalTab, sessionWindowId };
}

const CARRIER_KEY = "chan-cli-reload-bits";

function carrier(): { windowId: string; hash: string; bits: number[] } | null {
  const raw = sessionStorage.getItem(CARRIER_KEY);
  return raw ? JSON.parse(raw) : null;
}

function bits(): unknown {
  return carrier()?.bits;
}

function layoutHash(): string {
  return new URLSearchParams(window.location.hash.slice(1)).get("s") ?? "";
}

function hashLayout(): unknown {
  const raw = new URLSearchParams(window.location.hash.slice(1)).get("s");
  return raw ? JSON.parse(raw) : null;
}

beforeEach(() => {
  vi.resetModules();
  getSession.mockReset().mockResolvedValue(null);
  putSession.mockReset().mockResolvedValue();
  window.history.replaceState({}, "", "/?kind=terminal&w=w-cli&seed=0");
  sessionStorage.clear();
  localStorage.clear();
  serveMeta("chan-files", false);
  serveMeta("chan-drafts", false);
});

afterEach(async () => {
  const { store } = await app();
  store.__testResetSessionDiscarded();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.head.querySelector('meta[name="chan-files"]')?.remove();
  document.head.querySelector('meta[name="chan-drafts"]')?.remove();
});

test("a CLI command without a session restores a plain tab with a notice owed", async () => {
  const { store, tabs, resetLayout, sessionWindowId } = await app();
  resetLayout();
  store.onWatchEvent({ type: "window_command", window_id: sessionWindowId(), command: "open_term_new", tab_name: "build", spawn_command: "printf sentinel", env: { SENTINEL: "secret" } });
  const first = tabs.activePane().tabs[0];
  expect(first?.kind).toBe("terminal");

  await store.bootstrap();
  const restored = tabs.activePane().tabs[0];
  expect(restored?.kind).toBe("terminal");
  if (restored?.kind !== "terminal") throw new Error("terminal was not restored");
  expect(restored.cliReloadNotice, "a pre-session reload owes a visible notice").toBe(true);
  expect(bits(), "an owed notice is carried immediately for a second reload").toEqual([2]);
  expect(restored.terminalSessionId).toBeUndefined();
  expect(restored.spawnCommand).toBeUndefined();
  expect(restored.spawnEnv).toBeUndefined();
});

test("boot writes an owed notice against the restored layout value", async () => {
  const { store, tabs, resetLayout, terminalTab, sessionWindowId } = await app();
  resetLayout([terminalTab({ id: "first", cliCommandPending: true }), terminalTab({ id: "second" })]);
  store.persistStateToHash();
  expect(bits()).toEqual([1, 0]);
  resetLayout();
  await store.bootstrap();
  expect(tabs.activePane().tabs).toHaveLength(2);
  expect(carrier(), "the next boot must accept the updated vector for this layout").toEqual({
    windowId: sessionWindowId(), hash: layoutHash(), bits: [2, 0],
  });
});

test("a second reload during a pending session GET retains the notice", async () => {
  const { store, tabs, resetLayout, terminalTab } = await app();
  resetLayout([terminalTab({ cliCommandPending: true })]);
  store.persistStateToHash();
  let finishGet!: (value: unknown) => void;
  getSession.mockReturnValueOnce(new Promise((resolve) => { finishGet = resolve; })).mockResolvedValue(null);
  resetLayout();
  const firstBoot = store.bootstrap();
  await vi.waitFor(() => expect(getSession).toHaveBeenCalled());
  try {
    expect(bits(), "a second reload during GET still has the pending marker").toEqual([1]);
    resetLayout();
    await store.bootstrap();
    const restored = tabs.activePane().tabs[0];
    expect(restored?.kind === "terminal" && restored.cliReloadNotice, "the second reload still owes the notice").toBe(true);
  } finally {
    finishGet(null);
    await firstBoot;
  }
});

test("the public hash and server payload contain no spawn values or private bit", async () => {
  const { store, tabs, resetLayout, sessionWindowId } = await app();
  resetLayout([{ kind: "dashboard", id: "dash", title: "Dashboard" }]);
  store.onWatchEvent({ type: "window_command", window_id: sessionWindowId(), command: "open_term_new", tab_name: "build", spawn_command: "printf sentinel", env: { SENTINEL: "secret" } });
  expect(bits()).toEqual([1]);
  expect(carrier()).toEqual({ windowId: sessionWindowId(), hash: layoutHash(), bits: [1] });
  expect(window.history.state?.chanCliReloadBits).toBeUndefined();
  const hash = JSON.stringify(hashLayout());
  expect(hash, "public hash excludes command, environment and reload marker").not.toMatch(/sentinel|secret|cliReload|cliCommand|spawnCommand|spawnEnv/i);
  expect(tabs.activePane().tabs).toHaveLength(2);

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  store.scheduleSessionSave();
  await vi.advanceTimersByTimeAsync(750);
  expect(putSession).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(putSession.mock.calls[0]?.[0]), "server payload excludes command, environment and reload marker").not.toMatch(/sentinel|secret|cliReload|cliCommand|spawnCommand|spawnEnv/i);
});

test("equal named terminals swap their private bits while their hash stays equal", async () => {
  const { store, tabs, resetLayout, terminalTab } = await app();
  const a = terminalTab({ id: "a", title: "same", cliCommandPending: true });
  const b = terminalTab({ id: "b", title: "same" });
  const pane = resetLayout([{ kind: "dashboard", id: "dash", title: "Dashboard" }, a, b]);
  store.persistStateToHash();
  const before = window.location.href;
  expect(bits()).toEqual([1, 0]);
  tabs.reorderTab(pane.id, "a", 2);
  tabs.selectTabInPane(pane.id, "dash");
  store.persistStateToHash();
  expect(window.location.href).toBe(before);
  expect(bits(), "URL-only dedup would leave the bit on the wrong tab").toEqual([0, 1]);
});

test("a saved session id suppresses the pending notice, but an owed notice survives it", async () => {
  const { tabs, resetLayout } = await app();
  const source: Parameters<typeof tabs.restoreLayout>[0] = { k: "l", t: [{ k: "t", n: "build", a: 1 }] };
  const saved: Parameters<typeof tabs.restoreLayout>[0] = { k: "l", t: [{ k: "t", n: "build", tsid: "session-1" }] };
  resetLayout();
  await tabs.restoreLayout(source, saved, [1]);
  const attached = tabs.activePane().tabs[0];
  expect(attached?.kind === "terminal" && attached.cliReloadNotice, "an attached pending terminal owes no notice").toBeFalsy();
  await tabs.restoreLayout(source, saved, [2]);
  const owed = tabs.activePane().tabs[0];
  expect(owed?.kind === "terminal" && owed.cliReloadNotice, "dismissal alone clears an owed notice").toBe(true);
});

test("an ended command clears its private bit and restores without a notice", async () => {
  const { store, tabs, resetLayout, terminalTab } = await app();
  resetLayout([terminalTab({ terminalSessionId: "ended-session", cliCommandPending: true })]);
  store.persistStateToHash();
  expect(bits()).toEqual([1]);
  const live = tabs.activePane().tabs[0];
  if (live?.kind !== "terminal") throw new Error("terminal missing");
  tabs.clearTerminalSession(live, true);
  store.persistStateToHash();
  expect(bits(), "an exit or closed frame leaves no command debt").toEqual([0]);
  await tabs.restoreLayout(hashLayout() as Parameters<typeof tabs.restoreLayout>[0], null, bits());
  const restored = tabs.activePane().tabs[0];
  expect(restored?.kind === "terminal" && restored.cliReloadNotice).toBeFalsy();
});

test("reopening a closed command or owed-notice tab starts a plain shell", async () => {
  const { store, tabs, resetLayout, terminalTab } = await app();
  for (const fields of [{ cliCommandPending: true }, { cliReloadNotice: true }]) {
    const pane = resetLayout([terminalTab(fields)]);
    const closed = pane.tabs[0];
    if (!closed) throw new Error("terminal missing");
    await tabs.closeTab(pane.id, closed.id, { force: true });
    expect(tabs.reopenClosedTab()).toBe(true);
    const reopened = tabs.activePane().tabs[0];
    if (reopened?.kind !== "terminal") throw new Error("reopened terminal missing");
    expect(reopened.cliCommandPending, "a reopened tab has no prior command debt").toBeFalsy();
    expect(reopened.cliReloadNotice, "a reopened tab has no prior notice").toBeFalsy();
    store.persistStateToHash();
    expect(bits()).toEqual([0]);
  }
});

test("a reattached command keeps its bit until a later restore lacks the session", async () => {
  const { store, tabs, resetLayout } = await app();
  const source: Parameters<typeof tabs.restoreLayout>[0] = { k: "l", t: [{ k: "t", n: "build", a: 1 }] };
  const saved: Parameters<typeof tabs.restoreLayout>[0] = { k: "l", t: [{ k: "t", n: "build", tsid: "attached-session" }] };
  resetLayout();
  await tabs.restoreLayout(source, saved, [1]);
  const attached = tabs.activePane().tabs[0];
  expect(attached?.kind === "terminal" && attached.cliCommandPending).toBe(true);
  expect(attached?.kind === "terminal" && attached.cliReloadNotice).toBeFalsy();
  store.persistStateToHash();
  expect(bits(), "an attached command still carries the private bit").toEqual([1]);
  await tabs.restoreLayout(source, null, bits());
  const detached = tabs.activePane().tabs[0];
  expect(detached?.kind === "terminal" && detached.cliReloadNotice, "the later detached restore owes the notice").toBe(true);
});

test("dismissing a notice on its first restored page survives another reload", async () => {
  const { store, tabs, resetLayout, terminalTab } = await app();
  resetLayout([terminalTab({ cliCommandPending: true })]);
  store.persistStateToHash();
  resetLayout();
  await store.bootstrap();
  const owed = tabs.activePane().tabs[0];
  if (owed?.kind !== "terminal") throw new Error("restored terminal missing");
  expect(owed.cliReloadNotice).toBe(true);
  store.dismissCliReloadNotice(owed);
  expect(bits()).toEqual([0]);
  resetLayout();
  await store.bootstrap();
  const dismissed = tabs.activePane().tabs[0];
  expect(dismissed?.kind === "terminal" && dismissed.cliReloadNotice, "the dismissed notice stays gone").toBeFalsy();
});

test("environment-only and ordinary terminal opens do not mark", async () => {
  const { store, tabs, resetLayout, sessionWindowId } = await app();
  resetLayout();
  store.onWatchEvent({ type: "window_command", window_id: sessionWindowId(), command: "open_term_new", tab_name: "env", env: { SENTINEL: "secret" } });
  tabs.openTerminalInActivePane({ spawnCommand: "ordinary command" });
  store.persistStateToHash();
  expect(bits(), "an environment-only or ordinary open has no CLI command marker").toEqual([0, 0]);
});

test("a malformed or mismatched vector is dropped for every terminal slot", async () => {
  const { tabs, resetLayout } = await app();
  const source: Parameters<typeof tabs.restoreLayout>[0] = { k: "l", t: [{ k: "t", n: "one" }, { k: "t", n: "two" }] };
  resetLayout();
  for (const vector of [[1], [1, 3], "11", [1, "2"]]) {
    await tabs.restoreLayout(source, null, vector);
    expect(tabs.activePane().tabs.every((tab) => tab.kind === "terminal" && !tab.cliReloadNotice), `invalid ${JSON.stringify(vector)}`).toBe(true);
  }
  await tabs.restoreLayout(source, null, [1, 0]);
  const first = tabs.activePane().tabs[0];
  expect(first?.kind === "terminal" && first.cliReloadNotice).toBe(true);
});

test("discard removes the carrier even when the unload flush follows", async () => {
  const { store, resetLayout, terminalTab } = await app();
  resetLayout([terminalTab({ cliCommandPending: true })]);
  store.persistStateToHash();
  expect(bits()).toEqual([1]);
  store.discardWindowSessionLocal();
  store.persistStateToHash();
  expect(sessionStorage.getItem(CARRIER_KEY), "the unload flush cannot restore a discarded vector").toBeNull();
});

test("a same-window move carries the bit and no shared layout carries it", async () => {
  const { store, tabs, resetLayout, terminalTab } = await app();
  const source = resetLayout([terminalTab({ id: "move", title: "build", cliCommandPending: true })]);
  const targetId = tabs.splitPane(source.id, "row");
  if (!targetId) throw new Error("split was refused");
  tabs.moveTab(source.id, "move", targetId);
  const target = tabs.layout.nodes[targetId];
  expect(target?.kind === "leaf" && target.tabs[0]?.kind === "terminal" && target.tabs[0].cliCommandPending, "a same-window clone carries the marker").toBe(true);
  store.persistStateToHash();
  expect(bits()).toEqual([1]);
  expect(JSON.stringify(hashLayout())).not.toMatch(/cliCommandPending|cliReloadNotice|chanCliReloadBits/);
  if (target?.kind !== "leaf" || target.tabs[0]?.kind !== "terminal") throw new Error("moved terminal missing");
  expect(tabs.TERMINAL_MOVE_DECISIONS.cliCommandPending).toBe("drop");
  expect(tabs.TERMINAL_MOVE_DECISIONS.cliReloadNotice).toBe("drop");
  expect(JSON.stringify(tabs.crossWindowTerminalSnapshot(target.tabs[0])), "cross-window snapshot excludes the marker").not.toMatch(/cliCommandPending|cliReloadNotice|chanCliReloadBits/);
});

test("the fresh flag drops a copied storage vector and skips its layout", async () => {
  const { store, tabs, resetLayout, terminalTab } = await app();
  resetLayout([terminalTab({ cliCommandPending: true })]);
  store.persistStateToHash();
  expect(bits()).toEqual([1]);
  const fresh = new URL(window.location.href);
  fresh.searchParams.set("fresh", "1");
  window.history.replaceState(null, "", fresh);
  resetLayout();
  await store.bootstrap();
  expect(bits(), "fresh flag strips the copied private vector").toBeUndefined();
  expect(tabs.activePane().tabs).toHaveLength(0);
});

test("window id and layout hash mismatches each drop the copied vector", async () => {
  const { store, tabs, resetLayout, terminalTab } = await app();
  resetLayout([terminalTab({ cliCommandPending: true })]);
  store.persistStateToHash();
  const original = carrier();
  if (!original) throw new Error("carrier missing");
  for (const changed of [{ ...original, windowId: "other-window" }, { ...original, hash: "other-layout" }]) {
    sessionStorage.setItem(CARRIER_KEY, JSON.stringify(changed));
    resetLayout();
    await store.bootstrap();
    const restored = tabs.activePane().tabs[0];
    expect(restored?.kind === "terminal" && restored.cliReloadNotice, "a mismatched carrier cannot show a notice").toBeFalsy();
    expect(sessionStorage.getItem(CARRIER_KEY), "a mismatched carrier is removed").toBeNull();
  }
});

test("a second window drops a copied carrier even with the same layout hash", async () => {
  const { store, tabs, resetLayout, terminalTab } = await app();
  resetLayout([terminalTab({ cliCommandPending: true })]);
  store.persistStateToHash();
  const copy = carrier();
  expect(copy?.windowId).toBe("w-cli");
  const second = new URL(window.location.href);
  second.searchParams.set("w", "w-second");
  window.history.replaceState(null, "", second);
  resetLayout();
  await store.bootstrap();
  const restored = tabs.activePane().tabs[0];
  expect(restored?.kind === "terminal" && restored.cliReloadNotice, "copied storage belongs to another window").toBeFalsy();
  expect(sessionStorage.getItem(CARRIER_KEY)).toBeNull();
});

test("malformed, absent and throwing storage restore silently", async () => {
  const { store, tabs, resetLayout, terminalTab } = await app();
  resetLayout([terminalTab({ cliCommandPending: true })]);
  store.persistStateToHash();
  for (const raw of ["{broken", JSON.stringify({ windowId: "w-cli", hash: layoutHash(), bits: "1" }), null]) {
    if (raw === null) sessionStorage.removeItem(CARRIER_KEY);
    else sessionStorage.setItem(CARRIER_KEY, raw);
    resetLayout();
    await store.bootstrap();
    const restored = tabs.activePane().tabs[0];
    expect(restored?.kind === "terminal" && restored.cliReloadNotice, "bad or absent carrier cannot show a notice").toBeFalsy();
  }
  vi.spyOn(Storage.prototype, "getItem").mockImplementation((key) => {
    if (key === CARRIER_KEY) throw new Error("storage unavailable");
    return null;
  });
  resetLayout();
  await store.bootstrap();
  const restored = tabs.activePane().tabs[0];
  expect(restored?.kind === "terminal" && restored.cliReloadNotice, "throwing storage cannot show a notice").toBeFalsy();
});

test("an owed notice persists through another reload and dismissal clears its bit", async () => {
  const { store, tabs, resetLayout, terminalTab } = await app();
  resetLayout([terminalTab({ cliCommandPending: true })]);
  store.persistStateToHash();
  const source = hashLayout() as Parameters<typeof tabs.restoreLayout>[0];
  await tabs.restoreLayout(source, null, bits());
  store.persistStateToHash();
  expect(bits(), "the first restore writes a notice-owed bit").toEqual([2]);
  await tabs.restoreLayout(source, { k: "l", t: [{ k: "t", n: "Terminal", tsid: "replacement" }] }, bits());
  const owed = tabs.activePane().tabs[0];
  expect(owed?.kind === "terminal" && owed.cliReloadNotice).toBe(true);
  if (owed?.kind !== "terminal") throw new Error("terminal was not restored");
  store.dismissCliReloadNotice(owed);
  expect(bits(), "dismissal clears the notice-owed bit").toEqual([0]);
  await tabs.restoreLayout(source, null, bits());
  const dismissed = tabs.activePane().tabs[0];
  expect(dismissed?.kind === "terminal" && dismissed.cliReloadNotice).toBeFalsy();
});
