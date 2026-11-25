// @vitest-environment jsdom
//
// Escape closes a terminal menu before the widget encodes the key. The next
// Escape reaches the PTY through the real widget and chan's key listener.

import { tick } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));

import { mountGhosttyTerminal } from "../__tests__/ghosttyTab";
import { terminalPreferences } from "../__tests__/standalone";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import { tabMenu } from "../state/tabMenu.svelte";
import TerminalTab from "./TerminalTab.svelte";
import {
  attach,
  installTerminalDom,
  openBodyMenu,
  openTerminalMenu,
  receive,
  resetTerminals,
  seatTerminals,
  sentFrames,
  terminalTab,
  TerminalSocket,
} from "../__tests__/terminalTab";

installTerminalDom();

afterEach(() => {
  resetTerminals();
  __testSetStandalonePreferences(null);
});

async function attached() {
  __testSetStandalonePreferences(terminalPreferences());
  const [tab] = seatTerminals([terminalTab()]);
  const { target } = await mountGhosttyTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  await vi.waitFor(() => expect(terminalInput(target), "the terminal took focus").toBe(document.activeElement));
  expect(target.querySelector(".terminal-tab")?.getAttribute("data-terminal-tab-id")).toBe(tab!.id);
  socket.sent.splice(0);
  return { tab: tab!, target, socket };
}

/// The widget focuses the host when the tab asks it to take the keyboard.
function terminalInput(target: HTMLElement): Element | null {
  return target.querySelector(".terminal-host[tabindex]");
}

/// A trusted-looking Escape keydown on whatever holds focus, as the browser
/// sends it; returns whether it bubbled out to the window.
function pressEscape(): { bubbled: boolean } {
  let bubbled = false;
  const seen = () => {
    bubbled = true;
  };
  window.addEventListener("keydown", seen);
  try {
    const event = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });
    Object.defineProperty(event, "keyCode", { value: 27 });
    (document.activeElement ?? document.body).dispatchEvent(event);
  } finally {
    window.removeEventListener("keydown", seen);
  }
  return { bubbled };
}

function inputs(socket: TerminalSocket): unknown[] {
  return sentFrames(socket)
    .filter((frame) => frame.type === "input")
    .map((frame) => frame.data);
}

function menuOpen(): boolean {
  return document.body.querySelector(".terminal-tab-menu-bubble") !== null;
}

describe("terminal menu Escape", () => {
  test("Escape with no menu open is the terminal's: it reaches the PTY as ESC", async () => {
    const { socket } = await attached();
    pressEscape();
    expect(inputs(socket)).toEqual(["\x1b"]);
  });

  test.each([
    ["body menu", "menu"],
    ["tab menu", "dialog"],
  ] as const)("Escape closes the %s, sends the PTY nothing and leaves the keyboard on the terminal", async (_menu, role) => {
    const { tab, target, socket } = await attached();
    if (role === "menu") await openBodyMenu(target);
    else await openTerminalMenu(tab);
    expect(document.body.querySelector(".terminal-tab-menu-bubble")?.getAttribute("role")).toBe(role);
    expect(document.activeElement, "the terminal keeps the keyboard while its menu is open").toBe(terminalInput(target));

    const pressed = pressEscape();
    await tick();

    expect({ open: menuOpen(), opened: tabMenu.openForTabId, sent: inputs(socket), bubbled: pressed.bubbled }).toEqual({
      open: false,
      opened: null,
      sent: [],
      bubbled: false,
    });
    expect(document.activeElement).toBe(terminalInput(target));
    pressEscape();
    expect(inputs(socket), "the next Escape is the terminal's").toEqual(["\x1b"]);
  });

  test("Escape in the tab menu's Name field closes the menu and sends the PTY nothing", async () => {
    const { tab, socket } = await attached();
    await openTerminalMenu(tab);
    const name = document.body.querySelector<HTMLInputElement>(".terminal-tab-menu-bubble .rename-input")!;
    name.focus();
    expect(document.activeElement).toBe(name);

    pressEscape();
    await tick();

    expect({ open: menuOpen(), sent: inputs(socket) }).toEqual({ open: false, sent: [] });
  });
});
