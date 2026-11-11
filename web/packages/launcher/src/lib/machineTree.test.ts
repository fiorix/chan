// Unit tests for the pure machine-tree grouping: sort order, duplicate-key
// drop, the flat-feed grouping, the nested tree (disjoint control / terminal
// / per-workspace partition, window counts, trailing-slash path join, loose +
// orphan fallbacks, LOCAL-first machine ordering), and the tmux connection
// nodes (rows grouped by their mark, the pinned control row, the provisional
// node, the unopened windows, the card title, and the control terminal listed
// again on the card of the machine that runs the connection).

import { describe, it, expect } from "vitest";
import {
  sortWindows,
  dedupeWindows,
  buildMachineTree,
  machineName,
  machineWindowCount,
  tmuxCardTitle,
  tmuxWindowMachine,
  windowOverview,
  type MachineNode,
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
    expect(tmuxCardTitle(tmux({ connection: "a" }), null)).toBe("tmux -CC on this machine");
    expect(
      tmuxCardTitle(
        tmux({ connection: "b", origin: { program: "ssh", command: "ssh geekom", local: false } }),
        null,
      ),
    ).toBe("tmux -CC from ssh geekom");
  });

  it("names a tmux run in a devserver's terminal by the devserver", () => {
    expect(tmuxCardTitle(tmux({ connection: "a", library_id: "lib-a" }), "alpha")).toBe(
      "tmux -CC on alpha",
    );
    // A carrier's command line already says where the server runs.
    expect(
      tmuxCardTitle(
        tmux({
          connection: "b",
          library_id: "lib-a",
          origin: { program: "ssh", command: "ssh geekom", local: false },
        }),
        "alpha",
      ),
    ).toBe("tmux -CC from ssh geekom");
  });

  it("falls back to the program when the OS let no command line be read", () => {
    expect(
      tmuxCardTitle(
        tmux({ connection: "c", origin: { program: "ssh", command: null, local: false } }),
        null,
      ),
    ).toBe("tmux -CC from ssh");
    expect(
      tmuxCardTitle(
        tmux({ connection: "c", origin: { program: "mosh", command: "", local: false } }),
        null,
      ),
    ).toBe("tmux -CC from mosh");
  });

  it("is the bare command while the record has not arrived", () => {
    expect(tmuxCardTitle(null, null)).toBe("tmux -CC");
    expect(tmuxCardTitle(null, "alpha")).toBe("tmux -CC");
  });
});

