// @vitest-environment jsdom
//
// The close prompt paints over the reconnect and session-ended covers, and
// so it holds the keyboard over them: raised over either cover it takes the
// keyboard onto Cancel, Escape cancels it and Tab cycles its buttons, and a
// key lands on the prompt rather than on the cover's own button beneath it.
// Neither cover takes the keyboard back from it, and when the screen lock
// over both lifts, Cancel has the keyboard again. With no owner to take
// the keyboard, the cover on top takes it, as the prompt over it closes or
// a cover over it lifts, and the screen lock, which takes it itself, keeps
// it: a cover arriving under the lock leaves it the keyboard, and its
// buttons take no key. The real covers, lock and prompt, in jsdom.

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
import { COVER_ROOT_ATTR, coverOwnsButton, coverOwnsTextEntry, promptState, raisedCoverKeys, setCoverBlocking, ui, workspace } from "../state/store.svelte";
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
  promptState.open = false;
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

test("the reconnect cover leaves the close prompt over it the keyboard as the window takes focus", async () => {
  await reconnectCover();
  const { cancel } = await promptOver();
  window.dispatchEvent(new Event("focus"));
  await settle();
  expect(document.activeElement, "Cancel keeps the keyboard as the window takes focus").toBe(cancel);
  // A dialog's state changing runs the cover's focus effect again.
  promptState.open = true;
  await settle();
  expect(document.activeElement, "Cancel keeps the keyboard as the cover looks again").toBe(cancel);
});

test("the reconnect cover takes the keyboard from a field it paints over", async () => {
  const field = document.body.appendChild(document.createElement("textarea"));
  field.focus();
  const cover = await reconnectCover();
  expect(cover.contains(document.activeElement), "the cover's card").toBe(true);
});

test("the session-ended cover arriving under the close prompt leaves Cancel the keyboard", async () => {
  const { cancel } = await promptOver();
  const cover = await sessionEndedCover();
  expect(raisedCoverKeys()).toContain("session-ended");
  expect(document.activeElement, "Cancel keeps the keyboard").toBe(cancel);
  expect(cover.contains(document.activeElement), "Enter cannot reach the cover's button").toBe(false);
});

test("the session-ended cover takes the keyboard from a field it paints over", async () => {
  const field = document.body.appendChild(document.createElement("textarea"));
  field.focus();
  const cover = await sessionEndedCover();
  expect(document.activeElement, "the cover's button").toBe(cover.querySelector("button.close"));
});

/// The screen lock mounted at its layer, unlocked. Its rain draws on a
/// canvas and asks about reduced motion and fonts.
function mountLock(): void {
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
  layered(ScreensaverOverlay, 39000);
}

/// Bring the mounted lock up; it takes the keyboard onto its backdrop.
async function lock(): Promise<HTMLElement> {
  screensaver.locked = true;
  await settle();
  const backdrop = document.querySelector<HTMLElement>(".screensaver-backdrop")!;
  expect(document.activeElement, "the lock takes the keyboard").toBe(backdrop);
  return backdrop;
}

test("the close prompt over the reconnect cover takes Cancel back when the screen lock over both lifts", async () => {
  mountLock();
  await reconnectCover();
  const { cancel } = await promptOver();
  await lock();
  screensaver.locked = false;
  await settle();
  expect(raisedCoverKeys(), "the reconnect cover is still up").toEqual(["reconnect"]);
  expect(document.activeElement, "Cancel once the lock lifts").toBe(cancel);
});

test("the close prompt closing over the session-ended cover hands the cover the keyboard", async () => {
  const cover = await sessionEndedCover();
  await promptOver();
  resolveCloseConfirm("cancel");
  await settle();
  expect(document.activeElement, "the cover's button").toBe(cover.querySelector("button.close"));
});

test("the reconnect cover takes the keyboard back onto its card when the screen lock over it lifts", async () => {
  mountLock();
  const cover = await reconnectCover();
  expect(cover.contains(document.activeElement), "the card holds the keyboard").toBe(true);
  await lock();
  screensaver.locked = false;
  await settle();
  expect(raisedCoverKeys(), "the reconnect cover is still up").toEqual(["reconnect"]);
  expect(cover.contains(document.activeElement), "the card once the lock lifts").toBe(true);
});

