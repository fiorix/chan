import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The per-machine collapse store: a localStorage-cached, config-reconciled set
// of collapsed machine keys. `initialCollapsed()` runs at module load, so each
// scenario primes localStorage / fetch first and re-imports the module.

const STORAGE_KEY = "chan-launcher-collapsed-machines";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("machineCollapse initial hydration", () => {
  test("empty when nothing is stored", async () => {
    const { collapsedState } = await import("./machineCollapse.svelte");
    expect(collapsedState.keys).toEqual([]);
  });

  test("adopts a stored array of keys", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["local", "ds-1"]));
    const { collapsedState, isMachineCollapsed } = await import("./machineCollapse.svelte");
    expect(collapsedState.keys).toEqual(["local", "ds-1"]);
    expect(isMachineCollapsed("ds-1")).toBe(true);
    expect(isMachineCollapsed("ds-2")).toBe(false);
  });

  test("ignores malformed JSON (starts expanded)", async () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    const { collapsedState } = await import("./machineCollapse.svelte");
    expect(collapsedState.keys).toEqual([]);
  });

  test("ignores a non-array stored value and non-string members", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ local: true }));
    const { collapsedState } = await import("./machineCollapse.svelte");
    expect(collapsedState.keys).toEqual([]);
  });
});

describe("machineCollapse toggle", () => {
  test("adds a key, caches it, and mirrors it to the desktop config", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { collapsedState, isMachineCollapsed, toggleMachineCollapsed } = await import(
      "./machineCollapse.svelte"
    );

    toggleMachineCollapsed("ds-1");

    expect(isMachineCollapsed("ds-1")).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(["ds-1"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/library/collapsed-machines",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ collapsed: ["ds-1"] }),
      }),
    );
    // Toggling again removes the key.
    toggleMachineCollapsed("ds-1");
    expect(collapsedState.keys).toEqual([]);
  });

  test("still flips in memory when the PUT fails (best-effort)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("no store");
      }),
    );
    const { isMachineCollapsed, toggleMachineCollapsed } = await import("./machineCollapse.svelte");
    toggleMachineCollapsed("local");
    expect(isMachineCollapsed("local")).toBe(true);
  });
});

describe("machineCollapse reconcile", () => {
  test("adopts the authoritative config array and refreshes the cache", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ collapsed: ["ds-2"] }), { status: 200 })),
    );
    const { collapsedState, reconcileCollapsedMachines } = await import("./machineCollapse.svelte");
    expect(collapsedState.keys).toEqual([]);
    await reconcileCollapsedMachines();
    expect(collapsedState.keys).toEqual(["ds-2"]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(["ds-2"]);
  });

  test("keeps the current set when the config is null (unset / no store)", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["local"]));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ collapsed: null }), { status: 200 })),
    );
    const { collapsedState, reconcileCollapsedMachines } = await import("./machineCollapse.svelte");
    expect(collapsedState.keys).toEqual(["local"]);
    await reconcileCollapsedMachines();
    expect(collapsedState.keys).toEqual(["local"]);
  });

  test("keeps the current set on a non-ok response", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["local"]));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    const { collapsedState, reconcileCollapsedMachines } = await import("./machineCollapse.svelte");
    await reconcileCollapsedMachines();
    expect(collapsedState.keys).toEqual(["local"]);
  });

  test("keeps the current set when the fetch throws", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["local"]));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const { collapsedState, reconcileCollapsedMachines } = await import("./machineCollapse.svelte");
    await reconcileCollapsedMachines();
    expect(collapsedState.keys).toEqual(["local"]);
  });
});
