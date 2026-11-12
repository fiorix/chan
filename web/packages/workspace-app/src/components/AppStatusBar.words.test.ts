// @vitest-environment jsdom
//
// A status bar button that runs a catalog command is named by it: the
// Transfers launcher by Show transfers and the warnings line by Show
// workspace warnings. The indexing pill opens a Dashboard on its Search
// slide, which no command does, and keeps its own name.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test } from "vitest";

import { expectWords } from "../__tests__/menuWords";
import type { WorkspaceWarning } from "../api/types";
import { indexStatus, ui, workspaceWarningsDialog } from "../state/store.svelte";
import { beginTransfer, transfers } from "../state/transfers.svelte";
import AppStatusBar from "./AppStatusBar.svelte";

let view: Record<string, unknown> | null = null;

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.replaceChildren();
  indexStatus.value = null;
  transfers.items = [];
  transfers.shown = false;
  workspaceWarningsDialog.warnings = [];
  workspaceWarningsDialog.open = false;
  ui.status = null;
  ui.statusKind = null;
  ui.statusAction = null;
});

function mountBar(): HTMLElement {
  const target = document.body.appendChild(document.createElement("div"));
  view = mount(AppStatusBar, { target });
  flushSync();
  return target;
}

test("each button that runs a command carries the command's title", () => {
  const warning: WorkspaceWarning = { kind: "broken_draft", path: "a", message: "unreadable" };
  indexStatus.value = { state: "building", current: 1, total: 2, file: "a.md" };
  beginTransfer({ kind: "download", filename: "dump.sql", cancel: null });
  workspaceWarningsDialog.warnings = [warning];
  ui.status = "Workspace warnings";
  ui.statusAction = { kind: "workspace-warnings", label: "Workspace warnings" };
  const bar = mountBar();

  const actions = [...bar.querySelectorAll<HTMLButtonElement>("button.status-action")];
  expectWords(
    actions.map((button) => button.getAttribute("aria-label") ?? ""),
    [
      {
        own: "open indexing dashboard",
        because: "opens a Dashboard on its Search slide with rotation off, which no command does",
      },
      { command: "app.transfers.show" },
      { command: "app.workspace.showWarnings" },
    ],
  );
  expect(actions[1]!.title).toBe("Show transfers");
});

test("the Transfers launcher shows the panel its command shows", () => {
  beginTransfer({ kind: "download", filename: "dump.sql", cancel: null });
  const bar = mountBar();

  bar.querySelector<HTMLButtonElement>('[aria-label="Show transfers"]')!.click();
  expect(transfers.shown).toBe(true);
});

test("the warnings line opens the dialog its command opens", () => {
  workspaceWarningsDialog.warnings = [{ kind: "broken_draft", path: "a", message: "unreadable" }];
  ui.status = "Workspace warnings";
  ui.statusAction = { kind: "workspace-warnings", label: "Workspace warnings" };
  const bar = mountBar();

  bar.querySelector<HTMLButtonElement>('[aria-label="Show workspace warnings"]')!.click();
  expect(workspaceWarningsDialog.open).toBe(true);
});