test("no cover under the screen lock takes its keyboard, nor takes the keyboard at large under it", async () => {
  mountLock();
  const cover = await sessionEndedCover();
  await promptOver();
  const backdrop = await lock();
  resolveCloseConfirm("cancel");
  await settle();
  expect(document.activeElement, "the lock keeps the keyboard as the prompt closes").toBe(backdrop);
  void uiCloseConfirm();
  await settle();
  backdrop.blur();
  expect(document.activeElement, "the keyboard at large under the lock").toBe(document.body);
  resolveCloseConfirm("cancel");
  await settle();
  expect(cover.contains(document.activeElement), "the cover under the lock takes nothing").toBe(false);
});

test("the session-ended cover arriving under the screen lock leaves the lock its keyboard, and its button no key", async () => {
  mountLock();
  const backdrop = await lock();
  const cover = await sessionEndedCover();
  const close = cover.querySelector<HTMLButtonElement>("button.close")!;
  expect(document.activeElement, "the lock keeps the keyboard").toBe(backdrop);
  expect(coverOwnsButton(close), "Enter and Space cannot reach the cover's button under the lock").toBe(false);
  screensaver.locked = false;
  await settle();
  expect(coverOwnsButton(close), "the cover's button once the lock lifts").toBe(true);
  expect(document.activeElement, "and the keyboard with it").toBe(close);
});

test("the reconnect cover arriving under the screen lock leaves the lock its keyboard", async () => {
  mountLock();
  const backdrop = await lock();
  const cover = await reconnectCover();
  expect(raisedCoverKeys()).toContain("reconnect");
  expect(document.activeElement, "the lock keeps the keyboard").toBe(backdrop);
  expect(cover.contains(document.activeElement)).toBe(false);
});

/// Lock the screen and leave the keyboard at large under the lock, as when
/// an engine blurs the PIN field while it is disabled.
async function lockAtLarge(): Promise<void> {
  const backdrop = await lock();
  backdrop.blur();
  expect(document.activeElement, "the keyboard at large under the lock").toBe(document.body);
}

test("the session-ended cover arriving under the screen lock takes no keyboard left at large", async () => {
  mountLock();
  await lockAtLarge();
  const cover = await sessionEndedCover();
  expect(cover.contains(document.activeElement), "the cover under the lock takes nothing").toBe(false);
});

test("the reconnect cover arriving under the screen lock takes no keyboard left at large", async () => {
  mountLock();
  await lockAtLarge();
  const cover = await reconnectCover();
  expect(cover.contains(document.activeElement), "the cover under the lock takes nothing").toBe(false);
});

test("the reconnect cover under the screen lock takes no keyboard at large as the window takes focus", async () => {
  mountLock();
  const cover = await reconnectCover();
  await lockAtLarge();
  window.dispatchEvent(new Event("focus"));
  await settle();
  expect(cover.contains(document.activeElement), "the card under the lock takes nothing").toBe(false);
});

test("the session-ended cover arriving over the reconnect cover takes the keyboard off its card", async () => {
  const reconnect = await reconnectCover();
  expect(reconnect.contains(document.activeElement), "the card holds the keyboard").toBe(true);
  const cover = await sessionEndedCover();
  expect(document.activeElement, "the session-ended cover's button").toBe(cover.querySelector("button.close"));
});

test("with the covers mounted before the lock, as the App mounts them, the lock still paints on top", async () => {
  const cover = await reconnectCover();
  mountLock();
  await lockAtLarge();
  window.dispatchEvent(new Event("focus"));
  await settle();
  expect(cover.contains(document.activeElement), "the card under the lock takes nothing").toBe(false);
  screensaver.locked = false;
  await settle();
  expect(cover.contains(document.activeElement), "the card once the lock lifts").toBe(true);
});

test("typing reaches the screen lock's PIN field only while the lock paints on top", async () => {
  mountLock();
  const backdrop = await lock();
  backdrop.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
  await settle();
  const pin = backdrop.querySelector<HTMLInputElement>('input[type="password"]')!;
  expect(coverOwnsTextEntry(pin), "the lock on top takes typing").toBe(true);
  // The missing-token cover's root at its layer, over the lock's 39000.
  const missing = document.body.appendChild(document.createElement("div"));
  missing.setAttribute(COVER_ROOT_ATTR, "missing-token");
  missing.style.position = "fixed";
  missing.style.zIndex = "40000";
  setCoverBlocking("missing-token", true);
  try {
    expect(coverOwnsTextEntry(pin), "the PIN field under the missing-token cover takes none").toBe(false);
  } finally {
    setCoverBlocking("missing-token", false);
    missing.remove();
  }
});
