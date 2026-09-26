// @vitest-environment jsdom
//
// ConfirmModal, mounted and opened through uiConfirm: what each button, key
// and click resolves, and where focus sits while it is open.

import { afterEach, describe, expect, test } from "vitest";

import ConfirmModal from "./ConfirmModal.svelte";
import { resolveConfirm, uiConfirm } from "../state/confirm.svelte";
import {
  clickBackdrop,
  dialogIn,
  dialogName,
  mountDialog,
  press,
  recordDocumentKeys,
  settle,
  unmountDialogs,
} from "../__tests__/dialog";

function button(target: HTMLElement, label: string): HTMLButtonElement {
  const found = [...target.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`no button labelled ${label}`);
  return found;
}

/// Open the dialog. The answer rides back inside an object so the caller's
/// `await` does not block on the open dialog.
async function open(target: HTMLElement): Promise<{ answer: Promise<boolean> }> {
  const answer = uiConfirm({
    title: "Delete notes.md?",
    message: "It moves to the trash.",
    confirmLabel: "Delete",
    cancelLabel: "Keep",
  });
  await settle();
  expect(dialogIn(target), "the confirm is open").not.toBeNull();
  return { answer };
}

afterEach(() => {
  resolveConfirm(false);
  unmountDialogs();
});

describe("ConfirmModal", () => {
  test("renders nothing until a confirm is asked", () => {
    const target = mountDialog(ConfirmModal);
    expect(dialogIn(target)).toBeNull();
  });

  test("shows the title, the message and both labels, with the confirm button focused", async () => {
    const target = mountDialog(ConfirmModal);
    await open(target);
    const dialog = dialogIn(target)!;
    expect(dialog.textContent).toContain("Delete notes.md?");
    expect(dialog.textContent).toContain("It moves to the trash.");
    expect(document.activeElement).toBe(button(target, "Delete"));
    expect(button(target, "Keep")).toBeTruthy();
  });

  test("is a modal dialog named by its title", async () => {
    const target = mountDialog(ConfirmModal);
    await open(target);
    const dialog = dialogIn(target)!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialogName(dialog)).toBe("Delete notes.md?");
  });

  test("the confirm button answers true and the cancel button false", async () => {
    const target = mountDialog(ConfirmModal);
    let { answer } = await open(target);
    button(target, "Delete").click();
    await expect(answer).resolves.toBe(true);
    await settle();
    expect(dialogIn(target)).toBeNull();

    ({ answer } = await open(target));
    button(target, "Keep").click();
    await expect(answer).resolves.toBe(false);
  });

  test("Enter confirms and Escape cancels", async () => {
    const target = mountDialog(ConfirmModal);
    let { answer } = await open(target);
    const enter = press(document.activeElement!, "Enter");
    await expect(answer).resolves.toBe(true);
    expect(enter.defaultPrevented).toBe(true);

    ({ answer } = await open(target));
    const escape = press(document.activeElement!, "Escape");
    await expect(answer).resolves.toBe(false);
    expect(escape.defaultPrevented).toBe(true);
  });

  test("the Escape that cancels goes no further than the dialog", async () => {
    const target = mountDialog(ConfirmModal);
    const { answer } = await open(target);
    const reached = recordDocumentKeys();
    press(document.activeElement!, "Escape");
    reached.stop();
    await expect(answer).resolves.toBe(false);
    expect(reached.keys, "keys that reached the document").toEqual([]);
  });

  test("a click on the backdrop cancels and a click inside the panel does not", async () => {
    const target = mountDialog(ConfirmModal);
    const { answer } = await open(target);
    let settled = false;
    void answer.then(() => (settled = true));

    dialogIn(target)!.querySelector<HTMLElement>(".message")!.click();
    await settle();
    expect(settled, "a click inside the panel leaves the confirm open").toBe(false);
    expect(dialogIn(target)).not.toBeNull();

    clickBackdrop(target);
    await expect(answer).resolves.toBe(false);
  });
});
