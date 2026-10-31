// Unit tests for the pure machine-tree grouping: sort order, duplicate-key
// drop, the flat-feed grouping, the nested tree (disjoint control / terminal
// / per-workspace partition, window counts, trailing-slash path join, loose +
// orphan fallbacks, LOCAL-first machine ordering), and the tmux connection
// nodes (rows grouped by their mark, the pinned control row, the provisional
// node, the unopened windows, the card title).

import { describe, it, expect } from "vitest";
import {
  sortWindows,
  dedupeWindows,
  buildMachineTree,
  machineName,
  machineWindowCount,
  tmuxCardTitle,
  windowOverview,
} from "./machineTree";
import type {
  DevserverEntry,
  TmuxConnectionEntry,
  WindowRecord,
  WorkspaceEntry,
} from "../api/library";

function win(
  over: Partial<WindowRecord> & Pick<WindowRecord, "window_id" | "library_id">,
): WindowRecord {
  return {
    kind: "terminal",
    title: "",
    ordinal: 1,
    workspace_path: null,
    prefix: "",
    token: "",
    persisted: true,
    connected: true,
    active_transfer: false,
    control: false,
    ...over,
  };
}

function ws(over: Partial<WorkspaceEntry> & Pick<WorkspaceEntry, "workspace_id" | "path">): WorkspaceEntry {
  return {
    label: "",
    on: true,
    status: "running",
    library_id: "local",
    devserver_id: null,
    prefix: over.workspace_id,
    ...over,
  };
}

function ds(over: Partial<DevserverEntry> & Pick<DevserverEntry, "id">): DevserverEntry {
  return {
    url: "http://host:8000",
    host: "host",
    port: 8000,
    label: "",
    script: "",
    has_token: false,
    library_id: null,
    status: "disconnected",
    pending_signin: false,
    auto_hide_control: false,
    os: "",
    pretty_name: null,
    gateway_id: null,
    gateway_url: "",
    shared: false,
    native_trust_required: false,
    ...over,
  };
}

describe("sortWindows", () => {
  it("pins control first, terminals before workspaces, then by ordinal", () => {
    const control = win({ window_id: "c", library_id: "local", control: true, ordinal: 9 });
    const term2 = win({ window_id: "t2", library_id: "local", kind: "terminal", ordinal: 2 });
    const term1 = win({ window_id: "t1", library_id: "local", kind: "terminal", ordinal: 1 });
    const wsWin = win({ window_id: "w", library_id: "local", kind: "workspace", ordinal: 1 });
    const sorted = [wsWin, term2, control, term1].sort(sortWindows);
    expect(sorted.map((w) => w.window_id)).toEqual(["c", "t1", "t2", "w"]);
  });
});

describe("dedupeWindows", () => {
  it("drops a duplicated window_id, keeping the first", () => {
    const a = win({ window_id: "dup", library_id: "local", ordinal: 1 });
    const b = win({ window_id: "dup", library_id: "local", ordinal: 2 });
    const out = dedupeWindows([a, b]);
    expect(out.length).toBe(1);
    expect(out[0]!.ordinal).toBe(1);
  });
});

