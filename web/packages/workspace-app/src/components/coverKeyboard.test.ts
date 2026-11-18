// @vitest-environment jsdom
//
// A dialog open when a cover comes up over the window: the cover holds the
// keyboard while it shows, and the dialog takes it back when the cover
// lifts. The real screen lock and the app's prompt dialog, in jsdom.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import ScreensaverOverlay from "./ScreensaverOverlay.svelte";
import Harness from "../__tests__/ModalStackHarness.svelte";
import { focusOrigin, settle } from "../__tests__/dialog";
import { recordingContext2d } from "../__tests__/canvas";
import { demoWorkspaceInfo } from "../demo/data";
import { screensaver } from "../state/screensaver.svelte";
import { promptState, resolvePrompt, uiPrompt, workspace } from "../state/store.svelte";

const mounted: Array<ReturnType<typeof mount>> = [];

beforeEach(() => {
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
});

afterEach(async () => {
  screensaver.locked = false;
  if (promptState.open) resolvePrompt(null);
  for (const component of mounted.splice(0)) await unmount(component);
  await settle();
  workspace.info = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("the screen lock over an open dialog holds the keyboard, and the dialog takes it back on unlock", async () => {
  focusOrigin();
  const dialogs = document.body.appendChild(document.createElement("div"));
  mounted.push(mount(Harness, { target: dialogs, props: { callers: true } }));
  flushSync();
  void uiPrompt("Name");
  await settle();
  const field = document.querySelector<HTMLInputElement>('.modal[role="dialog"] input')!;
  field.focus();
  expect(document.activeElement, "the dialog's field").toBe(field);
  const lock = document.body.appendChild(document.createElement("div"));
  mounted.push(mount(ScreensaverOverlay, { target: lock }));
  screensaver.locked = true;
  await settle();
  const backdrop = document.querySelector<HTMLElement>(".screensaver-backdrop")!;
  expect(document.activeElement, "the lock takes the keyboard from the dialog").toBe(backdrop);
  backdrop.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
  await settle();
  const pin = backdrop.querySelector<HTMLInputElement>('input[type="password"]')!;
  expect(document.activeElement, "the woken card's PIN field").toBe(pin);
  await settle();
  expect(document.activeElement, "the dialog's repair leaves the PIN alone").toBe(pin);
  screensaver.locked = false;
  await settle();
  expect(document.activeElement, "the dialog's field once the lock lifts").toBe(field);
});
