// @vitest-environment jsdom
//
// TerminalTab on the ghostty backend: chosen from the terminal settings when
// the terminal spawns, loaded lazily with an xterm fallback, and wired through
// chan's own fitter, compatibility hooks, viewport controller and key
// handling. A TerminalTab is mounted with the ghostty kit and its hooks
// stubbed; each stand-in records what the component asked of it, in order.

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { VtHost } from "@chan/ghostty-web-ng/vt";

const ghostty = vi.hoisted(() => {
  const record = {
    events: [] as string[],
    kitFails: false,
    kitLoads: 0,
    instances: 0,
    hosts: [] as VtHost[],
    alignOk: true,
    terminals: [] as Array<Record<string, any>>,
    viewportWrites: [] as string[],
    wheels: 0,
    osc52: [] as string[],
    // Whether the program in the terminal has focus reporting on (DECSET
    // 1004), as ghostty-web's own mode tracking would answer.
    focusEvents: false,
    // A renderer without the private hooks the mask painter binds to.
    bareRenderer: false,
    // Whether the program asked for bracketed paste (DECSET 2004), and
    // every text the component pasted through ghostty-web.
    bracketedPaste: false,
    pastes: [] as string[],
    // The forceAll flag of every render pass asked of the renderer.
    renders: [] as boolean[],
    // When set, focus() does what ghostty-web's does: it focuses the element
    // the terminal opened in, and again on a zero-delay timer.
    realFocus: false,
    // Every theme the component handed the live-switch hook, with the
    // terminal it named.
    themes: [] as Array<{ term: unknown; theme: Record<string, string> }>,
  };
  /// ghostty-web's own render, as the painter finds it on the renderer.
  function fakeRender(_buffer: unknown, forceAll?: boolean) {
    record.renders.push(forceAll === true);
  }
  class FakeGhosttyTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
    wheelHandler: ((e: WheelEvent) => boolean) | null = null;
    dataHandlers: Array<(data: string) => void> = [];
    resizeHandlers: Array<(size: { cols: number; rows: number }) => void> = [];
    resized: Array<[number, number]> = [];
    // What the secret mask painter hooks: a 2D context, the render it
    // wraps, and the buffer and viewport it reads.
    renderer: Record<string, unknown> = record.bareRenderer
      ? { getMetrics: () => ({ width: 8, height: 16 }) }
      : { getMetrics: () => ({ width: 8, height: 16 }), ctx: {}, render: fakeRender };
    buffer = { active: { type: "normal", length: 24, getLine: () => undefined }, alternate: {} };
    // The wasm core the renderer draws from, as far as a render pass reads it.
    wasmTerm = {
      getDimensions: () => ({ cols: this.cols, rows: this.rows }),
      isRowDirty: () => false,
      beginFrame: () => 0,
    };
    applicationCursorKeys = false;
    element: HTMLElement | null = null;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      record.terminals.push(this);
      record.events.push("construct");
    }
    open(element?: HTMLElement) {
      this.element = element ?? null;
      record.events.push("open");
    }
    attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean) {
      this.keyHandler = handler;
    }
    attachCustomWheelEventHandler(handler: (e: WheelEvent) => boolean) {
      this.wheelHandler = handler;
    }
    onData(handler: (data: string) => void) {
      this.dataHandlers.push(handler);
      return { dispose() {} };
    }
    onResize(handler: (size: { cols: number; rows: number }) => void) {
      this.resizeHandlers.push(handler);
      return { dispose() {} };
    }
    hasMouseTracking() {
      return false;
    }
    hasFocusEvents() {
      return record.focusEvents;
    }
    getMode(mode: number) {
      if (mode === 2004) return record.bracketedPaste;
      return mode === 1 ? this.applicationCursorKeys : false;
    }
    hasBracketedPaste() {
      return record.bracketedPaste;
    }
    write() {}
    writeln() {}
    paste(text: string) {
      record.pastes.push(text);
    }
    resize(cols: number, rows: number) {
      if (cols === this.cols && rows === this.rows) return;
      this.resized.push([cols, rows]);
      this.cols = cols;
      this.rows = rows;
      for (const handler of this.resizeHandlers) handler({ cols, rows });
    }
    focus() {
      record.events.push("focus");
      const element = this.element;
      if (!record.realFocus || !element) return;
      element.focus();
      setTimeout(() => element.focus(), 0);
    }
    blur() {
      record.events.push("blur");
    }
    getSelection() {
      return "chosen";
    }
    getViewportY() {
      return 0;
    }
    getScrollbackLength() {
      return 0;
    }
    scrolled: number[] = [];
    scrollLines(amount: number) {
      this.scrolled.push(amount);
    }
    selectAll() {}
    clearSelection() {}
    dispose() {}
  }
  return { record, FakeGhosttyTerminal, fakeRender };
});

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../terminal/backend")>()),
  loadGhosttyKit: vi.fn(async () => {
    ghostty.record.kitLoads += 1;
    if (ghostty.record.kitFails) throw new Error("wasm fetch failed");
    return {
      instantiate: async (host?: VtHost) => {
        if (host) ghostty.record.hosts.push(host);
        ghostty.record.instances += 1;
        ghostty.record.events.push("instantiate");
        return { instance: ghostty.record.instances };
      },
      Terminal: ghostty.FakeGhosttyTerminal,
    };
  }),
}));
vi.mock("../terminal/ghosttyCompat", () => ({
  measureXtermCellDimensions: () => ({ width: 8, height: 16 }),
  alignGhosttyRendererToXterm: () => {
    ghostty.record.events.push("align");
    return ghostty.record.alignOk;
  },
  installGhosttyCustomGlyphs: () => (ghostty.record.events.push("glyphs"), true),
  installGhosttyOverlayScrollbar: () => (ghostty.record.events.push("scrollbar"), true),
  gateGhosttyScrollbarClicks: () => {
    ghostty.record.events.push("gate");
    return () => ghostty.record.events.push("ungate");
  },
}));
vi.mock("../terminal/ghosttyTheme", () => ({
  applyGhosttyTheme: (term: unknown, theme: Record<string, string>) => {
    ghostty.record.themes.push({ term, theme });
    return true;
  },
}));
vi.mock("../terminal/ghosttyViewport", () => ({
  GhosttyViewportController: class {
    write(bytes: Uint8Array) {
      ghostty.record.viewportWrites.push(new TextDecoder().decode(bytes));
    }
    handleWheel() {
      ghostty.record.wheels += 1;
      return true;
    }
    dispose() {}
  },
}));
vi.mock("../terminal/osc52Bridge", () => ({
  Osc52Bridge: class {
    push(bytes: Uint8Array) {
      ghostty.record.osc52.push(new TextDecoder().decode(bytes));
    }
  },
}));
vi.mock("../terminal/resize", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../terminal/resize")>()),
  proposeGhosttyDimensions: () => ({ cols: 100, rows: 30 }),
}));

