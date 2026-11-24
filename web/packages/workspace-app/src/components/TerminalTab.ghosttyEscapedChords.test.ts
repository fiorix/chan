// A chord the terminal lets out to the app, pressed in a real Ghostty
// widget under the mounted app in a browser. The widget cancels no key its
// embedder claims, so whether the browser still acts on one is the app's
// answer alone: each handler that acts on a chord cancels it, and a chord
// the app declines keeps its default.

import type { Terminal } from "@chan/ghostty-web-ng";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const ghostty = vi.hoisted(() => ({
  module: null as WebAssembly.Module | null,
  terminals: [] as Terminal[],
}));

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
// The reload chord would navigate the test's own document.
vi.mock("../api/desktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/desktop")>()),
  reloadWindow: vi.fn(async () => {}),
}));

import { mountApp, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { compileGhosttyCore, installSoftwareCanvas } from "../__tests__/ghosttyTab";
import { terminalPreferences } from "../__tests__/standalone";
import { fileTab, resetLayout, terminalTab } from "../__tests__/tabs";
import { attach, receive, resetTerminals, sentFrames, TerminalSocket } from "../__tests__/terminalTab";
import { reloadWindow } from "../api/desktop";
import { setSocketFactory } from "../api/transport";
import { demoSocketFactory } from "../demo/socket";
import { confirmState } from "../state/confirm.svelte";
import { hydrateOverrides } from "../state/keymapOverrides.svelte";
import { closePaneTree, paneTree } from "../state/paneTree.svelte";
import { currentOS, currentPlatform, osChord, SHORTCUTS, shouldEscapeTerminal } from "../state/shortcuts";
import { closeSettings, launcherPanel, searchPanel, ui } from "../state/store.svelte";
import { cancelPaneMode, clearRecentlyClosedTabsForTest, paneMode } from "../state/tabs.svelte";

const PANE = "ghostty-escape-pane";

stubAppEnvironment();

beforeAll(async () => {
  await compileGhosttyCore(ghostty);
});

beforeEach(() => {
  installSoftwareCanvas();
  vi.mocked(document.fonts.load).mockReset().mockResolvedValue([]);
  vi.mocked(reloadWindow).mockClear();
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64)");
  expect(currentOS()).toBe("linux");
  expect(currentPlatform()).toBe("web");
});

afterEach(async () => {
  if (paneMode.active) cancelPaneMode();
  closePaneTree();
  closeSettings();
  launcherPanel.open = false;
  searchPanel.open = false;
  confirmState.open = false;
  ui.terminalControl = false;
  hydrateOverrides(null);
  await unmountApp();
  clearRecentlyClosedTabsForTest();
  resetTerminals();
  ghostty.terminals.splice(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/// The app with one terminal and a file tab beside it, the keyboard in the
/// widget's own input.
async function openTerminal() {
  await mountApp(undefined, { preferences: terminalPreferences() });
  setSocketFactory((url) => new URL(url, location.href).pathname === "/api/terminal/ws"
    ? new TerminalSocket(url) as unknown as WebSocket
    : demoSocketFactory(url));
  resetLayout([terminalTab({ id: "shell" }), fileTab({ id: "neighbour" })], { id: PANE });
  await vi.waitFor(() => expect(TerminalSocket.all).toHaveLength(1));
  const socket = TerminalSocket.all[0]!;
  await attach(socket);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  await settle();
  expect(ghostty.terminals).toHaveLength(1);
  const input = document.querySelector<HTMLTextAreaElement>('.terminal-host textarea[aria-label="Terminal input"]')!;
  expect(input).not.toBeNull();
  input.focus();
  expect(document.activeElement).toBe(input);
  socket.sent.splice(0);
  return { input, socket };
}

function press(input: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  input.dispatchEvent(event);
  return event;
}

function inputs(socket: TerminalSocket) {
  return sentFrames(socket).filter((frame) => frame.type === "input");
}

/// Every chord the registry lets out of a terminal in a browser on Linux,
/// as the keydown a browser sends for it.
const ESCAPED: Record<string, KeyboardEventInit> = {
  "app.launcher.toggle": { key: "k", code: "KeyK", ctrlKey: true, altKey: true },
  "app.settings.open": { key: ",", code: "Comma", ctrlKey: true },
  "app.search.toggle": { key: "s", code: "KeyS", ctrlKey: true, altKey: true },
  "app.terminal.toggle": { key: "T", code: "KeyT", ctrlKey: true, shiftKey: true },
  "app.pane.mode": { key: ".", code: "Period", ctrlKey: true },
  "app.pane.flip": { key: "`", code: "Backquote", ctrlKey: true },
  "app.window.reload": { key: "R", code: "KeyR", ctrlKey: true, shiftKey: true },
  "app.pane.prev": { key: "[", code: "BracketLeft", altKey: true },
  "app.pane.next": { key: "]", code: "BracketRight", altKey: true },
  "app.pane.splitRight": { key: "/", code: "Slash", ctrlKey: true, altKey: true },
  "app.pane.splitDown": { key: "?", code: "Slash", ctrlKey: true, altKey: true, shiftKey: true },
  "app.pane.tree": { key: "A", code: "KeyA", ctrlKey: true, shiftKey: true },
  "app.tab.reopenClosed": { key: "T", code: "KeyT", ctrlKey: true, altKey: true, shiftKey: true },
  "app.tab.next": { key: "}", code: "BracketRight", altKey: true, shiftKey: true },
  "app.tab.prev": { key: "{", code: "BracketLeft", altKey: true, shiftKey: true },
  "app.tab.jump": { key: "1", code: "Digit1", ctrlKey: true, altKey: true },
  "terminal.richPrompt": { key: "p", code: "KeyP", ctrlKey: true, altKey: true },
  "terminal.find": { key: "F", code: "KeyF", ctrlKey: true, shiftKey: true },
};

describe("a chord the terminal lets out to the app, in a browser", () => {
  test("the table holds every chord the registry lets out of a terminal here", () => {
    const registry = SHORTCUTS.filter((s) => s.escapeTerminal && osChord(s, "web", "linux")).map((s) => s.id);
    expect(Object.keys(ESCAPED).sort()).toEqual(registry.sort());
  });

  test.each(Object.entries(ESCAPED))("%s is cancelled by the handler that acts on it", async (_id, init) => {
    const { input, socket } = await openTerminal();
    const event = press(input, init);
    expect(shouldEscapeTerminal(event), "the terminal lets the chord out").toBe(true);
    expect(event.defaultPrevented, "the app took the key").toBe(true);
    await settle();
    expect(inputs(socket), "nothing reaches the shell").toEqual([]);
  });

  test("a chord the app declines keeps its default: the pane tree's in a control terminal", async () => {
    const { input, socket } = await openTerminal();
    ui.terminalControl = true;
    await settle();
    const event = press(input, ESCAPED["app.pane.tree"]!);
    expect(shouldEscapeTerminal(event), "the terminal lets the chord out").toBe(true);
    expect(paneTree.open, "the tree does not open here").toBe(false);
    expect(event.defaultPrevented, "nothing took the key, so the browser still may").toBe(false);
    expect(inputs(socket)).toEqual([]);

    // The same chord where the tree may open is the app's.
    ui.terminalControl = false;
    await settle();
    const taken = press(input, ESCAPED["app.pane.tree"]!);
    expect(paneTree.open).toBe(true);
    expect(taken.defaultPrevented).toBe(true);
  });
});
