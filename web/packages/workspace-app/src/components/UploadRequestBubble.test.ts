// @vitest-environment jsdom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import TransferBubble from "./TransferBubble.svelte";
import PasteRequestBubble from "./PasteRequestBubble.svelte";
import { onWatchEvent } from "../state/store.svelte";
import { pasteRequestState } from "../state/pasteRequest.svelte";
import { transfers, activeTransferCount } from "../state/transfers.svelte";

const mounted: Record<string, unknown>[] = [];

beforeEach(() => {
  transfers.items = [];
  transfers.shown = true;
  window.history.replaceState(null, "", "/?w=window-a");
  vi.stubGlobal("navigator", Object.create(navigator, { userActivation: { value: { isActive: false } } }));
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
  mounted.push(mount(TransferBubble, { target: document.body }));
  mounted.push(mount(PasteRequestBubble, { target: document.body }));
  flushSync();
});

afterEach(() => {
  pasteRequestState.card = null;
  flushSync();
  for (const app of mounted.splice(0)) unmount(app);
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function requestUpload(): void {
  onWatchEvent({ type: "window_command", window_id: "window-a", command: "upload", path: "notes", root: "workspace" });
  flushSync();
}

function uploadSurface(): HTMLElement | null {
  return document.querySelector('[aria-label="Upload request"]');
}

test("a pending command renders and focuses the shown panel with zero byte transfers", () => {
  requestUpload();
  const surface = uploadSurface();
  expect(surface, "the waiting request must make an empty Transfers panel visible").not.toBeNull();
  expect(surface!.textContent).toContain("Waiting for file selection");
  expect(surface!.textContent).toContain("notes");
  expect(surface!.contains(document.activeElement)).toBe(true);
  expect(activeTransferCount()).toBe(0);
  expect(transfers.items).toEqual([]);
});

test.each(["paste first", "upload first"])("paste and upload stay reachable, with one keyboard owner: %s", (order) => {
  const paste = () => {
    pasteRequestState.card = { requestId: "paste-1", prefer: "text" as never, busy: false };
    flushSync();
  };
  if (order === "paste first") { paste(); requestUpload(); }
  else { requestUpload(); paste(); }
  const upload = uploadSurface();
  expect(upload, "an upload must remain actionable beside a live paste card").not.toBeNull();
  const pasteCard = document.querySelector<HTMLElement>('[aria-label="Paste request"]')!;
  expect(pasteCard).not.toBeNull();
  expect((order === "paste first" ? upload! : pasteCard).contains(document.activeElement)).toBe(true);
  const choose = [...upload!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Choose files")!;
  expect(choose).toBeDefined();
  choose.focus();
  choose.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  expect(HTMLInputElement.prototype.click).toHaveBeenCalledTimes(1);
  expect(pasteRequestState.card?.requestId).toBe("paste-1");
});