import { privacy } from "@chan/web-shared/privacy";
import TerminalTab from "./TerminalTab.svelte";
import { terminalPreferences } from "../__tests__/standalone";
import { commandById } from "../state/commands";
import { __testSetStandalonePreferences, hybridSurfaceThemes, ui } from "../state/store.svelte";
import { bumpTabFocusPulse } from "../state/tabs.svelte";
import {
  attach,
  installTerminalDom,
  menuRow,
  mountTerminal,
  openBodyMenu,
  output,
  receive,
  resetTerminals,
  resizeObservers,
  seatTerminals,
  sentFrames,
  terminalTab,
  TERMINAL_PANE,
  TerminalSocket,
  xterm,
} from "../__tests__/terminalTab";

installTerminalDom();

class DialRecordingSocket extends TerminalSocket {
  constructor(url: string) {
    super(url);
    ghostty.record.events.push("dial");
  }
}
globalThis.WebSocket = DialRecordingSocket as unknown as typeof WebSocket;

const clipboard = { writeText: vi.fn(async (_text: string) => {}) };
Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });

beforeEach(() => {
  Object.assign(ghostty.record, {
    events: [],
    kitFails: false,
    kitLoads: 0,
    instances: 0,
    hosts: [],
    alignOk: true,
    terminals: [],
    viewportWrites: [],
    wheels: 0,
    osc52: [],
    focusEvents: false,
    bareRenderer: false,
    bracketedPaste: false,
    pastes: [],
    realFocus: false,
    themes: [],
  });
  __testSetStandalonePreferences(terminalPreferences({ ghostty: true, font_size: 15 }));
});

afterEach(() => {
  resetTerminals();
  __testSetStandalonePreferences(null);
  clipboard.writeText.mockClear();
  ui.status = null;
  ui.terminalControl = false;
  vi.restoreAllMocks();
});

const ghosttyMounts: Array<Record<string, unknown>> = [];

afterEach(() => {
  for (const component of ghosttyMounts.splice(0)) unmount(component);
});

/// Mount a terminal that spawns on ghostty (the harness's mountTerminal waits
/// for an xterm instance, which a ghostty terminal never makes).
async function mountGhostty() {
  const [tab] = seatTerminals([terminalTab()]);
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(TerminalTab, {
    target,
    props: { tab: tab!, paneId: TERMINAL_PANE, side: "a", active: true, focused: true },
  }) as Record<string, unknown>;
  ghosttyMounts.push(component);
  await vi.waitFor(() => expect(TerminalSocket.all.length).toBeGreaterThan(0));
  const mounted = { target, component };
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  socket.sent.splice(0);
  return { ...mounted, tab: tab!, socket, term: ghostty.record.terminals.at(-1)! };
}

