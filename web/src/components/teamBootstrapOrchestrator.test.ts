// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/client";
import { runTeamBootstrap } from "../state/teamOrchestrator.svelte";
import type { TeamDialogConfig } from "../state/teamDialog.svelte";
import {
  allTerminalTabs,
  layout,
  terminalBroadcastMemberIds,
  type LeafNode,
  type TerminalTab,
} from "../state/tabs.svelte";

// Lead-first bootstrap chain. The Team Work Lead terminal already
// exists (created at Cmd+P); the orchestrator runs against it.
// These tests pin: config written, lead launched FIRST into the
// existing tab (restart, no respawn/close), workers spawned into
// new tabs, identity prompt primed in the lead's embedded editor,
// and the final broadcast membership set == {lead, workers} exactly.

function leadTerminalTab(partial: Partial<TerminalTab> = {}): TerminalTab {
  return {
    kind: "terminal",
    id: "lead-tab",
    title: "Terminal",
    createdAt: 1,
    broadcastEnabled: false,
    broadcastTargetIds: [],
    terminalSessionId: "lead-session",
    ...partial,
  };
}

function resetLayoutWithLead(lead: TerminalTab): LeafNode {
  const pane: LeafNode = {
    kind: "leaf",
    id: "pane-test",
    tabs: [lead],
    activeTabId: lead.id,
  };
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
  layout.focusColor = "blue";
  return pane;
}

// `layout.nodes` is a $state proxy: the orchestrator mutates the
// PROXY of each tab, not the raw object passed to
// resetLayoutWithLead. Re-read tabs from `allTerminalTabs()` (the
// proxied source of truth) to observe rename / teamWork / broadcast
// mutations.
function tabFromLayout(id: string): TerminalTab {
  const tab = allTerminalTabs().find((t) => t.id === id);
  if (!tab) throw new Error(`tab ${id} not found`);
  return tab;
}

function tabsConfig(): TeamDialogConfig {
  return {
    hostName: "@@Neo",
    configMode: "new",
    configPath: "/tmp/new-team-1/chan-team.toml",
    size: 3,
    autoPrefix: false,
    members: [
      { name: "@@Lead", command: "claude", env: "", isLead: true },
      { name: "@@Worker1", command: "claude --resume", env: "", isLead: false },
      { name: "@@Worker2", command: "codex", env: "", isLead: false },
    ],
    realEstate: { kind: "tabs" },
  };
}

let spawnCounter = 0;

function mockApi(): {
  write: ReturnType<typeof vi.spyOn>;
  restart: ReturnType<typeof vi.spyOn>;
  spawn: ReturnType<typeof vi.spyOn>;
} {
  const write = vi
    .spyOn(api, "writeTeamConfigFile")
    .mockResolvedValue(undefined as unknown as void);
  const restart = vi
    .spyOn(api, "restartTerminal")
    .mockResolvedValue(undefined as unknown as void);
  spawnCounter = 0;
  const spawn = vi.spyOn(api, "spawnTerminal").mockImplementation(async () => {
    spawnCounter += 1;
    return { session: `worker-session-${spawnCounter}`, tab_label: `w${spawnCounter}` };
  });
  return { write, restart, spawn };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetLayoutWithLead(leadTerminalTab());
});

