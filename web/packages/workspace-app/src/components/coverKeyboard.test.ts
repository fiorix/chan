// @vitest-environment jsdom
//
// A dialog open when a cover comes up over the window: the cover holds the
// keyboard while it shows, and the dialog takes it back when the cover
// lifts. The real screen lock, the app's prompt dialog, the close prompt
// and the Team dialog, in jsdom.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import CloseConfirmOverlay from "./CloseConfirmOverlay.svelte";
import ScreensaverOverlay from "./ScreensaverOverlay.svelte";
import TeamDialog from "./TeamDialog.svelte";
import Harness from "../__tests__/ModalStackHarness.svelte";
import { focusOrigin, settle } from "../__tests__/dialog";
import { recordingContext2d } from "../__tests__/canvas";
import { resetLayout, terminalTab } from "../__tests__/tabs";
import { demoWorkspaceInfo } from "../demo/data";
import { resolveCloseConfirm, uiCloseConfirm } from "../state/closeConfirm.svelte";
import { screensaver } from "../state/screensaver.svelte";
import { promptState, resolvePrompt, uiPrompt, workspace } from "../state/store.svelte";
import { closeTeamDialog, openTeamDialog } from "../state/teamDialog.svelte";

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
  resolveCloseConfirm("cancel");
  closeTeamDialog();
  for (const component of mounted.splice(0)) await unmount(component);
  await settle();
  workspace.info = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/// The lock's mount, at the layer its stylesheet sets: jsdom applies no
/// component stylesheet, and the dialogs' stack sets their layers inline.
function lockLayer(): HTMLElement {
  const target = document.body.appendChild(document.createElement("div"));
  target.style.position = "fixed";
  target.style.zIndex = "39000";
  return target;
}

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
  mounted.push(mount(ScreensaverOverlay, { target: lockLayer() }));
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

/// Bring the screen lock up over the page and lift it.
async function lockAndUnlock(): Promise<void> {
  mounted.push(mount(ScreensaverOverlay, { target: lockLayer() }));
  screensaver.locked = true;
  await settle();
  const backdrop = document.querySelector<HTMLElement>(".screensaver-backdrop")!;
  expect(document.activeElement, "the lock takes the keyboard").toBe(backdrop);
  screensaver.locked = false;
  await settle();
}

test("the close prompt takes the keyboard back onto Cancel when the screen lock over it lifts", async () => {
  focusOrigin();
  const target = document.body.appendChild(document.createElement("div"));
  mounted.push(mount(CloseConfirmOverlay, { target }));
  void uiCloseConfirm();
  await settle();
  const cancel = target.querySelector<HTMLButtonElement>("button.cancel")!;
  expect(document.activeElement, "Cancel as the prompt shows").toBe(cancel);
  await lockAndUnlock();
  expect(document.activeElement, "Cancel once the lock lifts").toBe(cancel);
});

test("the Team dialog takes the keyboard back onto its name field when the screen lock over it lifts", async () => {
  resetLayout([terminalTab({ id: "lead-tab", terminalSessionId: "lead-session" })]);
  focusOrigin();
  const request = { leadTabId: "lead-tab", leadPaneId: "pane-test" };
  openTeamDialog(request);
  const target = document.body.appendChild(document.createElement("div"));
  mounted.push(mount(TeamDialog, { target, props: { request } }));
  await settle();
  const name = target.querySelector<HTMLInputElement>(".team-field input")!;
  expect(document.activeElement, "the name field as the dialog shows").toBe(name);
  await lockAndUnlock();
  expect(document.activeElement, "the name field once the lock lifts").toBe(name);
});
