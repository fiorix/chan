// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/client";
import { runTeamBootstrap } from "./teamOrchestrator.svelte";
import type { TeamDialogConfig } from "./teamDialog.svelte";
import { layout, type LeafNode, type TerminalTab } from "./tabs.svelte";

// `layout.nodes` is a $state proxy: assigning a pane deep-proxies
// its tabs, so the orchestrator mutates the PROXY, not the raw
// object passed to resetLayout. Re-read the lead tab from the
// layout to observe those mutations (mirrors tabs.test.ts).
function leadFromLayout(): TerminalTab {
  const node = layout.nodes["pane-test"];
  if (!node || node.kind !== "leaf") throw new Error("no lead pane");
  const tab = node.tabs.find((t) => t.id === "lead-tab");
  if (!tab || tab.kind !== "terminal") throw new Error("no lead tab");
  return tab;
}

// The identity prompt lands in the LEAD's embedded Team Work editor
// (primeTeamWork), not in a worker tab. These tests pin the placement
// target + the prompt content.

function leadTab(): TerminalTab {
  return {
    kind: "terminal",
    id: "lead-tab",
    title: "Terminal",
    createdAt: 1,
    broadcastEnabled: false,
    broadcastTargetIds: [],
    terminalSessionId: "lead-session",
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

function config(): TeamDialogConfig {
  return {
    hostName: "@@Neo",
    configMode: "new",
    configPath: "/tmp/new-team-1/chan-team.toml",
    size: 3,
    autoPrefix: false,
    members: [
      { name: "@@Lead", command: "claude", env: "", isLead: true },
      { name: "@@Worker1", command: "claude", env: "", isLead: false },
      { name: "@@Worker2", command: "claude", env: "", isLead: false },
    ],
    realEstate: { kind: "tabs" },
  };
}

function mockApi(): void {
  vi.spyOn(api, "writeTeamConfigFile").mockResolvedValue(undefined as unknown as void);
  vi.spyOn(api, "restartTerminal").mockResolvedValue(undefined as unknown as void);
  let n = 0;
  vi.spyOn(api, "spawnTerminal").mockImplementation(async () => {
    n += 1;
    return { session: `worker-${n}`, tab_label: `w${n}` };
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  setLayout(leadTab());
});

describe("identity prompt placement", () => {
  test("primes the lead's embedded editor (open + buffer set)", async () => {
    setLayout(leadTab());
    mockApi();
    await runTeamBootstrap(config(), {
      leadTabId: "lead-tab",
      leadPaneId: "pane-test",
    });
    const lead = leadFromLayout();
    expect(lead.teamWork?.open).toBe(true);
    expect(lead.teamWork?.buffer.startsWith("# Team work")).toBe(true);
  });

  test("prompt names the team size, host, lead, and worker bullets", async () => {
    setLayout(leadTab());
    mockApi();
    await runTeamBootstrap(config(), {
      leadTabId: "lead-tab",
      leadPaneId: "pane-test",
    });
    const buffer = leadFromLayout().teamWork?.buffer ?? "";
    expect(buffer).toContain("We are a team of 3");
    expect(buffer).toContain("Our host is @@Neo and the team lead is @@Lead");
    expect(buffer).toContain("send_agent_task");
    expect(buffer).toContain("list_agent_tasks");
    expect(buffer).toContain("poke");
    expect(buffer).toContain("- @@Worker1");
    expect(buffer).toContain("- @@Worker2");
  });

  test("$CHAN_TAB_NAME stays literal (the lead's shell expands it)", async () => {
    setLayout(leadTab());
    mockApi();
    await runTeamBootstrap(config(), {
      leadTabId: "lead-tab",
      leadPaneId: "pane-test",
    });
    const buffer = leadFromLayout().teamWork?.buffer ?? "";
    expect(buffer).toContain("You are $CHAN_TAB_NAME");
    expect(buffer).not.toContain("\\$CHAN_TAB_NAME");
  });
});
