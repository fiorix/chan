// @vitest-environment jsdom
//
// On a devserver window of the desktop the reconnecting cover offers Show in
// Computers from the moment it shows, where the installed desktop advertises
// the command: the desktop shows the Computers screen over the window on the
// devserver's card. Restart connection and Abandon keep their 8 s. A local
// window, a control terminal, a browser page and a desktop that does not
// advertise the command get no such action.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { WsStatus } from "../api/client";
import { showComputersForWindow } from "../api/desktop";
import { resetHostVocabularyForTests } from "../api/nativeVocabulary";
import { resetConnectionHealthForTests, setConnectionWatchStatus, watchConnectionProbe } from "../state/connectionHealth.svelte";
import { overlayStack, ui } from "../state/store.svelte";
import DisconnectOverlay from "./DisconnectOverlay.svelte";

type TauriWindow = { __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } };

const ADVERTISED = { version: "0.132.0", build: "git-test", commands: ["native_vocabulary", "show_computers_for_window"] };

let invoke: ReturnType<typeof vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>>;
let vocabulary: () => Promise<unknown>;
let showComputers: () => Promise<unknown>;
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

/// Let the vocabulary query and an action's IPC settle: each is a short
/// chain of promises, which fake timers do not run.
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
  await tick();
}

beforeEach(() => {
  vi.useFakeTimers();
  resetConnectionHealthForTests();
  resetHostVocabularyForTests();
  vocabulary = async () => ADVERTISED;
  showComputers = async () => undefined;
  invoke = vi.fn(async (cmd: string) => {
    if (cmd === "native_vocabulary") return vocabulary();
    if (cmd === "show_computers_for_window") return showComputers();
    return undefined;
  });
  watchStatus("open");
  ui.wsAttempt = 0;
  ui.terminalControl = false;
  overlayStack.ids = [];
  document.documentElement.removeAttribute("data-launcher-shown");
});

afterEach(() => {
  for (const view of mounted.splice(0)) unmount(view);
  resetConnectionHealthForTests();
  resetHostVocabularyForTests();
  document.body.innerHTML = "";
  delete (window as TauriWindow).__TAURI_INTERNALS__;
  history.replaceState(null, "", "/");
  vi.useRealTimers();
  vi.restoreAllMocks();
  ui.ws = "connecting";
  ui.wsAttempt = 0;
  ui.terminalControl = false;
  overlayStack.ids = [];
  document.documentElement.removeAttribute("data-launcher-shown");
});

function desktopWindow(lib: string): void {
  (window as TauriWindow).__TAURI_INTERNALS__ = { invoke };
  history.replaceState(null, "", `/?lib=${lib}`);
}

async function mountCover(): Promise<HTMLElement> {
  const target = document.body.appendChild(document.createElement("div"));
  mounted.push(mount(DisconnectOverlay, { target }));
  await settle();
  return target;
}

async function dropConnection(target: HTMLElement): Promise<HTMLElement> {
  watchStatus("reconnecting");
  await tick();
  vi.advanceTimersByTime(600);
  await settle();
  const cover = target.querySelector<HTMLElement>('[data-cover="reconnect"]');
  expect(cover).not.toBeNull();
  return cover!;
}

/// To the 8 s after the drop at which Restart connection and Abandon appear.
async function toRecoveryActions(): Promise<void> {
  vi.advanceTimersByTime(7_400);
  await settle();
}

/// Whether `element` sits in an inert subtree. Svelte sets `inert` as a
/// property, which jsdom does not reflect to the attribute.
function inert(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if ((node as HTMLElement & { inert?: boolean }).inert) return true;
  }
  return false;
}

/// The actions the cover offers: a held place's buttons are inert.
const labels = (target: HTMLElement): string[] =>
  [...target.querySelectorAll<HTMLButtonElement>(".actions button")]
    .filter((b) => !inert(b))
    .map((b) => b.textContent?.trim() ?? "");

