// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/client";
import { runTeamBootstrap } from "./teamOrchestrator.svelte";
import type { TeamDialogConfig } from "./teamDialog.svelte";
import { layout, type LeafNode, type TerminalTab } from "./tabs.svelte";

// The lead launches FIRST, in place. The Team Work Lead terminal
// already exists (created at Cmd+P), so the orchestrator restarts
// ITS pty with the lead command + env. These tests pin the in-place
// launch + the env carry-through.

function leadTab(partial: Partial<TerminalTab> = {}): TerminalTab {
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

// `layout.nodes` is a $state proxy: re-read the lead tab from the
// layout to observe in-place mutations (rename) the orchestrator
// makes via the proxy.
function leadFromLayout(): TerminalTab {
  const node = layout.nodes["pane-test"];
  if (!node || node.kind !== "leaf") throw new Error("no lead pane");
  const tab = node.tabs.find((t) => t.id === "lead-tab");
  if (!tab || tab.kind !== "terminal") throw new Error("no lead tab");
  return tab;
}

function config(): TeamDialogConfig {
  return {
    hostName: "@@Neo",
    configMode: "new",
    configPath: "/tmp/solo/chan-team.toml",
    size: 1,
    autoPrefix: false,
    members: [
      { name: "@@Lead", command: "claude --resume", env: "DEBUG=1", isLead: true },
    ],
    realEstate: { kind: "tabs" },
  };
}

function mockApi() {
  vi.spyOn(api, "writeTeamConfigFile").mockResolvedValue(undefined as unknown as void);
  vi.spyOn(api, "spawnTerminal").mockResolvedValue({
    session: "w",
    tab_label: "w",
  });
  const restart = vi
    .spyOn(api, "restartTerminal")
    .mockResolvedValue(undefined as unknown as void);
  return { restart };
}

afterEach(() => {
  vi.restoreAllMocks();
  setLayout(leadTab());
});

describe("lead launch (in-place, lead-first)", () => {
  test("restarts the existing lead session with command + env + name", async () => {
    const lead = leadTab();
    setLayout(lead);
    const { restart } = mockApi();
    await runTeamBootstrap(config(), {
      leadTabId: "lead-tab",
      leadPaneId: "pane-test",
    });
    expect(restart).toHaveBeenCalledTimes(1);
    const [session, opts] = restart.mock.calls[0];
    expect(session).toBe("lead-session");
    expect(opts).toMatchObject({
      name: "@@Lead",
      command: "claude --resume",
    });
    // Team Work identity is system-owned; the user's env entry rides along.
    expect(opts?.env?.CHAN_TEAM_NAME).toBe("solo");
    expect(opts?.env?.CHAN_TAB_NAME).toBe("@@Lead");
    expect(opts?.env?.DEBUG).toBe("1");
  });

  test("never closes the lead session (no close/respawn dance)", async () => {
    setLayout(leadTab());
    mockApi();
    const close = vi.spyOn(api, "closeTerminal");
    await runTeamBootstrap(config(), {
      leadTabId: "lead-tab",
      leadPaneId: "pane-test",
    });
    expect(close).not.toHaveBeenCalled();
  });

  test("renames the lead tab to the lead handle in place", async () => {
    setLayout(leadTab());
    mockApi();
    await runTeamBootstrap(config(), {
      leadTabId: "lead-tab",
      leadPaneId: "pane-test",
    });
    expect(leadFromLayout().title).toBe("@@Lead");
  });

  test("no PTY yet: renames the tab but skips the restart (edge case)", async () => {
    setLayout(leadTab({ terminalSessionId: undefined }));
    const { restart } = mockApi();
    await runTeamBootstrap(config(), {
      leadTabId: "lead-tab",
      leadPaneId: "pane-test",
    });
    expect(restart).not.toHaveBeenCalled();
    expect(leadFromLayout().title).toBe("@@Lead");
  });
});