describe("buildMachineTree", () => {
  it("always renders LOCAL first, even with no workspaces or windows", () => {
    const tree = buildMachineTree([], [], []);
    expect(tree.machines.length).toBe(1);
    expect(tree.machines[0]!.kind).toBe("local");
    expect(tree.machines[0]!.libraryId).toBe("local");
  });

  it("partitions a machine's windows into disjoint control / terminal / workspace buckets", () => {
    const windows = [
      win({ window_id: "c", library_id: "local", control: true, ordinal: 0 }),
      win({ window_id: "t", library_id: "local", kind: "terminal", ordinal: 1 }),
      win({
        window_id: "w1",
        library_id: "local",
        kind: "workspace",
        workspace_path: "/p/notes",
        ordinal: 1,
      }),
      win({
        window_id: "w2",
        library_id: "local",
        kind: "workspace",
        workspace_path: "/p/notes",
        ordinal: 2,
      }),
    ];
    const workspaces = [ws({ workspace_id: "ws-notes", path: "/p/notes" })];
    const tree = buildMachineTree([], workspaces, windows);
    const local = tree.machines[0]!;
    expect(local.control.map((w) => w.window_id)).toEqual(["c"]);
    expect(local.terminals.map((w) => w.window_id)).toEqual(["t"]);
    expect(local.workspaces.length).toBe(1);
    expect(local.workspaces[0]!.count).toBe(2);
    expect(local.workspaces[0]!.windows.map((w) => w.window_id)).toEqual(["w1", "w2"]);
    expect(local.looseWindows.length).toBe(0);
    // No window appears in two buckets.
    const all = [
      ...local.control,
      ...local.terminals,
      ...local.workspaces.flatMap((c) => c.windows),
      ...local.looseWindows,
    ];
    expect(new Set(all.map((w) => w.window_id)).size).toBe(all.length);
  });

  it("joins workspace windows by path tolerant of a trailing slash", () => {
    const windows = [
      win({
        window_id: "w",
        library_id: "local",
        kind: "workspace",
        workspace_path: "/p/notes/",
        ordinal: 1,
      }),
    ];
    const workspaces = [ws({ workspace_id: "ws-notes", path: "/p/notes" })];
    const tree = buildMachineTree([], workspaces, windows);
    expect(tree.machines[0]!.workspaces[0]!.count).toBe(1);
    expect(tree.machines[0]!.looseWindows.length).toBe(0);
  });

  it("uses a local workspace row's library id for the local machine", () => {
    const windows = [win({ window_id: "term", library_id: "lib-local-devserver", ordinal: 1 })];
    const workspaces = [
      ws({
        workspace_id: "ws-notes",
        path: "/p/notes",
        library_id: "lib-local-devserver",
      }),
    ];
    const tree = buildMachineTree([], workspaces, windows);
    const local = tree.machines[0]!;
    expect(local.libraryId).toBe("lib-local-devserver");
    expect(local.terminals.map((w) => w.window_id)).toEqual(["term"]);
    expect(tree.orphans).toEqual([]);
  });

  it("treats the sole library on a devserver first boot as local", () => {
    const windows = [win({ window_id: "boot-term", library_id: "lib-boot", ordinal: 1 })];
    const tree = buildMachineTree([], [], windows);
    const local = tree.machines[0]!;
    expect(local.libraryId).toBe("lib-boot");
    expect(local.terminals.map((w) => w.window_id)).toEqual(["boot-term"]);
    expect(tree.orphans).toEqual([]);
  });

  it("falls back loose workspace windows whose path matches no card", () => {
    const windows = [
      win({
        window_id: "w",
        library_id: "local",
        kind: "workspace",
        workspace_path: "/p/gone",
        ordinal: 1,
      }),
    ];
    const tree = buildMachineTree([], [], windows);
    expect(tree.machines[0]!.workspaces.length).toBe(0);
    expect(tree.machines[0]!.looseWindows.map((w) => w.window_id)).toEqual(["w"]);
  });

  it("buckets windows of an unknown library into orphans (unsynced control terminal)", () => {
    const windows = [
      win({ window_id: "orphan", library_id: "lib-unsynced", control: true, ordinal: 0 }),
    ];
    // The devserver exists but has no library_id yet (never connected), so the
    // control window's library_id matches no machine.
    const devservers = [ds({ id: "ds-1", label: "fresh", library_id: null })];
    const tree = buildMachineTree(devservers, [], windows);
    expect(tree.orphans.map((w) => w.window_id)).toEqual(["orphan"]);
    // The devserver still appears as a machine block (header only, no windows).
    expect(tree.machines.some((m) => m.devserver?.id === "ds-1")).toBe(true);
  });

  it("orders devservers by name after LOCAL and joins each one's windows", () => {
    const devservers = [
      ds({ id: "ds-b", label: "zeta", library_id: "lib-b", status: "connected" }),
      ds({ id: "ds-a", label: "alpha", library_id: "lib-a", status: "connected" }),
    ];
    const windows = [
      win({ window_id: "a-term", library_id: "lib-a", kind: "terminal", ordinal: 1 }),
    ];
    const tree = buildMachineTree(devservers, [], windows);
    expect(tree.machines.map((m) => (m.kind === "local" ? "local" : m.devserver!.label))).toEqual([
      "local",
      "alpha",
      "zeta",
    ]);
    const alpha = tree.machines.find((m) => m.devserver?.id === "ds-a")!;
    expect(alpha.terminals.map((w) => w.window_id)).toEqual(["a-term"]);
  });
});

