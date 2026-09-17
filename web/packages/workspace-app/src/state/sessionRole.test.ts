// @vitest-environment jsdom

// isLeader/isFollower read THIS window's ORIGIN-derived role off the /ws
// roster: a local participant reads leader, a tunnel participant follower, and a
// window with no self row is NEITHER (a solo / not-yet-seeded window must still
// own its own layout blob). This is a real runtime test (not a ?raw pin), so a
// Svelte-5 reactivity regression in the derivation is caught here.

import { beforeEach, describe, expect, test } from "vitest";
import {
  applySessionRoster,
  isFollower,
  isLeader,
  type SessionParticipant,
} from "./session.svelte";

const SELF = "w-self";

function participant(
  window_id: string,
  role: "leader" | "follower",
): SessionParticipant {
  return { window_id, name: null, role, status: "live" };
}

beforeEach(() => {
  // sessionWindowId() reads `?w=` off the URL; pin it to SELF for these cases.
  window.history.replaceState({}, "", `/?w=${SELF}`);
  applySessionRoster({ participants: [], leader: null });
});

describe("session role readers (origin-derived)", () => {
  test("a local self participant reads leader, not follower", () => {
    applySessionRoster({
      participants: [
        participant(SELF, "leader"),
        participant("w-remote", "follower"),
      ],
      leader: SELF,
    });
    expect(isLeader()).toBe(true);
    expect(isFollower()).toBe(false);
  });

  test("a tunnel self participant reads follower, not leader", () => {
    applySessionRoster({
      participants: [
        participant("w-local", "leader"),
        participant(SELF, "follower"),
      ],
      leader: "w-local",
    });
    expect(isFollower()).toBe(true);
    expect(isLeader()).toBe(false);
  });

  test("no self participant is NEITHER leader nor follower", () => {
    // A not-yet-seeded / untagged window: it must still own its own layout blob,
    // so it is not a follower even though it is not a leader.
    applySessionRoster({
      participants: [participant("w-other", "leader")],
      leader: "w-other",
    });
    expect(isLeader()).toBe(false);
    expect(isFollower()).toBe(false);
  });

  test("role tracks ORIGIN, not the single owner slot", () => {
    // Two local windows both read leader; the owner slot names the first one.
    // Old code compared self against the owner slot and would have called self a
    // follower here. Origin-derived role keeps self a leader.
    applySessionRoster({
      participants: [
        participant("w-first", "leader"),
        participant(SELF, "leader"),
      ],
      leader: "w-first",
    });
    expect(isLeader()).toBe(true);
    expect(isFollower()).toBe(false);
  });
});
