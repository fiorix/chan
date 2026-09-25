// @vitest-environment jsdom
//
// Closing a window. The desktop host prevents an OS close (the red dot) and
// sends `app.window.confirmClose`: while the reconnect overlay is up, or when
// the window holds no tab, the window closes straight away, discarding its
// session so nothing is left recorded; any other window asks Hide / Close /
// Cancel. A full-window cover drops every host command except this one, since
// the host is already waiting on the answer. A terminal-only window accepts
// it too. On the web, closing the browser tab is a hide: it flushes buffers
// and the layout and discards nothing, while the explicit close-window
// command clears the window and asks the desktop to close it.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xterm);
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fit);
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).search);
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serialize);
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinks);

const host = vi.hoisted(() => ({ desktop: true }));

vi.mock("./api/desktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/desktop")>()),
  isTauriDesktop: () => host.desktop,
  requestCloseWindow: vi.fn(async () => {}),
  reloadWindow: vi.fn(async () => {}),
}));

vi.mock("./state/store.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state/store.svelte")>()),
  discardWindowSession: vi.fn(async () => {}),
  persistLayoutToHash: vi.fn(),
}));

import { reloadWindow, requestCloseWindow } from "./api/desktop";
import { hostCommand, mountApp, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { fileTab, resetLayout } from "./__tests__/tabs";
import { resolveCloseConfirm } from "./state/closeConfirm.svelte";
import { lockNow, screensaver } from "./state/screensaver.svelte";
import { discardWindowSession, persistLayoutToHash, ui } from "./state/store.svelte";
import { TERMINAL_ONLY_COMMANDS } from "./state/windowMode";

stubAppEnvironment();

function prompt(): HTMLElement | null {
  return document.querySelector(".actions button.cancel")?.closest<HTMLElement>(".card") ?? null;
}

beforeEach(async () => {
  host.desktop = true;
  await mountApp();
  resetLayout([fileTab({ id: "a-file", path: "README.md", content: "hello", saved: "hello" })]);
  await settle();
  vi.clearAllMocks();
});

afterEach(async () => {
  resolveCloseConfirm("cancel");
  ui.disconnectBlocking = false;
  screensaver.locked = false;
  await settle();
  await unmountApp();
});

describe("the desktop's close request", () => {
  test("asks Hide / Close / Cancel on a live window with tabs", async () => {
    hostCommand("app.window.confirmClose");
    await settle();

    expect(prompt()?.textContent).toContain("close this window?");
    expect(discardWindowSession).not.toHaveBeenCalled();
    expect(requestCloseWindow).not.toHaveBeenCalled();
  });

  test("closes at once while the reconnect overlay is up", async () => {
    ui.disconnectBlocking = true;
    await settle();
    hostCommand("app.window.confirmClose");
    await settle();

    expect(prompt()).toBeNull();
    expect(discardWindowSession).toHaveBeenCalledWith({ reap: true });
    expect(requestCloseWindow).toHaveBeenCalledTimes(1);
  });

  test("closes at once when the window holds no tab", async () => {
    resetLayout([]);
    await settle();
    hostCommand("app.window.confirmClose");
    await settle();

    expect(prompt()).toBeNull();
    expect(discardWindowSession).toHaveBeenCalledWith({ reap: true });
    expect(requestCloseWindow).toHaveBeenCalledTimes(1);
  });

  test("gets through a full-window cover that drops every other command", async () => {
    await vi.waitFor(() => expect(screensaver.loaded).toBe(true));
    lockNow();
    await settle();
    hostCommand("app.window.reload");
    hostCommand("app.window.confirmClose");
    await settle();

    expect(reloadWindow).not.toHaveBeenCalled();
    expect(prompt()).not.toBeNull();
  });

  test("is accepted by a terminal-only window", () => {
    expect(TERMINAL_ONLY_COMMANDS.has("app.window.confirmClose")).toBe(true);
  });
});

describe("closing a web window", () => {
  test("closing the browser tab flushes the layout and discards nothing", async () => {
    window.dispatchEvent(new Event("beforeunload"));
    window.dispatchEvent(new Event("pagehide"));

    expect(persistLayoutToHash).toHaveBeenCalledTimes(2);
    expect(discardWindowSession).not.toHaveBeenCalled();
  });

  test("the close-window command discards the window, and asks the desktop only there", async () => {
    hostCommand("app.window.close");
    await settle();
    expect(discardWindowSession).toHaveBeenCalledTimes(1);
    expect(requestCloseWindow).toHaveBeenCalledTimes(1);

    host.desktop = false;
    vi.clearAllMocks();
    resetLayout([fileTab({ id: "b-file", path: "README.md", content: "hello", saved: "hello" })]);
    await settle();
    hostCommand("app.window.close");
    await settle();
    expect(discardWindowSession).toHaveBeenCalledTimes(1);
    expect(requestCloseWindow).not.toHaveBeenCalled();
  });
});
