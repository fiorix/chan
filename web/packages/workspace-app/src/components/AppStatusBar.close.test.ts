// @vitest-environment jsdom
//
// Every status-bar section a person cannot answer has a close. A close hides
// that section until its content changes: a new index state or run, a
// different error, a new warning, a new transfer or upload request, a changed
// roster. Hybrid Nav has none; Esc and Enter end it. When every showing
// section is closed the bar leaves, chevron included.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";

import { sessionWindowId } from "../api/client";
import type { IndexStatus, WorkspaceWarning } from "../api/types";
import { importStatus, indexStatus, ui, workspaceWarningsDialog } from "../state/store.svelte";
import { sessionState, type SessionParticipant } from "../state/session.svelte";
import { paneMode } from "../state/tabs.svelte";
import { beginTransfer, setTransferProgress, transfers } from "../state/transfers.svelte";
import AppStatusBar from "./AppStatusBar.svelte";

let view: Record<string, unknown> | null = null;
let target: HTMLElement;

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
  indexStatus.value = null;
  importStatus.value = null;
  transfers.items = [];
  paneMode.active = false;
  sessionState.participants = [];
  workspaceWarningsDialog.warnings = [];
  ui.status = null;
  ui.statusKind = null;
  ui.statusAction = null;
});

function mountBar(): void {
  target = document.body.appendChild(document.createElement("div"));
  view = mount(AppStatusBar, { target });
  flushSync();
}

function shown(label: string): boolean {
  return target.querySelector(`[aria-label="${label}"]`) !== null;
}

function close(label: string): void {
  const button = target.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  expect(button, `${label} is offered`).not.toBeNull();
  button!.click();
  flushSync();
}

function setIndex(status: IndexStatus | null): void {
  indexStatus.value = status;
  flushSync();
}

describe("the index section's close", () => {
  test("hides a reindex run through its file changes and returns with the next run", () => {
    setIndex({ state: "reindexing", file: "notes/a.md" } as IndexStatus);
    mountBar();
    close("hide indexing status");
    expect(shown("open indexing dashboard")).toBe(false);

    setIndex({ state: "reindexing", file: "notes/b.md" } as IndexStatus);
    expect(shown("open indexing dashboard"), "the same run stays hidden").toBe(false);

    setIndex({ state: "idle" } as IndexStatus);
    setIndex({ state: "reindexing", file: "notes/c.md" } as IndexStatus);
    expect(shown("open indexing dashboard"), "the next run shows").toBe(true);
  });

  test("returns when the index moves to another state", () => {
    setIndex({ state: "reindexing", file: "notes/a.md" } as IndexStatus);
    mountBar();
    close("hide indexing status");
    setIndex({ state: "building", current: 1, total: 9, file: "notes/a.md" } as IndexStatus);
    expect(shown("open indexing dashboard")).toBe(true);
  });

  test("hides an error until a different error arrives", () => {
    setIndex({ state: "error", message: "boom" } as IndexStatus);
    mountBar();
    close("hide indexing status");
    setIndex({ state: "error", message: "boom" } as IndexStatus);
    expect(shown("open indexing dashboard"), "the same error stays hidden").toBe(false);
    setIndex({ state: "error", message: "disk full" } as IndexStatus);
    expect(shown("open indexing dashboard")).toBe(true);
  });
});

test("the import section hides until another import starts", () => {
  importStatus.value = { label: "importing contacts from Google..." };
  mountBar();
  close("hide import status");
  expect(shown("import status")).toBe(false);
  importStatus.value = null;
  flushSync();
  importStatus.value = { label: "importing contacts from Google..." };
  flushSync();
  expect(shown("import status")).toBe(true);
});

test("the transfers launcher hides through progress and returns with a new transfer", () => {
  const first = beginTransfer({ kind: "upload", filename: "a.bin", cancel: null });
  mountBar();
  close("hide file transfers");
  expect(shown("show file transfers")).toBe(false);

  setTransferProgress(first, 0.5);
  flushSync();
  expect(shown("show file transfers"), "progress is not new content").toBe(false);

  beginTransfer({ kind: "upload", filename: "b.bin", cancel: null });
  flushSync();
  expect(shown("show file transfers")).toBe(true);
});

test("workspace warnings hide until a new warning arrives", () => {
  const warning = (path: string): WorkspaceWarning => ({ kind: "broken_draft", path, message: "unreadable" });
  workspaceWarningsDialog.warnings = [warning("a")];
  ui.status = "Workspace warnings";
  ui.statusAction = { kind: "workspace-warnings", label: "Workspace warnings" };
  mountBar();
  close("hide workspace warnings");
  expect(shown("open workspace warnings")).toBe(false);

  workspaceWarningsDialog.warnings = [warning("a"), warning("b")];
  flushSync();
  expect(shown("open workspace warnings")).toBe(true);
});

test("hidden workspace warnings stay hidden when they re-assert after a confirmation", () => {
  const warning: WorkspaceWarning = { kind: "broken_draft", path: "a", message: "unreadable" };
  const assertWarnings = (): void => {
    ui.status = "Workspace warnings";
    ui.statusKind = "persistent";
    ui.statusAction = { kind: "workspace-warnings", label: "Workspace warnings" };
    flushSync();
  };
  workspaceWarningsDialog.warnings = [warning];
  assertWarnings();
  mountBar();
  close("hide workspace warnings");

  ui.status = "Copied path";
  ui.statusKind = "transient";
  ui.statusAction = null;
  flushSync();
  assertWarnings();
  expect(shown("open workspace warnings"), "the same warnings stay hidden").toBe(false);
});

test("the session role badge hides until the roster changes", () => {
  const participant = (role: "leader" | "follower", window_id: string): SessionParticipant =>
    ({ window_id, name: null, role, status: "live" });
  sessionState.participants = [participant("leader", sessionWindowId()), participant("follower", "remote-1")];
  mountBar();
  close("hide session role");
  expect(shown("session role")).toBe(false);

  sessionState.participants = [...sessionState.participants, participant("follower", "remote-2")];
  flushSync();
  expect(shown("session role"), "a new arrival shows the badge").toBe(true);
});

test("Hybrid Nav offers no close", () => {
  paneMode.active = true;
  mountBar();
  expect(shown("Hybrid Nav active")).toBe(true);
  expect(target.querySelector('[aria-label="Hybrid Nav active"] button')).toBeNull();
  expect(target.querySelectorAll(".section-close")).toHaveLength(0);
});

test("the bar leaves, chevron included, once every showing section is closed", () => {
  setIndex({ state: "reindexing", file: "notes/a.md" } as IndexStatus);
  beginTransfer({ kind: "upload", filename: "a.bin", cancel: null });
  mountBar();
  close("hide indexing status");
  expect(target.querySelector(".app-statusbar"), "one section still shows").not.toBeNull();
  close("hide file transfers");
  expect(target.querySelector(".app-statusbar")).toBeNull();
});

test("a close keeps its neighbours' separators consistent", () => {
  setIndex({ state: "reindexing", file: "notes/a.md" } as IndexStatus);
  beginTransfer({ kind: "upload", filename: "a.bin", cancel: null });
  paneMode.active = true;
  mountBar();
  close("hide file transfers");
  const row = target.querySelector(".row")!;
  const kinds = [...row.children].map((child) => (child.classList.contains("sep") ? "sep" : "section"));
  expect(kinds).toEqual(["section", "sep", "section"]);
});
