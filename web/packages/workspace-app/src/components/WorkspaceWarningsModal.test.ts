// @vitest-environment jsdom
//
// The workspace warnings list is a modal dialog: Tab stays inside it, and
// focus goes back to where it was when it closes. Its rows, the busy row and
// the session's dismissals are told apart by a warning's key: its kind, path
// and message together.

import { afterEach, describe, expect, test } from "vitest";

import WorkspaceWarningsModal from "./WorkspaceWarningsModal.svelte";
import {
  closeWorkspaceWarningsDialog,
  openWorkspaceWarningsDialog,
  workspaceWarningKey,
  workspaceWarningsDialog,
} from "../state/store.svelte";
import { dialogIn, focusOrigin, mountDialog, press, settle, unmountDialogs } from "../__tests__/dialog";

afterEach(() => {
  workspaceWarningsDialog.busyKey = null;
  closeWorkspaceWarningsDialog();
  unmountDialogs();
});

async function openWarnings(): Promise<HTMLElement> {
  const target = mountDialog(WorkspaceWarningsModal);
  workspaceWarningsDialog.warnings = [];
  openWorkspaceWarningsDialog();
  await settle();
  return target;
}

function buttons(dialog: HTMLElement): HTMLButtonElement[] {
  return [...dialog.querySelectorAll<HTMLButtonElement>("button")];
}

describe("the workspace warnings dialog", () => {
  test("a busy warning refuses Escape without passing it to the underlying overlay", async () => {
    const target = await openWarnings();
    workspaceWarningsDialog.busyKey = "busy"; await settle();
    const event = press(document.body, "Escape"); await settle();
    expect(dialogIn(target)).not.toBeNull();
    expect(event.defaultPrevented, "refused close still owns Escape").toBe(true);
  });

  test("keeps Tab inside: past the last control it wraps to the first", async () => {
    const dialog = dialogIn(await openWarnings())!;
    const [first, ...rest] = buttons(dialog);
    const last = rest.at(-1)!;
    last.focus();
    press(last, "Tab");
    expect(document.activeElement).toBe(first);
  });

  test("hands focus back to where it was when it closes", async () => {
    const origin = focusOrigin();
    const target = await openWarnings();
    // The user is on the dialog's OK when it closes.
    const ok = buttons(dialogIn(target)!).find((b) => b.textContent?.trim() === "OK")!;
    ok.focus();
    ok.click();
    await settle();
    expect(dialogIn(target), "OK closes it").toBeNull();
    expect(document.activeElement).toBe(origin);
  });
});

describe("a warning's key", () => {
  const warning = { kind: "broken_draft", path: ".Drafts/untitled-8", message: "unreadable" };

  test("differs for two warnings that differ only in their kind", () => {
    const other = { ...warning, kind: "broken_note" };

    expect(workspaceWarningKey(other)).not.toBe(workspaceWarningKey(warning));
  });

  test("differs for two warnings that differ only in their path", () => {
    const other = { ...warning, path: ".Drafts/untitled-9" };

    expect(workspaceWarningKey(other)).not.toBe(workspaceWarningKey(warning));
  });

  test("differs for two warnings that differ only in their message", () => {
    const other = { ...warning, message: "truncated" };

    expect(workspaceWarningKey(other)).not.toBe(workspaceWarningKey(warning));
  });

  test("is the same for the same warning read twice", () => {
    expect(workspaceWarningKey({ ...warning })).toBe(workspaceWarningKey(warning));
  });
});