describe("machineWindowCount", () => {
  it("is zero for a machine with no windows", () => {
    const tree = buildMachineTree([], [], []);
    expect(machineWindowCount(tree.machines[0]!)).toBe(0);
  });

  it("sums control + terminals + per-workspace + loose across the disjoint buckets", () => {
    const windows = [
      win({ window_id: "c", library_id: "local", control: true, ordinal: 0 }),
      win({ window_id: "t", library_id: "local", kind: "terminal", ordinal: 1 }),
      win({
        window_id: "w1",
        library_id: "local",
        kind: "workspace",
        workspace_path: "/p/notes",
        ordinal: 1,
      }),
      win({
        window_id: "w2",
        library_id: "local",
        kind: "workspace",
        workspace_path: "/p/notes",
        ordinal: 2,
      }),
      win({
        window_id: "loose",
        library_id: "local",
        kind: "workspace",
        workspace_path: "/p/gone",
        ordinal: 3,
      }),
    ];
    const workspaces = [ws({ workspace_id: "ws-notes", path: "/p/notes" })];
    const local = buildMachineTree([], workspaces, windows).machines[0]!;
    // 1 control + 1 terminal + 2 in the notes card + 1 loose.
    expect(machineWindowCount(local)).toBe(5);
  });

  it("excludes orphan windows (they belong to no machine)", () => {
    const windows = [
      win({ window_id: "orphan", library_id: "lib-unsynced", control: true, ordinal: 0 }),
    ];
    const devservers = [ds({ id: "ds-1", label: "fresh", library_id: null })];
    const tree = buildMachineTree(devservers, [], windows);
    expect(tree.orphans.map((w) => w.window_id)).toEqual(["orphan"]);
    for (const m of tree.machines) expect(machineWindowCount(m)).toBe(0);
  });
});

function tmux(
  over: Partial<TmuxConnectionEntry> & Pick<TmuxConnectionEntry, "connection">,
): TmuxConnectionEntry {
  return {
    library_id: "local",
    origin: { program: "tmux", command: "tmux -CC", local: true },
    version: "3.5a",
    session: { id: "$0", name: "main" },
    windows: [],
    window_cap: 8,
    errors: [],
    control_window: `${over.connection}-control`,
    ...over,
  };
}

function tmuxRow(
  connection: string,
  window_id: string,
  control: boolean,
  ordinal: number,
  library_id = "local",
): WindowRecord {
  return win({ window_id, library_id, control, ordinal, tmux: { connection, control } });
}

describe("tmuxCardTitle", () => {
  it("names a local run and a remote one by the foreground that printed the marker", () => {
    expect(tmuxCardTitle(tmux({ connection: "a" }))).toBe("tmux -CC on this machine");
    expect(
      tmuxCardTitle(
        tmux({ connection: "b", origin: { program: "ssh", command: "ssh geekom", local: false } }),
      ),
    ).toBe("tmux -CC from ssh geekom");
  });

  it("falls back to the program when the OS let no command line be read", () => {
    expect(
      tmuxCardTitle(tmux({ connection: "c", origin: { program: "ssh", command: null, local: false } })),
    ).toBe("tmux -CC from ssh");
    expect(
      tmuxCardTitle(tmux({ connection: "c", origin: { program: "mosh", command: "", local: false } })),
    ).toBe("tmux -CC from mosh");
  });

  it("is the bare command while the record has not arrived", () => {
    expect(tmuxCardTitle(null)).toBe("tmux -CC");
  });
});