/// A keydown on the terminal host, where chan's ghostty key listener runs
/// ahead of ghostty-web, with the legacy key code xterm.js reads.
function hostKey(target: HTMLElement, init: KeyboardEventInit & { keyCode?: number }): KeyboardEvent {
  const { keyCode = 0, ...rest } = init;
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...rest });
  Object.defineProperty(event, "keyCode", { value: keyCode });
  target.querySelector(".terminal-host")!.dispatchEvent(event);
  return event;
}

function inputs(socket: TerminalSocket): unknown[] {
  return sentFrames(socket)
    .filter((frame) => frame.type === "input")
    .map((frame) => frame.data);
}

function key(term: Record<string, any>, init: KeyboardEventInit): { event: KeyboardEvent; claimed: boolean } {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  return { event, claimed: term.keyHandler(event) };
}

const MASKING_ROW = "Secret masking (this terminal)";

/// What the open body menu says of the terminal: its engine and whether its
/// masking row is checked, with how many times the ghostty kit was asked for.
async function spawned(target: HTMLElement): Promise<{ engine: string; masking: boolean; kitLoads: number }> {
  await openBodyMenu(target);
  return {
    engine: document.body.querySelector(".terminal-backend-value")?.textContent ?? "",
    masking: menuRow(MASKING_ROW).getAttribute("aria-checked") === "true",
    kitLoads: ghostty.record.kitLoads,
  };
}

describe("a control terminal whose masking starts on", () => {
  test.each([
    ["unset", {}],
    ["on", { secret_masking: true }],
  ] as const)("with the preference %s it spawns on ghostty, masked", async (_name, masking) => {
    ui.terminalControl = true;
    __testSetStandalonePreferences(terminalPreferences({ ghostty: true, font_size: 15, ...masking }));
    const { target } = await mountGhostty();
    expect(await spawned(target)).toEqual({ engine: "ghostty", masking: true, kitLoads: 1 });
    expect(ghostty.record.terminals, "one ghostty terminal built").toHaveLength(1);
  });

  test("its own toggle turns masking off and leaves it on ghostty", async () => {
    ui.terminalControl = true;
    const { target } = await mountGhostty();
    expect(await spawned(target)).toEqual({ engine: "ghostty", masking: true, kitLoads: 1 });
    menuRow(MASKING_ROW).click();
    await tick();
    expect(await spawned(target)).toEqual({ engine: "ghostty", masking: false, kitLoads: 1 });
  });

  test("with the preference off it starts unmasked on the configured backend", async () => {
    ui.terminalControl = true;
    __testSetStandalonePreferences(terminalPreferences({ ghostty: true, font_size: 15, secret_masking: false }));
    const { target } = await mountGhostty();
    expect(await spawned(target)).toEqual({ engine: "ghostty", masking: false, kitLoads: 1 });
  });

  test("a terminal of any other window masks on ghostty with the preference on", async () => {
    __testSetStandalonePreferences(terminalPreferences({ ghostty: true, font_size: 15, secret_masking: true }));
    const { target } = await mountGhostty();
    expect(await spawned(target)).toEqual({ engine: "ghostty", masking: true, kitLoads: 1 });
  });
});

describe("choosing the backend", () => {
  test("the ghostty setting spawns the terminal on ghostty with chan's options", async () => {
    const { target, term } = await mountGhostty();
    expect(xterm.terminals, "no xterm built").toHaveLength(0);
    expect(term.options).toMatchObject({ fontSize: 15, smoothScrollDuration: 0, cursorBlink: false, cursorStyle: "block" });
    await openBodyMenu(target);
    expect(document.body.querySelector(".terminal-backend-value")?.textContent).toBe("ghostty");
  });

  test("a kit that fails to load falls back to xterm", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    ghostty.record.kitFails = true;
    const [tab] = seatTerminals([terminalTab()]);
    const { target } = await mountTerminal(TerminalTab, tab!);
    expect(ghostty.record.terminals).toHaveLength(0);
    expect(xterm.terminals).toHaveLength(1);
    await openBodyMenu(target);
    expect(document.body.querySelector(".terminal-backend-value")?.textContent).toBe("xterm");
  });

  test("the xterm-only pieces stay off ghostty", async () => {
    await mountGhostty();
    expect(xterm.webgl).toHaveLength(0);
  });

  test("the component reaches ghostty-web only through the lazy kit loader", async () => {
    vi.resetModules();
    let loads = 0;
    vi.doMock("@chan/ghostty-web-ng", () => {
      loads += 1;
      return {};
    });
    await import("./TerminalTab.svelte");
    expect(loads).toBe(0);
  });
});

