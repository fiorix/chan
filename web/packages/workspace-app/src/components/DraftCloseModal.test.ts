// @vitest-environment jsdom
//
// Closing a draft asks where to save it in a modal dialog: its path field
// takes focus as it opens, Tab stays inside, and focus goes back to where it
// was when the dialog closes. A draft drawing whose unsaved text does not
// parse has nothing to save, so its dialog offers Discard and Cancel alone.

import { afterEach, describe, expect, test, vi } from "vitest";

import DraftCloseModal from "./DraftCloseModal.svelte";
import { api } from "../api/client";
import { closeTab, draftCloseState, resolveDraftClose } from "../state/tabs.svelte";
import { dialogIn, focusOrigin, mountDialog, press, settle, unmountDialogs } from "../__tests__/dialog";
import { fileTab, readTab, resetLayout } from "../__tests__/tabs";

afterEach(() => {
  resolveDraftClose("cancel");
  draftCloseState.open = false;
  draftCloseState.resolve = null;
  vi.restoreAllMocks();
  resetLayout([]);
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

describe("the draft close dialog of a drawing whose unsaved text does not parse", () => {
  const path = ".Drafts/untitled/untitled.excalidraw";
  // What a typo in source mode leaves: a trailing comma.
  const broken = '{ "type": "excalidraw", "elements": [], }';
  const saved = '{ "type": "excalidraw", "elements": [] }';

  function parseReason(): string {
    try {
      JSON.parse(broken);
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error("the buffer parses");
  }

  /// Close the draft through the store with the dialog mounted, and hand back
  /// the open dialog with every request the close can send recorded.
  async function closeBrokenDraft() {
    const target = mountDialog(DraftCloseModal);
    const pane = resetLayout([
      fileTab({ id: "board-1", path, fileKind: "text", mode: "source", content: broken, saved }),
    ]);
    const write = vi.spyOn(api, "write").mockResolvedValue({ mtime: 2, mtime_ns: "2" });
    const discard = vi.spyOn(api, "discardDraft").mockResolvedValue(undefined);
    vi.spyOn(api, "inspectDraft").mockResolvedValue({
      path,
      name: "untitled",
      file_count: 1,
      dir_count: 0,
      total_size: saved.length,
      has_attachments: false,
    });
    const close = closeTab(pane.id, "board-1");
    await vi.waitFor(() => expect(dialogIn(target), "the draft's own dialog opens").not.toBeNull());
    await settle();
    return { dialog: dialogIn(target)!, target, close, write, discard };
  }

  function labels(dialog: HTMLElement): string[] {
    return buttons(dialog).map((b) => b.textContent?.trim() ?? "");
  }

  test("offers Discard and Cancel only, with no path field, and says why", async () => {
    const { dialog, close } = await closeBrokenDraft();

    expect({
      buttons: labels(dialog),
      pathFields: dialog.querySelectorAll("input").length,
      saysWhy: dialog.textContent?.includes(`does not parse (${parseReason()})`),
    }).toEqual({ buttons: ["Discard Draft", "Cancel"], pathFields: 0, saysWhy: true });
    resolveDraftClose("cancel");
    await close;
  });

  test("puts focus on Cancel as it opens", async () => {
    const { dialog, close } = await closeBrokenDraft();

    expect(document.activeElement?.textContent?.trim()).toBe("Cancel");
    expect(dialog.contains(document.activeElement)).toBe(true);
    resolveDraftClose("cancel");
    await close;
  });

  test("its Discard button removes the draft with nothing written first", async () => {
    const { dialog, target, close, write, discard } = await closeBrokenDraft();

    buttons(dialog).find((b) => b.textContent?.trim() === "Discard Draft")!.click();
    await close;
    await settle();

    expect({
      dialogOpen: dialogIn(target) !== null,
      tabOpen: readTab("board-1") !== undefined,
      discarded: discard.mock.calls,
      written: write.mock.calls.length,
    }).toEqual({ dialogOpen: false, tabOpen: false, discarded: [[path]], written: 0 });
  });

  test("its Cancel button keeps the tab and the text as typed", async () => {
    const { dialog, target, close, write, discard } = await closeBrokenDraft();

    buttons(dialog).find((b) => b.textContent?.trim() === "Cancel")!.click();
    await close;
    await settle();

    expect({
      dialogOpen: dialogIn(target) !== null,
      content: readTab("board-1")?.content,
      discarded: discard.mock.calls.length,
      written: write.mock.calls.length,
    }).toEqual({ dialogOpen: false, content: broken, discarded: 0, written: 0 });
  });
});
