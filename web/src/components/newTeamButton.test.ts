import { describe, expect, test } from "vitest";
import dialog from "./TeamDialog.svelte?raw";
import {
  defaultTeamConfig,
  TEAM_MAX_SIZE,
  TEAM_MIN_SIZE,
  validateTeamConfig,
} from "../state/teamDialog.svelte";

// Team Work dialog. Pins the New/Load path-config control, the 1-9
// dropdown, the "drag-me" chip label, the removed copy/paste buttons,
// and the default-state contract with canonical host handles.

describe("default config contract", () => {
  test("host name defaults to @@Neo, New mode, one lead agent", () => {
    const cfg = defaultTeamConfig();
    expect(cfg.hostName).toBe("@@Neo");
    expect(cfg.configMode).toBe("new");
    expect(cfg.configPath).toBe("/tmp/new-team-1/chan-team.toml");
    expect(cfg.size).toBe(TEAM_MIN_SIZE);
    expect(cfg.members).toHaveLength(1);
    expect(cfg.members[0].isLead).toBe(true);
    expect(cfg.autoPrefix).toBe(false);
  });

  test("validate requires an absolute config path (no team name)", () => {
    const cfg = { ...defaultTeamConfig(), configPath: "relative/x.toml" };
    expect(validateTeamConfig(cfg)).toBe("Path to configuration must be absolute");
    const empty = { ...defaultTeamConfig(), configPath: "" };
    expect(validateTeamConfig(empty)).toBe("Path to configuration required");
    expect(validateTeamConfig(defaultTeamConfig())).toBeNull();
  });
});

describe("TeamDialog component shell", () => {
  test("renders Bootstrap + Cancel footer buttons", () => {
    expect(dialog).toMatch(/class="team-dialog-bootstrap"[\s\S]*?onclick=\{onBootstrap\}/);
    expect(dialog).toMatch(/class="team-dialog-cancel"[\s\S]*?onclick=\{onCancel\}/);
  });

  test("host name input defaults placeholder to @@Neo", () => {
    expect(dialog).toMatch(/bind:value=\{config\.hostName\}/);
    expect(dialog).toMatch(/placeholder="@@Neo"/);
  });

  test("auto-prefix checkbox is removed", () => {
    expect(dialog).not.toMatch(/bind:checked=\{config\.autoPrefix\}/);
    expect(dialog).not.toMatch(/Auto-prefix names/);
  });

  test("Team configuration New/Load toggle replaces the Team name field", () => {
    expect(dialog).toMatch(/Team configuration/);
    expect(dialog).toMatch(/setConfigMode\("new"\)/);
    expect(dialog).toMatch(/setConfigMode\("load"\)/);
    // The old free-text Team name binding is gone.
    expect(dialog).not.toMatch(/bind:value=\{config\.teamName\}/);
  });

  test("Path to configuration field binds config.configPath", () => {
    expect(dialog).toMatch(/Path to configuration/);
    expect(dialog).toMatch(/bind:value=\{config\.configPath\}/);
  });

  test("New mode shows the team-management-dir info line", () => {
    expect(dialog).toMatch(/team management files will be created in/);
  });

  test("Load mode auto-validates the path via readTeamConfigFile", () => {
    expect(dialog).toMatch(/api\.readTeamConfigFile/);
    expect(dialog).toMatch(/void validateAndLoad\(\)/);
  });

  test("agent count is a 1-9 dropdown, not a slider", () => {
    expect(dialog).toMatch(/Number of agents/);
    expect(dialog).toMatch(/onSizeChange\(Number\(/);
    expect(dialog).not.toMatch(/type="range"/);
    // The dropdown spans TEAM_MIN_SIZE..TEAM_MAX_SIZE.
    expect(dialog).toMatch(/TEAM_MAX_SIZE - TEAM_MIN_SIZE \+ 1/);
  });

  test("per-member row renders name + command + env + lead radio", () => {
    expect(dialog).toMatch(/class="team-member-name"/);
    expect(dialog).toMatch(/class="team-member-command"/);
    expect(dialog).toMatch(/class="team-member-env"/);
    expect(dialog).toMatch(/name="team-lead"/);
  });

  test("the unassigned chip is relabeled drag-me", () => {
    expect(dialog).toMatch(/drag-me/);
    expect(dialog).not.toMatch(/>unassigned</);
  });

  test("copy/paste config buttons are removed", () => {
    expect(dialog).not.toMatch(/Copy config/);
    expect(dialog).not.toMatch(/Paste config/);
    expect(dialog).not.toMatch(/onCopyConfig/);
    expect(dialog).not.toMatch(/onPasteConfig/);
  });

  test("Cancel deletes the lead terminal tab the dialog was opened over", () => {
    expect(dialog).toMatch(
      /function onCancel\(\): void \{[\s\S]{1,400}closeTab\(request\.leadPaneId, request\.leadTabId/,
    );
  });

  test("Bootstrap runs the orchestrator against the lead tab + pane", () => {
    expect(dialog).toMatch(
      /runTeamBootstrap\(config, \{[\s\S]{1,200}leadTabId: request\.leadTabId,[\s\S]{1,80}leadPaneId: request\.leadPaneId,/,
    );
  });

  test("Escape key closes the dialog", () => {
    expect(dialog).toMatch(
      /function onKeydown\(e: KeyboardEvent\): void \{[\s\S]*?if \(e\.key === "Escape" && !busy\) \{[\s\S]*?onCancel\(\);/,
    );
  });
});
