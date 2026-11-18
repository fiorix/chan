// @vitest-environment jsdom
//
// The close prompt paints over the reconnect and session-ended covers, and
// so it holds the keyboard over them: raised over either cover it takes the
// keyboard onto Cancel, Escape cancels it and Tab cycles its buttons, and a
// key lands on the prompt rather than on the cover's own button beneath it.
// The real covers and prompt, in jsdom.

import { mount, tick, unmount, type Component } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import CloseConfirmOverlay from "./CloseConfirmOverlay.svelte";
import DisconnectOverlay from "./DisconnectOverlay.svelte";
import SessionEndedOverlay from "./SessionEndedOverlay.svelte";
import type { WsStatus } from "../api/client";
import { closeConfirmState, resolveCloseConfirm, uiCloseConfirm } from "../state/closeConfirm.svelte";
import { resetConnectionHealthForTests, setConnectionWatchStatus, watchConnectionProbe } from "../state/connectionHealth.svelte";
import { raisedCoverKeys, ui } from "../state/store.svelte";
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
  resolveCloseConfirm("cancel");
  for (const view of mounted.splice(0)) unmount(view);
  await settle();
  __resetWindowLifecycle();
  resetConnectionHealthForTests();
  ui.ws = "connecting";
  ui.wsAttempt = 0;
  ui.disconnectBlocking = false;
  document.body.replaceChildren();
  vi.useRealTimers();
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
