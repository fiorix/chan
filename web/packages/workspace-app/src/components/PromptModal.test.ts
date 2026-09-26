// @vitest-environment jsdom
//
// PromptModal, mounted and opened through uiPrompt: the default value it
// offers, and what each button, key and click resolves.

import { afterEach, describe, expect, test } from "vitest";

import PromptModal from "./PromptModal.svelte";
import { resolvePrompt, uiPrompt } from "../state/store.svelte";
import {
  clickBackdrop,
  dialogIn,
  dialogName,
  focusOrigin,
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

function input(target: HTMLElement): HTMLInputElement {
  return dialogIn(target)!.querySelector("input")!;
}

/// Open the dialog. The answer rides back inside an object so the caller's
/// `await` does not block on the open dialog.
async function open(target: HTMLElement): Promise<{ answer: Promise<string | null> }> {
  const answer = uiPrompt("Rename", "old.md");
  await settle();
  expect(dialogIn(target), "the prompt is open").not.toBeNull();
  return { answer };
}

async function type(target: HTMLElement, text: string): Promise<void> {
  input(target).value = text;
  input(target).dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}

afterEach(() => {
  resolvePrompt(null);
  unmountDialogs();
});

describe("PromptModal", () => {
  test("renders nothing until a prompt is asked", () => {
    const target = mountDialog(PromptModal);
    expect(dialogIn(target)).toBeNull();
  });

  test("offers the default value selected in a focused input", async () => {
    const target = mountDialog(PromptModal);
    await open(target);
    expect(dialogIn(target)!.textContent).toContain("Rename");
    expect(input(target).value).toBe("old.md");
    expect(document.activeElement).toBe(input(target));
    expect([input(target).selectionStart, input(target).selectionEnd]).toEqual([0, 6]);
  });

  test("is a modal dialog named by its title", async () => {
    const target = mountDialog(PromptModal);
    await open(target);
    const dialog = dialogIn(target)!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialogName(dialog)).toBe("Rename");
  });

  test("OK answers the typed value and Cancel answers null", async () => {
    const target = mountDialog(PromptModal);
    let { answer } = await open(target);
    await type(target, "new.md");
    button(target, "OK").click();
    await expect(answer).resolves.toBe("new.md");
    await settle();
    expect(dialogIn(target)).toBeNull();

    ({ answer } = await open(target));
    button(target, "Cancel").click();
    await expect(answer).resolves.toBeNull();
  });

  test("Enter in the input answers the typed value and Escape answers null", async () => {
    const target = mountDialog(PromptModal);
    let { answer } = await open(target);
    await type(target, "new.md");
    const enter = press(input(target), "Enter");
    await expect(answer).resolves.toBe("new.md");
    expect(enter.defaultPrevented).toBe(true);

    ({ answer } = await open(target));
    const escape = press(input(target), "Escape");
    await expect(answer).resolves.toBeNull();
    expect(escape.defaultPrevented).toBe(true);
  });

  test("Escape anywhere in the dialog cancels it and goes no further", async () => {
    const target = mountDialog(PromptModal);
    const { answer } = await open(target);
    let answered: string | null | undefined;
    void answer.then((v) => (answered = v));
    const reached = recordDocumentKeys();
    press(button(target, "Cancel"), "Escape");
    reached.stop();
    await settle();
    expect(answered, "Escape on the Cancel button answers null").toBeNull();
    expect(reached.keys, "keys that reached the document").toEqual([]);
  });

  test("closing returns focus to where it was when the prompt opened", async () => {
    const target = mountDialog(PromptModal);
    const origin = focusOrigin();
    const { answer } = await open(target);
    button(target, "Cancel").click();
    await answer;
    await settle();
    expect(document.activeElement).toBe(origin);
  });

  test("a click on the backdrop cancels and a click inside the panel does not", async () => {
    const target = mountDialog(PromptModal);
    const { answer } = await open(target);
    let settled = false;
    void answer.then(() => (settled = true));

    input(target).click();
    await settle();
    expect(settled, "a click inside the panel leaves the prompt open").toBe(false);
    expect(dialogIn(target)).not.toBeNull();

    clickBackdrop(target);
    await expect(answer).resolves.toBeNull();
  });
});
