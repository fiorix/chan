// @vitest-environment jsdom
//
// keyboardOwnedByDialog answers whether an app-root dialog is open, for the
// chords that act on the focused pane and stand down while one is.

import { afterEach, describe, expect, test } from "vitest";
import { confirmState } from "./confirm.svelte";
import {
  importContactsPanel,
  keyboardOwnedByDialog,
  pathPromptState,
  promptState,
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
});

describe("keyboardOwnedByDialog", () => {
  test("is false with no dialog open", () => {
    expect(keyboardOwnedByDialog()).toBe(false);
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
  ])("is true while %s is open", (_name, open) => {
    open();
    expect(keyboardOwnedByDialog()).toBe(true);
  });
});
