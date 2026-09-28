// @vitest-environment jsdom
//
// The contacts import wizard is a modal dialog over the window: named by its
// title, keeping Tab inside, and handing focus back when it closes.

import { afterEach, describe, expect, test } from "vitest";

import ImportContactsModal from "./ImportContactsModal.svelte";
import { importContactsPanel } from "../state/store.svelte";
import { dialogIn, dialogName, focusOrigin, mountDialog, press, settle, unmountDialogs } from "../__tests__/dialog";

afterEach(() => {
  importContactsPanel.open = false;
  unmountDialogs();
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
