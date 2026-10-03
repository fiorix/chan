// @vitest-environment jsdom
//
// The contacts import wizard is a modal dialog over the window: named by its
// title, keeping Tab inside, and handing focus back when it closes.

import { afterEach, describe, expect, test, vi } from "vitest";

import ImportContactsModal from "./ImportContactsModal.svelte";
import { api } from "../api/client";
import { importContactsPanel } from "../state/store.svelte";
import { dialogIn, dialogName, focusOrigin, mountDialog, press, settle, unmountDialogs } from "../__tests__/dialog";

afterEach(() => {
  importContactsPanel.open = false;
  unmountDialogs();
  vi.restoreAllMocks();
});

async function openWizard(): Promise<HTMLElement> {
  const target = mountDialog(ImportContactsModal, {
    get open() {
      return importContactsPanel.open;
    },
    onClose: () => {
      importContactsPanel.open = false;
    },
  });
  importContactsPanel.open = true;
  await settle();
  return target;
}

function tabStops(dialog: HTMLElement): HTMLElement[] {
  return [
    ...dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]):not([tabindex="-1"]), input:not([type="hidden"]):not([tabindex="-1"]), select, textarea',
    ),
  ];
}

describe("the contacts import wizard", () => {
  test("recovers focus when Next disables itself and when a completed import removes its button", async () => {
    vi.spyOn(api, "list").mockResolvedValue([]);
    vi.spyOn(api, "importContacts").mockResolvedValue({ wrote: [], overwrote: [], skipped: [], failed: [], warnings: [] });
    const target = await openWizard();
    const dialog = dialogIn(target)!;
    const next = dialog.querySelector<HTMLButtonElement>(".ok")!;
    next.focus(); next.click(); await settle();
    expect(next.disabled, "file step disables Next").toBe(true);
    expect(document.activeElement, "wizard disabled focus repair").toBe(dialog);
    const file = dialog.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(file, "files", { value: [new File(["Name\nA"], "contacts.csv", { type: "text/csv" })] });
    file.dispatchEvent(new Event("change", { bubbles: true })); await settle();
    next.click(); await settle(); next.click(); await settle();
    const run = dialog.querySelector<HTMLButtonElement>(".ok")!;
    expect(run.textContent?.trim()).toBe("Import");
    run.focus(); run.click(); await settle();
    expect(run.isConnected, "done step removes Import").toBe(false);
    expect(document.activeElement, "wizard removed focus repair").toBe(dialog);
    press(document.activeElement!, "Escape"); await settle();
    expect(dialogIn(target)).toBeNull();
  });

  test("is a modal dialog named by its title", async () => {
    const dialog = dialogIn(await openWizard())!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialogName(dialog)).toBe("Import contacts");
  });

  test("keeps Tab inside: past the last control it wraps to the first", async () => {
    const dialog = dialogIn(await openWizard())!;
    const stops = tabStops(dialog);
    stops.at(-1)!.focus();
    press(stops.at(-1)!, "Tab");
    expect(document.activeElement).toBe(stops[0]);
  });

  test("hands focus back to where it was when it closes", async () => {
    const origin = focusOrigin();
    const target = await openWizard();
    // The user is on a control of the wizard when it closes.
    const control = tabStops(dialogIn(target)!)[0]!;
    control.focus();
    press(control, "Escape");
    await settle();
    expect(dialogIn(target), "Escape closes it").toBeNull();
    expect(document.activeElement).toBe(origin);
  });
});
