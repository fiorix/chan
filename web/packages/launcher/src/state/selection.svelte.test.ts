// Multi-select + bulk-action tests against the in-memory mock. ONE selection
// spans three kinds (local workspaces + served devserver workspaces +
// devservers) feeding one global bulk bar; the bulk ops are global (no kind
// argument), and bulk remove runs an ordered cross-kind delete. Each case adds
// its own rows so it is robust to the shared module-level mock state.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { WorkspaceStatus } from "../api/library";
import {
  selection,
  isSelected,
  selectedCount,
  toggleSelected,
  clearSelection,
  bulkSetOnAll,
  requestBulkDelete,
  cancelBulkDelete,
  confirmBulkDelete,
  setSelectMode,
  toggleSelectMode,
  checksVisible,
} from "./selection.svelte";
import {
  addGateway,
  addLocalWorkspace,
  connectDevserver,
  library,
  loadLibrary,
  saveDevserver,
  stopWatching,
} from "./library.svelte";

// Pin the in-memory mock as the backend so these tests drive the registries with
// no live server, independent of how the app composes its default backend. The
// async-import factory dodges vi.mock's hoist-over-imports trap.
vi.mock("../api/backend", async () => {
  const { mockApi } = await import("../api/mock");
  return { backend: mockApi };
});

// A macrotask hop drains the coalesced live re-fetch the window-watch push
// drives (the served-workspace ops refresh `library.workspaces` only through it,
// not by a direct await).
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

beforeEach(async () => {
  clearSelection();
  await loadLibrary();
});

afterEach(() => {
  stopWatching();
});

