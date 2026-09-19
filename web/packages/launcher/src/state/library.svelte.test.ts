// State-layer tests against the in-memory mock backend (the default). They
// assert deltas rather than absolute counts, since the mock state is a shared
// module-level singleton mutated across cases.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  addGateway,
  addLocalWorkspace,
  connectDevserver,
  connectGateway,
  disconnectDevserver,
  disconnectGateway,
  library,
  loadLibrary,
  openWorkspaceWindow,
  removeDevserver,
  removeGateway,
  removeWorkspace,
  resync,
  saveDevserver,
  stopWatching,
  toggleWorkspace,
  updateGateway,
  windowLiveTerminalCount,
} from "./library.svelte";
import { ApiError } from "../api/library";
import { beginPending, clearAllPending, dsKey, isPending, wsKey } from "./pending.svelte";

// Pin the in-memory mock as the backend so these tests drive the registry +
// window feed with no live server, independent of how the app composes its
// default backend. The async-import factory dodges vi.mock's hoist-over-imports
// trap (the factory can't close over a top-level import binding).
vi.mock("../api/backend", async () => {
  const { mockApi } = await import("../api/mock");
  return { backend: mockApi };
});

beforeEach(async () => {
  await loadLibrary();
});

afterEach(() => {
  stopWatching();
  vi.useRealTimers();
});

describe("loadLibrary", () => {
  // The window feed is served live (a real watch socket), so its population is
  // not asserted here: jsdom has no WebSocket, and loadLibrary subscribes
  // best-effort. The feed's grouping/recompose logic is covered by
  // windowLabel.test.ts; its live behaviour by the integration pass.
  it("populates both registries", () => {
    expect(library.workspaces.length).toBeGreaterThanOrEqual(2);
    expect(library.devservers.length).toBeGreaterThanOrEqual(1);
  });

  it("never exposes a devserver token (write-only wire)", () => {
    for (const ds of library.devservers) {
      expect(Object.prototype.hasOwnProperty.call(ds, "token")).toBe(false);
      expect(typeof ds.has_token).toBe("boolean");
    }
  });

  it("subscribes to the window feed before registry restoration settles", async () => {
    stopWatching();
    const { backend } = await import("../api/backend");
    const order: string[] = [];
    let resolveWorkspaces: (value: []) => void = () => {};
    let resolveDevservers: (value: []) => void = () => {};
    const watch = vi.spyOn(backend, "watchWindows").mockImplementation(() => {
      order.push("watch");
      return () => {};
    });
    const workspaces = vi.spyOn(backend, "listWorkspaces").mockImplementation(
      () =>
        new Promise((resolve) => {
          order.push("workspaces");
          resolveWorkspaces = resolve as (value: []) => void;
        }),
    );
    const devservers = vi.spyOn(backend, "listDevservers").mockImplementation(
      () =>
        new Promise((resolve) => {
          order.push("devservers");
          resolveDevservers = resolve as (value: []) => void;
        }),
    );

    const loading = loadLibrary();
    expect(order[0]).toBe("watch");
    expect(order).toEqual(["watch", "workspaces", "devservers"]);

    resolveWorkspaces([]);
    resolveDevservers([]);
    await loading;

    watch.mockRestore();
    workspaces.mockRestore();
    devservers.mockRestore();
  });
});

describe("window live-terminal count", () => {
  it.each([
    new Error("count unavailable"),
    new ApiError(404, "missing window"),
  ])("treats a failed count request as unknown", async (error) => {
    const { backend } = await import("../api/backend");
    const count = vi.spyOn(backend, "liveTerminalCount").mockRejectedValueOnce(error);

    await expect(windowLiveTerminalCount(library.windows[0]!)).resolves.toBeNull();
    expect(count).toHaveBeenCalledOnce();
    count.mockRestore();
  });
});

