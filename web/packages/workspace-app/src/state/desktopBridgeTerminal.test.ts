import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import TerminalTab from "../components/TerminalTab.svelte";
import {
  attach,
  installTerminalDom,
  mountTerminal,
  pressInTerminal,
  resetTerminals,
  seatTerminals,
  sentFrames,
  terminalTab,
  TerminalSocket,
  xterm,
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

  async function focusedTerminal(native: boolean) {
    if (native) {
      vi.stubGlobal("__TAURI_INTERNALS__", { invoke: vi.fn(async () => undefined) });
    }
    xterm.textareaFocus = true;
    const [tab] = seatTerminals([terminalTab()]);
    const { target, term } = await mountTerminal(TerminalTab, tab!);
    expect(currentOS()).toBe(os);
    expect(currentPlatform()).toBe(native ? "native" : "web");
    expect(target.querySelector(".terminal-tab.active")?.contains(document.activeElement)).toBe(true);
    return term;
  }

  async function attachedTerminal(native: boolean) {
    const term = await focusedTerminal(native);
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    socket.sent.splice(0);
    return { term, socket };
  }

  function inputs(socket: TerminalSocket): unknown[] {
    return sentFrames(socket).filter((frame) => frame.type === "input").map((frame) => frame.data);
  }

  describe.each([
    ["[", "BracketLeft", "{"],
    ["]", "BracketRight", "}"],
    ["/", "Slash", "?"],
  ] as const)("%s", (key, code, shiftedKey) => {
    if (key !== "/") test("native Ctrl reaches xterm without preventing its default", async () => {
      const term = await focusedTerminal(true);
      const { event, handled } = pressInTerminal(term, { key, code, ctrlKey: true });

      // True asks xterm to encode the key; the stand-in does not encode it.
      expect(handled).toBe(true);
      expect(event.defaultPrevented).toBe(false);
      expect(shouldEscapeTerminal(event)).toBe(false);
    });

    test("the native platform command with Shift still leaves the terminal", async () => {
      const term = await focusedTerminal(true);
      const { event, handled } = pressInTerminal(term, {
        key: shiftedKey, code, shiftKey: true,
        ...(os === "mac" ? { metaKey: true } : { ctrlKey: true }),
      });
      expect(handled).toBe(false);
      expect(shouldEscapeTerminal(event)).toBe(true);
    });

    if (os === "mac") {
      test("native Command still leaves the terminal", async () => {
        const term = await focusedTerminal(true);
        const { event, handled } = pressInTerminal(term, { key, code, metaKey: true });
        expect(handled).toBe(false);
        expect(shouldEscapeTerminal(event)).toBe(true);
      });
    }

    test("the browser chord still leaves the terminal", async () => {
      const term = await focusedTerminal(false);
      const { event, handled } = pressInTerminal(term, {
        key, code, altKey: true, ctrlKey: key === "/",
      });
      expect(handled).toBe(false);
      expect(shouldEscapeTerminal(event)).toBe(true);
    });

    test("a user-assigned Ctrl chord still leaves the native terminal", async () => {
      const term = await focusedTerminal(true);
      assignOverride("app.search.toggle", `Ctrl+${key}`);
      const { event, handled } = pressInTerminal(term, { key, code, ctrlKey: true });
      expect(handled).toBe(false);
      expect(shouldEscapeTerminal(event)).toBe(true);
      expect(event.defaultPrevented).toBe(false);
    });
  });

  test("native Ctrl slash stays out of command escape", async () => {
    const term = await focusedTerminal(true);
    const { event } = pressInTerminal(term, { key: "/", code: "Slash", ctrlKey: true });
    expect(shouldEscapeTerminal(event)).toBe(false);
  });

  test.each([true, false])("Ctrl slash sends one byte and suppresses xterm (native=%s)", async (native) => {
    const { term, socket } = await attachedTerminal(native);
    for (const code of ["Slash", "BracketLeft"]) {
      socket.sent.splice(0);
      const { event, handled } = pressInTerminal(term, { key: "/", code, ctrlKey: true });
      expect(inputs(socket)).toEqual(["\x1f"]);
      expect(handled, "xterm must not also encode the key").toBe(false);
      expect(event.defaultPrevented).toBe(true);
      expect(event.cancelBubble).toBe(true);
      expect(shouldEscapeTerminal(event)).toBe(false);
    }
  });

  test.each([true, false])("Ctrl slash fallback ignores other keys, modifiers and event types (native=%s)", async (native) => {
    const { term, socket } = await attachedTerminal(native);
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
      const event = new KeyboardEvent(type, { cancelable: true, ...init });
      term.keyHandler!(event);
      expect(inputs(socket), `${type} ${JSON.stringify(init)}`).toEqual([]);
    }
  });

  test("a user-assigned Ctrl slash still leaves the browser terminal", async () => {
    const { term, socket } = await attachedTerminal(false);
    assignOverride("app.search.toggle", "Ctrl+/");
    const { event, handled } = pressInTerminal(term, { key: "/", code: "Slash", ctrlKey: true });
    expect(inputs(socket)).toEqual([]);
    expect(handled).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(shouldEscapeTerminal(event)).toBe(true);
  });
});
