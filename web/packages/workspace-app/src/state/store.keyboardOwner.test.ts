// @vitest-environment jsdom
//
// keyboardOwnedAbovePanes answers whether an overlay or an app-root dialog is
// open over the panes, for Ctrl+D and the pane flip, which stand down while
// one is.

import { afterEach, describe, expect, test } from "vitest";
import { closeConfirmState } from "./closeConfirm.svelte";
import { confirmState } from "./confirm.svelte";
import {
  importContactsPanel,
  keyboardOwnedAbovePanes,
  launcherPanel,
  pathPromptState,
  promptState,
  searchPanel,
  settingsPanel,
  syncOverlayStack,
  workspaceWarningsDialog,
} from "./store.svelte";
import { conflictDialog, draftCloseState } from "./tabs.svelte";
import { teamDialogState } from "./teamDialog.svelte";

afterEach(() => {
  promptState.open = false;
  pathPromptState.open = false;
  confirmState.open = false;
  draftCloseState.open = false;
  teamDialogState.request = null;
  conflictDialog.open = false;
  workspaceWarningsDialog.open = false;
  importContactsPanel.open = false;
  closeConfirmState.open = false;
  searchPanel.open = false;
  launcherPanel.open = false;
  settingsPanel.open = false;
  syncOverlayStack();
});

describe("keyboardOwnedAbovePanes", () => {
  test("is false with no dialog open", () => {
    expect(keyboardOwnedAbovePanes()).toBe(false);
  });

  test.each([
    ["a prompt", () => (promptState.open = true)],
    ["a path prompt", () => (pathPromptState.open = true)],
    ["a confirm", () => (confirmState.open = true)],
    ["the draft close dialog", () => (draftCloseState.open = true)],
    ["the Team Work dialog", () => (teamDialogState.request = { leadTabId: "t", leadPaneId: "p" })],
    ["the file conflict dialog", () => (conflictDialog.open = true)],
    ["the workspace warnings", () => (workspaceWarningsDialog.open = true)],
    ["the contacts import", () => (importContactsPanel.open = true)],
    ["the desktop close prompt", () => (closeConfirmState.open = true)],
    ["the Search overlay", () => ((searchPanel.open = true), syncOverlayStack())],
    ["the command launcher", () => ((launcherPanel.open = true), syncOverlayStack())],
    ["Settings", () => ((settingsPanel.open = true), syncOverlayStack())],
  ])("is true while %s is open", (_name, open) => {
    open();
    expect(keyboardOwnedAbovePanes()).toBe(true);
  });
});