function button(target: HTMLElement, label: string): HTMLButtonElement {
  const found = [...target.querySelectorAll<HTMLButtonElement>(".actions button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(found, `the cover offers ${label}`).toBeDefined();
  return found!;
}

const pressTab = (cover: HTMLElement, shiftKey = false): boolean =>
  cover.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }));

// chan-desktop marks the page's root while its Computers screen shows over
// the window and the screen holds the keyboard; the window blurs, and
// focuses again when the screen hides (launcher_transition.js).
function showLauncher(): void {
  document.documentElement.setAttribute("data-launcher-shown", "");
  window.dispatchEvent(new Event("blur"));
}

function hideLauncher(): void {
  document.documentElement.removeAttribute("data-launcher-shown");
  window.dispatchEvent(new Event("focus"));
}

describe("Show in Computers on the reconnecting cover", () => {
  test("is offered from the moment the cover shows, before Restart connection and Abandon", async () => {
    desktopWindow("dev-1");
    const target = await mountCover();
    expect(invoke).toHaveBeenCalledWith("native_vocabulary", undefined);
    const cover = await dropConnection(target);

    expect(labels(target)).toEqual(["Show in Computers"]);
    expect(document.activeElement, "focus parks on the cover, never on an action").toBe(cover);
    await toRecoveryActions();
    expect(labels(target)).toEqual(["Restart connection", "Abandon", "Show in Computers"]);
    expect(document.activeElement).toBe(cover);
  });

  // The card is centred on the window, so a row that enters it moves every
  // row below. jsdom lays nothing out; what it can show is that no row of
  // the card enters or leaves when Restart connection and Abandon appear:
  // their place is held, hidden, from the moment the cover shows.
  test("keeps its place when Restart connection and Abandon appear", async () => {
    desktopWindow("dev-1");
    const cover = await dropConnection(await mountCover());
    const card = cover.querySelector<HTMLElement>(".card")!;
    const target = cover.parentElement!;
    const rowsAtShow = [...card.children];
    const heldAtShow = [...card.querySelectorAll<HTMLButtonElement>("button")].map((b) => ({
      button: b, text: b.textContent?.trim(), inert: inert(b), disabled: b.disabled,
    }));

    await toRecoveryActions();
    expect([...card.children], "no row entered or left the card").toEqual(rowsAtShow);
    expect(heldAtShow.map(({ text, inert, disabled }) => ({ text, inert, disabled })), "held, not offered, until 8 s").toEqual([
      { text: "Restart connection", inert: true, disabled: true },
      { text: "Abandon", inert: true, disabled: true },
      { text: "Show in Computers", inert: false, disabled: false },
    ]);
    const restart = button(target, "Restart connection");
    expect(restart).toBe(heldAtShow[0].button);
    expect(inert(restart)).toBe(false);
    expect(restart.disabled).toBe(false);
    expect(labels(target)).toEqual(["Restart connection", "Abandon", "Show in Computers"]);
  });

  test("is in the cover's Tab cycle with the other actions", async () => {
    desktopWindow("dev-1");
    const cover = await dropConnection(await mountCover());
    const target = cover.parentElement!;

    expect(pressTab(cover)).toBe(false);
    expect(document.activeElement).toBe(button(target, "Show in Computers"));
    pressTab(cover);
    expect(document.activeElement, "the one action cycles to itself").toBe(button(target, "Show in Computers"));
    await toRecoveryActions();
    pressTab(cover);
    expect(document.activeElement).toBe(button(target, "Restart connection"));
    pressTab(cover, true);
    expect(document.activeElement).toBe(button(target, "Show in Computers"));
    pressTab(cover, true);
    expect(document.activeElement).toBe(button(target, "Abandon"));
  });

  test("asks the desktop for the screen, leaves it the keyboard, and takes the focus back when it hides", async () => {
    desktopWindow("dev-1");
    let shown!: () => void;
    showComputers = () => new Promise((resolve) => { shown = () => resolve(undefined); });
    const target = await mountCover();
    const cover = await dropConnection(target);
    const action = button(target, "Show in Computers");
    action.focus();
    action.click();
    await settle();
    expect(invoke).toHaveBeenCalledWith("show_computers_for_window", undefined);
    expect(action.disabled, "the action holds while the desktop answers").toBe(true);

    // The screen takes the keyboard before the desktop answers, and a
    // browser drops focus from a button as it becomes disabled; jsdom keeps
    // it, so focus goes to a stray element instead.
    const stray = document.body.appendChild(document.createElement("textarea"));
    stray.focus();
    showLauncher();
    shown();
    await settle();
    expect(action.disabled).toBe(false);
    expect(document.activeElement, "the shown screen keeps the keyboard").toBe(stray);
    expect(target.querySelector(".error")).toBeNull();

    hideLauncher();
    await settle();
    expect(target.querySelector('[data-cover="reconnect"]'), "the cover stays up while the outage lasts").toBe(cover);
    expect(document.activeElement).toBe(action);
    vi.advanceTimersByTime(30_000);
    await settle();
    expect(target.querySelector('[data-cover="reconnect"]')).toBe(cover);

    watchStatus("open");
    await settle();
    expect(target.querySelector('[data-cover="reconnect"]')).toBeNull();
  });

  test("shows a refusal on the cover as a Restart connection failure does", async () => {
    desktopWindow("dev-1");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    showComputers = async () => { throw new Error("the Computers screen did not show over this window"); };
    const target = await mountCover();
    const cover = await dropConnection(target);

    button(target, "Show in Computers").click();
    await settle();
    expect(target.querySelector('[role="alert"]')?.textContent).toBe("the Computers screen did not show over this window");
    expect(cover.contains(document.activeElement)).toBe(true);
    expect(button(target, "Show in Computers").disabled).toBe(false);
  });
});