describe("the mount", () => {
  test("instantiate its own wasm, open, align to xterm's cell, install the hooks, then dial", async () => {
    await mountGhostty();
    expect(ghostty.record.events.slice(0, 8)).toEqual([
      "instantiate",
      "construct",
      "open",
      "align",
      "glyphs",
      "scrollbar",
      "gate",
      "dial",
    ]);
  });

  test("the terminal is built on the wasm instance its own spawn created", async () => {
    await mountGhostty();
    expect(ghostty.record.instances).toBe(1);
    expect(ghostty.record.terminals[0].options.ghostty).toEqual({ instance: 1 });
  });

  test("a renderer without the alignment hook is kept, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ghostty.record.alignOk = false;
    await mountGhostty();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("renderer metrics unavailable"))).toBe(true);
  });

  test("a resize fits with chan's own measurement", async () => {
    const { term } = await mountGhostty();
    resizeObservers.at(-1)!.callback();
    await tick();
    expect(term.resized).toContainEqual([100, 30]);
  });

  test("a shown fit publishes through Ghostty's resize handler", async () => {
    const { term, socket } = await mountGhostty();
    term.resize(90, 30);
    socket.sent.splice(0);
    resizeObservers.at(-1)!.callback();
    expect(sentFrames(socket).filter((frame) => frame.type === "resize"))
      .toEqual([{ type: "resize", cols: 100, rows: 30 }]);
  });

  test("the scrollbar gate is removed when the terminal goes", async () => {
    const { component } = await mountGhostty();
    unmount(component);
    ghosttyMounts.splice(ghosttyMounts.indexOf(component), 1);
    expect(ghostty.record.events).toContain("ungate");
  });
});

describe("keys", () => {
  test("host insertText reaches the PTY once as typed input and never as paste", async () => {
    const { target, socket } = await mountGhostty();
    const host = target.querySelector<HTMLElement>(".terminal-host")!;
    host.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true, cancelable: true, inputType: "insertText", data: "\u{1f600}",
    }));
    expect(inputs(socket)).toEqual(["\u{1f600}"]);
    expect(ghostty.record.pastes).toEqual([]);
  });

  test("a handled key's following host insertText does not duplicate its bytes", async () => {
    const { target, socket } = await mountGhostty();
    const host = target.querySelector<HTMLElement>(".terminal-host")!;
    hostKey(target, { key: "Enter", code: "Enter", keyCode: 13 });
    host.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true, cancelable: true, inputType: "insertText", data: "\r",
    }));
    expect(inputs(socket)).toEqual(["\r"]);
  });

  test.each([["Enter", 13, "\r"], ["Tab", 9, "\t"]] as const)(
    "Dead then %s reaches the PTY", async (key, keyCode, data) => {
      const { target, socket } = await mountGhostty();
      hostKey(target, { key: "Dead", code: "Quote", keyCode: 222 });
      hostKey(target, { key, code: key, keyCode });
      expect(inputs(socket)).toEqual([data]);
    },
  );

  test("the handler ghostty calls inverts chan's answer: copy is claimed, paste stays native", async () => {
    const { term } = await mountGhostty();
    const copy = key(term, { key: "C", code: "KeyC", ctrlKey: true, shiftKey: true });
    const paste = key(term, { key: "V", code: "KeyV", ctrlKey: true, shiftKey: true });
    await tick();

    expect(copy.claimed).toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledWith("chosen");
    expect(paste.claimed).toBe(false);
    expect(paste.event.defaultPrevented).toBe(false);
  });

  test("a bare Ctrl+V sends the control byte, before ghostty would drop it with its paste chords", async () => {
    const { target, socket } = await mountGhostty();
    const event = hostKey(target, { key: "v", code: "KeyV", keyCode: 86, ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(inputs(socket)).toEqual(["\x16"]);
  });

  test("Shift+Enter sends chan's line feed, before ghostty would send Enter", async () => {
    const { target, socket } = await mountGhostty();
    hostKey(target, { key: "Enter", code: "Enter", keyCode: 13, shiftKey: true });
    expect(inputs(socket)).toEqual(["\n"]);
  });

  test("Alt+Left sends xterm.js's word motion, not ghostty's modified arrow", async () => {
    const { target, socket } = await mountGhostty();
    const outer = vi.fn();
    target.addEventListener("keydown", outer);
    const event = hostKey(target, { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, altKey: true });
    expect(inputs(socket)).toEqual(["\x1bb"]);
    expect(event.defaultPrevented).toBe(true);
    expect(outer, "stopped before ghostty-web and the tab").not.toHaveBeenCalled();
  });

  test("Shift+PageUp scrolls the terminal a page less one row", async () => {
    const { target, socket, term } = await mountGhostty();
    hostKey(target, { key: "PageUp", code: "PageUp", keyCode: 33, shiftKey: true });
    expect(term.scrolled).toEqual([-(term.rows - 1)]);
    expect(inputs(socket)).toEqual([]);
  });

  test("a key xterm.js leaves to the browser stops before ghostty without losing its default", async () => {
    const { target, socket } = await mountGhostty();
    const outer = vi.fn();
    target.addEventListener("keydown", outer);
    const event = hostKey(target, { key: "w", code: "KeyW", keyCode: 87, metaKey: true });
    expect(outer).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(inputs(socket)).toEqual([]);
  });

  test("plain typing and chan's own chords still reach ghostty-web", async () => {
    const { target } = await mountGhostty();
    const outer = vi.fn();
    target.addEventListener("keydown", outer);
    hostKey(target, { key: "a", code: "KeyA", keyCode: 65 });
    hostKey(target, { key: "C", code: "KeyC", keyCode: 67, ctrlKey: true, shiftKey: true });
    hostKey(target, { key: "V", code: "KeyV", keyCode: 86, ctrlKey: true, shiftKey: true });
    expect(outer).toHaveBeenCalledTimes(3);
  });

  test("the program's keyboard protocol requests reach the modified Enter", async () => {
    const { target, socket } = await mountGhostty();
    await output(socket, "\x1b[>4;2m\x1b[?4m");
    expect(inputs(socket), "the modifyOtherKeys query is answered").toEqual(["\x1b[>4;2m"]);
    socket.sent.splice(0);
    hostKey(target, { key: "Enter", code: "Enter", keyCode: 13, shiftKey: true });
    expect(inputs(socket)).toEqual(["\x1b[27;2;13~"]);
  });
});

