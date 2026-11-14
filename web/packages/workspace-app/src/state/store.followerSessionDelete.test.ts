// @vitest-environment jsdom
//
// An emptied web window deletes its own layout blob, from the debounced save
// and from the exit flush, unless it is a gateway window while another window
// holds the session's leader slot. A window on the serving machine always
// deletes, leading or not, so its closed tabs never stay on the server. Each
// row drives the real store with a roster as the server sends it: a row's
// `role` is its origin, and `leader` is the slot.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./caretIndex");

import { api, sessionWindowId } from "../api/client";
import {
  __testResetSessionDiscarded,
  __testResetSessionWrites,
  __testSetBootstrapHydrated,
  discardWindowSessionLocal,
  installSessionFlushHook,
  scheduleSessionSave,
} from "./store.svelte";
import { applySessionRoster, type SessionParticipant } from "./session.svelte";
import { cancelPaneMode } from "./tabs.svelte";
import { fileTab, resetLayout } from "../__tests__/tabs";

function spyFetch() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
}

let fetchSpy: ReturnType<typeof spyFetch>;

beforeEach(() => {
  vi.useFakeTimers();
  cancelPaneMode();
  resetLayout([fileTab()], { id: "pane-delete" });
  discardWindowSessionLocal();
  __testResetSessionDiscarded();
  __testResetSessionWrites();
  __testSetBootstrapHydrated(true);
  fetchSpy = spyFetch();
  installSessionFlushHook();
});

afterEach(async () => {
  cancelPaneMode();
  applySessionRoster({ participants: [], leader: null });
  await vi.runOnlyPendingTimersAsync();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function save(): Promise<void> {
  scheduleSessionSave();
  await vi.advanceTimersByTimeAsync(750);
}

const SELF = "self";
const local = (id: string): SessionParticipant => ({ window_id: id, name: null, role: "leader", status: "live" });
const gateway = (id: string): SessionParticipant => ({ window_id: id, name: null, role: "follower", status: "live" });

/// Save a layout, apply the roster, empty the window, and report whether it
/// sent the DELETE through `path`.
async function emptiedWindowDeletes(
  path: "save" | "exit",
  participants: SessionParticipant[],
  leader: string | null,
): Promise<boolean> {
  const me = sessionWindowId();
  const resolve = (id: string | null) => (id === SELF ? me : id);
  vi.spyOn(api, "putSession").mockResolvedValue(undefined);
  await save();
  const del = vi.spyOn(api, "deleteSession").mockResolvedValue(undefined);
  applySessionRoster({
    participants: participants.map((p) => ({ ...p, window_id: resolve(p.window_id)! })),
    leader: resolve(leader),
  });
  resetLayout([], { id: "pane-delete" });
  if (path === "save") {
    await save();
    return del.mock.calls.length > 0;
  }
  scheduleSessionSave();
  window.dispatchEvent(new Event("pagehide"));
  return fetchSpy.mock.calls.some(([, init]) => init?.method === "DELETE");
}

const rows: [string, SessionParticipant[], string | null, boolean][] = [
  ["a sole local window that leads deletes", [local(SELF)], SELF, true],
  ["the leader of two local windows deletes", [local(SELF), local("w-b")], SELF, true],
  ["a local window that does not lead deletes", [local("w-a"), local(SELF)], "w-a", true],
  ["a local window that leads beside a gateway window deletes", [local(SELF), gateway("w-g")], SELF, true],
  ["a gateway window keeps the blob while a local window leads", [local("w-a"), gateway(SELF)], "w-a", false],
  ["a local window deletes while a gateway window leads", [local(SELF), gateway("w-g")], "w-g", true],
  ["a gateway window that leads beside a local window deletes", [local("w-a"), gateway(SELF)], SELF, true],
  ["a local window deletes with the slot vacant", [local(SELF)], null, true],
  ["a gateway window deletes with the slot vacant", [gateway(SELF)], null, true],
  ["a sole gateway window that leads deletes", [gateway(SELF)], SELF, true],
];

describe.each(["save", "exit"] as const)("an emptied web window, through the %s path", (path) => {
  test.each(rows)("%s", async (_name, participants, leader, deletes) => {
    expect(await emptiedWindowDeletes(path, participants, leader)).toBe(deletes);
  });
});
