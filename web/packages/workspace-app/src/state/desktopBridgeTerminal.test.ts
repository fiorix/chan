import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));

import type { Terminal } from "@chan/ghostty-web-ng";
import TerminalTab from "../components/TerminalTab.svelte";
import { mountGhosttyTerminal, pressInGhostty } from "../__tests__/ghosttyTab";
import {
  attach,
  installTerminalDom,
  resetTerminals,
  seatTerminals,
  sentFrames,
  terminalTab,
  TerminalSocket,
} from "../__tests__/terminalTab";
import { currentOS, currentPlatform, shouldEscapeTerminal } from "./shortcuts";
import { persistStateToHash } from "./store.svelte";
import { assignOverride, hydrateOverrides } from "./keymapOverrides.svelte";

installTerminalDom();

afterEach(() => {
  hydrateOverrides(null);
  resetTerminals();
  persistStateToHash();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each([
  ["mac", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)"],
  ["linux", "Mozilla/5.0 (X11; Linux x86_64)"],
  ["windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"],
] as const)("%s terminal shortcuts", (os, userAgent) => {
  beforeEach(() => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
  });

  /// A focused terminal on the widget, attached, with nothing sent yet. What
  /// a key did is what reached its socket: the widget's own encoding when the
  /// key stays with the terminal, chan's bytes when chan claims it, nothing
  /// when it leaves the terminal for the app.
  async function focusedTerminal(native: boolean): Promise<{ term: Terminal; socket: TerminalSocket }> {
    if (native) {
      vi.stubGlobal("__TAURI_INTERNALS__", { invoke: vi.fn(async () => undefined) });
    }
    const [tab] = seatTerminals([terminalTab()]);
    const { target, term } = await mountGhosttyTerminal(TerminalTab, tab!);
    expect(currentOS()).toBe(os);
    expect(currentPlatform()).toBe(native ? "native" : "web");
    expect(target.querySelector(".terminal-tab.active")?.contains(document.activeElement)).toBe(true);
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    socket.sent.splice(0);
    return { term, socket };
  }

  function inputs(socket: TerminalSocket): unknown[] {
    return sentFrames(socket).filter((frame) => frame.type === "input").map((frame) => frame.data);
  }

  /// The control byte a terminal encodes for Ctrl with this key.
  const CONTROL: Record<string, string> = { "[": "\x1b", "]": "\x1d" };

  /// The key code a browser sets for the physical key, which the widget's
  /// encoder reads.
  const KEY_CODES: Record<string, number> = { BracketLeft: 219, BracketRight: 221, Slash: 191 };

  /// A keydown typed into the widget, with its key code.
  function press(term: Terminal, init: KeyboardEventInit): KeyboardEvent {
    return pressInGhostty(term, { keyCode: KEY_CODES[init.code ?? ""], ...init });
  }

  /// Whether a keydown typed into the widget bubbled to the document, where
  /// the app's chord listener reads it.
  function reachesDocument(term: Terminal, init: KeyboardEventInit): { event: KeyboardEvent; reached: boolean } {
    let reached = false;
    const record = () => { reached = true; };
    document.addEventListener("keydown", record);
    try {
      return { event: press(term, init), reached };
    } finally {
      document.removeEventListener("keydown", record);
    }
  }

  describe.each([
    ["[", "BracketLeft", "{"],
    ["]", "BracketRight", "}"],
    ["/", "Slash", "?"],
  ] as const)("%s", (key, code, shiftedKey) => {
    if (key !== "/") test("native Ctrl reaches the widget, which sends its control byte", async () => {
      const { term, socket } = await focusedTerminal(true);
      const event = press(term, { key, code, ctrlKey: true });

      expect(inputs(socket), "the widget encodes the key").toEqual([CONTROL[key]]);
      expect(shouldEscapeTerminal(event)).toBe(false);
    });

    if (os === "mac" || key !== "/") test("the native platform command with Shift still leaves the terminal", async () => {
      const { term, socket } = await focusedTerminal(true);
      const event = press(term, {
        key: shiftedKey, code, shiftKey: true,
        ...(os === "mac" ? { metaKey: true } : { ctrlKey: true }),
      });
      expect(inputs(socket)).toEqual([]);
      expect(shouldEscapeTerminal(event)).toBe(true);
    });

    if (os !== "mac" && key === "/") {
      test.each([
        ["/", false],
        ["?", true],
      ] as const)("native Ctrl+Alt+%s leaves the terminal as a split", async (typed, shiftKey) => {
        const { term, socket } = await focusedTerminal(true);
        const event = press(term, {
          key: typed, code, ctrlKey: true, altKey: true, shiftKey,
        });
        expect(inputs(socket)).toEqual([]);
        expect(shouldEscapeTerminal(event)).toBe(true);
      });

      test("native Ctrl+Shift+/ stays out of command escape", async () => {
        const { term } = await focusedTerminal(true);
        const event = press(term, { key: "?", code, ctrlKey: true, shiftKey: true });
        expect(shouldEscapeTerminal(event)).toBe(false);
      });
    }

    if (os !== "mac" && key !== "/") {
      test("native Alt leaves the terminal as pane navigation", async () => {
        const { term, socket } = await focusedTerminal(true);
        const event = press(term, { key, code, altKey: true });
        expect(inputs(socket)).toEqual([]);
        expect(shouldEscapeTerminal(event)).toBe(true);
      });
    }

    if (os === "mac") {
      test("native Command still leaves the terminal", async () => {
        const { term, socket } = await focusedTerminal(true);
        const event = press(term, { key, code, metaKey: true });
        expect(inputs(socket)).toEqual([]);
        expect(shouldEscapeTerminal(event)).toBe(true);
      });
    }

    test("the browser chord still leaves the terminal", async () => {
      const { term, socket } = await focusedTerminal(false);
      const event = press(term, {
        key, code, altKey: true, ctrlKey: key === "/",
      });
      expect(inputs(socket)).toEqual([]);
      expect(shouldEscapeTerminal(event)).toBe(true);
    });

    test("a user-assigned Ctrl chord still leaves the native terminal", async () => {
      const { term, socket } = await focusedTerminal(true);
      assignOverride("app.search.toggle", `Ctrl+${key}`);
      const { event, reached } = reachesDocument(term, { key, code, ctrlKey: true });
      expect(inputs(socket)).toEqual([]);
      expect(shouldEscapeTerminal(event)).toBe(true);
      expect(reached, "the app's chord listener gets the key").toBe(true);
    });
  });

  test("native Ctrl slash stays out of command escape", async () => {
    const { term } = await focusedTerminal(true);
    const event = press(term, { key: "/", code: "Slash", ctrlKey: true });
    expect(shouldEscapeTerminal(event)).toBe(false);
  });

  test.each([true, false])("Ctrl slash sends one byte and suppresses the widget's own encoding (native=%s)", async (native) => {
    const { term, socket } = await focusedTerminal(native);
    const bubbled: KeyboardEvent[] = [];
    const record = (event: KeyboardEvent) => bubbled.push(event);
    document.addEventListener("keydown", record);
    try {
      for (const code of ["Slash", "BracketLeft"]) {
        socket.sent.splice(0);
        const event = press(term, { key: "/", code, ctrlKey: true });
        expect(inputs(socket), "one Unit Separator, and nothing more from the widget").toEqual(["\x1f"]);
        expect(event.defaultPrevented).toBe(true);
        expect(bubbled, "the key stops at the terminal").not.toContain(event);
        expect(shouldEscapeTerminal(event)).toBe(false);
      }
    } finally {
      document.removeEventListener("keydown", record);
    }
  });

  test.each([true, false])("Ctrl slash fallback ignores other keys, modifiers and event types (native=%s)", async (native) => {
    const { term, socket } = await focusedTerminal(native);
    const cases: Array<[string, KeyboardEventInit]> = [
      ["keydown", { key: "/", code: "Slash" }],
      ["keydown", { key: "/", code: "Slash", ctrlKey: true, shiftKey: true }],
      ["keydown", { key: "/", code: "Slash", ctrlKey: true, altKey: true }],
      ["keydown", { key: "/", code: "Slash", ctrlKey: true, metaKey: true }],
      ["keydown", { key: "?", code: "Slash", ctrlKey: true }],
      ["keydown", { key: "z", code: "Slash", ctrlKey: true }],
      ["keydown", { key: "Dead", code: "Slash", ctrlKey: true }],
      ["keydown", { key: "/", code: "Slash", ctrlKey: true, isComposing: true }],
      ["keypress", { key: "/", code: "Slash", ctrlKey: true }],
      ["keyup", { key: "/", code: "Slash", ctrlKey: true }],
    ];
    for (const [type, init] of cases) {
      socket.sent.splice(0);
      term.element!.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, keyCode: KEY_CODES.Slash, ...init }));
      expect(inputs(socket), `${type} ${JSON.stringify(init)}`).not.toContain("\x1f");
    }
  });

  test("a user-assigned Ctrl slash still leaves the browser terminal", async () => {
    const { term, socket } = await focusedTerminal(false);
    assignOverride("app.search.toggle", "Ctrl+/");
    const { event, reached } = reachesDocument(term, { key: "/", code: "Slash", ctrlKey: true });
    expect(inputs(socket)).toEqual([]);
    expect(reached, "the app's chord listener gets the key").toBe(true);
    expect(shouldEscapeTerminal(event)).toBe(true);
  });
});