describe("output and scrolling", () => {
  test("PTY output goes through the viewport controller and the OSC 52 observer", async () => {
    const { socket } = await mountGhostty();
    await output(socket, "hello");
    expect(ghostty.record.viewportWrites).toContain("hello");
    expect(ghostty.record.osc52).toContain("hello");
  });

  test("the wheel goes to the viewport controller", async () => {
    const { term } = await mountGhostty();
    expect(term.wheelHandler!(new WheelEvent("wheel", { deltaY: 10 }))).toBe(true);
    expect(ghostty.record.wheels).toBe(1);
  });

  const arrows = (socket: TerminalSocket): unknown[] =>
    sentFrames(socket)
      .filter((frame) => frame.type === "input")
      .map((frame) => frame.data);

  test("on the alternate screen a trackpad swipe sends one arrow per row it adds up to", async () => {
    const { term, socket } = await mountGhostty();
    term.buffer.active = term.buffer.alternate;
    // 10 px on a 16 px row, scaled by 0.3: 0.1875 of a row per event.
    const claimed = Array.from({ length: 20 }, () =>
      term.wheelHandler!(new WheelEvent("wheel", { deltaY: 10 })),
    );
    expect(claimed.every(Boolean)).toBe(true);
    expect(arrows(socket)).toEqual(["\x1b[B", "\x1b[B", "\x1b[B"]);
    expect(ghostty.record.wheels).toBe(0);
  });

  test("on the alternate screen application cursor keys send the SS3 arrow", async () => {
    const { term, socket } = await mountGhostty();
    term.buffer.active = term.buffer.alternate;
    term.applicationCursorKeys = true;
    term.wheelHandler!(new WheelEvent("wheel", { deltaY: -1, deltaMode: 1 }));
    expect(arrows(socket)).toEqual(["\x1bOA"]);
  });
});

