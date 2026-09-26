// @vitest-environment jsdom
//
// ConflictModal, mounted over an open conflictDialog: the path it names, the
// state action each button runs, and which clicks dismiss it.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../state/tabs.svelte", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/tabs.svelte")>();
  return {
    ...actual,
    reloadConflictedTab: vi.fn(async () => {}),
    overwriteConflictedTab: vi.fn(async () => {}),
  };
});

import ConflictModal from "./ConflictModal.svelte";
import {
  conflictDialog,
  dismissConflict,
  overwriteConflictedTab,
  reloadConflictedTab,
} from "../state/tabs.svelte";
import {
  clickBackdrop,
  dialogIn,
  dialogName,
  mountDialog,
  settle,
  unmountDialogs,
} from "../__tests__/dialog";

function button(target: HTMLElement, label: string): HTMLButtonElement {
  const found = [...target.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`no button labelled ${label}`);
  return found;
}

async function open(target: HTMLElement): Promise<void> {
  conflictDialog.open = true;
  conflictDialog.tabId = "tab-1";
  conflictDialog.path = "notes/today.md";
  await settle();
  expect(dialogIn(target), "the conflict dialog is open").not.toBeNull();
}

beforeEach(() => {
  vi.mocked(reloadConflictedTab).mockClear();
  vi.mocked(overwriteConflictedTab).mockClear();
});

afterEach(() => {
  dismissConflict();
  unmountDialogs();
});

describe("ConflictModal", () => {
  test("renders nothing while no conflict is open", () => {
    const target = mountDialog(ConflictModal);
    expect(dialogIn(target)).toBeNull();
  });

  test("names the conflicted path", async () => {
    const target = mountDialog(ConflictModal);
    await open(target);
    expect(dialogIn(target)!.querySelector("code")!.textContent).toBe("notes/today.md");
  });

  test("is a modal dialog named by its title", async () => {
    const target = mountDialog(ConflictModal);
    await open(target);
    const dialog = dialogIn(target)!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialogName(dialog)).toBe("External edit detected");
  });

  test("Reload and Overwrite run their state actions and Cancel dismisses", async () => {
    const target = mountDialog(ConflictModal);
    await open(target);
    button(target, "Reload").click();
    expect(reloadConflictedTab).toHaveBeenCalledTimes(1);
    button(target, "Overwrite").click();
    expect(overwriteConflictedTab).toHaveBeenCalledTimes(1);

    button(target, "Cancel").click();
    await settle();
    expect(conflictDialog.open).toBe(false);
    expect(dialogIn(target)).toBeNull();
  });

  test("a click on the backdrop dismisses and a click inside the panel does not", async () => {
    const target = mountDialog(ConflictModal);
    await open(target);

    dialogIn(target)!.querySelector("code")!.click();
    await settle();
    expect(conflictDialog.open, "a click inside the panel leaves the dialog open").toBe(true);

    clickBackdrop(target);
    await settle();
    expect(conflictDialog.open).toBe(false);
    expect(dialogIn(target)).toBeNull();
  });
});
