// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import client from "../api/client.ts?raw";
import dialog from "./TeamDialog.svelte?raw";
import { api } from "../api/client";
import type { TeamConfigWire } from "../api/client";
import {
  runTeamBootstrap,
  translateConfig,
  wireToDialog,
} from "../state/teamOrchestrator.svelte";
import { resizeTeamMembers } from "../state/teamDialog.svelte";
import { layout, type LeafNode, type TerminalTab } from "../state/tabs.svelte";

// Path-based New/Load config flow. Load reads an existing chan-team.toml
// back via readTeamConfigFile, prepopulates the (still-editable) form
// via wireToDialog, and re-saves the edited config on Bootstrap.

describe("api client: path-based team-config read/write", () => {
  test("readTeamConfigFile POSTs /api/team-config/read with { path }", () => {
    expect(client).toMatch(
      /readTeamConfigFile: \(path: string\) =>[\s\S]{1,200}req<TeamConfigWire>\("POST", "\/api\/team-config\/read", \{ path \}\)/,
    );
  });

  test("writeTeamConfigFile POSTs /api/team-config/write with { path, config }", () => {
    expect(client).toMatch(
      /writeTeamConfigFile: \(path: string, config: TeamConfigWire\) =>[\s\S]{1,200}req<void>\("POST", "\/api\/team-config\/write", \{ path, config \}\)/,
    );
  });
});

describe("TeamDialog Load flow", () => {
  test("Load populates the form from wireToDialog + stays editable (resizeTeamMembers)", () => {
    expect(dialog).toMatch(/const wire = await api\.readTeamConfigFile\(path\);/);
    expect(dialog).toMatch(/const loaded = wireToDialog\(wire, path\);/);
    expect(dialog).toMatch(/config = resizeTeamMembers\(loaded\);/);
  });

  test("Load surfaces the backend 400 inline instead of throwing", () => {
    expect(dialog).toMatch(/loadError = \(err as Error\)\.message/);
  });
});

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

function loadedWire(): TeamConfigWire {
  return {
    team_name: "saved-team",
    host_name: "@@Trinity",
    host_handle: "@@Trinity",
    auto_prefix_at: true,
    created_at: "2026-05-29T00:00:00.000Z",
    members: [
      {
        handle: "@@Lead",
        command: "claude",
        env: { CHAN_TEAM_NAME: "saved-team", CHAN_TAB_NAME: "@@Lead" },
        is_lead: true,
      },
      {
        handle: "@@Worker1",
        command: "codex",
        env: { CHAN_TEAM_NAME: "saved-team", CHAN_TAB_NAME: "@@Worker1" },
        is_lead: false,
      },
    ],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  setLayout(leadTab());
});

describe("Load -> edit -> Bootstrap re-saves the config", () => {
  test("a loaded config round-trips into an editable dialog config", () => {
    const cfg = resizeTeamMembers(wireToDialog(loadedWire(), "/tmp/x/chan-team.toml"));
    expect(cfg.configMode).toBe("load");
    expect(cfg.hostName).toBe("@@Trinity");
    expect(cfg.members.map((m) => m.name)).toEqual(["@@Lead", "@@Worker1"]);
    // The config is a plain editable object; translating it back
    // yields the same members (the round-trip the dialog uses on
    // Bootstrap).
    const back = translateConfig(cfg);
    expect(back.members.map((m) => m.handle)).toEqual(["@@Lead", "@@Worker1"]);
  });

  test("Bootstrap writes the (edited) config back to the path", async () => {
    const lead = leadTab();
    setLayout(lead);
    const write = vi
      .spyOn(api, "writeTeamConfigFile")
      .mockResolvedValue(undefined as unknown as void);
    vi.spyOn(api, "restartTerminal").mockResolvedValue(undefined as unknown as void);
    vi.spyOn(api, "spawnTerminal").mockResolvedValue({ session: "w", tab_label: "w" });

    const cfg = resizeTeamMembers(wireToDialog(loadedWire(), "/tmp/x/chan-team.toml"));
    await runTeamBootstrap(cfg, { leadTabId: "lead-tab", leadPaneId: "pane-test" });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe("/tmp/x/chan-team.toml");
    // The persisted wire carries the loaded host handle.
    expect(write.mock.calls[0][1]).toMatchObject({ host_name: "@@Trinity" });
  });
});
