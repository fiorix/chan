// @vitest-environment jsdom
//
// A dialog open when a cover comes up over the window: the cover holds the
// keyboard while it shows, and the dialog takes it back when the cover
// lifts; with nothing owning the keyboard, the focused terminal takes it
// back. The real screen lock, the app's prompt dialog, the close prompt,
// the Team dialog and a terminal over the stand-in xterm, in jsdom.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import CloseConfirmOverlay from "./CloseConfirmOverlay.svelte";
import ScreensaverOverlay from "./ScreensaverOverlay.svelte";
import TeamDialog from "./TeamDialog.svelte";
import TerminalTab from "./TerminalTab.svelte";
import {
  attach,
  installTerminalDom,
  mountTerminal,
  receive,
  resetTerminals,
  seatTerminals,
  TerminalSocket,
} from "../__tests__/terminalTab";
import { xterm } from "../__tests__/xterm";
import Harness from "../__tests__/ModalStackHarness.svelte";
import { focusOrigin, settle } from "../__tests__/dialog";
import { recordingContext2d } from "../__tests__/canvas";
import { resetLayout, terminalTab } from "../__tests__/tabs";
import { demoWorkspaceInfo } from "../demo/data";
import { resolveCloseConfirm, uiCloseConfirm } from "../state/closeConfirm.svelte";
import { screensaver } from "../state/screensaver.svelte";
import { bumpTabFocusPulse } from "../state/tabs.svelte";
import { COVER_ROOT_ATTR, promptState, resolvePrompt, setCoverBlocking, uiPrompt, workspace } from "../state/store.svelte";
import { closeTeamDialog, openTeamDialog } from "../state/teamDialog.svelte";

installTerminalDom();

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
  resetTerminals();
  xterm.textareaFocus = false;
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

test("a terminal that held the keyboard takes it back when the screen lock lifts with nothing owning it", async () => {
  xterm.textareaFocus = true;
  const [tab] = seatTerminals([terminalTab({ title: "shell" })]);
  const { target } = await mountTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  const textarea = target.querySelector<HTMLElement>("textarea")!;
  await vi.waitFor(() => expect(document.activeElement, "the terminal holds the keyboard").toBe(textarea));
  await lockAndUnlock();
  await vi.waitFor(() => expect(document.activeElement, "the terminal once the lock lifts").toBe(textarea));
});

test("a tab-focus pulse fired under the screen lock leaves its PIN field the keyboard", async () => {
  focusOrigin();
  mounted.push(mount(ScreensaverOverlay, { target: lockLayer() }));
  screensaver.locked = true;
  await settle();
  const backdrop = document.querySelector<HTMLElement>(".screensaver-backdrop")!;
  backdrop.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
  await settle();
  const pin = backdrop.querySelector<HTMLInputElement>('input[type="password"]')!;
  expect(document.activeElement, "the woken card's PIN field").toBe(pin);
  bumpTabFocusPulse();
  await settle();
  expect(document.activeElement, "the pulse leaves the PIN field alone").toBe(pin);
});

/// The app's prompt dialog open with its field focused, then the screen lock
/// up over it with its card woken and its PIN field holding the keyboard.
async function dialogUnderWokenLock(): Promise<{ field: HTMLInputElement; backdrop: HTMLElement; pin: HTMLInputElement }> {
  focusOrigin();
  const dialogs = document.body.appendChild(document.createElement("div"));
  mounted.push(mount(Harness, { target: dialogs, props: { callers: true } }));
  flushSync();
  void uiPrompt("Name");
  await settle();
  const field = document.querySelector<HTMLInputElement>('.modal[role="dialog"] input')!;
  field.focus();
  mounted.push(mount(ScreensaverOverlay, { target: lockLayer() }));
  screensaver.locked = true;
  await settle();
  const backdrop = document.querySelector<HTMLElement>(".screensaver-backdrop")!;
  backdrop.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
  await settle();
  const pin = backdrop.querySelector<HTMLInputElement>('input[type="password"]')!;
  expect(document.activeElement, "the woken card's PIN field").toBe(pin);
  return { field, backdrop, pin };
}

test("Tab on the screen lock's PIN field stays on the lock, off the dialog under it", async () => {
  const { backdrop, pin } = await dialogUnderWokenLock();
  pin.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  await settle();
  expect(backdrop.contains(document.activeElement), "Tab cycles the lock's own controls").toBe(true);
});

test("Escape on the screen lock leaves the dialog under it open", async () => {
  const { pin } = await dialogUnderWokenLock();
  pin.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await settle();
  expect(promptState.open, "the dialog under the lock stays open").toBe(true);
  expect(document.activeElement, "the PIN field keeps the keyboard").toBe(pin);
});

test("a dialog field left focused under the reconnect cover answers no Escape", async () => {
  focusOrigin();
  const dialogs = document.body.appendChild(document.createElement("div"));
  mounted.push(mount(Harness, { target: dialogs, props: { callers: true } }));
  flushSync();
  void uiPrompt("Name");
  await settle();
  const field = document.querySelector<HTMLInputElement>('.modal[role="dialog"] input')!;
  field.focus();
  // The reconnect cover's root at its layer, over the dialogs' 26000; the
  // cover leaves a dialog's focus where it was.
  const cover = document.body.appendChild(document.createElement("div"));
  cover.setAttribute(COVER_ROOT_ATTR, "reconnect");
  cover.style.position = "fixed";
  cover.style.zIndex = "30000";
  setCoverBlocking("reconnect", true);
  try {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle();
    expect(promptState.open, "the dialog stays open during the outage").toBe(true);
  } finally {
    setCoverBlocking("reconnect", false);
    cover.remove();
  }
});