// WKWebView can keep document.activeElement on the host ghostty-web focuses
// while detaching keyboard input after a sleep or an app switch, and focus()
// on the active element is a DOM no-op; the host-resume recovery therefore
// blurs the host before it refocuses the terminal, so the focus is a change.
describe("focus recovery after a host resume", () => {
  const resume = async (): Promise<void> => {
    window.dispatchEvent(new Event("pageshow"));
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  // ghostty-web has no refresh() and its frame loop repaints dirty rows
  // only, so pixels the host dropped while the window sat off-screen come
  // back only through a forced full pass of its renderer; the resume must
  // ask for one even though the grid is unchanged and the fit is a no-op.
  test("the resume forces a full render pass of the ghostty renderer", async () => {
    const { term } = await mountGhostty();
    // The mount fits and paints; the resume is judged from a settled terminal.
    await vi.waitFor(() => expect(ghostty.record.renders).not.toEqual([]));
    await new Promise((resolve) => setTimeout(resolve, 300));
    ghostty.record.renders.splice(0);
    term.resized.splice(0);

    await resume();
    await vi.waitFor(() => expect(ghostty.record.renders, "a forced pass").toContain(true));
    expect(term.resized, "the repaint is not a resize").toEqual([]);
  });

  test("with the host active, the resume blurs it and then focuses the terminal", async () => {
    const { target } = await mountGhostty();
    const host = target.querySelector<HTMLElement>(".terminal-host")!;
    host.tabIndex = 0;
    host.focus();
    expect(document.activeElement, "the host is active before the resume").toBe(host);
    const blurred = vi.spyOn(host, "blur");
    ghostty.record.events.splice(0);

    await resume();
    expect(blurred, "the host is blurred once").toHaveBeenCalledTimes(1);
    expect(ghostty.record.events, "the terminal is focused after the blur").toContain("focus");
    expect(document.activeElement, "the DOM focus left the host").not.toBe(host);
  });

  test("with the focus elsewhere, the resume leaves the host and the terminal alone", async () => {
    const { target } = await mountGhostty();
    const host = target.querySelector<HTMLElement>(".terminal-host")!;
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    expect(document.activeElement).toBe(input);
    const blurred = vi.spyOn(host, "blur");
    ghostty.record.events.splice(0);

    await resume();
    expect(blurred).not.toHaveBeenCalled();
    expect(ghostty.record.events).not.toContain("focus");
    expect(document.activeElement, "the input keeps the focus").toBe(input);
    input.remove();
  });

  // chan-desktop marks the page's root while the window's Computers launcher
  // is shown over it. The launcher is a second webview holding the keyboard;
  // a focus change in this page would move the window's first responder back
  // here and leave the launcher deaf, so the resume refocus waits for the
  // launcher to hide.
  test("with the launcher shown over the window, the resume leaves the host alone until it hides", async () => {
    const { target } = await mountGhostty();
    const host = target.querySelector<HTMLElement>(".terminal-host")!;
    host.tabIndex = 0;
    host.focus();
    const blurred = vi.spyOn(host, "blur");
    document.documentElement.setAttribute("data-launcher-shown", "");
    ghostty.record.events.splice(0);
    try {
      await resume();
      expect(blurred, "the host is not blurred under the launcher").not.toHaveBeenCalled();
      expect(ghostty.record.events, "the terminal is not focused under the launcher").not.toContain("focus");
      expect(document.activeElement, "the host keeps the DOM focus").toBe(host);
    } finally {
      document.documentElement.removeAttribute("data-launcher-shown");
    }

    await resume();
    expect(blurred, "once the launcher hides, a resume blurs the host").toHaveBeenCalledTimes(1);
    expect(ghostty.record.events, "and focuses the terminal").toContain("focus");
  });

  // A terminal that mounts or gains its pane's focus under the launcher (the
  // host page reloaded and lost its mark, a tab opened from cs) focuses a
  // fresh element: a real focus change that would make the host webview the
  // window's first responder. Every refocus waits for the launcher to hide.
  test("a terminal focused under the launcher takes the keyboard only after it hides", async () => {
    document.documentElement.setAttribute("data-launcher-shown", "");
    try {
      await mountGhostty();
      bumpTabFocusPulse();
      await tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(ghostty.record.events, "the terminal is not focused under the launcher").not.toContain("focus");
    } finally {
      document.documentElement.removeAttribute("data-launcher-shown");
    }
    bumpTabFocusPulse();
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ghostty.record.events, "the pane focus after the launcher hid focuses the terminal").toContain("focus");
  });
});

test("the VT reads current renderer metrics and sends a resize reply to its own PTY", async () => {
  const { term, socket } = await mountGhostty();
  expect(ghostty.record.hosts).toHaveLength(1);
  const host = ghostty.record.hosts[0]!;
  expect(host.cellSize()).toEqual({ width: 8, height: 16 });
  vi.spyOn(term.renderer, "getMetrics").mockReturnValue({ width: 10, height: 20 });
  expect(host.cellSize()).toEqual({ width: 10, height: 20 });
  host.onResizeReply("\x1b[48;30;100;600;1000t");
  expect(inputs(socket)).toEqual(["\x1b[48;30;100;600;1000t"]);
});

// ghostty-web tracks DECSET 1004 and sends no report of its own, so the
// component reports focus at the element ghostty-web focuses.
// A launcher opened from the body menu's Commands records what holds the
// keyboard as it opens and focuses its own input a tick later, as the
// command deck does. ghostty-web's focus() focuses its element again on a
// zero-delay timer, after that.
describe("the body menu's Commands", () => {
  test("hands the launcher the terminal's host, and leaves the keyboard in the launcher", async () => {
    ghostty.record.realFocus = true;
    const { target } = await mountGhostty();
    const host = target.querySelector<HTMLElement>(".terminal-host")!;
    host.tabIndex = 0;
    const launcherInput = document.createElement("input");
    document.body.append(launcherInput);
    let opener: Element | null = null;
    const onCommand = (e: Event) => {
      if ((e as CustomEvent<{ name: string }>).detail.name !== "app.launcher.toggle") return;
      opener = document.activeElement;
      void tick().then(() => launcherInput.focus());
    };
    window.addEventListener("chan:command", onCommand);
    try {
      await openBodyMenu(target);
      const row = menuRow("Command launcher");
      row.focus();
      row.click();
      await tick();
      await tick();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(opener, "the launcher opens from the terminal").toBe(host);
      expect(document.activeElement, "nothing takes the keyboard back from the launcher").toBe(launcherInput);
    } finally {
      window.removeEventListener("chan:command", onCommand);
      launcherInput.remove();
    }
  });
});

