// The session-role badge shows ONLY when the roster is genuinely split by
// ORIGIN: at least one local Leader AND at least one remote Follower. A sole-user
// all-local roster (his standalone terminals, his workspace windows) stays quiet;
// a mixed roster (a gateway browser joined a devserver) shows the badge, reading
// the self window's role.
//
// The visibility PREDICATE is unit-tested directly; the ?raw source pin guards
// that AppStatusBar still computes it this way and reads the self role. A real
// browser badge smoke is a host-smoke item (a ?raw pin misses Svelte-5 runtime
// reactivity).

import { describe, expect, test } from "vitest";
import statusBar from "./AppStatusBar.svelte?raw";
import type { SessionParticipant } from "../state/session.svelte";

function participant(role: "leader" | "follower"): SessionParticipant {
  return { window_id: `w-${role}`, name: null, role, status: "live" };
}

// The exact predicate AppStatusBar uses for roleVisible: a real origin split.
function roleVisible(participants: SessionParticipant[]): boolean {
  return (
    participants.some((p) => p.role === "leader") &&
    participants.some((p) => p.role === "follower")
  );
}

describe("session role badge visibility", () => {
  test("hidden for a sole-user all-local roster (all leaders)", () => {
    expect(roleVisible([participant("leader")])).toBe(false);
    expect(roleVisible([participant("leader"), participant("leader")])).toBe(
      false,
    );
  });

  test("hidden for a remote-only roster (all followers)", () => {
    expect(
      roleVisible([participant("follower"), participant("follower")]),
    ).toBe(false);
  });

  test("shown for a mixed roster (a gateway browser joined)", () => {
    expect(roleVisible([participant("leader"), participant("follower")])).toBe(
      true,
    );
  });

  test("hidden for an empty roster", () => {
    expect(roleVisible([])).toBe(false);
  });
});

describe("AppStatusBar source keeps the origin-split rule", () => {
  test("roleVisible is a leader-AND-follower split, not a bare participant count", () => {
    expect(statusBar).toMatch(
      /sessionState\.participants\.some\(\(p\) => p\.role === "leader"\)[\s\S]{1,80}sessionState\.participants\.some\(\(p\) => p\.role === "follower"\)/,
    );
    // The old count-based rule must be gone.
    expect(statusBar).not.toMatch(/participants\.length > 1/);
  });

  test("the badge reads the self participant's role", () => {
    expect(statusBar).toMatch(/selfParticipant\(\)\?\.role/);
  });
});