describe("buildMachineTree: tmux connections", () => {
  it("groups a connection's rows under its own machine, control first, and off This machine", () => {
    const entry = tmux({ connection: "tm-1" });
    const windows = [
      win({ window_id: "plain", library_id: "local", ordinal: 1 }),
      tmuxRow("tm-1", "tm-1-w2", false, 2),
      tmuxRow("tm-1", "tm-1-control", true, 0),
      tmuxRow("tm-1", "tm-1-w1", false, 1),
    ];
    const tree = buildMachineTree([], [], windows, [entry]);
    const local = tree.machines[0]!;
    expect(local.terminals.map((w) => w.window_id)).toEqual(["plain"]);
    expect(local.control).toEqual([]);
    const node = tree.machines.find((m) => m.kind === "tmux")!;
    expect(node.connection).toBe("tm-1");
    expect(node.tmux).toBe(entry);
    expect(node.devserver).toBeNull();
    expect(node.libraryId).toBe("local");
    expect(node.control.map((w) => w.window_id)).toEqual(["tm-1-control"]);
    expect(node.terminals.map((w) => w.window_id)).toEqual(["tm-1-w1", "tm-1-w2"]);
    expect(node.workspaces).toEqual([]);
    expect(node.looseWindows).toEqual([]);
    expect(tree.orphans).toEqual([]);
    expect(machineName(node)).toBe("tmux -CC on this machine");
    expect(machineName(local)).toBe("This machine");
  });

  it("pins the control row by its tmux mark alone", () => {
    // The plain control flag is the devserver's; a tmux row is the control
    // terminal when its mark says so, whatever the flag reads.
    const windows = [
      win({ window_id: "c", library_id: "local", ordinal: 5, tmux: { connection: "tm-1", control: true } }),
      win({ window_id: "w", library_id: "local", ordinal: 1, tmux: { connection: "tm-1", control: false } }),
    ];
    const node = buildMachineTree([], [], windows, [tmux({ connection: "tm-1" })]).machines[1]!;
    expect(node.control.map((w) => w.window_id)).toEqual(["c"]);
    expect(node.terminals.map((w) => w.window_id)).toEqual(["w"]);
  });

  it("takes a devserver library's tmux rows off the devserver card", () => {
    const devservers = [ds({ id: "ds-a", label: "alpha", library_id: "lib-a", status: "connected" })];
    const windows = [
      win({ window_id: "a-term", library_id: "lib-a", ordinal: 1 }),
      tmuxRow("tm-a", "tm-a-w1", false, 1, "lib-a"),
    ];
    const tree = buildMachineTree(devservers, [], windows, [
      tmux({ connection: "tm-a", library_id: "lib-a" }),
    ]);
    const alpha = tree.machines.find((m) => m.devserver?.id === "ds-a")!;
    expect(alpha.terminals.map((w) => w.window_id)).toEqual(["a-term"]);
    const node = tree.machines.find((m) => m.kind === "tmux")!;
    expect(node.terminals.map((w) => w.window_id)).toEqual(["tm-a-w1"]);
    expect(node.libraryId).toBe("lib-a");
  });

  it("builds a provisional node for rows whose record has not arrived", () => {
    const windows = [
      tmuxRow("tm-early", "e-control", true, 0),
      tmuxRow("tm-early", "e-w1", false, 1),
    ];
    const tree = buildMachineTree([], [], windows);
    const node = tree.machines.find((m) => m.kind === "tmux")!;
    expect(node.tmux).toBeNull();
    expect(node.connection).toBe("tm-early");
    expect(machineName(node)).toBe("tmux -CC");
    expect(node.control.map((w) => w.window_id)).toEqual(["e-control"]);
    expect(node.terminals.map((w) => w.window_id)).toEqual(["e-w1"]);
    expect(node.unopened).toEqual([]);
    expect(node.libraryId).toBe("local");
    expect(tree.orphans).toEqual([]);
    expect(tree.machines[0]!.control).toEqual([]);
  });

  it("lists the record's windows with no chan window as unopened rows", () => {
    const entry = tmux({
      connection: "tm-1",
      windows: [
        { id: "@1", name: "vim", panes: 2, open: true, chan_window: "tm-1-w1" },
        { id: "@3", name: "logs", panes: 1, open: false },
        { id: "@4", name: "top", panes: 1, open: false, chan_window: null },
      ],
    });
    const rows = [tmuxRow("tm-1", "tm-1-control", true, 0), tmuxRow("tm-1", "tm-1-w1", false, 1)];
    const node = buildMachineTree([], [], rows, [entry]).machines[1]!;
    expect(node.unopened.map((tw) => tw.id)).toEqual(["@3", "@4"]);
    // The badge counts every row the card shows: control, open, unopened.
    expect(machineWindowCount(node)).toBe(4);
  });

  it("gives a record with no rows yet a node of its own", () => {
    const tree = buildMachineTree([], [], [], [tmux({ connection: "tm-1" })]);
    expect(tree.machines.map((m) => m.kind)).toEqual(["local", "tmux"]);
    expect(machineWindowCount(tree.machines[1]!)).toBe(0);
  });

  it("orders the connections after the devservers: local, remote by title, then unrecorded", () => {
    const devservers = [ds({ id: "ds-a", label: "alpha", library_id: "lib-a" })];
    const entries = [
      tmux({ connection: "z", origin: { program: "ssh", command: "ssh zeta", local: false } }),
      tmux({ connection: "a", origin: { program: "ssh", command: "ssh alpha", local: false } }),
      tmux({ connection: "l" }),
      tmux({ connection: "l", origin: { program: "ssh", command: "ssh dup", local: false } }),
    ];
    const tree = buildMachineTree(devservers, [], [tmuxRow("early", "e", false, 1)], entries);
    expect(tree.machines.map((m) => (m.kind === "tmux" ? m.connection : m.kind))).toEqual([
      "local",
      "devserver",
      "l",
      "a",
      "z",
      "early",
    ]);
    // A repeated record keeps its first copy, so the deck never keys an id twice.
    expect(tree.machines.filter((m) => m.connection === "l")).toHaveLength(1);
    expect(tree.machines.find((m) => m.connection === "l")!.tmux!.origin.local).toBe(true);
  });
});

describe("windowOverview", () => {
  it("names a tmux row's machine with the card's title", () => {
    const entry = tmux({
      connection: "tm-1",
      origin: { program: "ssh", command: "ssh geekom", local: false },
    });
    const windows = [
      tmuxRow("tm-1", "tm-1-w1", false, 1),
      win({ window_id: "plain", library_id: "local", ordinal: 1 }),
    ];
    const tree = buildMachineTree([], [], windows, [entry]);
    expect(windowOverview(tree).map((r) => [r.window.window_id, r.machine])).toEqual([
      ["plain", "This machine"],
      ["tm-1-w1", "tmux -CC from ssh geekom"],
    ]);
  });
});
