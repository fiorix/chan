// @vitest-environment jsdom
//
// The Team Work entry (Cmd+P) opens a fresh lead terminal in the active pane
// and marks it as the pending lead the setup dialog edits. Every press is a
// new terminal; nothing toggles an existing one.

import { beforeEach, describe, expect, test } from "vitest";

import { defaultTeamConfig } from "./teamDialog.svelte";
import {
  createTeamWorkLeadTerminal,
  findTeamWorkPendingLead,
  layout,
  type LeafNode,
  type TerminalTab,
} from "./tabs.svelte";

const PANE = "team-lead-pane";

beforeEach(() => {
  layout.nodes = { [PANE]: { kind: "leaf", id: PANE, tabs: [], activeTabId: null } };
  layout.rootId = PANE;
  layout.activePaneId = PANE;
});

function terminals(): TerminalTab[] {
  return (layout.nodes[PANE] as LeafNode).tabs.filter((t): t is TerminalTab => t.kind === "terminal");
}

describe("the Team Work lead terminal", () => {
  test("opens a new terminal in the active pane, marked as the pending lead", () => {
    const lead = createTeamWorkLeadTerminal();

    expect(lead).not.toBeNull();
    expect(terminals().map((t) => t.id)).toEqual([lead!.id]);
    expect((layout.nodes[PANE] as LeafNode).activeTabId).toBe(lead!.id);
    expect(lead!.teamWorkPending).toEqual(defaultTeamConfig());
    expect(findTeamWorkPendingLead()).toEqual({ leadTabId: lead!.id, leadPaneId: PANE });
  });

  test("a second press opens another terminal instead of toggling the first", () => {
    const first = createTeamWorkLeadTerminal();
    const second = createTeamWorkLeadTerminal();

    expect(second!.id).not.toBe(first!.id);
    expect(terminals()).toHaveLength(2);
  });
});
