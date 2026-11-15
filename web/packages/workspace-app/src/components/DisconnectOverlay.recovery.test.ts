// @vitest-environment jsdom
//
// Once the connection to the chan server has been up and then drops, the
// overlay covers the window after a short grace: a spinner, what it is doing,
// and a retry readout of the reconnect attempt and the time elapsed. On a
// desktop window backed by a devserver it later offers Restart connection (the desktop
// force-closes the dead control terminal and dials again) and Abandon, each
// showing it is busy and saying why when the desktop refuses. A browser, or a
// desktop window on the local library, gets no actions: the watcher keeps
// retrying on its own.

import { readFileSync } from "node:fs";
import { createRawSnippet, flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { abandonDevserverForWindow, reconnectDevserverForWindow } from "../api/desktop";
import type { WsStatus } from "../api/client";
import { resetConnectionHealthForTests, setConnectionWatchStatus, watchConnectionProbe } from "../state/connectionHealth.svelte";
import { overlayStack, promptState, setCoverBlocking, ui } from "../state/store.svelte";
import { tabFocusPulse } from "../state/tabs.svelte";
import { resetLayout, terminalTab } from "../__tests__/tabs";
import { resetSurveysForTest, showSurvey } from "../state/survey.svelte";
import { teamDialogState } from "../state/teamDialog.svelte";
import { closeConfirmState } from "../state/closeConfirm.svelte";
import { WINDOW_TAB_BAR_MIN_HEIGHT, windowTabBar } from "../state/windowTabBar.svelte";
import BubbleOverlay from "./BubbleOverlay.svelte";
import DisconnectOverlay from "./DisconnectOverlay.svelte";
import OverlayShell from "./OverlayShell.svelte";
import PromptModal from "./PromptModal.svelte";

type TauriWindow = { __TAURI_INTERNALS__?: { invoke: (cmd: string) => Promise<unknown> } };

let invoke: ReturnType<typeof vi.fn<(cmd: string) => Promise<unknown>>>;
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

beforeEach(() => {
  vi.useFakeTimers();
  resetConnectionHealthForTests();
  invoke = vi.fn(async () => undefined);
  watchStatus("open");
  ui.wsAttempt = 0;
  windowTabBar.on = false;
  windowTabBar.height = WINDOW_TAB_BAR_MIN_HEIGHT;
  overlayStack.ids = [];
  promptState.open = false;
  teamDialogState.request = null;
  closeConfirmState.open = false;
  setCoverBlocking("screensaver", false);
  document.documentElement.removeAttribute("data-launcher-shown");
  resetLayout();
  resetSurveysForTest();
});

afterEach(() => {
  for (const view of mounted.splice(0)) unmount(view);
  resetConnectionHealthForTests();
  document.body.innerHTML = "";
  delete (window as TauriWindow).__TAURI_INTERNALS__;
  history.replaceState(null, "", "/");
  vi.useRealTimers();
  vi.restoreAllMocks();
  ui.ws = "connecting";
  ui.wsAttempt = 0;
  windowTabBar.on = false;
  windowTabBar.height = WINDOW_TAB_BAR_MIN_HEIGHT;
  overlayStack.ids = [];
  promptState.open = false;
  teamDialogState.request = null;
  closeConfirmState.open = false;
  setCoverBlocking("screensaver", false);
  document.documentElement.removeAttribute("data-launcher-shown");
  resetLayout();
  resetSurveysForTest();
});

function desktopWindow(lib: string): void {
  (window as TauriWindow).__TAURI_INTERNALS__ = { invoke };
  history.replaceState(null, "", `/?lib=${lib}`);
}

async function dropConnection(): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(DisconnectOverlay, { target }));
  await tick();
  watchStatus("reconnecting");
  await tick();
  vi.advanceTimersByTime(600);
  await tick();
  expect(target.querySelector(".overlay")).not.toBeNull();
  return target;
}

async function readyActions(): Promise<HTMLElement> {
  const target = await dropConnection();
  vi.advanceTimersByTime(7_400);
  await tick();
  return target;
}

async function deferredIntoSecondOutage(): Promise<HTMLTextAreaElement> {
  const behind = document.body.appendChild(document.createElement("textarea"));
  behind.focus();
  await dropConnection();
  showLauncher();
  watchStatus("open");
  await tick();
  await tick();
  watchStatus("reconnecting");
  await tick();
  vi.advanceTimersByTime(600);
  await tick();
  hideLauncher();
  await tick();
  return behind;
}