describe("runTeamBootstrap: lead-first flow", () => {
  test("writes the chan-team.toml to the dialog's config path", async () => {
    resetLayoutWithLead(leadTerminalTab());
    const { write } = mockApi();
    await runTeamBootstrap(tabsConfig(), {
      leadTabId: "lead-tab",
      leadPaneId: "pane-test",
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe("/tmp/new-team-1/chan-team.toml");
  });

  test("launches the LEAD agent into the existing tab via restart (no close/respawn)", async () => {
    resetLayoutWithLead(leadTerminalTab());
    const { restart } = mockApi();
    const close = vi.spyOn(api, "closeTerminal");
    await runTeamBootstrap(tabsConfig(), {
      leadTabId: "lead-tab",
      leadPaneId: "pane-test",
    });
    // Lead is launched by restarting the EXISTING session with the
    // lead command + env, never closed/respawned.
    expect(restart).toHaveBeenCalledWith(
      "lead-session",
      expect.objectContaining({ name: "@@Lead", command: "claude" }),
    );
    expect(close).not.toHaveBeenCalled();
    // The lead tab is renamed in place (same tab id).
    expect(tabFromLayout("lead-tab").title).toBe("@@Lead");
  });

  test("spawns one new tab per worker", async () => {
    resetLayoutWithLead(leadTerminalTab());
    const { spawn } = mockApi();
    await runTeamBootstrap(tabsConfig(), {
      leadTabId: "lead-tab",
      leadPaneId: "pane-test",
    });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0][0]).toMatchObject({ name: "@@Worker1" });
    expect(spawn.mock.calls[1][0]).toMatchObject({ name: "@@Worker2" });
    // Lead tab + two worker tabs all live in the active pane (tabs
    // real estate).
    expect(allTerminalTabs()).toHaveLength(3);
  });

  test("primes the # Team work identity prompt into the lead's embedded editor", async () => {
    resetLayoutWithLead(leadTerminalTab());
    mockApi();
    await runTeamBootstrap(tabsConfig(), {
      leadTabId: "lead-tab",
      leadPaneId: "pane-test",
    });
    const lead = tabFromLayout("lead-tab");
    expect(lead.teamWork?.open).toBe(true);
    expect(lead.teamWork?.buffer).toContain("# Team work");
    expect(lead.teamWork?.buffer).toContain("We are a team of 3");
    expect(lead.teamWork?.buffer).toContain("Our host is @@Neo");
    expect(lead.teamWork?.buffer).toContain("the team lead is @@Lead");
    expect(lead.teamWork?.buffer).toContain("send_agent_task");
    expect(lead.teamWork?.buffer).toContain("list_agent_tasks");
    expect(lead.teamWork?.buffer).toContain("- @@Worker1");
    expect(lead.teamWork?.buffer).toContain("- @@Worker2");
  });

  test("final broadcast membership == {lead, workers} exactly", async () => {
    resetLayoutWithLead(leadTerminalTab());
    mockApi();
    await runTeamBootstrap(tabsConfig(), {
      leadTabId: "lead-tab",
      leadPaneId: "pane-test",
    });
    const members = new Set(terminalBroadcastMemberIds(tabFromLayout("lead-tab")));
    const all = allTerminalTabs();
    const workerIds = all.filter((t) => t.id !== "lead-tab").map((t) => t.id);
    // Lead + both workers are broadcast members; nothing else.
    expect(members).toEqual(new Set(["lead-tab", ...workerIds]));
    // Every team tab reads back as broadcast-enabled.
    for (const tab of all) {
      expect(tab.broadcastEnabled).toBe(true);
    }
  });

  test("pre-existing broadcast group is cleared before the team's set is applied", async () => {
    // A stray terminal that was broadcasting before bootstrap must
    // be force-cleared by the "Deselect all" step so it does not
    // leak into the new team's broadcast set.
    const lead = leadTerminalTab();
    const stray: TerminalTab = {
      kind: "terminal",
      id: "stray",
      title: "Stray",
      createdAt: 1,
      broadcastEnabled: true,
      broadcastTargetIds: [],
      terminalSessionId: "stray-session",
    };
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-test",
      tabs: [lead, stray],
      activeTabId: lead.id,
    };
    layout.rootId = pane.id;
    layout.activePaneId = pane.id;
    layout.nodes = { [pane.id]: pane };
    layout.focusColor = "blue";
    mockApi();
    await runTeamBootstrap(tabsConfig(), {
      leadTabId: "lead-tab",
      leadPaneId: "pane-test",
    });
    // The stray is no longer in any broadcast group.
    expect(tabFromLayout("stray").broadcastEnabled).toBe(false);
    const members = new Set(terminalBroadcastMemberIds(tabFromLayout("lead-tab")));
    expect(members.has("stray")).toBe(false);
  });

  test("throws when the lead tab is missing (so the dialog surfaces the error)", async () => {
    resetLayoutWithLead(leadTerminalTab());
    mockApi();
    await expect(
      runTeamBootstrap(tabsConfig(), {
        leadTabId: "does-not-exist",
        leadPaneId: "pane-test",
      }),
    ).rejects.toThrow(/lead terminal not found/);
  });
});
