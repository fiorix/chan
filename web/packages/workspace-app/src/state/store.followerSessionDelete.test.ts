// @vitest-environment jsdom
//
// An emptied web window deletes its own layout blob, from the debounced save
// and from the exit flush, unless it is a gateway window while another window
// holds the session's leader slot. A window on the serving machine always
// deletes, leading or not, so its closed tabs never stay on the server. Each
// row drives the real store with a roster as the server sends it: a row's
// `role` is its origin, and `leader` is the slot. The decision is made once,
// by the first save that finds the view empty, from the last roster the page
// received; the rows after the table pin what follows from that.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./caretIndex");

// The event socket, so a row can deliver the roster as a frame and drop the
// socket the way the transport reports it.
const socket = vi.hoisted(() => ({
  event: null as ((e: unknown) => void) | null,
  status: null as ((s: "connecting" | "open" | "reconnecting" | "closed", attempt: number) => void) | null,
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    openWatchSocket: (
      onEvent: (e: unknown) => void,
      onStatus?: (s: "connecting" | "open" | "reconnecting" | "closed", attempt: number) => void,
    ) => {
      socket.event = onEvent;
      socket.status = onStatus ?? null;
      return Object.assign(() => {}, {
        subscribeDir() {},
        unsubscribeDir() {},
        reportTransfers() {},
        probe() {},
        close() {},
      });
    },
  };
});

import { api, sessionWindowId } from "../api/client";
import * as desktop from "../api/desktop";
import {
  __testResetSessionDiscarded,
  __testResetSessionWrites,
  __testSetBootstrapHydrated,
  discardWindowSessionLocal,
  installSessionFlushHook,
  resumeWatcher,
  scheduleSessionSave,
  teardown,
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
  teardown();
  socket.event = null;
  socket.status = null;
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

/// The roster as the server sends it, with `SELF` resolved to this page.
function roster(participants: SessionParticipant[], leader: string | null) {
  const me = sessionWindowId();
  const resolve = (id: string | null) => (id === SELF ? me : id);
  return {
    participants: participants.map((p) => ({ ...p, window_id: resolve(p.window_id)! })),
    leader: resolve(leader),
  };
}

/// Save a layout and spy on the save path's DELETE.
async function savedLayout() {
  vi.spyOn(api, "putSession").mockResolvedValue(undefined);
  await save();
  return vi.spyOn(api, "deleteSession").mockResolvedValue(undefined);
}

/// Whether the exit flush sent the DELETE.
function exitDeleted(): boolean {
  return fetchSpy.mock.calls.some(([, init]) => init?.method === "DELETE");
}

/// Empty the window and report whether it sent the DELETE through `path`.
async function emptyDeletes(path: "save" | "exit", del: Awaited<ReturnType<typeof savedLayout>>): Promise<boolean> {
  resetLayout([], { id: "pane-delete" });
  if (path === "save") {
    await save();
    return del.mock.calls.length > 0;
  }
  scheduleSessionSave();
  window.dispatchEvent(new Event("pagehide"));
  return exitDeleted();
}

/// Save a layout, apply the roster, empty the window, and report whether it
/// sent the DELETE through `path`.
async function emptiedWindowDeletes(
  path: "save" | "exit",
  participants: SessionParticipant[],
  leader: string | null,
): Promise<boolean> {
  const del = await savedLayout();
  applySessionRoster(roster(participants, leader));
  return emptyDeletes(path, del);
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
  // Its own row has not arrived, so it is no follower, whoever leads.
  ["a page with no row of its own yet deletes while another window leads", [local("w-a"), gateway("w-g")], "w-a", true],
];

describe.each(["save", "exit"] as const)("an emptied web window, through the %s path", (path) => {
  test.each(rows)("%s", async (_name, participants, leader, deletes) => {
    expect(await emptiedWindowDeletes(path, participants, leader)).toBe(deletes);
  });

  test("a desktop window deletes even as a gateway window while another leads", async () => {
    vi.spyOn(desktop, "isTauriDesktop").mockReturnValue(true);
    expect(await emptiedWindowDeletes(path, [local("w-a"), gateway(SELF)], "w-a")).toBe(true);
  });

  // The roster arrives as a frame on the event socket, then the socket drops.
  // Nothing clears the roster, so the page decides on that last roster though
  // the server may have moved the slot meanwhile: one that named it leader
  // deletes, and one that named another leader keeps the blob (a cleared
  // roster would leave no row of its own and delete).
  test.each([
    ["deletes on a last roster that named it leader", SELF, true],
    ["keeps the blob on a last roster that named another leader", "w-a", false],
  ] as const)("a gateway window whose socket is down %s", async (_name, leader, deletes) => {
    resumeWatcher();
    const del = await savedLayout();
    socket.event!({ type: "session_roster", ...roster([local("w-a"), gateway(SELF)], leader) });
    socket.status!("reconnecting", 1);
    expect(await emptyDeletes(path, del)).toBe(deletes);
  });
});

describe("a gateway window that empties while another window leads", () => {
  test("sends no DELETE after it gains the slot, at a later save or at exit", async () => {
    const del = await savedLayout();
    applySessionRoster(roster([local("w-a"), gateway(SELF)], "w-a"));
    expect(await emptyDeletes("save", del), "held back while following").toBe(false);

    applySessionRoster(roster([local("w-a"), gateway(SELF)], SELF));
    await save();
    expect(del, "the empty view is recorded as saved").not.toHaveBeenCalled();
    window.dispatchEvent(new Event("pagehide"));
    expect(exitDeleted(), "the exit flush sends nothing either").toBe(false);
  });

  test("deletes when it gains the slot before the debounced save runs", async () => {
    const del = await savedLayout();
    applySessionRoster(roster([local("w-a"), gateway(SELF)], "w-a"));
    resetLayout([], { id: "pane-delete" });
    scheduleSessionSave();
    applySessionRoster(roster([local("w-a"), gateway(SELF)], SELF));
    await vi.advanceTimersByTimeAsync(750);
    expect(del, "the save that finds the view empty reads the roster then").toHaveBeenCalled();
  });
});
