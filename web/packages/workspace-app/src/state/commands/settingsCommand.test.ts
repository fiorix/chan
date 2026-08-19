// The settings command: registration, availability, and that its run()
// opens the surface directly from the launcher.

import { afterEach, describe, expect, it } from "vitest";
import { availableCommands, type CommandContext } from "../commands";
import { settingsPanel } from "../store.svelte";
import "./settings";

function ctx(partial: Partial<CommandContext>): CommandContext {
  return {
    terminalOnly: false,
    terminalControl: false,
    // Full caps keep the requirement gate open; these tests pin the
    // per-command availability predicates on their own.
    caps: { workspace: true, files: true, drafts: true, terminal: true },
    activeSurface: null,
    activeSide: null,
    activeTabId: null,
    activeExtensionId: null,
    ...partial,
  };
}

afterEach(() => {
  settingsPanel.open = false;
});

describe("settings command", () => {
  it("is a Global command available in every window", () => {
    const cmd = availableCommands(ctx({})).find(
      (c) => c.id === "app.settings.open",
    );
    expect(cmd).toBeTruthy();
    expect(cmd?.category).toBe("Global");
    // Machine-global config, so it stays offered in a standalone terminal.
    const inTerminal = availableCommands(
      ctx({ terminalOnly: true, activeSurface: "terminal" }),
    );
    expect(inTerminal.some((c) => c.id === "app.settings.open")).toBe(true);
  });

  it("run() opens the settings surface", () => {
    const cmd = availableCommands(ctx({})).find(
      (c) => c.id === "app.settings.open",
    );
    expect(settingsPanel.open).toBe(false);
    cmd?.run();
    expect(settingsPanel.open).toBe(true);
  });
});
