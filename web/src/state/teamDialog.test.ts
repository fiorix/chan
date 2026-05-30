import { describe, expect, test } from "vitest";
import {
  assignMemberToCell,
  closeTeamDialog,
  defaultGridForSize,
  defaultTeamConfig,
  emptySlotsForGrid,
  gridShapesForSize,
  openTeamDialog,
  reshapeSplitGrid,
  resizeTeamMembers,
  switchRealEstate,
  TEAM_MIN_SIZE,
  teamDialogState,
  unassignMember,
  validateTeamConfig,
} from "./teamDialog.svelte";

// Pins the validation contract (path-based, no team name), the
// resize semantics (lead preservation + Worker-N filling), the
// open/close bus shape (leadTabId/leadPaneId), and the real-estate
// grid helpers.

describe("defaultTeamConfig", () => {
  test("default config: canonical host, New mode, one lead agent", () => {
    const cfg = defaultTeamConfig();
    expect(cfg.size).toBe(TEAM_MIN_SIZE);
    expect(cfg.hostName).toBe("@@Neo");
    expect(cfg.configMode).toBe("new");
    expect(cfg.members).toHaveLength(1);
    expect(cfg.members[0].name).toBe("@@Lead");
    expect(cfg.members.filter((m) => m.isLead)).toHaveLength(1);
    expect(cfg.members[0].isLead).toBe(true);
    expect(cfg.autoPrefix).toBe(false);
    expect(cfg.realEstate).toEqual({ kind: "tabs" });
  });
});

describe("validateTeamConfig", () => {
  test("requires non-empty Your name", () => {
    expect(validateTeamConfig({ ...defaultTeamConfig(), hostName: "" })).toBe(
      "Your name required",
    );
  });

  test("requires a non-empty, absolute config path", () => {
    expect(validateTeamConfig({ ...defaultTeamConfig(), configPath: "" })).toBe(
      "Path to configuration required",
    );
    expect(
      validateTeamConfig({ ...defaultTeamConfig(), configPath: "rel/x.toml" }),
    ).toBe("Path to configuration must be absolute");
  });

  test("rejects size below TEAM_MIN_SIZE", () => {
    expect(validateTeamConfig({ ...defaultTeamConfig(), size: 0 })).toContain(
      "at least",
    );
  });

  test("rejects size above TEAM_MAX_SIZE", () => {
    expect(validateTeamConfig({ ...defaultTeamConfig(), size: 99 })).toContain(
      "at most",
    );
  });

  test("requires exactly one lead", () => {
    const noLead = defaultTeamConfig();
    noLead.members[0].isLead = false;
    expect(validateTeamConfig(noLead)).toBe("one member must be marked as lead");

    const twoLeads = resizeTeamMembers({ ...defaultTeamConfig(), size: 2 });
    twoLeads.members[1].isLead = true;
    expect(validateTeamConfig(twoLeads)).toBe(
      "exactly one member can be marked as lead",
    );
  });

  test("requires every member to have a name", () => {
    const cfg = defaultTeamConfig();
    cfg.members[0].name = "";
    expect(validateTeamConfig(cfg)).toBe("every member needs a name");
  });

  test("rejects non-canonical host and member handles", () => {
    expect(validateTeamConfig({ ...defaultTeamConfig(), hostName: "Neo" })).toBe(
      "Your handle must be canonical @@Name",
    );
    const cfg = defaultTeamConfig();
    cfg.members[0].name = "Lead";
    expect(validateTeamConfig(cfg)).toBe("member handles must be canonical @@Name");
  });

  test("allows duplicate member handles", () => {
    const cfg = resizeTeamMembers({ ...defaultTeamConfig(), size: 2 });
    cfg.members[1].name = cfg.members[0].name;
    expect(validateTeamConfig(cfg)).toBeNull();
  });

  test("returns null for valid config", () => {
    expect(validateTeamConfig(defaultTeamConfig())).toBeNull();
  });
});

