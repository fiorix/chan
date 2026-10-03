// Per-tenant leadership gating: leaderless OR this launcher owns the leader
// window. hasWindowHandle is mocked so we control handle ownership directly.

import { describe, it, expect, beforeEach, vi } from "vitest";

const { hasWindowHandle } = vi.hoisted(() => ({ hasWindowHandle: vi.fn() }));
vi.mock("./windowManager.svelte", () => ({ hasWindowHandle }));

import { actingFor, canActOnTenant, ownsTenantLeader, tenantLeader } from "./leadership.svelte";
import { library } from "./library.svelte";

beforeEach(() => {
  library.leaders = {};
  hasWindowHandle.mockReset().mockReturnValue(false);
});

describe("tenantLeader", () => {
  it("returns the leader window_id, or null when leaderless", () => {
    library.leaders = { "proj-1": "w-lead" };
    expect(tenantLeader("proj-1")).toBe("w-lead");
    expect(tenantLeader("proj-2")).toBeNull();
  });
});

describe("ownsTenantLeader", () => {
  it("is true only when the leader window_id is one of our handles", () => {
    library.leaders = { "proj-1": "w-lead" };
    hasWindowHandle.mockImplementation((id: string) => id === "w-lead");
    expect(ownsTenantLeader("proj-1")).toBe(true);
    expect(hasWindowHandle).toHaveBeenCalledWith("w-lead");
  });

  it("is false when a different surface leads", () => {
    library.leaders = { "proj-1": "w-other" };
    hasWindowHandle.mockReturnValue(false);
    expect(ownsTenantLeader("proj-1")).toBe(false);
  });

  it("is false for a leaderless tenant (no leader to own)", () => {
    expect(ownsTenantLeader("proj-1")).toBe(false);
    expect(hasWindowHandle).not.toHaveBeenCalled();
  });
});

describe("canActOnTenant", () => {
  it("allows a leaderless tenant (creating establishes leadership)", () => {
    expect(canActOnTenant("proj-1")).toBe(true);
  });

  it("allows when this launcher owns the leader", () => {
    library.leaders = { "proj-1": "w-lead" };
    hasWindowHandle.mockImplementation((id: string) => id === "w-lead");
    expect(canActOnTenant("proj-1")).toBe(true);
  });

  it("blocks when another surface leads", () => {
    library.leaders = { "proj-1": "w-other" };
    hasWindowHandle.mockReturnValue(false);
    expect(canActOnTenant("proj-1")).toBe(false);
  });
});

describe("actingFor", () => {
  it("claims only the leader window this launcher holds", () => {
    library.leaders = { owned: "w-owned", foreign: "w-foreign" };
    hasWindowHandle.mockImplementation((id: string) => id === "w-owned");
    expect(actingFor("owned")).toBe("w-owned");
    expect(actingFor("foreign")).toBeUndefined();
    expect(actingFor("leaderless")).toBeUndefined();
  });
});