describe("workspace multi-select", () => {
  it("toggles a row in and out of the selection", () => {
    const id = library.workspaces.find((w) => w.devserver_id === null)!.workspace_id;
    expect(isSelected("workspace", id)).toBe(false);
    toggleSelected("workspace", id);
    expect(isSelected("workspace", id)).toBe(true);
    expect(selectedCount("workspace")).toBe(1);
    toggleSelected("workspace", id);
    expect(isSelected("workspace", id)).toBe(false);
    expect(selectedCount("workspace")).toBe(0);
  });

  it("bulk turn off sets every selected workspace off", async () => {
    await addLocalWorkspace("/tmp/sel-a");
    await addLocalWorkspace("/tmp/sel-b");
    const a = library.workspaces.find((w) => w.path === "/tmp/sel-a")!;
    const b = library.workspaces.find((w) => w.path === "/tmp/sel-b")!;
    toggleSelected("workspace", a.workspace_id);
    toggleSelected("workspace", b.workspace_id);
    await bulkSetOnAll(false);
    expect(library.workspaces.find((w) => w.workspace_id === a.workspace_id)?.on).toBe(false);
    expect(library.workspaces.find((w) => w.workspace_id === b.workspace_id)?.on).toBe(false);
  });

  it("bulk turn on skips locked workspaces", async () => {
    await addLocalWorkspace("/tmp/sel-locked");
    const locked = library.workspaces.find((w) => w.path === "/tmp/sel-locked")!;
    library.workspaces = library.workspaces.map((w) =>
      w.workspace_id === locked.workspace_id ? { ...w, on: false, status: "locked" } : w,
    );
    toggleSelected("workspace", locked.workspace_id);

    await bulkSetOnAll(true);

    const row = library.workspaces.find((w) => w.workspace_id === locked.workspace_id)!;
    expect(row.status).toBe("locked");
    expect(row.on).toBe(false);
    expect(selection.note).toBe("1 locked workspace skipped");
  });

  // Total over the wire union: which status a bulk run refuses to act on is the
  // classifier's `foreign` answer, so a status added to the wire needs an entry
  // here. A degraded mount is not one of them -- it is up, and turning it off is
  // the one action that helps it.
  const SKIPPED_BY_BULK: Record<WorkspaceStatus, boolean> = {
    stopped: false,
    starting: false,
    running: false,
    locked: true,
    closing: false,
    removing: false,
    error: false,
    unavailable: false,
  };

  it("skips a bulk run over the foreign lock alone", async () => {
    for (const status of Object.keys(SKIPPED_BY_BULK) as WorkspaceStatus[]) {
      const skipped = SKIPPED_BY_BULK[status];
      const path = `/tmp/sel-bulk-${status}`;
      clearSelection();
      await addLocalWorkspace(path);
      const id = library.workspaces.find((w) => w.path === path)!.workspace_id;
      library.workspaces = library.workspaces.map((w) =>
        w.workspace_id === id ? { ...w, on: true, status } : w,
      );
      toggleSelected("workspace", id);

      await bulkSetOnAll(false);

      // A skipped row is untouched (still on); an included one was turned off.
      const row = library.workspaces.find((w) => w.workspace_id === id)!;
      expect({ status, note: selection.note, on: row.on }).toEqual({
        status,
        note: skipped ? "1 locked workspace skipped" : null,
        on: skipped,
      });
    }
  });

  it("remove is gated behind a confirm; cancel leaves the row", async () => {
    await addLocalWorkspace("/tmp/sel-keep");
    const id = library.workspaces.find((w) => w.path === "/tmp/sel-keep")!.workspace_id;
    toggleSelected("workspace", id);
    requestBulkDelete();
    expect(selection.confirmingDelete).toBe(true);
    cancelBulkDelete();
    expect(selection.confirmingDelete).toBe(false);
    expect(library.workspaces.some((w) => w.workspace_id === id)).toBe(true);
  });

  it("confirmed bulk remove drops the selected workspaces and clears the selection", async () => {
    await addLocalWorkspace("/tmp/sel-del");
    const id = library.workspaces.find((w) => w.path === "/tmp/sel-del")!.workspace_id;
    const before = library.workspaces.length;
    toggleSelected("workspace", id);
    requestBulkDelete();
    await confirmBulkDelete();
    expect(library.workspaces.some((w) => w.workspace_id === id)).toBe(false);
    expect(library.workspaces.length).toBe(before - 1);
    expect(selectedCount()).toBe(0);
    expect(selection.confirmingDelete).toBe(false);
  });

  it("confirmed bulk remove skips locked workspaces and keeps them selected", async () => {
    await addLocalWorkspace("/tmp/sel-locked-rm");
    const locked = library.workspaces.find((w) => w.path === "/tmp/sel-locked-rm")!;
    library.workspaces = library.workspaces.map((w) =>
      w.workspace_id === locked.workspace_id ? { ...w, on: false, status: "locked" } : w,
    );
    toggleSelected("workspace", locked.workspace_id);
    requestBulkDelete();

    await confirmBulkDelete();

    expect(library.workspaces.some((w) => w.workspace_id === locked.workspace_id)).toBe(true);
    expect(isSelected("workspace", locked.workspace_id)).toBe(true);
    expect(selection.note).toBe("1 locked workspace skipped");
  });
});

describe("served (devserver-mounted) multi-select", () => {
  it("keys a served row by (kind, prefix, devserverId) so it never collides with a local id", () => {
    // The seed devserver ds-1 is connected; its served "w/docs" row is OFF.
    const local = library.workspaces.find((w) => w.devserver_id === null)!.workspace_id;
    toggleSelected("workspace", local);
    toggleSelected("served", "w/docs", "ds-1");
    expect(isSelected("workspace", local)).toBe(true);
    expect(isSelected("served", "w/docs", "ds-1")).toBe(true);
    // No devserverId (or a different one) is a different row.
    expect(isSelected("served", "w/docs")).toBe(false);
    expect(selectedCount("served")).toBe(1);
    expect(selectedCount()).toBe(2);
  });

  it("bulk turn on turns on every selected served workspace via its devserver", async () => {
    // ds-1:w/docs starts OFF (no live terminals → an unforced on/off is clean).
    expect(library.workspaces.find((w) => w.devserver_id === "ds-1" && w.prefix === "w/docs")!.on).toBe(false);
    toggleSelected("served", "w/docs", "ds-1");
    await bulkSetOnAll(true);
    await settle();
    expect(library.workspaces.find((w) => w.devserver_id === "ds-1" && w.prefix === "w/docs")!.on).toBe(true);
    expect(selection.note).toBeNull();
  });
});

