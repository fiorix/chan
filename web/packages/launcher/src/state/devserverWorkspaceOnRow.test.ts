// The connected-devserver turn-on answers 200 with the workspace's
// LauncherWorkspace row, the shape the list route sends, so a caller reads a
// degraded mount straight off the answer. 204 still happens where the desktop
// holds no row: a devserver that answered without one, or a local devserver
// whose toggle it could not complete.
//
// The launcher dropped that row and re-listed instead, so what the user saw
// after turning a workspace on was whatever the list happened to return. The
// re-list stays as a backstop for a dropped feed; correctness no longer waits
// on it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEntry } from "../api/library";

const calls = vi.hoisted(() => ({ list: 0 }));
const served = vi.hoisted(() => ({
  answer: null as unknown,
  listed: [] as unknown[],
}));

vi.mock("../api/backend", () => ({
  backend: {
    listWorkspaces: vi.fn(async () => {
      calls.list += 1;
      return served.listed;
    }),
    setDevserverWorkspaceOn: vi.fn(async () => served.answer),
    listDevservers: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listGateways: vi.fn(async () => []),
  },
}));

import { library, setDevserverWorkspaceOn } from "./library.svelte";

function row(over: Partial<WorkspaceEntry> = {}): WorkspaceEntry {
  return {
    workspace_id: "ws-served",
    path: "/remote/project",
    label: "project",
    on: true,
    status: "running",
    library_id: "lib-remote",
    devserver_id: "ds-1",
    prefix: "project",
    ...over,
  } as WorkspaceEntry;
}

beforeEach(() => {
  calls.list = 0;
  served.answer = null;
  served.listed = [];
  library.workspaces = [];
});

afterEach(() => {
  library.workspaces = [];
  vi.clearAllMocks();
});

describe("turning on a connected devserver's workspace", () => {
  it("shows the degraded mount the answer carries, without needing the re-list", async () => {
    // The route answers 200 with a row the devserver reports unavailable.
    served.answer = row({ status: "unavailable", error: "root is gone" });
    // The list is stale: this is the second request the contract says a caller
    // must not need for correctness.
    served.listed = [row({ status: "running" })];

    await setDevserverWorkspaceOn("ds-1", "project", true);

    const shown = library.workspaces.find((w) => w.prefix === "project");
    expect(shown?.status, "the answer's status is what the user sees").toBe("unavailable");
    expect(shown?.error, "and its reason").toBe("root is gone");
  });

  it("keeps a healthy row from the answer too", async () => {
    served.answer = row({ status: "running" });
    served.listed = [];

    await setDevserverWorkspaceOn("ds-1", "project", true);

    const shown = library.workspaces.find((w) => w.prefix === "project");
    expect(shown?.status).toBe("running");
  });

  it("falls back to the list when the route answers 204 with no row", async () => {
    // A devserver that answered without a row, or a local devserver whose
    // toggle the desktop could not complete: there is nothing to apply.
    served.answer = undefined;
    served.listed = [row({ status: "running" })];

    await setDevserverWorkspaceOn("ds-1", "project", true);

    expect(calls.list, "the re-list is what fills the gap").toBeGreaterThan(0);
    expect(library.workspaces.find((w) => w.prefix === "project")?.status).toBe("running");
  });

  it("still re-lists, so a dropped feed does not strand the marker", async () => {
    served.answer = row({ status: "running" });
    served.listed = [row({ status: "running" })];

    await setDevserverWorkspaceOn("ds-1", "project", true);

    expect(calls.list, "the backstop is unchanged").toBeGreaterThan(0);
  });
});
