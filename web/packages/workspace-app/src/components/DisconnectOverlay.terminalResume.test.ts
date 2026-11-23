// @vitest-environment jsdom
//
// A ghostty terminal under the reconnecting cover, and the Computers screen
// shown over the window from Show in Computers and hidden again. The hide
// gives the window the focus back, and two of its listeners answer: the
// terminal's own resume refocus and the cover's hand-back to the action. The
// engine runs each listener of a focus it delivers on an empty stack, so the
// microtasks a listener queues run before the next listener does (HTML's
// clean-up after running a callback); a script's dispatchEvent runs them only
// once every listener has. This test delivers the focus as the engine does.
// ghostty's focus() runs once, inside the terminal's listener, and nothing
// focuses the terminal later, so what the cover's hand-back leaves is what
// the case reads.
vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../terminal/backend")>();
  const { recordingKit } = await import("../__tests__/ghosttyTab");
  return { ...actual, loadGhosttyKit: async () => recordingKit(ghostty, actual.ghosttyKitFrom) };
});

import DisconnectOverlay from "./DisconnectOverlay.svelte";
import TerminalTab from "./TerminalTab.svelte";
import { mount, tick, unmount } from "svelte";
import type { Terminal } from "@chan/ghostty-web-ng";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { WsStatus } from "../api/client";
import { resetHostVocabularyForTests } from "../api/nativeVocabulary";
import { attachGhostty, compileGhosttyCore, installSoftwareCanvas, mountGhostty } from "../__tests__/ghosttyTab";
import { terminalPreferences } from "../__tests__/standalone";
import { installTerminalDom, resetTerminals, seatTerminals, terminalTab } from "../__tests__/terminalTab";
import { resetConnectionHealthForTests, setConnectionWatchStatus, watchConnectionProbe } from "../state/connectionHealth.svelte";
import { __testSetStandalonePreferences, ui } from "../state/store.svelte";

const ghostty = vi.hoisted(() => ({
  module: null as WebAssembly.Module | null,
  terminals: [] as Terminal[],
}));

installTerminalDom();

beforeAll(async () => {
  await compileGhosttyCore(ghostty);
});

type TauriWindow = { __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } };
const ADVERTISED = { version: "0.132.0", build: "git-test", commands: ["native_vocabulary", "show_computers_for_window"] };

const mounted: Record<string, unknown>[] = [];
// The window's focus listeners in the order they were added, so the test
// can call each the way the engine does.
const focusListeners: EventListenerOrEventListenerObject[] = [];
let shown: () => void = () => {};

function watchStatus(status: WsStatus): void {
  ui.ws = status;
  setConnectionWatchStatus(status);
  if (status === "open") {
    watchConnectionProbe.pingSent();
    watchConnectionProbe.frameReceived();
    watchConnectionProbe.pongReceived();
  }
}

async function drain(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/// The focus the window takes back as the engine delivers it: each listener
/// on an empty stack, its microtasks run before the next listener's.
async function engineWindowFocus(): Promise<void> {
  const event = new FocusEvent("focus");
  for (const listener of [...focusListeners]) {
    if (typeof listener === "function") listener.call(window, event);
    else listener.handleEvent(event);
    await drain();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  installSoftwareCanvas();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("terminal-host") ? 640 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("terminal-host") ? 384 : 0;
  });
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation(((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type === "focus" && listener) focusListeners.push(listener);
    add(type, listener, options);
  }) as typeof window.addEventListener);
  vi.spyOn(window, "removeEventListener").mockImplementation(((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    if (type === "focus") {
      const at = focusListeners.indexOf(listener);
      if (at >= 0) focusListeners.splice(at, 1);
    }
    remove(type, listener, options);
  }) as typeof window.removeEventListener);
  __testSetStandalonePreferences(terminalPreferences());
  resetConnectionHealthForTests();
  resetHostVocabularyForTests();
  const invoke = vi.fn(async (cmd: string) => {
    if (cmd === "native_vocabulary") return ADVERTISED;
    if (cmd === "show_computers_for_window") return new Promise((resolve) => { shown = () => resolve(undefined); });
    return undefined;
  });
  (window as TauriWindow).__TAURI_INTERNALS__ = { invoke };
  history.replaceState(null, "", "/?lib=dev-1");
  watchStatus("open");
  ui.wsAttempt = 0;
  document.documentElement.removeAttribute("data-launcher-shown");
});

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  resetTerminals();
  ghostty.terminals.splice(0);
  focusListeners.splice(0);
  __testSetStandalonePreferences(null);
  resetConnectionHealthForTests();
  resetHostVocabularyForTests();
  delete (window as TauriWindow).__TAURI_INTERNALS__;
  history.replaceState(null, "", "/");
  document.documentElement.removeAttribute("data-launcher-shown");
  document.body.innerHTML = "";
  ui.ws = "connecting";
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the Computers screen hidden over a terminal under the reconnecting cover", () => {
  test("leaves the keyboard on Show in Computers once the terminal's own refocus has run", async () => {
    const [tab] = seatTerminals([terminalTab()]);
    const terminal = mountGhostty(TerminalTab, tab!);
    mounted.push(terminal.component as Record<string, unknown>);
    const { host } = await attachGhostty(ghostty, terminal);
    await vi.advanceTimersByTimeAsync(10);
    expect(host.contains(document.activeElement), "the terminal holds the keyboard before the drop").toBe(true);

    const target = document.body.appendChild(document.createElement("div"));
    mounted.push(mount(DisconnectOverlay, { target }) as Record<string, unknown>);
    await drain();
    watchStatus("reconnecting");
    await tick();
    vi.advanceTimersByTime(600);
    await drain();
    await tick();
    const cover = target.querySelector<HTMLElement>('[data-cover="reconnect"]')!;
    expect(document.activeElement, "the cover takes the keyboard").toBe(cover);

    const action = [...cover.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Show in Computers")!;
    // The engine's click focuses the button, and the button, disabled while
    // the desktop answers, drops the page's focus to the body. jsdom's
    // click() focuses nothing and keeps a disabled button focused, so the
    // drop is made before the disabled state lands.
    action.focus();
    action.click();
    action.blur();
    await drain();
    // The screen shows and takes the keyboard.
    document.documentElement.setAttribute("data-launcher-shown", "");
    window.dispatchEvent(new Event("blur"));
    shown();
    await drain();
    await tick();
    expect(document.activeElement).toBe(document.body);

    // The screen hides: the desktop clears the mark, then the window takes
    // the focus back.
    document.documentElement.removeAttribute("data-launcher-shown");
    await drain();
    await engineWindowFocus();
    await vi.advanceTimersByTimeAsync(20);
    await drain();

    expect(target.querySelector('[data-cover="reconnect"]'), "the cover stays up").toBe(cover);
    expect(host.contains(document.activeElement), "the terminal under the cover holds no keyboard").toBe(false);
    expect(document.activeElement, "the keyboard is back on Show in Computers").toBe(action);
  });
});
