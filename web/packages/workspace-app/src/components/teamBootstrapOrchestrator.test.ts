// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/client";
import { runTeamBootstrap } from "../state/teamOrchestrator.svelte";
import {
  agentForMember,
  type TeamDialogConfig,
} from "../state/teamDialog.svelte";
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
// and broadcast left OFF for every tab (the clear-all sweep still
// runs so stale groups don't leak; nothing re-enables after it).

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

// After the consolidate the lead is a freshly-spawned terminal (the
// Cmd+P "lead-tab" placeholder is closed), renamed to the lead's handle
// (@@Lead). The Team Work bubble is gone, so we identify it by title.
function leadFromLayout(): TerminalTab {
  const tab = allTerminalTabs().find((t) => t.title === "@@Lead");
  if (!tab) throw new Error("no lead tab (@@Lead-titled terminal)");
  return tab;
}

function tabsConfig(): TeamDialogConfig {
  return {
    hostName: "Neo",
    configMode: "new",
    teamDir: "new-team-1",
    tabGroup: "chan-team",
    size: 3,
    autoPrefix: true,
    mcpEnv: false,
    members: [
      { name: "Lead", command: "claude", env: "", isLead: true },
      { name: "Worker1", command: "claude --resume", env: "", isLead: false },
      { name: "Worker2", command: "codex", env: "", isLead: false },
    ],
    realEstate: { kind: "tabs" },
    brief: "",
  };
}

let spawnCounter = 0;

function mockApi(): {
  write: ReturnType<typeof vi.spyOn>;
  restart: ReturnType<typeof vi.spyOn>;
  spawn: ReturnType<typeof vi.spyOn>;
} {
  const write = vi
    .spyOn(api, "writeTeamConfig")
    .mockResolvedValue(undefined as unknown as void);
  const restart = vi
    .spyOn(api, "restartTerminal")
    .mockResolvedValue(undefined as unknown as void);
  spawnCounter = 0;
  const spawn = vi.spyOn(api, "spawnTerminal").mockImplementation(async (request) => {
    spawnCounter += 1;
    return {
      session: `worker-session-${spawnCounter}`,
      // POST creation is the settlement point. A mounted proposal sink does
      // not exist yet, so the mock must return the requested name the real
      // registry would settle when there is no collision.
      tab_label: request.name ?? `w${spawnCounter}`,
    };
  });
  return { write, restart, spawn };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetLayoutWithLead(leadTerminalTab());
});

