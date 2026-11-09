// @vitest-environment jsdom
//
// New dashboard is offered and run only where a tab strip can show the new
// tab. A pane showing a tmux pane draws none (a control window's gate is
// pinned in requirementTable.test.ts), so the launcher hides the command
// there and the opener refuses it.

import { expect, test } from "vitest";
import { availableCommands } from "../commands";
import { capsForMode } from "../windowCaps";
import { activePane, allPaneTabs, openDashboardInActivePane } from "../tabs.svelte";
import { resetLayout, terminalTab } from "../../__tests__/tabs";

import "./install";

function offered(): boolean {
  const context = {
    terminalOnly: false,
    terminalControl: false,
    caps: capsForMode("workspace", false, false),
    activeSurface: "terminal" as const,
    activeSide: "a" as const,
    activeTabId: activePane().activeTabId,
    activeExtensionId: null,
  };
  return availableCommands(context).some((command) => command.id === "app.dashboard.open");
}

const kinds = () => allPaneTabs(activePane()).map((tab) => tab.kind);

test("a pane showing a tmux pane neither offers nor opens a Dashboard", () => {
  resetLayout([terminalTab({ id: "pane", terminalSessionId: "pane-a", tmuxPane: { connection: 1, pane: "%0" } })]);
  expect(offered()).toBe(false);
  expect(openDashboardInActivePane()).toBe(false);
  expect(kinds()).toEqual(["terminal"]);
});

test("a plain pane offers and opens one", () => {
  resetLayout([terminalTab({ id: "shell", terminalSessionId: "shell-1" })]);
  expect(offered()).toBe(true);
  expect(openDashboardInActivePane()).toBe(true);
  expect(kinds()).toEqual(["terminal", "dashboard"]);
});