describe("tmuxWindowMachine", () => {
  it("adds the tmux session to the card's title", () => {
    expect(tmuxWindowMachine(tmux({ connection: "a", library_id: "lib-a" }), "alpha")).toBe(
      "tmux -CC on alpha (main)",
    );
    expect(
      tmuxWindowMachine(
        tmux({
          connection: "b",
          origin: { program: "ssh", command: "ssh geekom", local: false },
          session: { id: "$1", name: "work" },
        }),
        null,
      ),
    ).toBe("tmux -CC from ssh geekom (work)");
  });

  it("is the title alone before tmux announces the session", () => {
    // The library leaves the session out of the record until tmux names it.
    const unnamed = { ...tmux({ connection: "a" }), session: undefined } as unknown as TmuxConnectionEntry;
    expect(tmuxWindowMachine(unnamed, null)).toBe("tmux -CC on this machine");
    expect(tmuxWindowMachine(null, null)).toBe("tmux -CC");
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
    expect(node.tmuxHost).toBe("alpha");
    expect(machineName(node)).toBe("tmux -CC on alpha");
  });

  it("names a devserver's tmux by the row that holds the library's windows", () => {
    // A direct row and its gateway roster row share one library; the first by
    // name holds its windows, so the tmux card names that one.
    const devservers = [
      ds({ id: "ds-z", label: "zeta", library_id: "lib-a" }),
      ds({ id: "ds-b", label: "beta", library_id: "lib-a" }),
    ];
    const tree = buildMachineTree(devservers, [], [], [
      tmux({ connection: "tm-a", library_id: "lib-a" }),
    ]);
    const holder = tree.machines.find((m) => m.libraryId === "lib-a" && m.kind === "devserver")!;
    expect(holder.devserver!.label).toBe("beta");
    expect(machineName(tree.machines.find((m) => m.kind === "tmux")!)).toBe("tmux -CC on beta");
  });

  it("keeps a local run on this machine while a devserver's library id is unknown", () => {
    const devservers = [ds({ id: "ds-a", label: "alpha", library_id: null })];
    const node = buildMachineTree(devservers, [], [], [tmux({ connection: "tm-1" })]).machines.find(
      (m) => m.kind === "tmux",
    )!;
    expect(node.tmuxHost).toBeNull();
    expect(machineName(node)).toBe("tmux -CC on this machine");
  });

  it("keeps a local run on this machine when a devserver resolves to its library", () => {
    const workspaces = [ws({ workspace_id: "local-ws", path: "/local", library_id: "lib-host" })];
    const devservers = [ds({ id: "ds-self", label: "other name", library_id: "lib-host" })];
    const windows = [win({ window_id: "local-term", library_id: "lib-host" })];
    const tree = buildMachineTree(devservers, workspaces, windows, [
      tmux({ connection: "tm-local", library_id: "lib-host" }),
    ]);
    expect(tree.machines[0]!.terminals.map((window) => window.window_id)).toEqual(["local-term"]);
    const node = tree.machines.find((machine) => machine.kind === "tmux")!;
    expect(node.tmuxHost).toBeNull();
    expect(machineName(node)).toBe("tmux -CC on this machine");
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

  it("orders a devserver's tmux after this machine's, among the remote ones by title", () => {
    const devservers = [ds({ id: "ds-a", label: "alpha", library_id: "lib-a" })];
    const entries = [
      tmux({ connection: "z", origin: { program: "ssh", command: "ssh zeta", local: false } }),
      tmux({ connection: "d", library_id: "lib-a" }),
      tmux({ connection: "l" }),
    ];
    const tree = buildMachineTree(devservers, [], [], entries);
    expect(tree.machines.filter((m) => m.kind === "tmux").map(machineName)).toEqual([
      "tmux -CC on this machine",
      "tmux -CC from ssh zeta",
      "tmux -CC on alpha",
    ]);
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
      ["plain", "local"],
      ["tm-1-w1", "tmux -CC from ssh geekom (main)"],
    ]);
  });

  it("names this machine local, as window titles do, and a devserver by its card", () => {
    const devservers = [ds({ id: "ds-a", label: "geekom", library_id: "lib-a" })];
    const workspaces = [
      ws({ workspace_id: "w-local", path: "/Users/hacker/src/chan" }),
      ws({ workspace_id: "w-remote", path: "/home/geekom/chan", library_id: "lib-a", devserver_id: "ds-a" }),
    ];
    const windows = [
      win({ window_id: "local-term", library_id: "local" }),
      win({ window_id: "local-ws", library_id: "local", kind: "workspace", workspace_path: "/Users/hacker/src/chan" }),
      win({ window_id: "remote-ws", library_id: "lib-a", kind: "workspace", workspace_path: "/home/geekom/chan" }),
    ];
    const tree = buildMachineTree(devservers, workspaces, windows);
    expect(windowOverview(tree).map((r) => [r.window.window_id, r.machine])).toEqual([
      ["local-term", "local"],
      ["local-ws", "local"],
      ["remote-ws", "geekom"],
    ]);
    // The card keeps its own name.
    expect(machineName(tree.machines[0]!)).toBe("This machine");
  });

  it("tells two connections on one devserver apart by their sessions", () => {
    const devservers = [ds({ id: "ds-a", label: "alpha", library_id: "lib-a" })];
    const entries = [
      tmux({ connection: "tm-1", library_id: "lib-a" }),
      tmux({ connection: "tm-2", library_id: "lib-a", session: { id: "$1", name: "work" } }),
    ];
    const windows = [
      tmuxRow("tm-1", "tm-1-w1", false, 1, "lib-a"),
      tmuxRow("tm-2", "tm-2-w1", false, 1, "lib-a"),
    ];
    const tree = buildMachineTree(devservers, [], windows, entries);
    expect(windowOverview(tree).map((r) => [r.window.window_id, r.machine])).toEqual([
      ["tm-1-w1", "tmux -CC on alpha (main)"],
      ["tm-2-w1", "tmux -CC on alpha (work)"],
    ]);
  });
});