describe("resizeTeamMembers", () => {
  test("grow: appends fresh Worker-N entries", () => {
    const out = resizeTeamMembers({ ...defaultTeamConfig(), size: 4 });
    expect(out.members).toHaveLength(4);
    expect(out.members[2].name).toBe("@@Worker2");
    expect(out.members[3].name).toBe("@@Worker3");
    expect(out.members.filter((m) => m.isLead)).toHaveLength(1);
  });

  test("shrink: truncates from the end", () => {
    const grown = resizeTeamMembers({ ...defaultTeamConfig(), size: 4 });
    const shrunk = resizeTeamMembers({ ...grown, size: 2 });
    expect(shrunk.members).toHaveLength(2);
    expect(shrunk.members[0].isLead).toBe(true);
  });

  test("shrink-past-lead: default lead to slot 0", () => {
    const grown = resizeTeamMembers({ ...defaultTeamConfig(), size: 3 });
    grown.members[0].isLead = false;
    grown.members[2].isLead = true;
    const shrunk = resizeTeamMembers({ ...grown, size: 2 });
    expect(shrunk.members).toHaveLength(2);
    expect(shrunk.members[0].isLead).toBe(true);
  });
});

describe("openTeamDialog / closeTeamDialog bus", () => {
  test("open sets state.request with the lead tab + pane; close clears it", () => {
    expect(teamDialogState.request).toBeNull();
    openTeamDialog({ leadTabId: "lead-tab", leadPaneId: "pane-1" });
    expect(teamDialogState.request).toEqual({
      leadTabId: "lead-tab",
      leadPaneId: "pane-1",
    });
    closeTeamDialog();
    expect(teamDialogState.request).toBeNull();
  });
});

describe("gridShapesForSize", () => {
  test("size 2 yields 1x2 and 2x1", () => {
    const shapes = gridShapesForSize(2);
    expect(shapes).toContainEqual({ rows: 1, cols: 2 });
    expect(shapes).toContainEqual({ rows: 2, cols: 1 });
  });

  test("size 4 yields most-balanced 2x2 first", () => {
    const shapes = gridShapesForSize(4);
    expect(shapes[0]).toEqual({ rows: 2, cols: 2 });
    expect(shapes).toContainEqual({ rows: 1, cols: 4 });
    expect(shapes).toContainEqual({ rows: 4, cols: 1 });
  });

  test("size 6 yields 2x3, 3x2, 1x6, 6x1", () => {
    const shapes = gridShapesForSize(6);
    expect(shapes).toContainEqual({ rows: 2, cols: 3 });
    expect(shapes).toContainEqual({ rows: 3, cols: 2 });
    expect(shapes).toContainEqual({ rows: 1, cols: 6 });
    expect(shapes).toContainEqual({ rows: 6, cols: 1 });
  });

  test("prime size 5 still produces shapes that hold >=5 cells", () => {
    const shapes = gridShapesForSize(5);
    expect(shapes.length).toBeGreaterThan(0);
    for (const s of shapes) {
      expect(s.rows * s.cols).toBeGreaterThanOrEqual(5);
    }
  });
});

describe("defaultGridForSize", () => {
  test("default for size 4 is 2x2 (most balanced)", () => {
    expect(defaultGridForSize(4)).toEqual({ rows: 2, cols: 2 });
  });

  test("default for size 6 is 2x3", () => {
    expect(defaultGridForSize(6)).toEqual({ rows: 2, cols: 3 });
  });
});

describe("switchRealEstate", () => {
  test("tabs -> split picks default grid + empty slots", () => {
    const cfg = defaultTeamConfig();
    const next = switchRealEstate(cfg, "split");
    expect(next.realEstate.kind).toBe("split");
    if (next.realEstate.kind === "split") {
      expect(next.realEstate.grid).toEqual(defaultGridForSize(cfg.size));
      expect(next.realEstate.slots).toEqual(emptySlotsForGrid(next.realEstate.grid));
    }
  });

  test("split -> tabs drops the grid + slots", () => {
    const cfg = switchRealEstate(defaultTeamConfig(), "split");
    expect(switchRealEstate(cfg, "tabs").realEstate).toEqual({ kind: "tabs" });
  });

  test("split -> split is a no-op (preserves the grid)", () => {
    const cfg = switchRealEstate(defaultTeamConfig(), "split");
    expect(switchRealEstate(cfg, "split")).toBe(cfg);
  });
});

