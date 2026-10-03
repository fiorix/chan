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
// command clears the window and asks the desktop to close it, and so do the
// command deck's Close window and a chord assigned to it. A hide discards
// nothing. Every way the
// page asks the desktop to hide or close its window, and an unload, first
// writes what its tabs hold and have not saved, a drawing's stroke still
// waiting for its serialize included, to the recovery buffer the next open
// of the file reads. A hide or close the desktop makes with no page code,
// and a webview destroyed with no unload event, write nothing.

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
  hideWindowFromCloseConfirm: vi.fn(async () => {}),
  reloadWindow: vi.fn(async () => {}),
}));

vi.mock("./state/store.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state/store.svelte")>()),
  discardWindowSession: vi.fn(async () => {}),
  persistLayoutToHash: vi.fn(),
}));

import { hideWindowFromCloseConfirm, reloadWindow, requestCloseWindow } from "./api/desktop";
import { hostCommand, mountApp, press, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { drawableBoard, drawableBoards } from "./__tests__/excalidraw";
import { fileTab, readTab, resetLayout } from "./__tests__/tabs";
import { allCommands } from "./state/commands";
import { bufferKey, divergentBufferOrNull } from "./state/editorBuffer";
import { assignOverride, hydrateOverrides } from "./state/keymapOverrides.svelte";
import { setTabContent, type FileTab } from "./state/tabs.svelte";
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
    hydrateOverrides(null);
  });

  /// A drawing open on a board a test can draw on, with a stroke drawn and
  /// its serialize still waiting on a clock that does not move, and `beside`
  /// open after it in the pane.
  async function strokeInDebounce(beside: FileTab[] = []): Promise<void> {
    drawableBoards();
    resetLayout([
      fileTab({
        id: "board", path: BOARD, fileKind: "text", mode: "canvas",
        content: EMPTY, saved: EMPTY, savedMtimeNs: DISK_MTIME_NS,
      }),
      ...beside,
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

  /// A stroke waiting as `strokeInDebounce` leaves it, beside a text tab
  /// whose edit waits on its recovery write's debounce.
  async function strokeAndEditInWait(): Promise<void> {
    await strokeInDebounce([fileTab({ id: "a-file", path: "README.md", content: "hello", saved: "hello" })]);
    setTabContent(readTab("a-file")!, "hello, edited");
    await settle();
  }

  const HIDE_CHORD = { key: "H", code: "KeyH", ctrlKey: true, shiftKey: true } as const;

  function runDeckRow(id: string): void {
    allCommands().find((command) => command.id === id)!.run();
  }

  function pressAssignedChord(id: string): void {
    assignOverride(id, "Ctrl+Alt+J", "web");
    press({ key: "j", code: "KeyJ", ctrlKey: true, altKey: true });
  }

  const HIDES_AND_CLOSES: [way: string, go: () => Promise<void>, asks: "hide" | "close"][] = [
    ["the red dot's Hide", async () => {
      hostCommand("app.window.confirmClose");
      await settle();
      document.querySelector<HTMLButtonElement>(".actions button.hide")!.click();
    }, "hide"],
    ["the hide chord", async () => void press(HIDE_CHORD), "hide"],
    ["the host's hide command", async () => hostCommand("app.window.hide"), "hide"],
    ["the command deck's Hide window", async () => runDeckRow("app.window.hide"), "hide"],
    ["a chord assigned to Hide window", async () => pressAssignedChord("app.window.hide"), "hide"],
    ["the command deck's Close window", async () => runDeckRow("app.window.close"), "close"],
    ["a chord assigned to Close window", async () => pressAssignedChord("app.window.close"), "close"],
  ];

  test.each(HIDES_AND_CLOSES)(
    "%s leaves a drawing's pending stroke and a text tab's queued edit for the next open",
    async (_way, go, asks) => {
      await strokeAndEditInWait();
      await go();

      expect({
        asked: {
          hide: vi.mocked(hideWindowFromCloseConfirm).mock.calls.length,
          close: vi.mocked(requestCloseWindow).mock.calls.length,
        },
        drawing: nextOpenOffers(BOARD, EMPTY),
        text: nextOpenOffers("README.md", "hello"),
      }).toEqual({
        asked: asks === "hide" ? { hide: 1, close: 0 } : { hide: 0, close: 1 },
        drawing: expect.stringContaining("last-stroke"),
        text: "hello, edited",
      });
    },
  );

  test.each(HIDES_AND_CLOSES)(
    "%s discards the window's session before it asks the desktop only where it closes",
    async (_way, go, asks) => {
      await go();

      const discard = vi.mocked(discardWindowSession).mock;
      const ask = vi.mocked(requestCloseWindow).mock;
      expect({
        discards: discard.calls,
        // The order the two calls were made in, read where both were made.
        discardedFirst:
          asks === "close" ? (discard.invocationCallOrder[0] ?? Infinity) < ask.invocationCallOrder[0]! : null,
      }).toEqual(asks === "close" ? { discards: [[]], discardedFirst: true } : { discards: [], discardedFirst: null });
    },
  );

  test("the close-window command leaves a text tab's edit whose recovery write is queued", async () => {
    vi.useFakeTimers();
    setTabContent(readTab("a-file")!, "hello, edited");
    await settle();
    hostCommand("app.window.close");

    expect(nextOpenOffers("README.md", "hello")).toBe("hello, edited");
  });
});
