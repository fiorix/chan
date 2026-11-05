// @vitest-environment jsdom
//
// Escape over a terminal's menu. The terminal keeps the keyboard while its
// menu is open, so the key goes first to the element that takes the
// terminal's keys: xterm.js's textarea, or the ghostty host where chan's key
// listener runs ahead of ghostty-web. Both encode Escape for the PTY and stop
// the event. The menu still takes it: Escape closes the menu, no ESC reaches
// the PTY, and the next Escape is the terminal's again.
//
// TerminalTab is mounted over the stand-in xterm with a real xterm.js opened
// in its host, so the key travels through xterm.js's own keydown, and over a
// ghostty stand-in, where the key listener is chan's real one.

import type { Terminal } from "@xterm/xterm";
import { tick } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => {
  HTMLCanvasElement.prototype.getContext = (() => ({
    createLinearGradient: () => ({ addColorStop() {} }),
    measureText: () => ({ width: 8 }),
    fillRect() {},
    clearRect() {},
    fillText() {},
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  const { Terminal } = await vi.importActual<typeof import("@xterm/xterm")>("@xterm/xterm");
  const { FakeTerminal } = await import("../__tests__/xterm");
  return {
    Terminal: class extends FakeTerminal {
      model: Terminal;
      constructor(options: Record<string, unknown>) {
        super(options);
        this.model = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 });
        this.model.onData((data) => this.type(data));
      }
      get _core(): unknown {
        return (this.model as unknown as { _core: unknown })._core;
      }
      open(element: HTMLElement): void {
        super.open(element);
        this.model.open(element);
      }
      attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean): void {
        super.attachCustomKeyEventHandler(handler);
        this.model.attachCustomKeyEventHandler(handler);
      }
      focus(): void {
        this.focusCount += 1;
        this.model.focus();
      }
      blur(): void {
        this.blurCount += 1;
        this.model.blur();
      }
      dispose(): void {
        this.model.dispose();
        super.dispose();
      }
    },
  };
});
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

// ghostty-web as far as TerminalTab drives it here. Like ghostty-web's open(),
// open() makes the host focusable and focus() focuses it. Its own keydown
// listener is not modelled: chan's key listener answers every key this file
// sends, on the host, before ghostty-web's would.
vi.mock("../terminal/backend", async (importOriginal) => {
  const { FakeTerminal } = await import("../__tests__/xterm");
  class GhosttyTerminal extends FakeTerminal {
    renderer = { getMetrics: () => ({ width: 8, height: 16 }) };
    buffer = { active: {}, alternate: {} };
    attachCustomWheelEventHandler(): void {}
    hasMouseTracking() {
      return false;
    }
    hasFocusEvents() {
      return false;
    }
    getMode(_mode: number, fallback = false) {
      return fallback;
    }
    clearSelection() {}
    scrollLines() {}
    selectAll() {}
    open(element: HTMLElement): void {
      super.open(element);
      element.setAttribute("tabindex", "0");
    }
    focus(): void {
      this.focusCount += 1;
      this.element?.focus();
    }
    blur(): void {
      this.blurCount += 1;
      this.element?.blur();
    }
  }
  return {
    ...(await importOriginal<typeof import("../terminal/backend")>()),
    loadGhosttyKit: async () => ({ instantiate: async () => ({}), Terminal: GhosttyTerminal }),
  };
});
vi.mock("../terminal/ghosttyCompat", () => ({
  measureXtermCellDimensions: () => ({ width: 8, height: 16 }),
  alignGhosttyRendererToXterm: () => true,
  installGhosttyCustomGlyphs: () => true,
  installGhosttyOverlayScrollbar: () => true,
  gateGhosttyScrollbarClicks: () => () => {},
}));
vi.mock("../terminal/ghosttyViewport", () => ({
  GhosttyViewportController: class {
    constructor(private term: { write(bytes: Uint8Array): void }) {}
    write(bytes: Uint8Array) {
      this.term.write(bytes);
    }
    handleWheel() {
      return false;
    }
    dispose() {}
  },
}));
vi.mock("../terminal/osc52Bridge", () => ({
  Osc52Bridge: class {
    push() {}
  },
}));

import { terminalPreferences } from "../__tests__/standalone";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import { tabMenu } from "../state/tabMenu.svelte";
import TerminalTab from "./TerminalTab.svelte";
import {
  attach,
  installTerminalDom,
  mountTerminal,
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

type Engine = "xterm" | "ghostty";

async function attached(engine: Engine) {
  __testSetStandalonePreferences(terminalPreferences({ ghostty: engine === "ghostty" }));
  const [tab] = seatTerminals([terminalTab()]);
  const { target } = await mountTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  await vi.waitFor(() => expect(terminalInput(target), "the terminal took focus").toBe(document.activeElement));
  expect(target.querySelector(".terminal-tab")?.getAttribute("data-terminal-tab-id")).toBe(tab!.id);
  socket.sent.splice(0);
  return { tab: tab!, target, socket };
}

/// The element that takes this terminal's keys: xterm.js's textarea, or the
/// ghostty host.
function terminalInput(target: HTMLElement): Element | null {
  return target.querySelector(".terminal-host textarea") ?? target.querySelector(".terminal-host[tabindex]");
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

describe.each(["xterm", "ghostty"] as const)("on %s", (engine) => {
  test("Escape with no menu open is the terminal's: it reaches the PTY as ESC", async () => {
    const { socket } = await attached(engine);
    pressEscape();
    expect(inputs(socket)).toEqual(["\x1b"]);
  });

  test.each([
    ["body menu", "menu"],
    ["tab menu", "dialog"],
  ] as const)("Escape closes the %s, sends the PTY nothing and leaves the keyboard on the terminal", async (_menu, role) => {
    const { tab, target, socket } = await attached(engine);
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
    const { tab, socket } = await attached(engine);
    await openTerminalMenu(tab);
    const name = document.body.querySelector<HTMLInputElement>(".terminal-tab-menu-bubble .rename-input")!;
    name.focus();
    expect(document.activeElement).toBe(name);

    pressEscape();
    await tick();

    expect({ open: menuOpen(), sent: inputs(socket) }).toEqual({ open: false, sent: [] });
  });
});