describe("reshapeSplitGrid", () => {
  test("re-picks grid + resets slots when reshaping", () => {
    const cfg = switchRealEstate({ ...defaultTeamConfig(), size: 4 }, "split");
    const reshaped = reshapeSplitGrid(cfg, { rows: 1, cols: 4 });
    expect(reshaped.realEstate.kind).toBe("split");
    if (reshaped.realEstate.kind === "split") {
      expect(reshaped.realEstate.grid).toEqual({ rows: 1, cols: 4 });
      expect(reshaped.realEstate.slots).toHaveLength(4);
      expect(reshaped.realEstate.slots.every((c) => c.length === 0)).toBe(true);
    }
  });

  test("no-op when realEstate.kind === 'tabs'", () => {
    const cfg = defaultTeamConfig();
    expect(reshapeSplitGrid(cfg, { rows: 1, cols: 2 })).toBe(cfg);
  });
});

describe("assignMemberToCell + unassignMember", () => {
  test("assign places the member in the target cell", () => {
    const cfg = switchRealEstate(defaultTeamConfig(), "split");
    const next = assignMemberToCell(cfg, 0, 0);
    if (next.realEstate.kind === "split") {
      expect(next.realEstate.slots[0]).toEqual([0]);
    }
  });

  test("re-assigning to a different cell removes from the prior cell", () => {
    let cfg = switchRealEstate(
      resizeTeamMembers({ ...defaultTeamConfig(), size: 2 }),
      "split",
    );
    cfg = assignMemberToCell(cfg, 0, 0);
    cfg = assignMemberToCell(cfg, 0, 1);
    if (cfg.realEstate.kind === "split") {
      expect(cfg.realEstate.slots[0]).toEqual([]);
      expect(cfg.realEstate.slots[1]).toEqual([0]);
    }
  });

  test("multiple members in same cell stack as tabs (no replacement)", () => {
    let cfg = switchRealEstate(
      resizeTeamMembers({ ...defaultTeamConfig(), size: 2 }),
      "split",
    );
    cfg = assignMemberToCell(cfg, 0, 0);
    cfg = assignMemberToCell(cfg, 1, 0);
    if (cfg.realEstate.kind === "split") {
      expect(cfg.realEstate.slots[0]).toEqual([0, 1]);
    }
  });

  test("same-member same-cell drop is idempotent", () => {
    let cfg = switchRealEstate(defaultTeamConfig(), "split");
    cfg = assignMemberToCell(cfg, 0, 0);
    cfg = assignMemberToCell(cfg, 0, 0);
    if (cfg.realEstate.kind === "split") {
      expect(cfg.realEstate.slots[0]).toEqual([0]);
    }
  });

  test("unassignMember removes from every cell", () => {
    let cfg = switchRealEstate(defaultTeamConfig(), "split");
    cfg = assignMemberToCell(cfg, 0, 0);
    cfg = unassignMember(cfg, 0);
    if (cfg.realEstate.kind === "split") {
      expect(cfg.realEstate.slots.every((c) => !c.includes(0))).toBe(true);
    }
  });
});

describe("resize preserves the split mode", () => {
  test("resize from 2 -> 4 keeps split mode + picks new default grid", () => {
    const cfg = switchRealEstate(
      resizeTeamMembers({ ...defaultTeamConfig(), size: 2 }),
      "split",
    );
    const grown = resizeTeamMembers({ ...cfg, size: 4 });
    expect(grown.realEstate.kind).toBe("split");
    if (grown.realEstate.kind === "split") {
      expect(grown.realEstate.grid).toEqual(defaultGridForSize(4));
    }
  });

  test("resize shrink drops slot assignments referencing removed members", () => {
    let cfg = switchRealEstate({ ...defaultTeamConfig(), size: 4 }, "split");
    cfg = resizeTeamMembers(cfg);
    cfg = assignMemberToCell(cfg, 3, 0);
    cfg = resizeTeamMembers({ ...cfg, size: 2 });
    if (cfg.realEstate.kind === "split") {
      for (const cell of cfg.realEstate.slots) {
        expect(cell.includes(3)).toBe(false);
      }
    }
  });
});