describe("buildMachineTree: a tmux connection's control terminal on its machine", () => {
  /** The ids a node's keyed lists render, each list on its own. */
  function keyedLists(node: MachineNode): Record<string, string[]> {
    return {
      control: node.control.map((w) => w.window_id),
      tmuxControls: node.tmuxControls.map((row) => row.window.window_id),
      terminals: node.terminals.map((w) => w.window_id),
      unopened: node.unopened.map((tw) => tw.id),
      looseWindows: node.looseWindows.map((w) => w.window_id),
      ...Object.fromEntries(node.workspaces.map((ws) => [`ws:${ws.ws.path}`, ws.windows.map((w) => w.window_id)])),
    };
  }

  /** Every window id a card shows, across its lists. */
  function cardIds(node: MachineNode): string[] {
    return Object.values(keyedLists(node)).flat();
  }

  it("lists a local run's control terminal on This machine and its windows on the connection's card alone", () => {
    const entry = tmux({ connection: "tm-1" });
    const windows = [
      win({ window_id: "plain", library_id: "local", ordinal: 1 }),
      tmuxRow("tm-1", "tm-1-control", true, 0),
      tmuxRow("tm-1", "tm-1-w1", false, 1),
    ];
    const tree = buildMachineTree([], [], windows, [entry]);
    const local = tree.machines[0]!;
    const node = tree.machines.find((m) => m.kind === "tmux")!;
    expect(local.tmuxControls.map((row) => row.window.window_id)).toEqual(["tm-1-control"]);
    // The row carries the connection's node: its detach and its title.
    expect(local.tmuxControls[0]!.node).toBe(node);
    expect(local.tmuxControls[0]!.window.tmux).toEqual({ connection: "tm-1", control: true });
    // Nothing else moves: the machine's own buckets and the connection's card.
    expect(local.control).toEqual([]);
    expect(local.terminals.map((w) => w.window_id)).toEqual(["plain"]);
    expect(node.control.map((w) => w.window_id)).toEqual(["tm-1-control"]);
    expect(node.terminals.map((w) => w.window_id)).toEqual(["tm-1-w1"]);
    expect(node.tmuxControls).toEqual([]);
    expect(cardIds(local)).not.toContain("tm-1-w1");
    // The badge counts the rows the card shows.
    expect(machineWindowCount(local)).toBe(2);
    expect(machineWindowCount(node)).toBe(2);
  });

  it("lists a devserver run's control terminal on that devserver's card", () => {
    const devservers = [
      ds({ id: "ds-a", label: "alpha", library_id: "lib-a", status: "connected" }),
      ds({ id: "ds-b", label: "beta", library_id: "lib-b", status: "connected" }),
    ];
    const windows = [
      win({ window_id: "a-term", library_id: "lib-a", ordinal: 1 }),
      tmuxRow("tm-a", "tm-a-control", true, 0, "lib-a"),
      tmuxRow("tm-a", "tm-a-w1", false, 1, "lib-a"),
    ];
    const tree = buildMachineTree(devservers, [], windows, [tmux({ connection: "tm-a", library_id: "lib-a" })]);
    const alpha = tree.machines.find((m) => m.devserver?.id === "ds-a")!;
    const beta = tree.machines.find((m) => m.devserver?.id === "ds-b")!;
    expect(alpha.tmuxControls.map((row) => row.window.window_id)).toEqual(["tm-a-control"]);
    expect(alpha.tmuxControls[0]!.node.connection).toBe("tm-a");
    expect(alpha.terminals.map((w) => w.window_id)).toEqual(["a-term"]);
    expect(cardIds(alpha)).not.toContain("tm-a-w1");
    expect(tree.machines[0]!.tmuxControls).toEqual([]);
    expect(beta.tmuxControls).toEqual([]);
  });

  it("lists it on the card that holds the library when two rows share one", () => {
    // A direct row and its gateway roster row: the first by name holds the
    // library's windows, so it holds the control terminal too.
    const devservers = [
      ds({ id: "ds-z", label: "zeta", library_id: "lib-a" }),
      ds({ id: "ds-b", label: "beta", library_id: "lib-a" }),
    ];
    const windows = [tmuxRow("tm-a", "tm-a-control", true, 0, "lib-a")];
    const tree = buildMachineTree(devservers, [], windows, [tmux({ connection: "tm-a", library_id: "lib-a" })]);
    const beta = tree.machines.find((m) => m.devserver?.id === "ds-b")!;
    const zeta = tree.machines.find((m) => m.devserver?.id === "ds-z")!;
    expect(beta.tmuxControls.map((row) => row.window.window_id)).toEqual(["tm-a-control"]);
    expect(zeta.tmuxControls).toEqual([]);
  });

  it("lists a carrier's run on the machine whose terminal ran it", () => {
    // The tmux server runs on geekom, but the buried terminal is a terminal
    // of the library that ran ssh.
    const carrier = { program: "ssh", command: "ssh geekom", local: false };
    const devservers = [ds({ id: "ds-a", label: "alpha", library_id: "lib-a", status: "connected" })];
    const windows = [
      tmuxRow("tm-here", "tm-here-control", true, 0),
      tmuxRow("tm-here", "tm-here-w1", false, 1),
      tmuxRow("tm-there", "tm-there-control", true, 0, "lib-a"),
    ];
    const tree = buildMachineTree(devservers, [], windows, [
      tmux({ connection: "tm-here", origin: carrier }),
      tmux({ connection: "tm-there", library_id: "lib-a", origin: carrier }),
    ]);
    const local = tree.machines[0]!;
    const alpha = tree.machines.find((m) => m.devserver?.id === "ds-a")!;
    expect(local.tmuxControls.map((row) => row.window.window_id)).toEqual(["tm-here-control"]);
    expect(machineName(local.tmuxControls[0]!.node)).toBe("tmux -CC from ssh geekom");
    expect(alpha.tmuxControls.map((row) => row.window.window_id)).toEqual(["tm-there-control"]);
    expect(cardIds(local)).not.toContain("tm-here-w1");
  });

  it("keeps a control terminal on its connection's card alone while no card holds its library", () => {
    const entries = [
      // A devserver library no card holds yet, local run and carrier alike.
      tmux({ connection: "tm-far", library_id: "lib-unknown" }),
      tmux({
        connection: "tm-far-ssh",
        library_id: "lib-unknown",
        origin: { program: "ssh", command: "ssh geekom", local: false },
      }),
    ];
    const windows = [
      tmuxRow("tm-far", "tm-far-control", true, 0, "lib-unknown"),
      tmuxRow("tm-far-ssh", "tm-far-ssh-control", true, 0, "lib-unknown"),
      // Rows whose record has not arrived: no record names the library.
      tmuxRow("tm-early", "tm-early-control", true, 0),
    ];
    const devservers = [ds({ id: "ds-a", label: "alpha", library_id: null })];
    const tree = buildMachineTree(devservers, [], windows, entries);
    for (const m of tree.machines) expect(m.tmuxControls).toEqual([]);
    for (const connection of ["tm-far", "tm-far-ssh", "tm-early"]) {
      const node = tree.machines.find((m) => m.connection === connection)!;
      expect(node.control.map((w) => w.window_id)).toEqual([`${connection}-control`]);
    }
  });

  it("repeats no id inside any one card, with the control terminal on two cards", () => {
    const entries = [
      tmux({ connection: "tm-1" }),
      // A repeated record keeps its first copy.
      tmux({ connection: "tm-1" }),
      tmux({ connection: "tm-2", session: { id: "$1", name: "work" } }),
    ];
    const control = tmuxRow("tm-1", "tm-1-control", true, 0);
    const windows = [
      win({ window_id: "plain", library_id: "local", ordinal: 1 }),
      control,
      // The feed repeating a row.
      { ...control },
      tmuxRow("tm-1", "tm-1-w1", false, 1),
      tmuxRow("tm-2", "tm-2-control", true, 0),
    ];
    const tree = buildMachineTree([], [], windows, entries);
    for (const node of tree.machines) {
      const ids = cardIds(node);
      expect(new Set(ids).size, `${machineName(node)} repeats an id: ${ids}`).toBe(ids.length);
    }
    expect(tree.machines[0]!.tmuxControls.map((row) => row.window.window_id)).toEqual([
      "tm-1-control",
      "tm-2-control",
    ]);
    // The control terminal is on its connection's card and its machine's.
    const holders = tree.machines.filter((m) => cardIds(m).includes("tm-1-control"));
    expect(holders.map((m) => m.kind)).toEqual(["local", "tmux"]);
  });

  it("leaves All windows as it was: each window once, the control terminal under its connection", () => {
    const entry = tmux({ connection: "tm-1" });
    const windows = [
      win({ window_id: "plain", library_id: "local", ordinal: 1 }),
      tmuxRow("tm-1", "tm-1-control", true, 0),
      tmuxRow("tm-1", "tm-1-w1", false, 1),
    ];
    const tree = buildMachineTree([], [], windows, [entry]);
    expect(tree.machines[0]!.tmuxControls).toHaveLength(1);
    expect(windowOverview(tree).map((r) => [r.window.window_id, r.machine])).toEqual([
      ["plain", "local"],
      ["tm-1-control", "tmux -CC on this machine (main)"],
      ["tm-1-w1", "tmux -CC on this machine (main)"],
    ]);
  });
});
