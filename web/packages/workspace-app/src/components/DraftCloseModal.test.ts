// @vitest-environment jsdom
//
// Closing a draft asks where to save it in a modal dialog: its path field
// takes focus as it opens, Tab stays inside, and focus goes back to where it
// was when the dialog closes.

import { afterEach, describe, expect, test } from "vitest";

import DraftCloseModal from "./DraftCloseModal.svelte";
import { draftCloseState } from "../state/tabs.svelte";
import { dialogIn, focusOrigin, mountDialog, press, settle, unmountDialogs } from "../__tests__/dialog";

afterEach(() => {
  draftCloseState.open = false;
  draftCloseState.resolve = null;
  unmountDialogs();
});

async function openDraftClose(): Promise<HTMLElement> {
  const target = mountDialog(DraftCloseModal);
  Object.assign(draftCloseState, {
    path: ".Drafts/note.md",
    name: "note",
    target: "notes/note.md",
    targetKind: "file",
    hasAttachments: false,
    error: null,
    resolve: () => {},
    open: true,
  });
  await settle();
  return target;
}

function buttons(dialog: HTMLElement): HTMLButtonElement[] {
  return [...dialog.querySelectorAll<HTMLButtonElement>("button")];
}

describe("the draft close dialog", () => {
  test("puts focus in its path field as it opens", async () => {
    const dialog = dialogIn(await openDraftClose())!;
    expect(document.activeElement).toBe(dialog.querySelector("input"));
  });

  test("keeps Tab inside: past the last control it wraps to the first", async () => {
    const dialog = dialogIn(await openDraftClose())!;
    const last = buttons(dialog).at(-1)!;
    last.focus();
    press(last, "Tab");
    expect(document.activeElement).toBe(dialog.querySelector("input"));
  });

  test("hands focus back to where it was when it closes", async () => {
    const origin = focusOrigin();
    const target = await openDraftClose();
    buttons(dialogIn(target)!).find((b) => b.textContent?.trim() === "Cancel")!.click();
    await settle();
    expect(dialogIn(target), "Cancel closes it").toBeNull();
    expect(document.activeElement).toBe(origin);
  });
});