describe("workspace registry", () => {
  it("adds a local workspace", async () => {
    const before = library.workspaces.length;
    await addLocalWorkspace("/tmp/added-by-test");
    expect(library.workspaces.length).toBe(before + 1);
    expect(library.workspaces.some((w) => w.path === "/tmp/added-by-test")).toBe(true);
  });

  it("toggles a workspace off and on", async () => {
    const ws = library.workspaces[0]!;
    await toggleWorkspace(ws.workspace_id, false);
    expect(library.workspaces.find((w) => w.workspace_id === ws.workspace_id)?.on).toBe(false);
    await toggleWorkspace(ws.workspace_id, true);
    expect(library.workspaces.find((w) => w.workspace_id === ws.workspace_id)?.on).toBe(true);
  });

  it("re-lists after a refused toggle so the row behind the error is the live one", async () => {
    // A refused `on` is how the launcher learns its row was stale: the server
    // answers 409 over a tenant whose root is not usable. The error still
    // reaches the caller, and the list behind it is fetched again.
    const { backend } = await import("../api/backend");
    const reason = "workspace root does not exist: /tmp/stale";
    await addLocalWorkspace("/tmp/stale");
    const ws = library.workspaces.find((w) => w.path === "/tmp/stale")!;
    const onSpy = vi
      .spyOn(backend, "setWorkspaceOn")
      .mockRejectedValueOnce(new ApiError(409, JSON.stringify({ error: reason })));
    const listSpy = vi.spyOn(backend, "listWorkspaces").mockImplementation(async () =>
      library.workspaces.map((w) =>
        w.workspace_id === ws.workspace_id
          ? { ...w, on: true, status: "unavailable" as const, error: reason }
          : w,
      ),
    );

    try {
      await expect(toggleWorkspace(ws.workspace_id, true)).rejects.toThrow(reason);
      expect(listSpy).toHaveBeenCalled();
      const row = library.workspaces.find((w) => w.workspace_id === ws.workspace_id)!;
      expect(row.status).toBe("unavailable");
      expect(row.error).toBe(reason);
      expect(isPending(wsKey(ws.workspace_id))).toBe(false);
    } finally {
      // The list stub answers for the whole registry, so a failure here would
      // follow the shared mock state into the next case.
      onSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it("removes a workspace", async () => {
    await addLocalWorkspace("/tmp/to-remove");
    const target = library.workspaces.find((w) => w.path === "/tmp/to-remove")!;
    const before = library.workspaces.length;
    await removeWorkspace(target.workspace_id);
    expect(library.workspaces.length).toBe(before - 1);
  });

  it("drops a workspace's windows from the feed when it is turned off (no stale state)", async () => {
    // Self-contained against the shared mock: add an on workspace, open a window
    // onto it, then turn it off. The off purges its windows (the backend's
    // discard_workspace_windows, mirrored in the mock) and the watch push
    // replaces library.windows wholesale, so no ghost window record lingers.
    await addLocalWorkspace("/tmp/w6-off");
    const ws = library.workspaces.find((w) => w.path === "/tmp/w6-off")!;
    await openWorkspaceWindow("/tmp/w6-off");
    expect(library.windows.some((w) => w.workspace_path === "/tmp/w6-off")).toBe(true);
    await toggleWorkspace(ws.workspace_id, false);
    expect(library.windows.some((w) => w.workspace_path === "/tmp/w6-off")).toBe(false);
  });
});

describe("devserver registry", () => {
  it("adds a devserver and reports a stored token without echoing it", async () => {
    const before = library.devservers.length;
    await saveDevserver({ host: "box.test", port: 9001, label: "qa", token: "tok_secret" });
    expect(library.devservers.length).toBe(before + 1);
    const added = library.devservers.find((d) => d.host === "box.test" && d.port === 9001)!;
    expect(added.has_token).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(added, "token")).toBe(false);
    expect(added.label).toBe("qa");
  });

  it("edits a devserver, keeping the stored token when none is supplied", async () => {
    await saveDevserver({ host: "edit.test", port: 9002, token: "tok_keep" });
    const ds = library.devservers.find((d) => d.host === "edit.test" && d.port === 9002)!;
    await saveDevserver({ host: "edit.test", port: 9003 }, ds.id);
    const updated = library.devservers.find((d) => d.id === ds.id)!;
    expect(updated.host).toBe("edit.test");
    expect(updated.port).toBe(9003);
    expect(updated.has_token).toBe(true);
  });

  it("edits a devserver and explicitly clears the stored token", async () => {
    await saveDevserver({ host: "clear-token.test", port: 9005, token: "tok_clear" });
    const ds = library.devservers.find((d) => d.host === "clear-token.test" && d.port === 9005)!;
    expect(ds.has_token).toBe(true);

    await saveDevserver({ host: "clear-token.test", port: 9005, clear_token: true }, ds.id);

    const updated = library.devservers.find((d) => d.id === ds.id)!;
    expect(updated.has_token).toBe(false);
  });

  it("removes a devserver", async () => {
    await saveDevserver({ host: "gone.test", port: 9004 });
    const ds = library.devservers.find((d) => d.host === "gone.test" && d.port === 9004)!;
    const before = library.devservers.length;
    await removeDevserver(ds.id);
    expect(library.devservers.length).toBe(before - 1);
  });

  it("connects a devserver and marks its library's windows live", async () => {
    // The seed devserver carries a library id (already connected once); the
    // mock marks that library's windows connected and pushes the feed.
    const ds = library.devservers.find((d) => d.library_id)!;
    library.error = null;
    await connectDevserver(ds.id);
    expect(library.error).toBeNull();
    const remote = library.windows.filter((w) => w.library_id === ds.library_id);
    expect(remote.length).toBeGreaterThan(0);
    expect(remote.every((w) => w.connected)).toBe(true);
  });

  it("disconnects a devserver and removes its transient control row", async () => {
    const ds = library.devservers.find((d) => d.id === "ds-1")!;
    await connectDevserver(ds.id);
    expect(library.windows.some((w) => w.library_id === ds.library_id && w.control)).toBe(true);

    await disconnectDevserver(ds.id);

    expect(library.devservers.find((d) => d.id === ds.id)?.status).toBe("disconnected");
    expect(library.windows.some((w) => w.library_id === ds.library_id && w.control)).toBe(false);
  });
});

describe("gateway sign-in wait", () => {
  afterEach(() => {
    clearAllPending();
  });

  it("clears the click bridge the moment a row reports pending_signin", async () => {
    // A gateway connect with no PAT returns at once: the row's wire status is
    // still `disconnected` (waiting is a row state, not a connection state),
    // so without the synthetic pending_signin mapping the click marker would
    // spin out its whole backstop. The refetch must read the hand-off as a
    // state move and hand the spinner to the waiting row.
    const { backend } = await import("../api/backend");
    const ds = library.devservers[0]!;
    beginPending(dsKey(ds.id), "connected");
    expect(isPending(dsKey(ds.id))).toBe(true);
    const spy = vi
      .spyOn(backend, "listDevservers")
      .mockResolvedValue([{ ...ds, status: "disconnected", pending_signin: true }]);
    resync();
    await new Promise((r) => setTimeout(r, 0));
    expect(isPending(dsKey(ds.id))).toBe(false);
    expect(library.devservers[0]!.pending_signin).toBe(true);
    spy.mockRestore();
  });

  it("holds the click bridge while the row has not moved", async () => {
    // Control case: no pending_signin and an unmoved status keep the bridge
    // open (the instant feedback between click and the backend transition).
    const { backend } = await import("../api/backend");
    const ds = library.devservers.find((d) => d.status === "disconnected") ?? {
      ...library.devservers[0]!,
      status: "disconnected" as const,
    };
    beginPending(dsKey(ds.id), "connected");
    const spy = vi
      .spyOn(backend, "listDevservers")
      .mockResolvedValue([{ ...ds, status: "disconnected", pending_signin: false }]);
    resync();
    await new Promise((r) => setTimeout(r, 0));
    expect(isPending(dsKey(ds.id))).toBe(true);
    spy.mockRestore();
  });
});

describe("resync on regaining visibility/focus", () => {
  it("re-reads both registries on a window focus event", async () => {
    // loadLibrary (beforeEach) installs the visibility/focus listener. A focus
    // re-reads the authoritative registries so state drift while hidden / a
    // feed blip is corrected with no user action.
    const { backend } = await import("../api/backend");
    const ws = vi.spyOn(backend, "listWorkspaces");
    const ds = vi.spyOn(backend, "listDevservers");
    window.dispatchEvent(new Event("focus"));
    await new Promise((r) => setTimeout(r, 0));
    expect(ws).toHaveBeenCalled();
    expect(ds).toHaveBeenCalled();
    ws.mockRestore();
    ds.mockRestore();
  });

  it("polls workspaces while visible and stops after teardown", async () => {
    vi.useFakeTimers();
    stopWatching();
    await loadLibrary();
    const { backend } = await import("../api/backend");
    const ws = vi.spyOn(backend, "listWorkspaces");

    await vi.advanceTimersByTimeAsync(2000);
    expect(ws).toHaveBeenCalled();
    const calls = ws.mock.calls.length;

    stopWatching();
    await vi.advanceTimersByTimeAsync(4000);
    expect(ws.mock.calls.length).toBe(calls);
    ws.mockRestore();
  });
});

describe("gateway registry state", () => {
  afterEach(async () => {
    const { resetMockGateways } = await import("../api/mock");
    resetMockGateways();
  });

  it("loadLibrary populates gateways alongside the other registries", async () => {
    await addGateway({ url: "https://gw.example" });
    await loadLibrary();
    expect(library.gateways.length).toBeGreaterThanOrEqual(1);
  });

  it("add/connect/disconnect/remove re-list so the acting client flips at once", async () => {
    await addGateway({ url: "https://gw.example", label: "gw" });
    const gw = library.gateways.find((g) => g.url === "https://gw.example")!;
    expect(gw).toBeTruthy();
    expect(gw.status).toBe("disconnected");

    await connectGateway(gw.id);
    expect(library.gateways.find((g) => g.id === gw.id)!.status).toBe("connected");

    await disconnectGateway(gw.id);
    const off = library.gateways.find((g) => g.id === gw.id)!;
    expect(off.status).toBe("disconnected");
    expect(off.enabled).toBe(false);

    await removeGateway(gw.id);
    expect(library.gateways.some((g) => g.id === gw.id)).toBe(false);
  });

  it("updateGateway renames and re-lists so the acting client flips at once", async () => {
    await addGateway({ url: "https://rename.example", label: "before" });
    const gw = library.gateways.find((g) => g.url === "https://rename.example")!;
    await updateGateway(gw.id, { url: gw.url, label: "after" });
    const renamed = library.gateways.find((g) => g.id === gw.id)!;
    expect(renamed.label).toBe("after");
    // Rename only: the URL is identity and never moves.
    expect(renamed.url).toBe("https://rename.example");
  });

  it("the watch push re-fetches gateways live (the third refresh)", async () => {
    const { backend } = await import("../api/backend");
    const spy = vi.spyOn(backend, "listGateways");
    // A window mutation fires the watch push; the gateway registry re-lists
    // on the same signal (the desktop signals library-change on gateway
    // mutations, which ride the same feed).
    await backend.createWindow("terminal");
    await new Promise((r) => setTimeout(r, 0));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
