import { describe, expect, test } from "vitest";
import terminalCommands from "./commands/terminal.ts?raw";
import teamOrchestrator from "./teamOrchestrator.svelte.ts?raw";

describe("server-authoritative terminal metadata callers", () => {
  test("the active group command proposes the complete live pair", () => {
    expect(terminalCommands).toMatch(
      /renameTerminalTab\(t, terminalTabName\(t\), group\)/,
    );
    expect(terminalCommands).not.toContain("setTerminalGroup(t, group)");
  });

  test("team spawns keep the registry-settled response label", () => {
    expect(teamOrchestrator).toMatch(/title: response\.tab_label/);
    expect(teamOrchestrator).not.toContain("renameTerminalTab");
  });
});
