// Unit tests for the optimistic bridge: begin opens a marker; reconcile holds it
// while the row is still at its pre-click status and drops it once the backend
// `status` moves off that (the transition began, so `status` drives the spinner),
// the row is gone, or the backstop elapses; clear stops the spinner (the reject
// path). No localStorage: the bridge is in-memory only -- a boot-restore spinner
// now comes from the backend `status:starting`, not a persisted marker.

import { describe, it, expect, beforeEach } from "vitest";
import {
  pending,
  isPending,
  beginPending,
  clearPending,
  clearAllPending,
  reconcile,
  wsKey,
  servedKey,
  dsKey,
} from "./pending.svelte";

beforeEach(() => {
  clearAllPending();
});

describe("pending bridge", () => {
  it("begins a marker and reports it pending", () => {
    const k = wsKey("a");
    expect(isPending(k)).toBe(false);
    beginPending(k, "on");
    expect(isPending(k)).toBe(true);
    expect(pending.markers[k]?.target).toBe("on");
  });

  it("keys served + devserver markers distinctly", () => {
    beginPending(servedKey("ds-1", "w/api"), "off");
    beginPending(dsKey("ds-1"), "connected");
    expect(isPending(servedKey("ds-1", "w/api"))).toBe(true);
    expect(isPending(dsKey("ds-1"))).toBe(true);
    // A different devserver serving the same prefix is a different marker.
    expect(isPending(servedKey("ds-2", "w/api"))).toBe(false);
  });

  it("holds the bridge while the row is still at its pre-click state, drops it once status moves", () => {
    beginPending(wsKey("a"), "on"); // pre-click state: "stopped"
    // Backend hasn't started the mount yet → still "stopped" → bridge held.
    reconcile({ [wsKey("a")]: "stopped" });
    expect(isPending(wsKey("a"))).toBe(true);
    // Status moved to the transitional "starting": backend `status` now drives
    // the spinner, so the bridge is dropped.
    reconcile({ [wsKey("a")]: "starting" });
    expect(isPending(wsKey("a"))).toBe(false);
  });

  it("drops the bridge once an off reaches its settled status", () => {
    beginPending(wsKey("b"), "off"); // pre-click state: "running"
    reconcile({ [wsKey("b")]: "running" }); // not begun yet → held
    expect(isPending(wsKey("b"))).toBe(true);
    reconcile({ [wsKey("b")]: "stopped" }); // reached → dropped
    expect(isPending(wsKey("b"))).toBe(false);
  });

  it("holds an off bridge over a degraded row, the same as a running one", () => {
    // A mount whose root stopped being usable is still mounted, so its Turn off
    // starts from `unavailable` rather than `running`. The bridge has to span
    // that click too, or the row loses its spinner the moment a poll lands.
    beginPending(wsKey("d"), "off");
    reconcile({ [wsKey("d")]: "unavailable" });
    expect(isPending(wsKey("d"))).toBe(true);
    reconcile({ [wsKey("d")]: "closing" });
    expect(isPending(wsKey("d"))).toBe(false);
  });

  it("holds a connect bridge until the dial leaves disconnected", () => {
    const k = dsKey("d");
    beginPending(k, "connected"); // pre-click state: "disconnected"
    reconcile({ [k]: "disconnected" }); // not begun → held
    expect(isPending(k)).toBe(true);
    reconcile({ [k]: "connecting" }); // dialing → status drives → dropped
    expect(isPending(k)).toBe(false);
  });

  it("drops a marker whose row is gone (no current state)", () => {
    beginPending(dsKey("x"), "connected");
    reconcile({}); // x no longer present
    expect(isPending(dsKey("x"))).toBe(false);
  });

  it("treats a backstopped marker as not pending and reconcile drops it", () => {
    const k = wsKey("c");
    beginPending(k, "on");
    // Backdate the marker well past the backstop.
    pending.markers[k]!.ts = Date.now() - 60_000;
    expect(isPending(k)).toBe(false);
    // Even though the row is still at its pre-click state, the backstop clears it.
    reconcile({ [k]: "stopped" });
    expect(k in pending.markers).toBe(false);
  });

  it("clearPending stops the spinner (the reject path)", () => {
    const k = dsKey("r");
    beginPending(k, "connected");
    expect(isPending(k)).toBe(true);
    clearPending(k);
    expect(isPending(k)).toBe(false);
  });
});
