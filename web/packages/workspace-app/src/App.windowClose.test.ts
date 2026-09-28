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
// command clears the window and asks the desktop to close it. However a
// window goes, what its tabs hold and have not saved, a drawing's stroke
// still waiting for its serialize included, is where the next open of the
// file finds it.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinksAddonModule());

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
import { drawableBoard, drawableBoards } from "./__tests__/excalidraw";
import { fileTab, readTab, resetLayout } from "./__tests__/tabs";
import { bufferKey, divergentBufferOrNull } from "./state/editorBuffer";
import { setTabContent } from "./state/tabs.svelte";
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

describe("what a window that goes leaves for the next open", () => {
  const BOARD = "notes/board.excalidraw";
  const EMPTY = '{"type":"excalidraw","version":2,"source":"chan","elements":[],"appState":{},"files":{}}';
  // The files' mtime on disk, well before any recovery write's stamp.
  const DISK_MTIME_NS = "1000000000";

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  /// A drawing open on a board a test can draw on, with a stroke drawn and
  /// its serialize still waiting on a clock that does not move.
  async function strokeInDebounce(): Promise<void> {
    drawableBoards();
    resetLayout([
      fileTab({
        id: "board", path: BOARD, fileKind: "text", mode: "canvas",
        content: EMPTY, saved: EMPTY, savedMtimeNs: DISK_MTIME_NS,
      }),
    ]);
    const board = await drawableBoard();
    await board.start();
    await settle();
    vi.useFakeTimers();
    board.stroke({ id: "last-stroke", version: 1 });
    expect(readTab("board")?.content).toBe(EMPTY);
  }

  /// What the next page load's open of `path` offers from the recovery
  /// buffer, over the file as it is on disk. A load's id is fixed when the
  /// load starts, so the entry this one wrote is relabelled as an earlier
  /// load's, which is how the next load reads it.
  function nextOpenOffers(path: string, disk: string): string {
    const raw = localStorage.getItem(bufferKey(path));
    if (raw === null) return "nothing stored";
    localStorage.setItem(bufferKey(path), JSON.stringify({ ...JSON.parse(raw), sessionId: "an-earlier-load" }));
    return divergentBufferOrNull(path, path, disk, DISK_MTIME_NS)?.content ?? "nothing offered";
  }

  const WAYS: [string, () => Promise<void>][] = [
    ["the close-window command", async () => hostCommand("app.window.close")],
    ["the red dot while reconnecting", async () => {
      ui.disconnectBlocking = true;
      hostCommand("app.window.confirmClose");
    }],
    ["the red dot's Close", async () => {
      hostCommand("app.window.confirmClose");
      await settle();
      document.querySelector<HTMLButtonElement>(".actions button.close")!.click();
    }],
    ["a pagehide", async () => void window.dispatchEvent(new Event("pagehide"))],
    ["a beforeunload", async () => void window.dispatchEvent(new Event("beforeunload"))],
  ];

  test.each(WAYS)("%s leaves a drawing's pending stroke for the next open", async (_way, go) => {
    await strokeInDebounce();
    await go();

    expect(nextOpenOffers(BOARD, EMPTY)).toContain("last-stroke");
  });

  test("the close-window command leaves a text tab's edit whose recovery write is queued", async () => {
    vi.useFakeTimers();
    setTabContent(readTab("a-file")!, "hello, edited");
    await settle();
    hostCommand("app.window.close");

    expect(nextOpenOffers("README.md", "hello")).toBe("hello, edited");
  });
});
