// Real Ghostty input, the desktop capture script and the mounted app share
// the same DOM event. Socket frames and layout changes identify its owner.

import type { Terminal } from "@chan/ghostty-web-ng";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const ghostty = vi.hoisted(() => ({
  module: null as WebAssembly.Module | null,
  terminals: [] as Terminal[],
}));

vi.mock("../terminal/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../terminal/backend")>();
  const { recordingKit } = await import("../__tests__/ghosttyTab");
  return { ...actual, loadGhosttyKit: async () => recordingKit(ghostty, actual.ghosttyKitFrom) };
});

import { mountApp, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { compileGhosttyCore, ghosttyLineText, installSoftwareCanvas } from "../__tests__/ghosttyTab";
import { terminalPreferences } from "../__tests__/standalone";
import { fileTab, resetLayout, terminalTab } from "../__tests__/tabs";
import { attach, receive, resetTerminals, sentFrames, TerminalSocket } from "../__tests__/terminalTab";
import { setSocketFactory } from "../api/transport";
import { demoSocketFactory } from "../demo/socket";
import { confirmState } from "../state/confirm.svelte";
import { hydrateOverrides } from "../state/keymapOverrides.svelte";
import { currentOS, currentPlatform } from "../state/shortcuts";
import { launcherPanel, searchPanel, ui } from "../state/store.svelte";
import { clearRecentlyClosedTabsForTest, layout, splitPane, type LeafNode } from "../state/tabs.svelte";

const KEY_BRIDGE = readFileSync("../../../desktop/src-tauri/src/key_bridge.js", "utf8");
const PANE = "ghostty-key-pane";
const cleanups: Array<() => void> = [];
const nativeInvoke = vi.fn(async (_command: string) => undefined);
const commands: string[] = [];

stubAppEnvironment();

beforeAll(async () => {
  await compileGhosttyCore(ghostty);
});

beforeEach(() => {
  installSoftwareCanvas();
  vi.mocked(document.fonts.load).mockReset().mockResolvedValue([]);
  nativeInvoke.mockClear();
  commands.splice(0);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  launcherPanel.open = false;
  searchPanel.open = false;
  confirmState.open = false;
  ui.terminalOnly = false;
  ui.terminalControl = false;
  hydrateOverrides(null);
  await unmountApp();
  clearRecentlyClosedTabsForTest();
  resetTerminals();
  ghostty.terminals.splice(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function installDesktopBridge(): void {
  // Forward registrations to the real window so capture and bubbling keep
  // their browser ordering; retain each listener for teardown.
  const host = {
    __TAURI__: { core: { invoke: nativeInvoke } },
    addEventListener(type: string, listener: EventListener, options?: boolean) {
      window.addEventListener(type, listener, options);
      cleanups.push(() => window.removeEventListener(type, listener, options));
    },
    dispatchEvent: window.dispatchEvent.bind(window),
  };
  new Function("window", "document", "navigator", "location", "CustomEvent", KEY_BRIDGE)(
    host, document, navigator, location, CustomEvent,
  );
  const record = (event: Event) => commands.push((event as CustomEvent<{ name: string }>).detail.name);
  window.addEventListener("chan:command", record);
  cleanups.push(() => window.removeEventListener("chan:command", record));
}

async function openTerminal(withNeighbour = false) {
  await mountApp(undefined, { preferences: terminalPreferences() });
  setSocketFactory((url) => new URL(url, location.href).pathname === "/api/terminal/ws"
    ? new TerminalSocket(url) as unknown as WebSocket
    : demoSocketFactory(url));
  const pane = resetLayout([
    terminalTab({ id: "shell" }),
    ...(withNeighbour ? [fileTab({ id: "neighbour" })] : []),
  ], { id: PANE });
  await vi.waitFor(() => expect(TerminalSocket.all).toHaveLength(1));
  const socket = TerminalSocket.all[0]!;
  await attach(socket);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  await settle();
  expect(ghostty.terminals).toHaveLength(1);
  expect(document.querySelector(".terminal-host canvas")).not.toBeNull();
  const input = document.querySelector<HTMLTextAreaElement>('.terminal-host textarea[aria-label="Terminal input"]')!;
  expect(input).not.toBeNull();
  input.focus();
  expect(document.activeElement).toBe(input);
  socket.sent.splice(0);
  nativeInvoke.mockClear();
  return { input, socket, pane };
}

function press(input: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  input.dispatchEvent(event);
  return event;
}

function inputs(socket: TerminalSocket) {
  return sentFrames(socket).filter((frame) => frame.type === "input");
}

describe.each([
  ["linux", "Mozilla/5.0 (X11; Linux x86_64)"],
  ["windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"],
  ["mac", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)"],
] as const)("Ghostty desktop keys on %s", (os, userAgent) => {
  beforeEach(() => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke: nativeInvoke });
    installDesktopBridge();
    expect(currentOS()).toBe(os);
    expect(currentPlatform()).toBe("native");
  });

  test("Ctrl+Shift+D leaves an exited tab and its neighbour in place", async () => {
    const { input, socket } = await openTerminal(true);
    await receive(socket, { type: "exit", code: 0 });
    await settle();
    const term = ghostty.terminals[0]!;
    expect(Array.from({ length: term.rows }, (_, row) => ghosttyLineText(term, row)).join("\n"))
      .toContain("process exited (0)");

    const shifted = press(input, { key: "D", code: "KeyD", keyCode: 68, ctrlKey: true, shiftKey: true });
    // A close awaits its sink; observe chord ownership before that async
    // close could be mistaken for the following plain Ctrl+D.
    expect(shifted.defaultPrevented).toBe(false);
    await settle();
    expect((layout.nodes[PANE] as LeafNode).tabs.map((tab) => tab.id)).toEqual(["shell", "neighbour"]);
    expect(inputs(socket)).toEqual([]);

    // The adjacent unshifted chord proves the exited close path is live.
    const root = input.closest(".terminal-tab")!;
    const bubbled = vi.fn();
    root.addEventListener("keydown", bubbled);
    cleanups.push(() => root.removeEventListener("keydown", bubbled));
    const plain = press(input, { key: "d", code: "KeyD", keyCode: 68, ctrlKey: true });
    expect(plain.defaultPrevented).toBe(true);
    expect(bubbled).not.toHaveBeenCalled();
    await vi.waitFor(() => expect((layout.nodes[PANE] as LeafNode).tabs.map((tab) => tab.id)).toEqual(["neighbour"]));
  });

  test.each([
    ["K", "k", "\x0b"],
    ["S", "s", "\x13"],
  ])("plain Ctrl+%s reaches the socket without opening a panel", async (code, key, data) => {
    const { input, socket } = await openTerminal();
    press(input, { key, code: `Key${code}`, keyCode: code.charCodeAt(0), ctrlKey: true });
    await settle();

    expect(inputs(socket)).toEqual([{ type: "input", data }]);
    expect(launcherPanel.open).toBe(false);
    expect(searchPanel.open).toBe(false);
    expect(commands).toEqual([]);
    expect(nativeInvoke).not.toHaveBeenCalled();
  });

  test.each([
    ["previous", "[", "BracketLeft", 219, "app.pane.prev"],
    ["next", "]", "BracketRight", 221, "app.pane.next"],
  ] as const)("moves to the %s pane from the real terminal input", async (direction, key, code, keyCode, command) => {
    const { input, socket } = await openTerminal();
    const next = splitPane(PANE, "row");
    expect(next).not.toBeNull();
    const previous = splitPane(next!, "row");
    expect(previous).not.toBeNull();
    layout.activePaneId = PANE;
    await settle();
    input.focus();
    expect(document.activeElement).toBe(input);

    const event = press(input, { key, code, keyCode, ...(os === "mac" ? { metaKey: true } : { altKey: true }) });
    await settle();
    expect(layout.activePaneId).toBe(direction === "next" ? next : previous);
    expect(event.defaultPrevented).toBe(true);
    expect(inputs(socket)).toEqual([]);
    expect(commands).toEqual(os === "mac" ? [command] : []);
    expect(nativeInvoke).not.toHaveBeenCalled();
  });

  test.each([
    ["right", "/", false, "row", "app.pane.splitRight"],
    ["down", "?", true, "column", "app.pane.splitDown"],
  ] as const)("splits %s from the real terminal input", async (_name, key, shiftKey, direction, command) => {
    const { input, socket } = await openTerminal();
    const event = press(input, {
      key, code: "Slash", keyCode: 191, shiftKey,
      ...(os === "mac" ? { metaKey: true } : { ctrlKey: true, altKey: true }),
    });
    await settle();

    expect(Object.values(layout.nodes).filter((node) => node.kind === "leaf")).toHaveLength(2);
    expect(layout.nodes[layout.rootId]).toMatchObject({ kind: "split", direction });
    expect(layout.activePaneId).not.toBe(PANE);
    expect(event.defaultPrevented).toBe(true);
    expect(inputs(socket)).toEqual([]);
    expect(commands).toEqual(os === "mac" ? [command] : []);
    expect(nativeInvoke).not.toHaveBeenCalled();
  });
});