function button(target: HTMLElement, label: string): HTMLButtonElement {
  return [...target.querySelectorAll<HTMLButtonElement>(".actions button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  )!;
}

describe("the reconnect overlay", () => {
  test("starts below the title band only while the window tab bar is on", async () => {
    windowTabBar.on = true;
    windowTabBar.height = 36;
    const target = await dropConnection();
    expect(target.querySelector<HTMLElement>(".overlay")?.style.top).toBe("36px");
    windowTabBar.on = false;
    await tick();
    expect(target.querySelector<HTMLElement>(".overlay")?.style.top).toBe("0px");
  });

  test("covers the band while an app overlay owns the keyboard", async () => {
    windowTabBar.on = true;
    windowTabBar.height = 36;
    overlayStack.ids = ["settings"];
    const target = await dropConnection();
    expect(target.querySelector<HTMLElement>(".overlay")?.style.top).toBe("0px");
    overlayStack.ids = [];
    await tick();
    expect(target.querySelector<HTMLElement>(".overlay")?.style.top).toBe("36px");
  });

  test("restarts the 600 ms grace when the watcher changes from reconnecting to connecting", async () => {
    const target = document.body.appendChild(document.createElement("div"));
    mounted.push(mount(DisconnectOverlay, { target }));
    await tick();
    watchStatus("reconnecting");
    await tick();
    vi.advanceTimersByTime(500);
    watchStatus("connecting");
    await tick();
    vi.advanceTimersByTime(500);
    await tick();
    expect(target.querySelector(".overlay"), "the first redial still has its grace").toBeNull();
    vi.advanceTimersByTime(100);
    await tick();
    expect(target.querySelector(".overlay")).not.toBeNull();
  });

  test("parks initial focus on the cover instead of a recovery button", async () => {
    desktopWindow("dev-1");
    const behind = document.body.appendChild(document.createElement("textarea"));
    behind.focus();
    const target = await dropConnection();
    const cover = target.querySelector<HTMLElement>(".overlay")!;
    expect(document.activeElement).toBe(cover);
    expect(behind).not.toBe(document.activeElement);
  });

  test("returns focus to the element that held it before the cover", async () => {
    const behind = document.body.appendChild(document.createElement("textarea"));
    behind.focus();
    const coverTarget = await dropConnection();
    expect(document.activeElement).toBe(coverTarget.querySelector(".overlay"));
    watchStatus("open");
    await tick();
    await tick();
    expect(document.activeElement).toBe(behind);
  });

  test("returns terminal focus through the active surface's focus pulse", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    host.className = "terminal-host";
    const input = host.appendChild(document.createElement("textarea"));
    input.focus();
    const before = tabFocusPulse.value;
    await dropConnection();
    watchStatus("open");
    await tick();
    await tick();
    expect(tabFocusPulse.value).toBe(before + 1);
  });

  test("returns editor focus through the active surface's focus pulse", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    host.className = "editor-host";
    const input = host.appendChild(document.createElement("textarea"));
    input.focus();
    const before = tabFocusPulse.value;
    await dropConnection();
    watchStatus("open");
    await tick();
    await tick();
    expect(tabFocusPulse.value).toBe(before + 1);
  });

  test.each(["search", "settings"] as const)("returns focus inside the %s overlay that owned it before the drop", async (id) => {
    const target = document.body.appendChild(document.createElement("div"));
    mounted.push(mount(OverlayShell, {
      target,
      props: {
        id,
        open: true,
        label: id,
        onClose: () => {},
        children: createRawSnippet(() => ({ render: () => '<input aria-label="owned field" />' })),
      },
    }));
    await tick();
    overlayStack.ids = [id];
    const input = target.querySelector<HTMLInputElement>('input[aria-label="owned field"]')!;
    input.focus();
    await dropConnection();
    watchStatus("open");
    await tick();
    await tick();
    expect(document.activeElement).toBe(input);
  });

  test("does not return focus to a lower overlay while another overlay owns the keyboard", async () => {
    const lower = document.body.appendChild(document.createElement("div"));
    lower.className = "panel";
    lower.setAttribute("role", "dialog");
    lower.dataset.overlayId = "search";
    const input = lower.appendChild(document.createElement("input"));
    overlayStack.ids = ["search"];
    input.focus();
    await dropConnection();
    overlayStack.ids = ["search", "settings"];
    watchStatus("open");
    await tick();
    await tick();
    expect(document.activeElement).not.toBe(input);
  });

  test("returns focus to the command launcher field that owned it before the drop", async () => {
    const deck = document.body.appendChild(document.createElement("div"));
    deck.className = "deck-shell";
    deck.setAttribute("role", "dialog");
    const input = deck.appendChild(document.createElement("input"));
    overlayStack.ids = ["launcher"];
    input.focus();
    await dropConnection();
    watchStatus("open");
    await tick();
    await tick();
    expect(document.activeElement).toBe(input);
  });

  test.each([
    ["window-wide survey", "survey-overlay", "dialog", null, () => showSurvey({ surveyId: "window", bodyMarkdown: "Question", options: ["Yes"] }, null)],
    ["Team Work dialog", "team-dialog", "dialog", null, () => { teamDialogState.request = { leadTabId: "t", leadPaneId: "p" }; }],
    ["close confirmation", "overlay", "alertdialog", "Close this window?", () => { closeConfirmState.open = true; }],
  ] as const)("returns focus to the %s field that owned it before the drop", async (_name, className, role, label, open) => {
    const root = document.body.appendChild(document.createElement("div"));
    root.className = className;
    root.setAttribute("role", role);
    if (label) root.setAttribute("aria-label", label);
    const input = root.appendChild(document.createElement("input"));
    open();
    input.focus();
    await dropConnection();
    watchStatus("open");
    await tick();
    await tick();
    expect(document.activeElement).toBe(input);
  });

  test("returns focus to a mounted window-wide survey card after the cover clears", async () => {
    showSurvey({ surveyId: "window", bodyMarkdown: "Question", options: ["Yes"] }, null);
    const target = document.body.appendChild(document.createElement("div"));
    mounted.push(mount(BubbleOverlay, { target }));
    await tick();
    const card = target.querySelector<HTMLElement>('.survey-overlay[role="dialog"] .survey-card')!;
    expect(document.activeElement).toBe(card);
    await dropConnection();
    watchStatus("open");
    await tick();
    await tick();
    expect(document.activeElement).toBe(card);
  });

  test("returns focus to the prompt field that owned it before the drop", async () => {
    promptState.open = true;
    promptState.title = "Prompt";
    const target = document.body.appendChild(document.createElement("div"));
    mounted.push(mount(PromptModal, { target }));
    await tick();
    const input = target.querySelector<HTMLInputElement>('.modal[role="dialog"] input')!;
    input.focus();
    const blur = vi.spyOn(input, "blur");
    await dropConnection();
    expect(blur).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    watchStatus("open");
    await tick();
    await tick();
    expect(document.activeElement).toBe(input);
  });

  test("does not restore focus while the Computers launcher is shown", async () => {
    const behind = document.body.appendChild(document.createElement("textarea"));
    behind.focus();
    await dropConnection();
    document.documentElement.setAttribute("data-launcher-shown", "");
    watchStatus("open");
    await tick();
    await tick();
    expect(document.activeElement).not.toBe(behind);
    document.documentElement.removeAttribute("data-launcher-shown");
  });

  test("returns the prior focus when the launcher hides after reconnection", async () => {
    const behind = document.body.appendChild(document.createElement("textarea"));
    behind.focus();
    await dropConnection();
    showLauncher();
    watchStatus("open");
    await tick();
    await tick();
    expect(document.activeElement).not.toBe(behind);
    hideLauncher();
    await tick();
    expect(document.activeElement).toBe(behind);
  });

  test("carries deferred focus through a second outage when the launcher hides during it", async () => {
    const behind = document.body.appendChild(document.createElement("textarea"));
    behind.focus();
    await dropConnection();
    showLauncher();
    watchStatus("open");
    await tick();
    await tick();
    watchStatus("reconnecting");
    await tick();
    vi.advanceTimersByTime(600);
    await tick();
    hideLauncher();
    await tick();
    expect(document.activeElement).not.toBe(behind);
    watchStatus("open");
    await tick();
    await tick();
    expect(document.activeElement).toBe(behind);
  });

  test("carries deferred focus when the launcher hides during a drop healed within the grace", async () => {
    const behind = document.body.appendChild(document.createElement("textarea"));
    behind.focus();
    await dropConnection();
    showLauncher();
    watchStatus("open");
    await tick();
    await tick();
    watchStatus("reconnecting");
    await tick();
    hideLauncher();
    await tick();
    expect(document.activeElement).not.toBe(behind);
    watchStatus("open");
    await tick();
    await tick();
    expect(document.activeElement).toBe(behind);
  });

  test("a new focus owner supersedes a deferred restore from an earlier outage", async () => {
    const old = document.body.appendChild(document.createElement("textarea"));
    old.focus();
    await dropConnection();
    showLauncher();
    watchStatus("open");
    await tick();
    await tick();
    const newer = document.body.appendChild(document.createElement("input"));
    newer.focus();
    watchStatus("reconnecting");
    await tick();
    vi.advanceTimersByTime(600);
    await tick();
    watchStatus("open");
    await tick();
    await tick();
    hideLauncher();
    await tick();
    expect(document.activeElement).toBe(newer);
    expect(document.activeElement).not.toBe(old);
  });

  test("a deferred restore carried through a second outage cannot run during a third outage", async () => {
    const behind = await deferredIntoSecondOutage();
    watchStatus("open");
    flushSync();
    watchStatus("reconnecting");
    flushSync();
    await tick();
    await tick();
    expect(document.activeElement).not.toBe(behind);
  });

  test("a deferred restore carried through a second outage cannot run after a later opening", async () => {
    const behind = await deferredIntoSecondOutage();
    watchStatus("open");
    flushSync();
    watchStatus("reconnecting");
    flushSync();
    watchStatus("open");
    flushSync();
    await tick();
    await tick();
    expect(document.activeElement).not.toBe(behind);
  });

  test.each([
    ["another cover", () => setCoverBlocking("screensaver", true)],
    ["an overlay", () => { overlayStack.ids = ["settings"]; }],
    ["a dialog", () => { promptState.open = true; }],
  ] as const)("does not restore focus while %s owns the keyboard", async (_owner, takeKeyboard) => {
    const behind = document.body.appendChild(document.createElement("textarea"));
    behind.focus();
    await dropConnection();
    takeKeyboard();
    watchStatus("open");
    await tick();
    await tick();
    expect(document.activeElement).not.toBe(behind);
  });

  test("does not take focus back after it moved elsewhere deliberately", async () => {
    const behind = document.body.appendChild(document.createElement("textarea"));
    behind.focus();
    await dropConnection();
    const other = document.body.appendChild(document.createElement("button"));
    other.focus();
    watchStatus("open");
    await tick();
    await tick();
    expect(document.activeElement).toBe(other);
  });

  test("does not focus an element removed during the outage", async () => {
    const behind = document.body.appendChild(document.createElement("textarea"));
    behind.focus();
    await dropConnection();
    const focus = vi.spyOn(behind, "focus");
    const before = tabFocusPulse.value;
    behind.remove();
    watchStatus("open");
    await tick();
    await tick();
    expect(focus).not.toHaveBeenCalled();
    expect(tabFocusPulse.value).toBe(before);
  });

  test.each(["terminal-host", "editor-host"] as const)("a removed %s node falls back to the active surface pulse", async (className) => {
    const host = document.body.appendChild(document.createElement("div"));
    host.className = className;
    const input = host.appendChild(document.createElement("textarea"));
    input.focus();
    const before = tabFocusPulse.value;
    await dropConnection();
    const focus = vi.spyOn(input, "focus");
    host.remove();
    watchStatus("open");
    await tick();
    await tick();
    expect(focus).not.toHaveBeenCalled();
    expect(tabFocusPulse.value).toBe(before + 1);
  });

  test("a survey over the active terminal refuses its return pulse", async () => {
    resetLayout([terminalTab({ id: "surveyed" })]);
    const host = document.body.appendChild(document.createElement("div"));
    host.className = "terminal-host";
    const input = host.appendChild(document.createElement("textarea"));
    input.focus();
    const before = tabFocusPulse.value;
    await dropConnection();
    showSurvey({ surveyId: "one", bodyMarkdown: "Question", options: ["Yes"] }, "surveyed");
    watchStatus("open");
    await tick();
    await tick();
    expect(tabFocusPulse.value).toBe(before);
  });

  test("returns focus after a recovery action reconnects the window", async () => {
    desktopWindow("dev-1");
    const behind = document.body.appendChild(document.createElement("textarea"));
    behind.focus();
    const target = await readyActions();
    button(target, "Restart connection").focus();
    button(target, "Restart connection").click();
    watchStatus("open");
    await tick();
    await tick();
    expect(document.activeElement).toBe(behind);
  });

  test("every watcher retry status says reconnecting in the title and dialog name", async () => {
    const target = await dropConnection();
    for (const status of ["reconnecting", "connecting"] as const) {
      watchStatus(status);
      await tick();
      expect(target.querySelector(".title")?.textContent).toBe("reconnecting to the chan server");
      expect(target.querySelector(".overlay")?.getAttribute("aria-label")).toBe("reconnecting to the chan server");
    }
  });

  test("the focused cover has no outline while its buttons retain focus outlines", () => {
    // jsdom does not paint focus rings; pin the component's CSS contract.
    const source = readFileSync("src/components/DisconnectOverlay.svelte", "utf8");
    expect(source).toMatch(/\.overlay:focus\s*\{\s*outline:\s*none;/);
    expect(source).not.toMatch(/\.actions\s+button:focus(?:-visible)?\s*\{\s*outline:\s*none;/);
  });

  test("waits eight seconds after the watcher leaves before showing recovery actions", async () => {
    desktopWindow("dev-1");
    const target = await dropConnection();
    expect(target.querySelector(".actions")).toBeNull();
    vi.advanceTimersByTime(3_000);
    watchStatus("connecting");
    await tick();
    vi.advanceTimersByTime(4_399);
    await tick();
    expect(target.querySelector(".actions")).toBeNull();
    vi.advanceTimersByTime(1);
    await tick();
    expect(button(target, "Restart connection")).toBeDefined();
    expect(button(target, "Abandon")).toBeDefined();
    const note = target.querySelector<HTMLElement>(".action-note")!;
    expect(note.textContent).toBe("Restart closes and reopens this computer's windows.");
    expect(button(target, "Restart connection").getAttribute("aria-describedby")).toBe(note.id);
    expect(document.activeElement).toBe(target.querySelector(".overlay"));
  });

  test("a brief return to open clears actions for the next outage", async () => {
    desktopWindow("dev-1");
    const target = await readyActions();
    expect(target.querySelector(".actions")).not.toBeNull();
    watchStatus("open");
    await tick();
    watchStatus("reconnecting");
    await tick();
    vi.advanceTimersByTime(600);
    await tick();
    expect(target.querySelector(".overlay")).not.toBeNull();
    expect(target.querySelector(".actions")).toBeNull();
  });

  test("Tab cycles through available actions and stays on the cover while none exist", async () => {
    desktopWindow("dev-1");
    const target = await dropConnection();
    const cover = target.querySelector<HTMLElement>(".overlay")!;
    const pressTab = (shiftKey = false) => cover.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }));
    expect(pressTab()).toBe(false);
    expect(pressTab(true)).toBe(false);
    expect(document.activeElement).toBe(cover);
    vi.advanceTimersByTime(7_400);
    await tick();
    pressTab();
    expect(document.activeElement).toBe(button(target, "Restart connection"));
    pressTab();
    expect(document.activeElement).toBe(button(target, "Abandon"));
    pressTab();
    expect(document.activeElement).toBe(button(target, "Restart connection"));
    pressTab(true);
    expect(document.activeElement).toBe(button(target, "Abandon"));
  });

  test("a later outage does not refocus a button activated in an earlier outage", async () => {
    desktopWindow("dev-1");
    const target = await readyActions();
    button(target, "Restart connection").click();
    await vi.waitFor(() => expect(button(target, "Restart connection").disabled).toBe(false));
    await vi.waitFor(() => expect(document.activeElement).toBe(button(target, "Restart connection")));
    watchStatus("open");
    await tick();
    watchStatus("reconnecting");
    await tick();
    vi.advanceTimersByTime(8_000);
    await tick();
    const behind = document.body.appendChild(document.createElement("textarea"));
    behind.focus();
    window.dispatchEvent(new Event("focus"));
    expect(document.activeElement).toBe(target.querySelector(".overlay"));
  });

  test("a restart that settles in a later outage leaves focus on its cover", async () => {
    desktopWindow("dev-1");
    let finish!: () => void;
    invoke.mockImplementation(() => new Promise<unknown>((resolve) => { finish = () => resolve(undefined); }));
    const target = await readyActions();
    button(target, "Restart connection").click();
    await tick();
    expect(finish).toBeTypeOf("function");
    watchStatus("open");
    await tick();
    watchStatus("reconnecting");
    await tick();
    vi.advanceTimersByTime(8_000);
    await tick();
    const cover = target.querySelector<HTMLElement>(".overlay")!;
    expect(document.activeElement).toBe(cover);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    await tick();
    expect(document.activeElement).toBe(cover);
  });

  test("a stale restart failure leaves a newer action pending and shows no old error", async () => {
    desktopWindow("dev-1");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let rejectOld!: (reason: Error) => void;
    let finishNew!: () => void;
    invoke.mockImplementation((command) => command === "reconnect_devserver_for_window"
      ? new Promise<unknown>((_resolve, reject) => { rejectOld = reject; })
      : new Promise<unknown>((resolve) => { finishNew = () => resolve(undefined); }));
    const target = await readyActions();
    button(target, "Restart connection").click();
    await tick();
    watchStatus("open");
    await tick();
    watchStatus("reconnecting");
    await tick();
    vi.advanceTimersByTime(8_000);
    await tick();
    button(target, "Abandon").click();
    await tick();
    expect(button(target, "Abandoning...").disabled).toBe(true);
    rejectOld(new Error("stale restart refusal"));
    await vi.advanceTimersByTimeAsync(0);
    await tick();
    expect(target.querySelector(".error"), "the old failure belongs to the old outage").toBeNull();
    expect(target.querySelector<HTMLButtonElement>(".actions .abandon")?.disabled, "the new action remains pending").toBe(true);
    finishNew();
    await tick();
  });
  test("shows a spinner, what it is doing, and the attempt with the time elapsed", async () => {
    ui.wsAttempt = 3;
    const target = await dropConnection();

    expect(target.querySelector(".spinner")).not.toBeNull();
    expect(target.querySelector(".title")?.textContent).toBe("reconnecting to the chan server");
    expect(target.querySelector(".meta")?.textContent).toBe("attempt 3 · 00:00");

    vi.advanceTimersByTime(65_000);
    await tick();
    expect(target.querySelector(".meta")?.textContent).toBe("attempt 3 · 01:05");
  });

  test("shows only the time elapsed before the first attempt", async () => {
    const target = await dropConnection();

    expect(target.querySelector(".meta")?.textContent).toBe("00:00");
  });

  test("offers no actions in a browser, even one on a devserver", async () => {
    history.replaceState(null, "", "/?lib=dev-1");
    const target = await dropConnection();

    expect(target.querySelector(".actions")).toBeNull();
  });

  test("offers no actions on a desktop window of the local library", async () => {
    desktopWindow("local");
    const target = await dropConnection();

    expect(target.querySelector(".actions")).toBeNull();
  });
});

