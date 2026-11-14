// @vitest-environment jsdom
//
// The session role badge shows when the roster has two or more windows and at
// least one of them is a gateway window (a gateway browser joined a
// devserver). A sole user's all-local roster, a lone gateway window and an
// empty roster stay quiet. The badge names who leads: "leader" only in the
// window the roster names as the session leader, "follower" in every other
// browser window, wherever each window connects from. A Chan Desktop window
// shows the badge only while it leads: the leader gate restricts nothing in a
// desktop window, so "follower" there would claim a limit that does not hold.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";

import { sessionWindowId } from "../api/client";
import { applySessionRoster, type SessionParticipant } from "../state/session.svelte";
import AppStatusBar from "./AppStatusBar.svelte";

let view: Record<string, unknown> | null = null;
let target: HTMLElement;

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
  applySessionRoster({ participants: [], leader: null });
});

// A roster row as the server sends it: `role` is the row's origin, "leader"
// for a window on the serving machine and "follower" for a gateway window.
function participant(role: "leader" | "follower", window_id = `w-${role}-${Math.random()}`): SessionParticipant {
  return { window_id, name: null, role, status: "live" };
}

function shownBadge(): string | null {
  return target.querySelector('[aria-label="session role"]')?.textContent?.trim() ?? null;
}

function badge(participants: SessionParticipant[], leader: string | null): string | null {
  applySessionRoster({ participants, leader });
  target = document.createElement("div");
  document.body.append(target);
  view = mount(AppStatusBar, { target });
  flushSync();
  return shownBadge();
}

describe("the session role badge", () => {
  test("stays hidden for an all-local roster", () => {
    const self = sessionWindowId();
    expect(badge([participant("leader", self), participant("leader")], self)).toBeNull();
  });

  test("stays hidden for a lone gateway window", () => {
    const self = sessionWindowId();
    expect(badge([participant("follower", self)], self)).toBeNull();
  });

  test("shows for a remote-only roster of two or more windows", () => {
    const self = sessionWindowId();
    const roster = [participant("follower", self), participant("follower", "w-remote")];
    expect(badge(roster, "w-remote")).not.toBeNull();

    applySessionRoster({ participants: [...roster, participant("follower")], leader: "w-remote" });
    flushSync();
    expect(shownBadge(), "a third gateway window").not.toBeNull();
  });

  test("reads leader in the gateway window that leads and follower in the other", () => {
    const self = sessionWindowId();
    const roster = [participant("follower", self), participant("follower", "w-remote")];
    expect(badge(roster, self)).toBe("leader");

    applySessionRoster({ participants: roster, leader: "w-remote" });
    flushSync();
    expect(shownBadge(), "the other gateway window leads").toBe("follower");
  });

  test("stays hidden for an empty roster", () => {
    expect(badge([], null)).toBeNull();
  });

  test("reads leader in the local window that leads once a gateway window joins", () => {
    const self = sessionWindowId();
    expect(badge([participant("leader", self), participant("follower", "w-remote")], self)).toBe("leader");
  });

  test("reads follower in a gateway window while a local window leads", () => {
    const self = sessionWindowId();
    expect(badge([participant("leader", "w-local"), participant("follower", self)], "w-local")).toBe("follower");
  });

  test("reads follower in a browser window on the serving machine that does not lead", () => {
    const self = sessionWindowId();
    const roster = [participant("leader", "w-first"), participant("leader", self), participant("follower", "w-remote")];
    expect(badge(roster, "w-first")).toBe("follower");
  });

  test("reads leader in a gateway window that leads", () => {
    const self = sessionWindowId();
    expect(badge([participant("leader", "w-local"), participant("follower", self)], self)).toBe("leader");
  });

  test("reads follower in every window while the leader slot is vacant", () => {
    const self = sessionWindowId();
    expect(badge([participant("leader", self), participant("follower", "w-remote")], null)).toBe("follower");
  });

  test("follows leadership as it moves between windows", () => {
    const self = sessionWindowId();
    const roster = [participant("leader", "w-local"), participant("follower", self)];
    expect(badge(roster, "w-local")).toBe("follower");

    applySessionRoster({ participants: roster, leader: self });
    flushSync();
    expect(shownBadge(), "a handover to this window").toBe("leader");

    applySessionRoster({ participants: roster, leader: "w-local" });
    flushSync();
    expect(shownBadge(), "leadership taken back").toBe("follower");
  });
});

describe("the session role badge in a Chan Desktop window", () => {
  type DesktopWindow = Window & { __TAURI_INTERNALS__?: unknown };

  // isTauriDesktop() reads this global; the bar reads it when it mounts.
  function onDesktop(): void {
    (window as DesktopWindow).__TAURI_INTERNALS__ = {};
  }

  afterEach(() => {
    delete (window as DesktopWindow).__TAURI_INTERNALS__;
  });

  test("stays hidden in a window that does not lead while a gateway window is present", () => {
    onDesktop();
    const self = sessionWindowId();
    const roster = [participant("leader", "w-first"), participant("leader", self), participant("follower", "w-remote")];
    expect(badge(roster, "w-first")).toBeNull();

    applySessionRoster({ participants: roster, leader: "w-remote" });
    flushSync();
    expect(shownBadge(), "the gateway window leads").toBeNull();
  });

  test("reads leader in the window that leads", () => {
    onDesktop();
    const self = sessionWindowId();
    expect(badge([participant("leader", self), participant("follower", "w-remote")], self)).toBe("leader");
  });

  test("shows once this window gains the slot", () => {
    onDesktop();
    const self = sessionWindowId();
    const roster = [participant("leader", "w-first"), participant("leader", self), participant("follower", "w-remote")];
    expect(badge(roster, "w-first")).toBeNull();

    applySessionRoster({ participants: roster, leader: self });
    flushSync();
    expect(shownBadge(), "a handover to this window").toBe("leader");
  });
});
