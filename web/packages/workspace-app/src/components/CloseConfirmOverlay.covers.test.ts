// @vitest-environment jsdom
//
// The close prompt paints over the reconnect and session-ended covers, and
// so it holds the keyboard over them: raised over either cover it takes the
// keyboard onto Cancel, Escape cancels it and Tab cycles its buttons, and a
// key lands on the prompt rather than on the cover's own button beneath it.
// When the screen lock over both lifts, Cancel has the keyboard again. The
// real covers, lock and prompt, in jsdom.

import { mount, tick, unmount, type Component } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import CloseConfirmOverlay from "./CloseConfirmOverlay.svelte";
import DisconnectOverlay from "./DisconnectOverlay.svelte";
import ScreensaverOverlay from "./ScreensaverOverlay.svelte";
import SessionEndedOverlay from "./SessionEndedOverlay.svelte";
import { recordingContext2d } from "../__tests__/canvas";
import type { WsStatus } from "../api/client";
import { demoWorkspaceInfo } from "../demo/data";
import { closeConfirmState, resolveCloseConfirm, uiCloseConfirm } from "../state/closeConfirm.svelte";
import { resetConnectionHealthForTests, setConnectionWatchStatus, watchConnectionProbe } from "../state/connectionHealth.svelte";
import { screensaver } from "../state/screensaver.svelte";
import { raisedCoverKeys, ui, workspace } from "../state/store.svelte";
import { __resetWindowLifecycle, markWindowHidden } from "../state/windowLifecycle.svelte";

const mounted: Array<Record<string, unknown>> = [];

function watchStatus(status: WsStatus): void {
  ui.ws = status;
  setConnectionWatchStatus(status);
  if (status === "open") {
    watchConnectionProbe.pingSent();
    watchConnectionProbe.frameReceived();
    watchConnectionProbe.pongReceived();
  }
}

/// A surface mounted in a layer of its own. jsdom applies no component
/// stylesheet, so the layer its stylesheet sets is put on its mount.
function layered(component: Component, zIndex: number): HTMLElement {
  const target = document.body.appendChild(document.createElement("div"));
  target.style.position = "fixed";
  target.style.zIndex = String(zIndex);
  mounted.push(mount(component, { target }) as Record<string, unknown>);
  return target;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  resetConnectionHealthForTests();
  watchStatus("open");
  ui.wsAttempt = 0;
});

afterEach(async () => {
  screensaver.locked = false;
  resolveCloseConfirm("cancel");
  for (const view of mounted.splice(0)) unmount(view);
  await settle();
  __resetWindowLifecycle();
  resetConnectionHealthForTests();
  ui.ws = "connecting";
  ui.wsAttempt = 0;
  ui.disconnectBlocking = false;
  document.body.replaceChildren();
  workspace.info = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function reconnectCover(): Promise<HTMLElement> {
  const target = layered(DisconnectOverlay, 30000);
  await tick();
  watchStatus("reconnecting");
  await tick();
  vi.advanceTimersByTime(600);
  await settle();
  return target;
}

async function sessionEndedCover(): Promise<HTMLElement> {
  const target = layered(SessionEndedOverlay, 30001);
  markWindowHidden();
  await settle();
  return target;
}

test.each([
  ["reconnect", reconnectCover],
  ["session-ended", sessionEndedCover],
] as const)("the close prompt raised over the %s cover holds the keyboard", async (cover, raise) => {
  const coverTarget = await raise();
  expect(raisedCoverKeys(), "the cover is up").toContain(cover);
  const prompt = layered(CloseConfirmOverlay, 30002);
  const answer = uiCloseConfirm();
  await settle();
  const cancel = prompt.querySelector<HTMLButtonElement>("button.cancel")!;
  expect(document.activeElement, "Cancel takes the keyboard").toBe(cancel);
  expect(coverTarget.contains(document.activeElement), "a key lands on the prompt, not on the cover beneath").toBe(false);

  cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  expect(document.activeElement, "Tab wraps to the first button").toBe(prompt.querySelector("button.hide"));
  (document.activeElement as HTMLElement).dispatchEvent(
    new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
  );
  expect(document.activeElement, "Shift+Tab wraps back to Cancel").toBe(cancel);

  cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await expect(answer, "Escape cancels").resolves.toBe("cancel");
  expect(closeConfirmState.open).toBe(false);
});

/// The close prompt raised over a cover that is already up, with Cancel
/// holding the keyboard.
async function promptOver(): Promise<{ prompt: HTMLElement; cancel: HTMLButtonElement }> {
  const prompt = layered(CloseConfirmOverlay, 30002);
  void uiCloseConfirm();
  await settle();
  const cancel = prompt.querySelector<HTMLButtonElement>("button.cancel")!;
  expect(document.activeElement, "Cancel takes the keyboard").toBe(cancel);
  return { prompt, cancel };
}

test("the close prompt over the reconnect cover takes Cancel back when the screen lock over both lifts", async () => {
  // The lock's rain draws on a canvas and asks about reduced motion and fonts.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    recordingContext2d().ctx as unknown as RenderingContext,
  );
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: true,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  Object.defineProperty(document, "fonts", { configurable: true, value: { load: vi.fn(async () => []) } });
  workspace.info = demoWorkspaceInfo({
    metadata: { workspaceRoot: "/ws", label: "ws", generatedAt: 1, fileCount: 0, textCount: 0 },
    files: [],
  });
  Object.assign(screensaver, { enabled: true, timeout_secs: 300, theme: "plain", pin_set: true, locked: false, loaded: true });
  await reconnectCover();
  const { cancel } = await promptOver();
  layered(ScreensaverOverlay, 39000);
  screensaver.locked = true;
  await settle();
  expect(document.activeElement, "the lock takes the keyboard").toBe(document.querySelector(".screensaver-backdrop"));
  screensaver.locked = false;
  await settle();
  expect(raisedCoverKeys(), "the reconnect cover is still up").toEqual(["reconnect"]);
  expect(document.activeElement, "Cancel once the lock lifts").toBe(cancel);
});
