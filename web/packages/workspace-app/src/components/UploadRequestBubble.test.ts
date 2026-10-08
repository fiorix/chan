// @vitest-environment jsdom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import TransferBubble from "./TransferBubble.svelte";
import PasteRequestBubble from "./PasteRequestBubble.svelte";
import UploadRequestBubble from "./UploadRequestBubble.svelte";
import SessionHandoverBubble from "./SessionHandoverBubble.svelte";
import { api } from "../api/client";
import { sessionState } from "../state/session.svelte";
import { disposeUploadRequests, uploadRequestState, cancelUploadRequest } from "../state/uploadRequest.svelte";
import { fileOps, onWatchEvent } from "../state/store.svelte";
import { pasteRequestState } from "../state/pasteRequest.svelte";
import { transfers, activeTransferCount } from "../state/transfers.svelte";

const mounted: Record<string, unknown>[] = [];
const originalActivation = Object.getOwnPropertyDescriptor(navigator, "userActivation");

beforeEach(() => {
  disposeUploadRequests();
  transfers.items = [];
  transfers.shown = true;
  window.history.replaceState(null, "", "/?w=window-a");
  Object.defineProperty(navigator, "userActivation", { configurable: true, value: { isActive: false } });
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
  mounted.push(mount(TransferBubble, { target: document.body }));
  mounted.push(mount(PasteRequestBubble, { target: document.body }));
  mounted.push(mount(UploadRequestBubble, { target: document.body }));
  mounted.push(mount(SessionHandoverBubble, { target: document.body }));
  vi.spyOn(api, "windowReply").mockResolvedValue();
  flushSync();
});

afterEach(() => {
  disposeUploadRequests();
  sessionState.handover = null;
  pasteRequestState.card = null;
  flushSync();
  for (const app of mounted.splice(0)) unmount(app);
  document.body.replaceChildren();
  vi.restoreAllMocks();
  if (originalActivation) Object.defineProperty(navigator, "userActivation", originalActivation);
  else Reflect.deleteProperty(navigator, "userActivation");
});

function requestUpload(): void {
  onWatchEvent({ type: "window_command", window_id: "window-a", command: "upload", path: "notes", root: "workspace" });
  flushSync();
}

function uploadSurface(): HTMLElement | null {
  return document.querySelector('[aria-label="Upload request"]');
}

function press(key: string): void {
  document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  flushSync();
}

function terminal(): HTMLTextAreaElement {
  const input = document.body.appendChild(document.createElement("textarea"));
  input.focus();
  return input;
}

test.each(["cancel", "selection"])("a hidden panel gives the card focus and restores it after chooser %s", (ending) => {
  transfers.shown = false;
  const previous = terminal();
  requestUpload();
  expect(document.querySelector(".transfer-bubble")).toBeNull();
  expect(document.querySelectorAll('[aria-label="Upload request"]')).toHaveLength(1);
  expect(uploadSurface()!.contains(document.activeElement)).toBe(true);
  press("Enter");
  expect(HTMLInputElement.prototype.click).toHaveBeenCalledTimes(1);
  expect(uploadRequestState.pending).toBeNull();
  const input = document.querySelector('input[type="file"]')!;
  const upload = vi.spyOn(fileOps, "uploadFilesTo").mockResolvedValue();
  if (ending === "selection") {
    const file = new File(["chosen"], "chosen.txt");
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));
    expect(upload).toHaveBeenCalledExactlyOnceWith("notes", [file], "workspace");
  } else {
    input.dispatchEvent(new Event("cancel"));
    expect(upload).not.toHaveBeenCalled();
  }
  flushSync();
  expect(document.activeElement).toBe(previous);
});

test("card and panel exchange the focused surface without changing its return target", () => {
  transfers.shown = false;
  const previous = terminal();
  requestUpload();
  for (const shown of [true, false, true]) {
    transfers.shown = shown;
    flushSync();
    expect(document.querySelectorAll('[aria-label="Upload request"]')).toHaveLength(1);
    expect(uploadSurface()!.contains(document.activeElement)).toBe(true);
  }
  press("Escape");
  expect(uploadRequestState.pending).toBeNull();
  expect(document.activeElement).toBe(previous);
});

test("surface switches and dismissal respect the user's move to another card", () => {
  transfers.shown = false;
  requestUpload();
  pasteRequestState.card = { requestId: "paste-other", prefer: "text" as never, busy: false };
  flushSync();
  const paste = document.activeElement;
  for (const shown of [true, false]) {
    transfers.shown = shown;
    flushSync();
    expect(document.activeElement).toBe(paste);
  }
  cancelUploadRequest(uploadRequestState.pending!.id);
  flushSync();
  expect(document.activeElement).toBe(paste);
});

test("Escape answers only the focused paste card and leaves the upload request waiting", async () => {
  requestUpload();
  pasteRequestState.card = { requestId: "paste-cancel", prefer: "text" as never, busy: false };
  flushSync();
  press("Escape");
  await Promise.resolve();
  flushSync();
  expect(api.windowReply).toHaveBeenCalledWith({ requestId: "paste-cancel", payload: { error: "paste cancelled in the window" } });
  expect(uploadRequestState.pending?.path).toBe("notes");
  expect(HTMLInputElement.prototype.click).not.toHaveBeenCalled();
});

test("removing the remembered paste card still restores its terminal after upload cancellation", () => {
  transfers.shown = false;
  const previous = terminal();
  pasteRequestState.card = { requestId: "paste-gone", prefer: "text" as never, busy: false };
  flushSync();
  requestUpload();
  pasteRequestState.card = null;
  flushSync();
  expect(uploadSurface()!.contains(document.activeElement)).toBe(true);
  press("Escape");
  expect(document.activeElement).toBe(previous);
});

test("an upload can take focus beside a handover without answering the handover", () => {
  sessionState.handover = { requestId: "handover", fromWindowId: "other", fromName: "Other", busy: false };
  flushSync();
  const previous = document.activeElement;
  requestUpload();
  expect(document.querySelector('[aria-label="Handover request"]')).not.toBeNull();
  expect(uploadSurface()!.contains(document.activeElement)).toBe(true);
  press("Escape");
  expect(sessionState.handover?.requestId).toBe("handover");
  expect(document.activeElement).toBe(previous);
});

test("replacement dispositions survive cancellation and can be dismissed individually", () => {
  requestUpload();
  requestUpload();
  expect(document.querySelectorAll(".tb-request-disposition")).toHaveLength(1);
  cancelUploadRequest(uploadRequestState.pending!.id);
  flushSync();
  expect(document.querySelector(".transfer-bubble")).not.toBeNull();
  const dismiss = document.querySelector<HTMLButtonElement>(".tb-request-disposition button")!;
  dismiss.click();
  flushSync();
  expect(document.querySelector(".transfer-bubble")).toBeNull();
});

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
