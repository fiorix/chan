// @vitest-environment jsdom
//
// The session role badge shows only when the roster is split by origin: at
// least one local leader and at least one remote follower (a gateway browser
// joined a devserver). A sole user's all-local roster, a remote-only roster
// and an empty one stay quiet. The badge names this window's own role.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";

import { sessionWindowId } from "../api/client";
import { sessionState, type SessionParticipant } from "../state/session.svelte";
import AppStatusBar from "./AppStatusBar.svelte";

let view: Record<string, unknown> | null = null;

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
  sessionState.participants = [];
});

function participant(role: "leader" | "follower", window_id = `w-${role}-${Math.random()}`): SessionParticipant {
  return { window_id, name: null, role, status: "live" };
}

function badge(participants: SessionParticipant[]): string | null {
  sessionState.participants = participants;
  const target = document.createElement("div");
  document.body.append(target);
  view = mount(AppStatusBar, { target });
  flushSync();
  return target.querySelector('[aria-label="session role"]')?.textContent?.trim() ?? null;
}

describe("the session role badge", () => {
  test("stays hidden for an all-local roster", () => {
    expect(badge([participant("leader", sessionWindowId()), participant("leader")])).toBeNull();
  });

  test("stays hidden for a remote-only roster", () => {
    expect(badge([participant("follower", sessionWindowId()), participant("follower")])).toBeNull();
  });

  test("stays hidden for an empty roster", () => {
    expect(badge([])).toBeNull();
  });

  test("names this window's role once a remote follower joins a local leader", () => {
    expect(badge([participant("leader", sessionWindowId()), participant("follower")])).toBe("leader");
  });

  test("names the follower role in the remote window", () => {
    expect(badge([participant("leader"), participant("follower", sessionWindowId())])).toBe("follower");
  });
});
