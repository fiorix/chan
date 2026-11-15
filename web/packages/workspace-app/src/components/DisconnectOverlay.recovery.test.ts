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

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { abandonDevserverForWindow, reconnectDevserverForWindow } from "../api/desktop";
import { overlayStack, ui } from "../state/store.svelte";
import { WINDOW_TAB_BAR_MIN_HEIGHT, windowTabBar } from "../state/windowTabBar.svelte";
import DisconnectOverlay from "./DisconnectOverlay.svelte";

type TauriWindow = { __TAURI_INTERNALS__?: { invoke: (cmd: string) => Promise<unknown> } };

let invoke: ReturnType<typeof vi.fn<(cmd: string) => Promise<unknown>>>;
const mounted: Array<Record<string, unknown>> = [];

beforeEach(() => {
  vi.useFakeTimers();
  invoke = vi.fn(async () => undefined);
  ui.ws = "open";
  ui.wsAttempt = 0;
  windowTabBar.on = false;
  windowTabBar.height = WINDOW_TAB_BAR_MIN_HEIGHT;
  overlayStack.ids = [];
});

afterEach(() => {
  for (const view of mounted.splice(0)) unmount(view);
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
  ui.ws = "reconnecting";
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
    ui.ws = "reconnecting";
    await tick();
    vi.advanceTimersByTime(500);
    ui.ws = "connecting";
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

  test("waits eight seconds after the watcher leaves before showing recovery actions", async () => {
    desktopWindow("dev-1");
    const target = await dropConnection();
    expect(target.querySelector(".actions")).toBeNull();
    vi.advanceTimersByTime(3_000);
    ui.ws = "connecting";
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
    ui.ws = "open";
    await tick();
    ui.ws = "reconnecting";
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
    ui.ws = "open";
    await tick();
    ui.ws = "reconnecting";
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
    ui.ws = "open";
    await tick();
    ui.ws = "reconnecting";
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
    ui.ws = "open";
    await tick();
    ui.ws = "reconnecting";
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