describe("where Show in Computers is offered", () => {
  test("not where the installed desktop does not advertise its command", async () => {
    desktopWindow("dev-1");
    vocabulary = async () => ({ ...ADVERTISED, commands: ["native_vocabulary", "reconnect_devserver_for_window"] });
    const target = await mountCover();
    await dropConnection(target);
    expect(labels(target)).toEqual([]);
    await toRecoveryActions();
    expect(labels(target)).toEqual(["Restart connection", "Abandon"]);
  });

  test("not by a desktop that cannot say, and asked again as a later cover shows", async () => {
    desktopWindow("dev-1");
    vocabulary = async () => { throw new Error("Command native_vocabulary not allowed by ACL"); };
    const target = await mountCover();
    await dropConnection(target);
    expect(labels(target)).toEqual([]);

    vocabulary = async () => ADVERTISED;
    watchStatus("open");
    await settle();
    await dropConnection(target);
    expect(labels(target)).toEqual(["Show in Computers"]);
  });

  test.each([
    ["a local window", () => desktopWindow("local")],
    ["a browser page, even one on a devserver", () => history.replaceState(null, "", "/?lib=dev-1")],
  ])("not on %s", async (_name, open) => {
    open();
    const target = await mountCover();
    await dropConnection(target);
    await toRecoveryActions();
    expect(labels(target)).toEqual([]);
  });

  test("not on a control terminal", async () => {
    desktopWindow("dev-1");
    ui.terminalControl = true;
    const target = await mountCover();
    await dropConnection(target);
    await toRecoveryActions();
    expect(labels(target)).not.toContain("Show in Computers");
  });
});

describe("the desktop's Show in Computers call", () => {
  test("refuses outside the desktop", async () => {
    await expect(showComputersForWindow()).rejects.toThrow("not running under Tauri");
  });

  test("logs a refused call and passes the failure on", async () => {
    desktopWindow("dev-1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    showComputers = async () => { throw new Error("denied"); };
    await expect(showComputersForWindow()).rejects.toThrow("denied");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
