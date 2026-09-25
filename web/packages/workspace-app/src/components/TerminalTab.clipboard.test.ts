// @vitest-environment jsdom
//
// Terminal copy / paste chords. macOS binds Cmd+C / Cmd+V (Cmd never
// collides with a control code); Linux / Windows bind Ctrl+Shift+C /
// Ctrl+Shift+V so bare Ctrl+C/V stay the shell's SIGINT / EOF. The registry
// entries and the chord handler are read directly; the handler's wiring is
// driven through a mounted TerminalTab over the stand-in xterm.

import { tick } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import TerminalTab from "./TerminalTab.svelte";
import { chordFor, osChord, SHORTCUTS } from "../state/shortcuts";
import { handleTerminalClipboardChord } from "../terminal/clipboardChord";
import {
  attach,
  installTerminalDom,
  menuRow,
  mountTerminal,
  openBodyMenu,
  pressInTerminal,
  resetTerminals,
  seatTerminals,
  sentFrames,
  terminalTab,
  TerminalSocket,
} from "../__tests__/terminalTab";

installTerminalDom();

const clipboard = { writeText: vi.fn(async (_text: string) => {}) };
Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });

afterEach(() => {
  resetTerminals();
  clipboard.writeText.mockClear();
});

describe("the chord registry", () => {
  const entry = (id: string) => SHORTCUTS.find((s) => s.id === id)!;

  test("binds copy and paste to Cmd+C and Cmd+V in the Terminal group, noting the other OSes", () => {
    expect(entry("terminal.copy")).toMatchObject({
      label: "Copy selection",
      web: "Cmd+C",
      native: "Cmd+C",
      group: "Terminal",
      note: "Ctrl+Shift+C on Linux / Windows",
    });
    expect(entry("terminal.paste")).toMatchObject({
      label: "Paste",
      web: "Cmd+V",
      native: "Cmd+V",
      group: "Terminal",
      note: "Ctrl+Shift+V on Linux / Windows",
    });
  });

  test("moves them to Mod+Shift off the Mac", () => {
    for (const platform of ["web", "native"] as const) {
      expect(osChord(entry("terminal.copy"), platform, "linux")).toBe("Mod+Shift+C");
      expect(osChord(entry("terminal.paste"), platform, "windows")).toBe("Mod+Shift+V");
      expect(osChord(entry("terminal.copy"), platform, "mac")).toBe("Cmd+C");
    }
  });
});

describe("in a mounted terminal off the Mac", () => {
  async function attached() {
    const [tab] = seatTerminals([terminalTab()]);
    const mounted = await mountTerminal(TerminalTab, tab!);
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    socket.sent.splice(0);
    return { ...mounted, socket };
  }

  test("Ctrl+Shift+C copies the selection and xterm skips the key", async () => {
    const { term, socket } = await attached();
    term.selection = "selected text";
    const { event, handled } = pressInTerminal(term, { key: "C", code: "KeyC", ctrlKey: true, shiftKey: true });
    await tick();

    expect(handled).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledWith("selected text");
    expect(sentFrames(socket)).toEqual([]);
  });

  test("bare Ctrl+C is left to xterm, which sends the shell its interrupt", async () => {
    const { term } = await attached();
    term.selection = "selected text";
    const { handled } = pressInTerminal(term, { key: "c", code: "KeyC", ctrlKey: true });
    expect(handled).toBe(true);
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  test("the body menu's Copy and Paste rows show the registry's chords", async () => {
    const { target } = await attached();
    await openBodyMenu(target);
    expect(menuRow("Copy").querySelector(".mbtn-chord")?.textContent).toBe(chordFor("terminal.copy"));
    expect(menuRow("Paste").querySelector(".mbtn-chord")?.textContent).toBe(chordFor("terminal.paste"));
    expect(chordFor("terminal.copy")).toBe("Ctrl+Shift+C");
  });
});

describe("terminal clipboard keydown behavior", () => {
  function dispatchClipboardChord(
    init: KeyboardEventInit,
    os: string,
    copySelection = vi.fn(),
  ): { event: KeyboardEvent; handled: boolean; copySelection: ReturnType<typeof vi.fn> } {
    const target = document.createElement("div");
    let handled = false;
    target.addEventListener("keydown", (event) => {
      handled = handleTerminalClipboardChord(event, { os, copySelection });
    });
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    target.dispatchEvent(event);
    return { event, handled, copySelection };
  }

  test("Cmd+V stays native and does not suppress WKWebView paste", () => {
    const { event, handled, copySelection } = dispatchClipboardChord(
      { key: "v", code: "KeyV", metaKey: true },
      "mac",
    );

    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(copySelection).not.toHaveBeenCalled();
  });

  test("copy is handled directly and suppresses the browser default", () => {
    const { event, handled, copySelection } = dispatchClipboardChord(
      { key: "c", code: "KeyC", ctrlKey: true, shiftKey: true },
      "linux",
    );

    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(copySelection).toHaveBeenCalledOnce();
  });
});