describe("focus reports", () => {
  const reports = (socket: TerminalSocket): unknown[] =>
    sentFrames(socket)
      .filter((frame) => frame.type === "input")
      .map((frame) => frame.data);
  const move = (
    host: HTMLElement,
    type: "focusin" | "focusout",
    relatedTarget: Element | null = null,
  ): void => {
    host.dispatchEvent(new FocusEvent(type, { bubbles: true, relatedTarget }));
  };

  test("with focus reporting on, focus-in sends CSI I and focus-out sends CSI O", async () => {
    const { target, socket } = await mountGhostty();
    const host = target.querySelector<HTMLElement>(".terminal-host")!;
    ghostty.record.focusEvents = true;

    move(host, "focusin");
    expect(reports(socket), "after focus-in").toEqual(["\x1b[I"]);
    move(host, "focusout");
    expect(reports(socket), "after focus-out").toEqual(["\x1b[I", "\x1b[O"]);
  });

  test("with focus reporting off, a focus change sends nothing", async () => {
    const { target, socket } = await mountGhostty();
    const host = target.querySelector<HTMLElement>(".terminal-host")!;

    move(host, "focusin");
    move(host, "focusout");
    expect(reports(socket), "with the mode off").toEqual([]);

    // The mode is read at each change, not once.
    ghostty.record.focusEvents = true;
    move(host, "focusin");
    ghostty.record.focusEvents = false;
    move(host, "focusout");
    expect(reports(socket), "after the mode came on and went off").toEqual([
      "\x1b[I",
    ]);
  });

  test("a resume reports each focus transition once despite retained browser events", async () => {
    const { target, socket, term } = await mountGhostty();
    const host = target.querySelector<HTMLElement>(".terminal-host")!;
    host.tabIndex = 0;
    ghostty.record.focusEvents = true;
    host.focus();
    expect(reports(socket)).toEqual(["\x1b[I"]);
    socket.sent.splice(0);
    vi.spyOn(term, "focus").mockImplementation(() => host.focus());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // Chromium retains the active element across a window blur, then
      // dispatches focusin after the resume repair blurs and refocuses it.
      move(host, "focusout");
      window.dispatchEvent(new Event("focus"));
      await tick();
      move(host, "focusin");
      expect(document.activeElement).toBe(host);
      expect(reports(socket)).toEqual(["\x1b[O", "\x1b[I"]);

      socket.sent.splice(0);
      host.blur();
      move(host, "focusout");
      host.focus();
      move(host, "focusin");
      expect(reports(socket), "a later tab switch still reports both transitions").toEqual(["\x1b[O", "\x1b[I"]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test("focus moving between the terminal's own elements is no change", async () => {
    const { target, socket } = await mountGhostty();
    const host = target.querySelector<HTMLElement>(".terminal-host")!;
    const inner = document.createElement("textarea");
    host.append(inner);
    ghostty.record.focusEvents = true;

    move(host, "focusout", inner);
    move(inner, "focusin", host);
    expect(reports(socket), "between the container and its input").toEqual([]);

    const outside = document.createElement("input");
    document.body.append(outside);
    move(inner, "focusout", outside);
    expect(reports(socket), "leaving for an element outside").toEqual([
      "\x1b[O",
    ]);
    outside.remove();
  });

  test("on xterm the component adds no report: xterm.js sends its own", async () => {
    __testSetStandalonePreferences(terminalPreferences({ ghostty: false, font_size: 15 }));
    const [tab] = seatTerminals([terminalTab()]);
    const { target } = await mountTerminal(TerminalTab, tab!);
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    socket.sent.splice(0);
    expect(ghostty.record.terminals, "ghostty terminals built").toHaveLength(0);
    const host = target.querySelector<HTMLElement>(".terminal-host")!;
    // Were a ghostty terminal asked, it would say reporting is on.
    ghostty.record.focusEvents = true;

    move(host, "focusin");
    move(host, "focusout");
    expect(reports(socket), "reports added on xterm").toEqual([]);
  });
});

describe("secret masking", () => {
  test("the painter hooks ghostty's renderer, and the row's check and the status line follow its toggle", async () => {
    const { target, term } = await mountGhostty();
    expect(term.renderer.render, "render wrapped after open").not.toBe(ghostty.fakeRender);
    expect(await spawned(target)).toMatchObject({ masking: false });
    menuRow(MASKING_ROW).click();
    await tick();
    expect(ui.status).toBe("Secret masking enabled for this terminal");
    expect(await spawned(target)).toMatchObject({ masking: true });
    menuRow(MASKING_ROW).click();
    await tick();
    expect(ui.status).toBe("Secret masking disabled for this terminal");
  });

  // What the painter fills at a frame, over a buffer whose first row holds a
  // secret: the mask itself, where a row's check only says what was asked.
  test("the launcher's command, the menu's row and Privacy mode each reach the painter", async () => {
    const { target, term } = await mountGhostty();
    const secret = "API_TOKEN=hunter2".padEnd(term.cols, " ");
    term.buffer.active.getLine = (row: number) =>
      row === 0
        ? {
            isWrapped: false,
            translateToString: (_trimRight?: boolean, start = 0, end = term.cols) => secret.slice(start, end),
            getCell: (x: number) => (x < term.cols ? { getWidth: () => 1, getChars: () => secret[x]!.trim() } : undefined),
          }
        : undefined;
    const fills: number[][] = [];
    term.renderer.ctx = { save() {}, restore() {}, fillRect: (...box: number[]) => fills.push(box) };
    /// The boxes one frame fills, in cells of the 8 by 16 stand-in metrics.
    const frame = (): number[][] => {
      fills.splice(0);
      term.renderer.render(term.wasmTerm, false, 0);
      return fills.map(([x, y, width, height]) => [x! / 8, y! / 16, width! / 8, height! / 16]);
    };
    const masked = [["API_TOKEN=".length, 0, "hunter2".length, 1]];
    const command = commandById("app.terminal.secretMasking.toggle")!;
    expect(frame(), "starts unmasked").toEqual([]);

    command.run();
    await tick();
    expect(frame(), "the launcher's command, on").toEqual(masked);
    command.run();
    await tick();
    expect(frame(), "the launcher's command, off").toEqual([]);

    await openBodyMenu(target);
    menuRow(MASKING_ROW).click();
    await tick();
    expect(frame(), "the menu's row, on").toEqual(masked);
    await openBodyMenu(target);
    menuRow(MASKING_ROW).click();
    await tick();
    expect(frame(), "the menu's row, off").toEqual([]);

    try {
      privacy.enabled = true;
      privacy.mask_terminal_secrets = true;
      await tick();
      expect(frame(), "Privacy mode, on").toEqual(masked);
      privacy.enabled = false;
      await tick();
      expect(frame(), "Privacy mode, off").toEqual([]);
    } finally {
      privacy.enabled = false;
      privacy.mask_terminal_secrets = false;
    }
  });

  test("a renderer without the hooks reports the failure and leaves masking off", async () => {
    __testSetStandalonePreferences(terminalPreferences({ ghostty: true, font_size: 15, secret_masking: true }));
    ghostty.record.bareRenderer = true;
    const { target } = await mountGhostty();
    expect(ui.status).toBe("Secret masking stopped working in this terminal");
    expect(await spawned(target)).toMatchObject({ masking: false });
  });
});


/// A paste event as the browser delivers it on the renderer host, its
/// clipboard text stood in (jsdom builds no ClipboardEvent of its own).
function pasteOn(element: Element, text: string): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type: string) => (type === "text/plain" ? text : "") },
  });
  element.dispatchEvent(event);
  return event;
}