describe("recovering a devserver-backed desktop window", () => {
  test("Restart connection and Abandon each ask the desktop", async () => {
    desktopWindow("dev-1");
    const target = await readyActions();

    button(target, "Restart connection").click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("reconnect_devserver_for_window", undefined));
    await vi.waitFor(() => expect(button(target, "Abandon").disabled).toBe(false));
    button(target, "Abandon").click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("abandon_devserver_for_window", undefined));
  });

  test("a pending action says so and holds both buttons", async () => {
    desktopWindow("dev-1");
    let finish!: () => void;
    invoke.mockImplementation(() => new Promise<undefined>((resolve) => (finish = () => resolve(undefined))));
    const target = await readyActions();

    button(target, "Restart connection").click();
    await tick();

    const buttons = [...target.querySelectorAll<HTMLButtonElement>(".actions button")];
    expect(buttons.map((b) => [b.textContent?.trim(), b.disabled])).toEqual([
      ["Restarting...", true],
      ["Abandon", true],
    ]);

    // Browsers can blur a button as it becomes disabled.
    button(target, "Restarting...").blur();
    finish();
    await vi.waitFor(() => expect(button(target, "Restart connection")?.disabled).toBe(false));
    await vi.waitFor(() => expect(document.activeElement).toBe(button(target, "Restart connection")));
  });

  test("a refused action shows the desktop's reason", async () => {
    desktopWindow("dev-1");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockRejectedValue(new Error("not allowed for this window"));
    const target = await readyActions();

    button(target, "Abandon").click();

    await vi.waitFor(() =>
      expect(target.querySelector('[role="alert"]')?.textContent).toBe("not allowed for this window"),
    );
  });
});

