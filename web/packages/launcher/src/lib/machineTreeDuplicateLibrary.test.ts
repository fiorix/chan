// Two machine rows can resolve to one library_id: a directly registered
// devserver plus its gateway roster row, or one box registered twice.
// buildMachineTree groups windows by library_id and then hands that same array
// to every machine claiming the id, so both machines carry the same
// WindowRecord objects.
//
// The Computers deck flattens machine windows into one keyed list, so a window
// reachable twice is a duplicate key: the deck throws each_key_duplicate and
// goes down, and any root-level query reaches it.
//
// dedupeWindows is not this guard. It runs over the INPUT list, before the
// per-machine fan-out, so it cannot see a window handed to two machines.

import { describe, it, expect } from "vitest";
import { buildMachineTree } from "./machineTree";
import type { DevserverEntry, WindowRecord, WorkspaceEntry } from "../api/library";

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
    ...over,
  };
}

/** Every window the deck would render, in the order it flattens them. */
function deckWindows(devservers: DevserverEntry[], windows: WindowRecord[]): WindowRecord[] {
  const tree = buildMachineTree(devservers, [] as WorkspaceEntry[], windows);
  const out: WindowRecord[] = [];
  for (const machine of tree.machines) {
    out.push(...machine.control);
    out.push(...machine.terminals);
    out.push(...machine.workspaces.flatMap((w) => w.windows));
    out.push(...machine.looseWindows);
  }
  out.push(...tree.orphans);
  return out;
}

describe("two machine rows sharing a library_id", () => {
  it("does not hand the same window to both", () => {
    const rows = [ds({ id: "direct", library_id: "lib-1" }), ds({ id: "roster", library_id: "lib-1" })];
    const windows = [win({ window_id: "w-1", library_id: "lib-1" })];

    const ids = deckWindows(rows, windows).map((w) => w.window_id);
    expect(new Set(ids).size, `the deck's keyed list would throw on: ${ids}`).toBe(ids.length);
  });

  it("does not hand a window to both the local machine and a devserver claiming its library", () => {
    const rows = [ds({ id: "direct", library_id: "local" })];
    const windows = [win({ window_id: "w-2", library_id: "local" })];

    const ids = deckWindows(rows, windows).map((w) => w.window_id);
    expect(new Set(ids).size, `the deck's keyed list would throw on: ${ids}`).toBe(ids.length);
  });

  it("still lists a window once when no library is shared", () => {
    const rows = [ds({ id: "a", library_id: "lib-a" }), ds({ id: "b", library_id: "lib-b" })];
    const windows = [
      win({ window_id: "w-a", library_id: "lib-a" }),
      win({ window_id: "w-b", library_id: "lib-b" }),
    ];

    const ids = deckWindows(rows, windows).map((w) => w.window_id).sort();
    expect(ids).toEqual(["w-a", "w-b"]);
  });
});