describe("paste", () => {
  test("a paste with no text reaches the program as an empty bracketed paste, which ghostty-web would drop", async () => {
    ghostty.record.bracketedPaste = true;
    const { target } = await mountGhostty();
    const host = target.querySelector(".terminal-host")!;
    const event = pasteOn(host, "");
    expect(event.defaultPrevented).toBe(true);
    expect(ghostty.record.pastes).toEqual([""]);
  });

  test("without bracketed paste an empty paste sends nothing; a paste with text is chan's, line ends converted", async () => {
    const { target } = await mountGhostty();
    const host = target.querySelector(".terminal-host")!;
    expect(pasteOn(host, "").defaultPrevented).toBe(true);
    expect(ghostty.record.pastes).toEqual([]);
    // The stand-in runs no core of chan's binding, so the cleaned paste goes
    // through ghostty-web's own (ghosttyPaste.test.ts covers the core's).
    expect(pasteOn(host, "hello\nworld").defaultPrevented).toBe(true);
    expect(ghostty.record.pastes).toEqual(["hello\rworld"]);
  });

  test("a paste outside the renderer host, the composer's, is not the terminal's", async () => {
    ghostty.record.bracketedPaste = true;
    const { target } = await mountGhostty();
    const event = pasteOn(target.querySelector(".terminal-tab")!, "");
    expect(event.defaultPrevented).toBe(false);
    expect(ghostty.record.pastes).toEqual([]);
  });
});

describe("a theme switch", () => {
  afterEach(() => {
    delete hybridSurfaceThemes.terminal;
  });

  test("reaches the live terminal through the binding, not through the option ghostty-web ignores after open", async () => {
    ui.theme = "dark";
    const { term } = await mountGhostty();
    const openedWith = term.options.theme as Record<string, string>;
    expect(openedWith.red, "opened dark").toBe("#ff6b6b");

    hybridSurfaceThemes.terminal = "light";
    flushSync();
    await tick();
    const switched = ghostty.record.themes.at(-1);
    expect(switched?.term).toBe(term);
    expect(switched?.theme.red, "the light palette").toBe("#cf222e");
    expect(term.options.theme, "the option is not reassigned").toBe(openedWith);

    delete hybridSurfaceThemes.terminal;
    flushSync();
    await tick();
    expect(ghostty.record.themes.at(-1)?.theme.red, "back to dark").toBe("#ff6b6b");
  });
});
