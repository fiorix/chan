// @vitest-environment jsdom
//
// Show workspace warnings opens the warnings dialog from the launcher, the
// way to it while the status bar's warnings line is closed. It is offered
// only while the workspace has a warning.

import { afterEach, expect, test } from "vitest";
import { allCommands, commandContext } from "../commands";
import { closeWorkspaceWarningsDialog, workspaceWarningsDialog } from "../store.svelte";
import "./global";

afterEach(() => {
  workspaceWarningsDialog.warnings = [];
  closeWorkspaceWarningsDialog();
});

function showWarningsCommand() {
  const command = allCommands().find((c) => c.id === "app.workspace.showWarnings");
  expect(command, "Show workspace warnings is registered").toBeDefined();
  return command!;
}

test("is not offered with no warning", () => {
  expect(showWarningsCommand().available(commandContext())).toBe(false);
});

test("opens the warnings dialog", () => {
  workspaceWarningsDialog.warnings = [{ kind: "broken_draft", path: "a", message: "unreadable" }];
  const command = showWarningsCommand();
  expect(command.available(commandContext())).toBe(true);
  command.run();
  expect(workspaceWarningsDialog.open).toBe(true);
});