describe("runTeamBootstrap: lead-first flow", () => {
  test("writes the team config to the dialog's team dir", async () => {
    resetLayoutWithLead(leadTerminalTab());
    const { write } = mockApi();
    await runTeamBootstrap(tabsConfig(), {
      leadTabId: "lead-tab",
      leadPaneId: "pane-test",
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe("new-team-1");
  });

  test("launches the LEAD agent by spawning a fresh session (not restart-in-place)", async () => {
    resetLayoutWithLead(leadTerminalTab());
    const { restart, spawn } = mockApi();
    await runTeamBootstrap(tabsConfig(), {
      leadTabId: "lead-tab",
      leadPaneId: "pane-test",
    });
    // The lead spawns FRESH (first spawn call) with its command + env -
    // the worker path - never restart-in-place (the broken reattach).
    expect(restart).not.toHaveBeenCalled();
    expect(spawn.mock.calls[0][0]).toMatchObject({ name: "@@Lead", command: "claude" });
    // The Cmd+P placeholder is dropped; the fresh lead tab is named the
    // lead handle.
    expect(allTerminalTabs().some((t) => t.id === "lead-tab")).toBe(false);
    expect(leadFromLayout().title).toBe("@@Lead");
  });

  test("spawns one fresh tab for the lead and each worker (one create path)", async () => {
    resetLayoutWithLead(leadTerminalTab());
    const { spawn } = mockApi();
    await runTeamBootstrap(tabsConfig(), {
      leadTabId: "lead-tab",
      leadPaneId: "pane-test",
    });
    // Lead spawns first, then the two workers - the consolidated path.
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(spawn.mock.calls[0][0]).toMatchObject({ name: "@@Lead" });
    expect(spawn.mock.calls[1][0]).toMatchObject({ name: "@@Worker1" });
    expect(spawn.mock.calls[2][0]).toMatchObject({ name: "@@Worker2" });
    // Fresh lead tab + two worker tabs in the active pane (the Cmd+P
    // placeholder is dropped), so still three terminals.
    expect(allTerminalTabs()).toHaveLength(3);
  });

  test("adopts a POST-settled suffix without a pre-mount rename", async () => {
    resetLayoutWithLead(leadTerminalTab());
    const { spawn } = mockApi();
    spawn.mockImplementation(async (request: Parameters<typeof api.spawnTerminal>[0]) => {
      spawnCounter += 1;
      return {
        session: `worker-session-${spawnCounter}`,
        tab_label: request.name === "@@Lead" ? "@@Lead-2" : request.name,
      };
    });

    await runTeamBootstrap(tabsConfig(), {
      leadTabId: "lead-tab",
      leadPaneId: "pane-test",
    });

    expect(spawn.mock.calls[0][0]).toMatchObject({ name: "@@Lead" });
    const settledLead = allTerminalTabs().find(
      (tab) => tab.terminalSessionId === "worker-session-1",
    );
    expect(settledLead?.title).toBe("@@Lead-2");
    expect(allTerminalTabs().some((tab) => tab.title === "@@Lead")).toBe(false);
  });

  test("auto-delivers the identity prompt to the lead through the write queue", async () => {
    // The Team Work bubble is gone: the lead is a normal terminal whose identity
    // prompt the orchestrator delivers via the prompt frame
    // (sendPromptToTerminal), retried until the freshly-spawned lead's WS
    // connects - NOT primed into a bubble buffer. The prompt CONTENT is pinned
    // in teamLeadPrompt.test.ts; this pins the delivery wiring (the async retry
    // against a live WS is fragile to fake-time in a unit test, so assert the
    // source-level wiring; the live lead bootstrap is validated by hand on a rebuild).
    const src = (await import("../state/teamOrchestrator.svelte?raw"))
      .default as string;
    expect(src).toMatch(/void deliverLeadIdentity\(\s*leadTab\.id,\s*prompt,/);
    expect(src).toMatch(
      /async function deliverLeadIdentity\([\s\S]*?sendPromptToTerminal\(tabId, text, agent\)/,
    );
    expect(src).toMatch(
      /const leadAgent = leadDraft[\s\S]{1,180}agentForMember\(leadDraft\.command, leadDraft\.env\)[\s\S]{1,220}deliverLeadIdentity\([\s\S]{1,100}leadAgent === "none" \? undefined : leadAgent/,
    );
    expect(src).not.toMatch(/primeTeamWork/);
  });

  test("spawns an OpenCode lead whose identity delivery derives opencode", async () => {
    resetLayoutWithLead(leadTerminalTab());
    const { spawn } = mockApi();
    const config = tabsConfig();
    config.members[0] = {
      ...config.members[0],
      command: "opencode --model test",
    };
    await runTeamBootstrap(config, {
      leadTabId: "lead-tab",
      leadPaneId: "pane-test",
    });
    expect(spawn.mock.calls[0][0]).toMatchObject({
      name: "@@Lead",
      command: "opencode --model test",
    });
    expect(agentForMember(config.members[0].command, config.members[0].env)).toBe(
      "opencode",
    );
  });

  test("teams start with broadcast OFF: final membership is empty", async () => {
    resetLayoutWithLead(leadTerminalTab());
    mockApi();
    await runTeamBootstrap(tabsConfig(), {
      leadTabId: "lead-tab",
      leadPaneId: "pane-test",
    });
    // Bootstrap never opts the team in - the host enables broadcast
    // manually when fan-out is wanted (identity prompts are delivered
    // server-side via the write queue, not via SPA broadcast).
    expect(terminalBroadcastMemberIds(leadFromLayout())).toEqual([]);
    for (const tab of allTerminalTabs()) {
      expect(tab.broadcastEnabled).toBe(false);
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
    const members = new Set(terminalBroadcastMemberIds(leadFromLayout()));
    expect(members.has("stray")).toBe(false);
  });
});
