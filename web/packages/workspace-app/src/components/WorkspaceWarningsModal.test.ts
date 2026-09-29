// @vitest-environment jsdom
//
// The workspace warnings list is a modal dialog: Tab stays inside it, and
// focus goes back to where it was when it closes.

import { afterEach, describe, expect, test } from "vitest";

import WorkspaceWarningsModal from "./WorkspaceWarningsModal.svelte";
import { closeWorkspaceWarningsDialog, openWorkspaceWarningsDialog, workspaceWarningsDialog } from "../state/store.svelte";
import { dialogIn, focusOrigin, mountDialog, press, settle, unmountDialogs } from "../__tests__/dialog";

afterEach(() => {
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
