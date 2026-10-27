// The terminal Details command follows the active tab and stays out of the
// control terminal's command catalog.

import { afterEach, describe, expect, test } from "vitest";

import { resetLayout, terminalTab } from "../../__tests__/tabs";
import { allCommands, availableCommands, type CommandContext } from "../commands";
import { type TerminalTab } from "../tabs.svelte";
import "./install";

const COMMAND_ID = "app.terminal.details";

function context(terminalControl = false): CommandContext {
  return {
    terminalOnly: true,
    terminalControl,
    caps: { workspace: false, files: false, drafts: false, terminal: true },
    activeSurface: "terminal",
    activeSide: null,
    activeTabId: "term-2",
    activeExtensionId: null,
  };
}

afterEach(() => resetLayout());

describe("terminal Details command", () => {
  test("is offered over a terminal and hidden over the control terminal", () => {
    resetLayout([terminalTab({ id: "term-2" })]);
    const command = allCommands().find((entry) => entry.id === COMMAND_ID);
    expect(command?.title).toBe("Toggle details");
    expect(command?.category).toBe("Terminal");
    expect(availableCommands(context()).some((entry) => entry.id === COMMAND_ID)).toBe(true);
    expect(availableCommands(context(true)).some((entry) => entry.id === COMMAND_ID)).toBe(false);
  });

  test("opens and closes Details on the active terminal tab", () => {
    const first = terminalTab({ id: "term-1", inspectorOpen: false });
    const second = terminalTab({ id: "term-2", inspectorOpen: false });
    const pane = resetLayout([first, second], { activeTabId: second.id });
    const command = availableCommands(context()).find((entry) => entry.id === COMMAND_ID);
    expect(command).toBeDefined();

    command!.run();
    expect((pane.tabs[0] as TerminalTab).inspectorOpen).toBe(false);
    expect((pane.tabs[1] as TerminalTab).inspectorOpen).toBe(true);

    command!.run();
    expect((pane.tabs[1] as TerminalTab).inspectorOpen).toBe(false);
  });
});
