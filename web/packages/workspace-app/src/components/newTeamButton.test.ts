import { describe, expect, test } from "vitest";
import dialog from "./TeamDialog.svelte?raw";
import {
  defaultTeamConfig,
  TEAM_MAX_SIZE,
  TEAM_MIN_SIZE,
  validateTeamConfig,
} from "../state/teamDialog.svelte";

// Team Work dialog. Pins the New/Load team-dir control, the 1-9
// dropdown (no slider), the "drag-me" chip label, the removed
// copy/paste buttons, and the default-state contract (host "Neo", New mode).

describe("default config contract", () => {
  test("host name defaults to Neo, New mode, one lead agent", () => {
    const cfg = defaultTeamConfig();
    expect(cfg.hostName).toBe("Neo");
    expect(cfg.configMode).toBe("new");
    expect(cfg.teamDir).toBe("new-team-1");
    expect(cfg.size).toBe(TEAM_MIN_SIZE);
    expect(cfg.members).toHaveLength(1);
    expect(cfg.members[0].isLead).toBe(true);
    expect(cfg.autoPrefix).toBe(true);
  });

  test("validate requires a workspace-relative team dir (no team name)", () => {
    const cfg = { ...defaultTeamConfig(), teamDir: "/tmp/new-team-1" };
    expect(validateTeamConfig(cfg)).toBe(
      "Team directory must be a path inside the workspace",
    );
    const empty = { ...defaultTeamConfig(), teamDir: "" };
    expect(validateTeamConfig(empty)).toBe("Team directory required");
    expect(validateTeamConfig(defaultTeamConfig())).toBeNull();
  });
});

describe("TeamDialog component shell", () => {
  test("renders Bootstrap + Cancel footer buttons", () => {
    expect(dialog).toMatch(/class="team-dialog-bootstrap"[\s\S]*?onclick=\{onBootstrap\}/);
    expect(dialog).toMatch(/class="team-dialog-cancel"[\s\S]*?onclick=\{onCancel\}/);
  });

  test("host name input defaults placeholder to Neo", () => {
    expect(dialog).toMatch(/bind:value=\{config\.hostName\}/);
    expect(dialog).toMatch(/placeholder="Neo"/);
  });

  test("auto-prefix checkbox is kept", () => {
    expect(dialog).toMatch(/bind:checked=\{config\.autoPrefix\}/);
  });

  test("Team configuration New/Load toggle replaces the Team name field", () => {
    expect(dialog).toMatch(/Team configuration/);
    expect(dialog).toMatch(/setConfigMode\("new"\)/);
    expect(dialog).toMatch(/setConfigMode\("load"\)/);
    // The old free-text Team name binding is gone.
    expect(dialog).not.toMatch(/bind:value=\{config\.teamName\}/);
  });

  test("Team directory field binds config.teamDir", () => {
    expect(dialog).toMatch(/Team directory \(in workspace\)/);
    expect(dialog).toMatch(/bind:value=\{config\.teamDir\}/);
  });

  test("New mode shows the team-dir info line", () => {
    expect(dialog).toMatch(/Team files will be created in/);
  });

  test("Load mode auto-validates the dir via readTeamConfig", () => {
    expect(dialog).toMatch(/api\.readTeamConfig/);
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

  test("the per-member agent dropdown is gone; agent derives from the command", () => {
    // The manual picker was removed. The submit-encoding agent now derives
    // from the command (loosely) with a CHAN_AGENT env override, so there is
    // no agent <select> and nothing writes setMemberField(idx, "agent", ...).
    expect(dialog).not.toMatch(/team-member-agent/);
    expect(dialog).not.toMatch(/agent-picker/);
    expect(dialog).not.toMatch(/setMemberField\(\s*idx,\s*"agent"/);
    // The env field advertises the override hatch.
    expect(dialog).toMatch(/CHAN_AGENT/);
    expect(dialog).toMatch(
      /auto-detect[\s\S]{1,160}<code>opencode<\/code>/,
    );
    expect(dialog).toMatch(/auto-detect[\s\S]{1,200}<code>kimi<\/code>/);
    expect(dialog).toMatch(/auto-detect[\s\S]{1,40}<code>agy<\/code>/);
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

  test("Escape listens in capture phase + stops propagation (TW3)", () => {
    // The dialog opens over a freshly-spawned lead terminal that grabs
    // focus; a bubble-phase listener was swallowed by the terminal. The
    // window listener must be capture-phase and the handler must
    // stopPropagation so Escape reaches the dialog, not the terminal.
    expect(dialog).toContain("<svelte:window onkeydowncapture={onKeydown} />");
    expect(dialog).toMatch(
      /if \(e\.key === "Escape" && !busy\) \{[\s\S]*?e\.stopPropagation\(\);/,
    );
  });
});
