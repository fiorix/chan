// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/client";
import { runTeamBootstrap } from "./teamOrchestrator.svelte";
import type { TeamDialogConfig } from "./teamDialog.svelte";
import { layout, type LeafNode, type TerminalTab } from "./tabs.svelte";

// The lead launches FIRST by SPAWNING a fresh agent session into the
// lead's pane and dropping the Cmd+P placeholder shell - the SAME
// spawn+mount path the workers use (TEAM-CONSOLIDATE). Restart-in-place
// was broken: the orchestrator's external api.restartTerminal closed the
// session but the lead TerminalTab never reattached, so the agent never
// came up. These tests pin the spawn-fresh launch, the env carry-through,
// and the placeholder drop.

function placeholder(partial: Partial<TerminalTab> = {}): TerminalTab {
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

function setLayout(lead: TerminalTab): void {
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
}

// After the consolidate the Cmd+P placeholder ("lead-tab") is closed and
// the lead is a freshly-spawned terminal; read the surviving terminal tab
// back from the layout proxy.
function leadFromLayout(): TerminalTab {
  const node = layout.nodes["pane-test"];
  if (!node || node.kind !== "leaf") throw new Error("no lead pane");
  const tab = node.tabs.find((t) => t.kind === "terminal");
  if (!tab || tab.kind !== "terminal") throw new Error("no lead tab");
  return tab;
}

function config(): TeamDialogConfig {
  return {
    hostName: "Neo",
    configMode: "new",
    teamDir: "solo",
    tabGroup: "chan-team",
    size: 1,
    autoPrefix: true,
    mcpEnv: false,
    members: [{ name: "Lead", command: "claude --resume", env: "DEBUG=1", isLead: true }],
    realEstate: { kind: "tabs" },
    brief: "",
  };
}

function mockApi() {
  vi.spyOn(api, "writeTeamConfig").mockResolvedValue(undefined as unknown as void);
  const spawn = vi.spyOn(api, "spawnTerminal").mockResolvedValue({
    session: "lead-fresh",
    tab_label: "@@Lead-2",
  });
  const restart = vi
    .spyOn(api, "restartTerminal")
    .mockResolvedValue(undefined as unknown as void);
  return { spawn, restart };
}

afterEach(() => {
  vi.restoreAllMocks();
  setLayout(placeholder());
});

describe("lead launch (spawn-fresh, lead-first)", () => {
  test("spawns a fresh lead session with command + env + name (no in-place restart)", async () => {
    setLayout(placeholder());
    const { spawn, restart } = mockApi();
    await runTeamBootstrap(config(), {
      leadTabId: "lead-tab",
      leadPaneId: "pane-test",
    });
    expect(restart).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    const [body] = spawn.mock.calls[0];
    expect(body).toMatchObject({
      name: "@@Lead",
      command: "claude --resume",
    });
    // CHAN_TAB_NAME is auto-injected; the user's env entry rides along.
    expect(body.env?.CHAN_TAB_NAME).toBe("@@Lead");
    expect(body.env?.DEBUG).toBe("1");
  });

  test("drops the Cmd+P placeholder and mounts a fresh lead tab", async () => {
    setLayout(placeholder());
    mockApi();
    await runTeamBootstrap(config(), {
      leadTabId: "lead-tab",
      leadPaneId: "pane-test",
    });
    const node = layout.nodes["pane-test"];
    if (!node || node.kind !== "leaf") throw new Error("no lead pane");
    // The placeholder is gone; the surviving lead is the fresh spawn.
    expect(node.tabs.some((t) => t.id === "lead-tab")).toBe(false);
    expect(leadFromLayout().terminalSessionId).toBe("lead-fresh");
  });

  test("keeps the registry-settled lead label without a local rewrite", async () => {
    setLayout(placeholder());
    mockApi();
    await runTeamBootstrap(config(), {
      leadTabId: "lead-tab",
      leadPaneId: "pane-test",
    });
    expect(leadFromLayout().title).toBe("@@Lead-2");
  });
});
