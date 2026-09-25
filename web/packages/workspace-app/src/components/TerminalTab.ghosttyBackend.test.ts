// @vitest-environment jsdom
//
// TerminalTab on the ghostty backend: chosen from the terminal settings when
// the terminal spawns, loaded lazily with an xterm fallback, and wired through
// chan's own fitter, compatibility hooks, viewport controller and key
// handling. A TerminalTab is mounted with the ghostty kit and its hooks
// stubbed; each stand-in records what the component asked of it, in order.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const ghostty = vi.hoisted(() => {
  const record = {
    events: [] as string[],
    kitFails: false,
    alignOk: true,
    hostOwned: false,
    terminals: [] as Array<Record<string, any>>,
    viewportWrites: [] as string[],
    wheels: 0,
    osc52: [] as string[],
  };
  class FakeGhosttyTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
    wheelHandler: ((e: WheelEvent) => boolean) | null = null;
    dataHandlers: Array<(data: string) => void> = [];
    resized: Array<[number, number]> = [];
    renderer = { getMetrics: () => ({ width: 8, height: 16 }) };
    buffer = { active: {}, alternate: {} };
    constructor(options: Record<string, unknown>) {
      this.options = options;
      record.terminals.push(this);
      record.events.push("construct");
    }
    open() {
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
    onResize() {
      return { dispose() {} };
    }
    hasMouseTracking() {
      return false;
    }
    write() {}
    writeln() {}
    paste() {}
    resize(cols: number, rows: number) {
      this.resized.push([cols, rows]);
      this.cols = cols;
      this.rows = rows;
    }
    refresh() {}
    focus() {}
    blur() {}
    getSelection() {
      return "chosen";
    }
    dispose() {}
  }
  return { record, FakeGhosttyTerminal };
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
    if (ghostty.record.kitFails) throw new Error("wasm fetch failed");
    return { ghostty: { kit: true }, Terminal: ghostty.FakeGhosttyTerminal };
  }),
}));
vi.mock("../terminal/ghosttyCompat", () => ({
  clearGhosttyRecycledGrid: () => ghostty.record.events.push("scrub"),
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
vi.mock("../terminal/hostChord", () => ({
  isHostOwnedChord: () => ghostty.record.hostOwned,
}));

import TerminalTab from "./TerminalTab.svelte";
import type { Preferences } from "../api/types";
import { __testSetStandalonePreferences, ui } from "../state/store.svelte";
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
    alignOk: true,
    hostOwned: false,
    terminals: [],
    viewportWrites: [],
    wheels: 0,
    osc52: [],
  });
  __testSetStandalonePreferences({ terminal: { ghostty: true, font_size: 15 } } as unknown as Preferences);
});

afterEach(() => {
  resetTerminals();
  __testSetStandalonePreferences(null);
  clipboard.writeText.mockClear();
  ui.status = null;
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

function key(term: Record<string, any>, init: KeyboardEventInit): { event: KeyboardEvent; claimed: boolean } {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  return { event, claimed: term.keyHandler(event) };
}

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
    vi.doMock("ghostty-web", () => {
      loads += 1;
      return {};
    });
    await import("./TerminalTab.svelte");
    expect(loads).toBe(0);
  });
});

describe("the mount", () => {
  test("after open: scrub the grid, align to xterm's cell, install the hooks, then dial", async () => {
    await mountGhostty();
    expect(ghostty.record.events.slice(0, 8)).toEqual([
      "construct",
      "open",
      "scrub",
      "align",
      "glyphs",
      "scrollbar",
      "gate",
      "dial",
    ]);
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

  test("the scrollbar gate is removed when the terminal goes", async () => {
    const { component } = await mountGhostty();
    unmount(component);
    ghosttyMounts.splice(ghosttyMounts.indexOf(component), 1);
    expect(ghostty.record.events).toContain("ungate");
  });
});

describe("keys", () => {
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

  test("Shift+Enter sends chan's line feed, before ghostty would send Enter", async () => {
    const { term, socket } = await mountGhostty();
    const { claimed } = key(term, { key: "Enter", shiftKey: true });
    expect(claimed).toBe(true);
    expect(sentFrames(socket).filter((f) => f.type === "input").map((f) => f.data)).toEqual(["\n"]);
  });

  test("a host-owned chord stops before ghostty without losing its default", async () => {
    ghostty.record.hostOwned = true;
    const { target } = await mountGhostty();
    const outer = vi.fn();
    target.addEventListener("keydown", outer);
    const host = target.querySelector(".terminal-tab")!.querySelector("div")!;
    const event = new KeyboardEvent("keydown", { key: "w", metaKey: true, bubbles: true, cancelable: true });
    host.dispatchEvent(event);
    expect(outer).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
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
});

describe("secret masking", () => {
  test("says it is unavailable on ghostty and changes nothing", async () => {
    const { target } = await mountGhostty();
    await openBodyMenu(target);
    menuRow("Secret masking unavailable").click();
    await tick();
    expect(ui.status).toBe("Secret masking unavailable on ghostty backend");
  });
});