describe("devserver multi-select", () => {
  it("keys selection by kind so a workspace and a devserver id never collide", () => {
    const ws = library.workspaces.find((w) => w.devserver_id === null)!.workspace_id;
    const ds = library.devservers[0]!.id;
    toggleSelected("workspace", ws);
    toggleSelected("devserver", ds);
    expect(selectedCount("workspace")).toBe(1);
    expect(selectedCount("devserver")).toBe(1);
    // Clearing one kind leaves the other.
    clearSelection("workspace");
    expect(selectedCount("workspace")).toBe(0);
    expect(selectedCount("devserver")).toBe(1);
  });

  it("bulk turn off disconnects every selected devserver", async () => {
    // The seed devserver is connected; bulk turn off → disconnect.
    const ds = library.devservers.find((d) => d.status === "connected")!;
    toggleSelected("devserver", ds.id);
    await bulkSetOnAll(false);
    expect(library.devservers.find((d) => d.id === ds.id)?.status).toBe("disconnected");
  });

  it("bulk turn on connects every selected devserver", async () => {
    await saveDevserver({ host: "bulk-on.example", port: 9200, label: "bulk-on" });
    const ds = library.devservers.find((d) => d.host === "bulk-on.example" && d.port === 9200)!;
    expect(ds.status).toBe("disconnected");
    toggleSelected("devserver", ds.id);
    await bulkSetOnAll(true);
    expect(library.devservers.find((d) => d.id === ds.id)?.status).toBe("connected");
  });

  it("confirmed bulk remove drops the selected devserver", async () => {
    await saveDevserver({ host: "bulk-rm.example", port: 9300, label: "bulk-rm" });
    const ds = library.devservers.find((d) => d.host === "bulk-rm.example" && d.port === 9300)!;
    const before = library.devservers.length;
    toggleSelected("devserver", ds.id);
    requestBulkDelete();
    expect(selection.confirmingDelete).toBe(true);
    await confirmBulkDelete();
    expect(library.devservers.some((d) => d.id === ds.id)).toBe(false);
    expect(library.devservers.length).toBe(before - 1);
    expect(selectedCount()).toBe(0);
  });
});