// chan-desktop shows the Computers launcher over a window as a second webview
// that holds the window's keyboard, marking the page's root while it shows
// (launcher_transition.js hostCovered); the page's window blurs, and focuses
// again when the launcher hides. A focus() in the page while the launcher
// shows would take the keyboard back from it.
function showLauncher(): void {
  document.documentElement.setAttribute("data-launcher-shown", "");
  window.dispatchEvent(new Event("blur"));
}

function hideLauncher(): void {
  document.documentElement.removeAttribute("data-launcher-shown");
  window.dispatchEvent(new Event("focus"));
}

describe("the Computers launcher over a reconnecting window", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-launcher-shown");
  });

  test("a launcher shown and hidden over the card leaves it focused and working", async () => {
    desktopWindow("dev-1");
    const target = await readyActions();
    const cover = target.querySelector<HTMLElement>(".overlay")!;
    expect(document.activeElement).toBe(cover);

    showLauncher();
    await tick();
    hideLauncher();
    await tick();

    expect(document.activeElement).toBe(cover);
    cover.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(button(target, "Restart connection"));
    button(target, "Restart connection").click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("reconnect_devserver_for_window", undefined));
  });

  test("the action the user moved to keeps focus across the launcher", async () => {
    desktopWindow("dev-1");
    const target = await readyActions();
    const cover = target.querySelector<HTMLElement>(".overlay")!;
    cover.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true, shiftKey: true }));
    expect(document.activeElement).toBe(button(target, "Abandon"));

    showLauncher();
    hideLauncher();
    await tick();

    expect(document.activeElement).toBe(button(target, "Abandon"));
  });

  test("a drop while the launcher shows leaves it the keyboard, and the card takes it on hide", async () => {
    desktopWindow("dev-1");
    showLauncher();
    const target = await dropConnection();
    await tick();

    expect(document.activeElement).not.toBe(target.querySelector(".overlay"));

    hideLauncher();
    await tick();

    expect(document.activeElement).toBe(target.querySelector(".overlay"));
  });

  test("a recovery that settles while the launcher shows leaves it the keyboard", async () => {
    desktopWindow("dev-1");
    let finish!: () => void;
    invoke.mockImplementation(() => new Promise<undefined>((resolve) => (finish = () => resolve(undefined))));
    const target = await readyActions();
    button(target, "Restart connection").click();
    await tick();
    // A browser drops focus from a button as it becomes disabled; jsdom keeps
    // it, so focus goes to a stray element instead.
    const stray = document.createElement("textarea");
    document.body.append(stray);
    stray.focus();

    showLauncher();
    finish();
    await vi.waitFor(() => expect(button(target, "Restart connection")?.disabled).toBe(false));
    await tick();
    expect(document.activeElement).not.toBe(button(target, "Restart connection"));

    hideLauncher();
    await tick();
    expect(document.activeElement).toBe(button(target, "Restart connection"));
  });

  test("focus that left for the page behind returns to the card when the window focuses", async () => {
    desktopWindow("dev-1");
    const target = await dropConnection();
    const behind = document.createElement("textarea");
    document.body.append(behind);
    behind.focus();

    window.dispatchEvent(new Event("focus"));
    await tick();

    expect(document.activeElement).toBe(target.querySelector(".overlay"));
  });

  test("a cover over the card keeps its own focus when the window focuses", async () => {
    desktopWindow("dev-1");
    await dropConnection();
    const lock = document.createElement("div");
    lock.setAttribute("data-cover", "screensaver");
    const pin = document.createElement("input");
    lock.append(pin);
    document.body.append(lock);
    pin.focus();

    window.dispatchEvent(new Event("focus"));
    await tick();

    expect(document.activeElement).toBe(pin);
  });
});

describe("the desktop's recovery calls", () => {
  test("refuse outside the desktop", async () => {
    await expect(reconnectDevserverForWindow()).rejects.toThrow("not running under Tauri");
    await expect(abandonDevserverForWindow()).rejects.toThrow("not running under Tauri");
  });

  test("log a refused call and pass the failure on", async () => {
    desktopWindow("dev-1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockRejectedValue(new Error("denied"));

    await expect(reconnectDevserverForWindow()).rejects.toThrow("denied");
    await expect(abandonDevserverForWindow()).rejects.toThrow("denied");
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
