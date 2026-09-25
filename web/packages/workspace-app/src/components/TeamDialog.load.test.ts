// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import client from "../api/client.ts?raw";
import dialog from "./TeamDialog.svelte?raw";
import { api } from "../api/client";
import type { TeamConfigWire } from "../api/client";
import type { WorkspaceInfo } from "../api/types";
import {
  runTeamBootstrap,
  translateConfig,
  wireToDialog,
} from "../state/teamOrchestrator.svelte";
import { resizeTeamMembers } from "../state/teamDialog.svelte";
import { layout, type LeafNode, type TerminalTab } from "../state/tabs.svelte";
import { workspace } from "../state/workspace.svelte";

// The orchestrator refuses to start a team whose workspace root it does not
// know (the identity prompt names bootstrap.md by its absolute path), so the
// root every test here runs under is seeded once.
workspace.info = { root: "/ws" } as unknown as WorkspaceInfo;

// Dir-based New/Load config flow. Load reads an existing team's
// config.toml back via readTeamConfig, prepopulates the
// (still-editable) form via wireToDialog, and re-saves the edited
// config on Bootstrap.

describe("api client: dir-based team-config read/write", () => {
  test("readTeamConfig POSTs /api/team-config/read with { dir }", () => {
    expect(client).toMatch(
      /readTeamConfig: \(dir: string\) =>[\s\S]{1,200}req<TeamConfigWire>\("POST", "\/api\/team-config\/read", \{ dir \}\)/,
    );
  });

  test("writeTeamConfig POSTs /api/team-config/write with { dir, config, brief_content }", () => {
    expect(client).toMatch(
      /writeTeamConfig: \(dir: string, config: TeamConfigWire, briefContent\?: string\) =>[\s\S]{1,200}req<void>\("POST", "\/api\/team-config\/write", \{[\s\S]{1,120}dir,[\s\S]{1,40}config,[\s\S]{1,80}brief_content: briefContent,/,
    );
  });
});

describe("TeamDialog Load flow", () => {
  test("Load populates the form from wireToDialog + stays editable (resizeTeamMembers)", () => {
    expect(dialog).toMatch(/const wire = await api\.readTeamConfig\(path\);/);
    expect(dialog).toMatch(/const loaded = wireToDialog\(wire, path\);/);
    expect(dialog).toMatch(/config = resizeTeamMembers\(loaded\);/);
  });

  test("Load surfaces the backend 400 inline instead of throwing", () => {
    expect(dialog).toMatch(/loadError = \(err as Error\)\.message/);
  });
});

describe("TeamDialog Load UX (TW1)", () => {
  test("team-dir input is backed by a directory autocomplete datalist", () => {
    expect(dialog).toContain('list="team-dir-suggestions"');
    expect(dialog).toMatch(
      /<datalist id="team-dir-suggestions">[\s\S]*?dirSuggestions/,
    );
  });

  test("autocomplete lists workspace directories only (forces a dir choice)", () => {
    // refreshDirSuggestions lists the typed parent segment and filters to
    // directories, so files never appear as path completions.
    expect(dialog).toMatch(/api\.list\(parent \|\| null\)/);
    expect(dialog).toMatch(/\.filter\(\(e\) => e\.is_dir\)/);
  });

  test("a successful load surfaces the resolved config.toml + team summary", () => {
    expect(dialog).toMatch(
      /loadedConfig = \{[\s\S]*?teamName: wire\.team_name,[\s\S]*?memberCount: wire\.members\.length,/,
    );
    expect(dialog).toContain("/config.toml");
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
    host_name: "Trinity",
    host_handle: "@@Trinity",
    tab_group: "saved-team",
    auto_prefix_at: true,
    mcp_env: false,
    created_at: "2026-05-29T00:00:00.000Z",
    members: [
      { handle: "@@Lead", command: "claude", env: { CHAN_TAB_NAME: "@@Lead" }, is_lead: true },
      {
        handle: "@@Worker1",
        command: "codex",
        env: { CHAN_TAB_NAME: "@@Worker1" },
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
    const cfg = resizeTeamMembers(wireToDialog(loadedWire(), "saved-team"));
    expect(cfg.configMode).toBe("load");
    expect(cfg.hostName).toBe("Trinity");
    expect(cfg.members.map((m) => m.name)).toEqual(["@@Lead", "@@Worker1"]);
    // The config is a plain editable object; translating it back
    // yields the same members (the round-trip the dialog uses on
    // Bootstrap).
    const back = translateConfig(cfg);
    expect(back.members.map((m) => m.handle)).toEqual(["@@Lead", "@@Worker1"]);
  });

  test("Bootstrap writes the (edited) config back to the team dir", async () => {
    const lead = leadTab();
    setLayout(lead);
    const write = vi
      .spyOn(api, "writeTeamConfig")
      .mockResolvedValue(undefined as unknown as void);
    vi.spyOn(api, "restartTerminal").mockResolvedValue(undefined as unknown as void);
    vi.spyOn(api, "spawnTerminal").mockResolvedValue({ session: "w", tab_label: "w" });

    const cfg = resizeTeamMembers(wireToDialog(loadedWire(), "saved-team"));
    await runTeamBootstrap(cfg, { leadTabId: "lead-tab", leadPaneId: "pane-test" });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe("saved-team");
    // The persisted wire carries the loaded host name.
    expect(write.mock.calls[0][1]).toMatchObject({ host_name: "Trinity" });
  });
});