describe("gateway multi-select", () => {
  afterEach(async () => {
    const { resetMockGateways } = await import("../api/mock");
    resetMockGateways();
  });

  it("bulk on/off routes gateway rows to the gateway ops, never the devserver ones", async () => {
    await addGateway({ url: "https://bulk-gw.example" });
    const gw = library.gateways.find((g) => g.url === "https://bulk-gw.example")!;
    const { backend } = await import("../api/backend");
    const dsConnect = vi.spyOn(backend, "connectDevserver");
    const dsDisconnect = vi.spyOn(backend, "disconnectDevserver");

    toggleSelected("gateway", gw.id);
    await bulkSetOnAll(true);
    expect(library.gateways.find((g) => g.id === gw.id)?.status).toBe("connected");
    await bulkSetOnAll(false);
    expect(library.gateways.find((g) => g.id === gw.id)?.status).toBe("disconnected");
    expect(selection.note).toBeNull();

    // The regression the explicit dispatch prevents: a gateway id riding the
    // devserver connect/disconnect path.
    expect(dsConnect).not.toHaveBeenCalled();
    expect(dsDisconnect).not.toHaveBeenCalled();
    dsConnect.mockRestore();
    dsDisconnect.mockRestore();
  });

  it("confirmed bulk remove drops the selected gateway and clears the selection", async () => {
    await addGateway({ url: "https://rm-gw.example" });
    const gw = library.gateways.find((g) => g.url === "https://rm-gw.example")!;
    toggleSelected("gateway", gw.id);
    requestBulkDelete();
    await confirmBulkDelete();
    expect(library.gateways.some((g) => g.id === gw.id)).toBe(false);
    expect(selectedCount()).toBe(0);
    expect(selection.confirmingDelete).toBe(false);
  });

  it("the ordered cross-kind delete removes gateways LAST", async () => {
    const { backend } = await import("../api/backend");
    const order: string[] = [];
    const spies = [
      vi.spyOn(backend, "removeWorkspace").mockImplementation(async () => {
        order.push("workspace");
      }),
      vi.spyOn(backend, "forgetDevserverWorkspace").mockImplementation(async () => {
        order.push("served");
      }),
      vi.spyOn(backend, "removeDevserver").mockImplementation(async () => {
        order.push("devserver");
      }),
      vi.spyOn(backend, "removeGateway").mockImplementation(async () => {
        order.push("gateway");
      }),
    ];
    try {
      toggleSelected("gateway", "gw-order");
      toggleSelected("devserver", "ds-order");
      toggleSelected("served", "w/order", "ds-order");
      toggleSelected("workspace", "ws-order");
      requestBulkDelete();
      await confirmBulkDelete();
      expect(order).toEqual(["workspace", "served", "devserver", "gateway"]);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

describe("select mode lifecycle", () => {
  it("reveals checks on enter and hides + clears the selection on exit", () => {
    expect(checksVisible()).toBe(false);
    setSelectMode(true);
    expect(selection.selectMode).toBe(true);
    expect(checksVisible()).toBe(true);
    toggleSelected("workspace", "ws-1");
    expect(selectedCount()).toBe(1);
    setSelectMode(false);
    expect(selection.selectMode).toBe(false);
    expect(checksVisible()).toBe(false);
    // Leaving select mode clears the selection so no stale check lingers.
    expect(selectedCount()).toBe(0);
  });

  it("keeps checks visible while a row stays selected, even in browse mode", () => {
    toggleSelected("devserver", "ds-1");
    expect(selection.selectMode).toBe(false);
    expect(checksVisible()).toBe(true);
  });

  it("toggleSelectMode flips the mode", () => {
    expect(selection.selectMode).toBe(false);
    toggleSelectMode();
    expect(selection.selectMode).toBe(true);
    toggleSelectMode();
    expect(selection.selectMode).toBe(false);
  });

  it("a full clearSelection() also leaves select mode", () => {
    setSelectMode(true);
    toggleSelected("workspace", "ws-1");
    clearSelection();
    expect(selection.selectMode).toBe(false);
    expect(selectedCount()).toBe(0);
  });
});

describe("ordered cross-kind bulk remove", () => {
  it("removes local workspaces, then forgets served workspaces, then removes devservers", async () => {
    // A mixed selection across all three kinds: a local workspace, a connected
    // devserver's served workspace (ds-1:w/api), and a fresh devserver. Ensure
    // ds-1 is connected first (a prior case may have disconnected it in the
    // shared mock) so its served rows merge into the feed, then re-list.
    await connectDevserver("ds-1");
    await loadLibrary();
    await addLocalWorkspace("/tmp/mix-local");
    await saveDevserver({ host: "mix.example", port: 9400, label: "mix" });
    const local = library.workspaces.find((w) => w.path === "/tmp/mix-local")!;
    const mix = library.devservers.find((d) => d.host === "mix.example" && d.port === 9400)!;
    expect(library.workspaces.some((w) => w.devserver_id === "ds-1" && w.prefix === "w/api")).toBe(true);

    toggleSelected("workspace", local.workspace_id);
    toggleSelected("served", "w/api", "ds-1");
    toggleSelected("devserver", mix.id);
    expect(selectedCount()).toBe(3);

    requestBulkDelete();
    expect(selection.confirmingDelete).toBe(true);
    await confirmBulkDelete();

    // Served workspace forgotten (left the merged feed), devserver removed, and
    // the local workspace removed -- all three gone; selection cleared.
    expect(library.workspaces.some((w) => w.devserver_id === "ds-1" && w.prefix === "w/api")).toBe(false);
    expect(library.devservers.some((d) => d.id === mix.id)).toBe(false);
    expect(library.workspaces.some((w) => w.path === "/tmp/mix-local")).toBe(false);
    expect(selectedCount()).toBe(0);
    expect(selection.confirmingDelete).toBe(false);
    expect(selection.note).toBeNull();
  });
});
