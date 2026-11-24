// @vitest-environment jsdom
//
// TerminalTab opens the shared real widget. Forwarding spies observe the
// app's wiring; buffer, canvas and socket assertions read its effects.

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Terminal } from "@chan/ghostty-web-ng";
import type { GhosttyVt, VtHost } from "@chan/ghostty-web-ng/vt";

const observed = vi.hoisted(() => ({
  events: [] as string[],
  hosts: [] as VtHost[],
  instances: [] as GhosttyVt[],
}));

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) => {
  const fixture = await (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal);
  return { ...fixture, loadGhosttyKit: vi.fn(async () => {
    const kit = await fixture.loadGhosttyKit();
    const instantiate = kit.instantiate;
    vi.spyOn(kit, "instantiate").mockImplementation(async (host) => {
      observed.events.push("instantiate");
      if (host) observed.hosts.push(host);
      const instance = await instantiate(host);
      observed.instances.push(instance);
      vi.spyOn(instance, "createTerminal");
      return instance;
    });
    return kit;
  }) };
});
vi.mock("../terminal/ghosttyTheme", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../terminal/ghosttyTheme")>();
  return { ...actual, applyGhosttyTheme: vi.fn(actual.applyGhosttyTheme) };
});

import { loadGhosttyKit } from "../terminal/backend";
import { applyGhosttyTheme } from "../terminal/ghosttyTheme";
import { GhosttyViewportController } from "../terminal/ghosttyViewport";
import { Osc52Bridge } from "../terminal/osc52Bridge";
import { ghosttyFixture, installSoftwareCanvas, mountGhosttyTerminal, pressInGhostty } from "../__tests__/ghosttyTab";
import { SoftwareCanvasContext } from "../__tests__/softwareCanvas";
import { requestXtermStandIn } from "../__tests__/xterm";
import { privacy } from "@chan/web-shared/privacy";
import TerminalTab from "./TerminalTab.svelte";
import { terminalPreferences } from "../__tests__/standalone";
import { commandById } from "../state/commands";
import { shouldEscapeTerminal } from "../state/shortcuts";
import { __testSetStandalonePreferences, hybridSurfaceThemes, ui } from "../state/store.svelte";
import { bumpTabFocusPulse } from "../state/tabs.svelte";
import { closeTeamDialog, openTeamDialog } from "../state/teamDialog.svelte";
import {
  attach,
  installTerminalDom,
  menuRow,
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
    observed.events.push("dial");
  }
}
globalThis.WebSocket = DialRecordingSocket as unknown as typeof WebSocket;

const clipboard = { writeText: vi.fn(async (_text: string) => {}) };
Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });

let canvas: ReturnType<typeof installSoftwareCanvas>;
let hostSize = { cols: 100, rows: 30 };

beforeEach(() => {
  observed.events.length = 0;
  observed.hosts.length = 0;
  observed.instances.length = 0;
  vi.clearAllMocks();
  canvas = installSoftwareCanvas();
  hostSize = { cols: 100, rows: 30 };
  // The software canvas measures 8 by 19 CSS pixels before the 1.2 line height.
  for (const [property, axis, cell] of [["clientWidth", "cols", 8], ["clientHeight", "rows", 19 * 1.2]] as const) {
    const original = Object.getOwnPropertyDescriptor(Element.prototype, property)!.get!;
    vi.spyOn(Element.prototype, property, "get").mockImplementation(function (this: Element) {
      return this.classList.contains("terminal-host") ? hostSize[axis] * cell : original.call(this);
    });
  }
  for (const name of ["open", "focus", "blur"] as const) {
    const original = Terminal.prototype[name];
    vi.spyOn(Terminal.prototype, name).mockImplementation(function (this: Terminal, ...args: any[]) {
      observed.events.push(name);
      return (original as (...args: any[]) => void).apply(this, args);
    });
  }
  __testSetStandalonePreferences(terminalPreferences({ font_size: 15 }));
});

const fallbackMounts: Array<Record<string, unknown>> = [];
afterEach(() => {
  for (const component of fallbackMounts.splice(0)) unmount(component);
  resetTerminals();
  __testSetStandalonePreferences(null);
  clipboard.writeText.mockClear();
  ui.status = null;
  ui.terminalControl = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountGhostty({ focused = true }: { focused?: boolean } = {}) {
  const [tab] = seatTerminals([terminalTab()]);
  const mounted = await mountGhosttyTerminal(TerminalTab, tab!, { focused });
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  socket.sent.splice(0);
  return { ...mounted, tab: tab!, socket };
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

function wheel(term: Terminal, init: WheelEventInit): WheelEvent {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  term.element!.querySelector("canvas")!.dispatchEvent(event);
  return event;
}

function painted(term: Terminal): number[][] {
  canvas.frame();
  const context = canvas.context(term.element!);
  const cells: number[][] = [];
  for (let x = 0; x < term.cols; x++) {
    const pixel = context.pixelAt(x * 8 + 4, 9);
    if (pixel.r === 108 && pixel.g === 108 && pixel.b === 112 && pixel.a === 1) cells.push([x, 0]);
  }
  return cells;
}

const MASKING_ROW = "Secret masking (this terminal)";

/// The engine the terminal was built on, whether the open body menu's
/// masking row is checked, and how many times the ghostty kit was asked for.
async function spawned(target: HTMLElement): Promise<{ engine: string; masking: boolean; kitLoads: number }> {
  await openBodyMenu(target);
  return {
    engine: ghosttyFixture.terminals.length > 0 ? "ghostty" : xterm.terminals.length > 0 ? "xterm" : "",
    masking: menuRow(MASKING_ROW).getAttribute("aria-checked") === "true",
    kitLoads: vi.mocked(loadGhosttyKit).mock.calls.length,
  };
}

describe("a control terminal whose masking starts on", () => {
  test.each([
    ["unset", {}],
    ["on", { secret_masking: true }],
  ] as const)("with the preference %s it spawns on ghostty, masked", async (_name, masking) => {
    ui.terminalControl = true;
    __testSetStandalonePreferences(terminalPreferences({ font_size: 15, ...masking }));
    const { target } = await mountGhostty();
    expect(await spawned(target)).toEqual({ engine: "ghostty", masking: true, kitLoads: 1 });
    expect(ghosttyFixture.terminals, "one ghostty terminal built").toHaveLength(1);
  });

  test("its own toggle turns masking off and leaves it on ghostty", async () => {
    ui.terminalControl = true;
    const { target } = await mountGhostty();
    expect(await spawned(target)).toEqual({ engine: "ghostty", masking: true, kitLoads: 1 });
    menuRow(MASKING_ROW).click();
    await tick();
    expect(await spawned(target)).toEqual({ engine: "ghostty", masking: false, kitLoads: 1 });
  });

  test("with the preference off it starts unmasked on ghostty", async () => {
    ui.terminalControl = true;
    __testSetStandalonePreferences(terminalPreferences({ font_size: 15, secret_masking: false }));
    const { target } = await mountGhostty();
    expect(await spawned(target)).toEqual({ engine: "ghostty", masking: false, kitLoads: 1 });
  });

  test("a terminal of any other window masks on ghostty with the preference on", async () => {
    __testSetStandalonePreferences(terminalPreferences({ font_size: 15, secret_masking: true }));
    const { target } = await mountGhostty();
    expect(await spawned(target)).toEqual({ engine: "ghostty", masking: true, kitLoads: 1 });
  });
});

describe("choosing the backend", () => {
  test("a terminal spawns on ghostty with chan's options", async () => {
    const { term } = await mountGhostty();
    expect(xterm.terminals, "no xterm built").toHaveLength(0);
    expect(term.options).toMatchObject({ fontSize: 15, smoothScrollDuration: 0, cursorBlink: false, cursorStyle: "block" });
  });

  test("a kit that fails to load falls back to xterm", async () => {
    // Deliberate loader-failure exception while the app still falls back to
    // xterm; replace this case when terminal load failures have their own UI.
    // The failure is the route's, which asks for the fallback the case reads.
    vi.mocked(loadGhosttyKit).mockImplementationOnce(requestXtermStandIn);
    const [tab] = seatTerminals([terminalTab()]);
    const target = document.createElement("div");
    document.body.append(target);
    fallbackMounts.push(mount(TerminalTab, {
      target, props: { tab: tab!, paneId: TERMINAL_PANE, side: "a", active: true, focused: true },
    }));
    await vi.waitFor(() => expect(xterm.terminals).toHaveLength(1));
    expect(ghosttyFixture.terminals).toHaveLength(0);
    expect(xterm.terminals).toHaveLength(1);
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
    vi.doUnmock("@chan/ghostty-web-ng");
  });
});

describe("the mount", () => {
  test("instantiate its own wasm, construct with widget options, open, then dial", async () => {
    const { term } = await mountGhostty();
    expect(observed.events.indexOf("instantiate")).toBeLessThan(observed.events.indexOf("open"));
    expect(observed.events.indexOf("open")).toBeLessThan(observed.events.indexOf("dial"));
    expect(term.options).toMatchObject({
      lineHeight: 1.2, boxGlyphs: true, scrollbar: "overlay",
      copy: expect.any(Function), joinDrawnWraps: expect.any(Function),
    });
  });

  test("the terminal is built on the wasm instance its own spawn created", async () => {
    await mountGhostty();
    expect(observed.instances).toHaveLength(1);
    expect(vi.mocked(observed.instances[0]!.createTerminal).mock.results[0]?.value).toBe(ghosttyFixture.terminals[0]!.wasmTerm);
  });

  test("a resize fits with chan's own measurement", async () => {
    const { term } = await mountGhostty();
    term.resize(80, 24);
    resizeObservers.at(-1)!.callback();
    canvas.frame();
    expect([term.cols, term.rows]).toEqual([100, 30]);
  });

  test("a shown fit publishes through Ghostty's resize handler", async () => {
    const { term, socket } = await mountGhostty();
    term.resize(90, 30);
    socket.sent.splice(0);
    resizeObservers.at(-1)!.callback();
    canvas.frame();
    expect(sentFrames(socket).filter((frame) => frame.type === "resize"))
      .toEqual([{ type: "resize", cols: 100, rows: 30 }]);
  });
});

describe("keys", () => {
  test("host insertText reaches the PTY once as typed input and never as paste", async () => {
    const { target, socket, term } = await mountGhostty();
    const pasted = vi.spyOn(term, "paste");
    const host = target.querySelector<HTMLElement>(".terminal-host")!;
    host.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true, cancelable: true, inputType: "insertText", data: "\u{1f600}",
    }));
    expect(inputs(socket)).toEqual(["\u{1f600}"]);
    expect(pasted).not.toHaveBeenCalled();
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
    const { term, socket } = await mountGhostty();
    await output(socket, "chosen");
    term.select(0, 0, 6);
    const copy = pressInGhostty(term, { key: "C", code: "KeyC", ctrlKey: true, shiftKey: true });
    const paste = pressInGhostty(term, { key: "V", code: "KeyV", ctrlKey: true, shiftKey: true });
    await tick();

    expect(copy.defaultPrevented).toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledWith("chosen");
    expect(paste.defaultPrevented).toBe(false);
    expect(inputs(socket)).toEqual([]);
  });

  test("a chord chan lets out of the terminal leaves with its default, and the tab cancels the one it acts on", async () => {
    const { term, socket } = await mountGhostty();
    const reached: Event[] = [];
    const record = (event: Event) => reached.push(event);
    document.addEventListener("keydown", record);
    try {
      // The launcher's chord: this tab acts on no part of it, and no app is
      // mounted here to take it.
      const launcher = pressInGhostty(term, { key: "k", code: "KeyK", ctrlKey: true, altKey: true });
      expect(shouldEscapeTerminal(launcher), "the launcher's chord").toBe(true);
      expect(reached.includes(launcher), "it reaches the page").toBe(true);
      expect(launcher.defaultPrevented, "nothing took the key, so the browser still may").toBe(false);

      // Find: the tab's own root opens its bar and cancels the key.
      const find = pressInGhostty(term, { key: "F", code: "KeyF", ctrlKey: true, shiftKey: true });
      expect(shouldEscapeTerminal(find), "the find chord").toBe(true);
      await tick();
      expect(document.querySelector(".terminal-find input.find"), "the find bar").not.toBeNull();
      expect(find.defaultPrevented, "the tab took the key").toBe(true);
      expect(inputs(socket)).toEqual([]);
    } finally {
      document.removeEventListener("keydown", record);
    }
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
    await output(socket, "line\r\n".repeat(100));
    hostKey(target, { key: "PageUp", code: "PageUp", keyCode: 33, shiftKey: true });
    expect(term.getViewportY()).toBe(term.rows - 1);
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

  test("plain typing reaches the PTY and copy and paste keep their own paths", async () => {
    const { target, socket } = await mountGhostty();
    const outer = vi.fn();
    target.addEventListener("keydown", outer);
    hostKey(target, { key: "a", code: "KeyA", keyCode: 65 });
    hostKey(target, { key: "C", code: "KeyC", keyCode: 67, ctrlKey: true, shiftKey: true });
    hostKey(target, { key: "V", code: "KeyV", keyCode: 86, ctrlKey: true, shiftKey: true });
    expect(outer).toHaveBeenCalledTimes(2);
    expect(inputs(socket)).toEqual(["a"]);
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
    const writes = vi.spyOn(GhosttyViewportController.prototype, "write");
    const osc = vi.spyOn(Osc52Bridge.prototype, "push");
    const { socket, term } = await mountGhostty();
    await output(socket, "hello");
    expect(writes.mock.calls.map(([bytes]) => typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes))).toContain("hello");
    expect(osc.mock.calls.map(([bytes]) => new TextDecoder().decode(bytes))).toContain("hello");
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("hello");
  });

  test("the wheel goes to the viewport controller", async () => {
    const scrolled = vi.spyOn(GhosttyViewportController.prototype, "handleWheel");
    const { term, socket } = await mountGhostty();
    await output(socket, "line\r\n".repeat(100));
    wheel(term, { deltaY: -19 });
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(term.getViewportY()).toBeGreaterThan(0);
  });

  const arrows = (socket: TerminalSocket): unknown[] =>
    sentFrames(socket)
      .filter((frame) => frame.type === "input")
      .map((frame) => frame.data);

  test("on the alternate screen a trackpad swipe sends one arrow per row it adds up to", async () => {
    const { term, socket } = await mountGhostty();
    await output(socket, "\x1b[?1049h");
    // 10 px on a 22.8 px row, scaled by 0.3: twenty-four events cross three
    // rows.
    const claimed = Array.from({ length: 24 }, () =>
      wheel(term, { deltaY: 10 }).defaultPrevented,
    );
    expect(claimed.every(Boolean)).toBe(true);
    expect(arrows(socket)).toEqual(["\x1b[B", "\x1b[B", "\x1b[B"]);
    expect(term.getViewportY()).toBe(0);
  });

  test("on the alternate screen application cursor keys send the SS3 arrow", async () => {
    const { term, socket } = await mountGhostty();
    await output(socket, "\x1b[?1049h");
    await output(socket, "\x1b[?1h");
    wheel(term, { deltaY: -1, deltaMode: 1 });
    expect(arrows(socket)).toEqual(["\x1bOA"]);
  });

  test("a wheel arrow sent to the PTY does not arm a connection probe", async () => {
    const { term, socket } = await mountGhostty();
    vi.useFakeTimers();
    try {
      await output(socket, "\x1b[?1049h");
      wheel(term, { deltaY: -1, deltaMode: 1 });
      expect(arrows(socket)).toEqual(["\x1b[A"]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sentFrames(socket).filter((frame) => frame.type === "ping")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
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
    canvas.frame();
    const rendered = vi.spyOn(term.renderer!, "render");
    const resized = vi.spyOn(term, "resize");
    await resume();
    expect(rendered.mock.calls.some((call) => call[1] === true), "a forced pass").toBe(true);
    expect(resized, "the repaint is not a resize").not.toHaveBeenCalled();
  });

  test("with the host active, the resume blurs it and then focuses the terminal", async () => {
    const { target } = await mountGhostty();
    const host = target.querySelector<HTMLElement>(".terminal-host")!;
    host.tabIndex = 0;
    host.focus();
    expect(document.activeElement, "the host is active before the resume").toBe(host);
    const blurred = vi.spyOn(host, "blur");
    observed.events.splice(0);

    await resume();
    expect(blurred, "the host is blurred once").toHaveBeenCalledTimes(1);
    expect(observed.events, "the terminal is focused after the blur").toContain("focus");
    expect(document.activeElement, "the real terminal regains focus after the blur").toBe(host);
    expect(blurred.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(Terminal.prototype.focus).mock.invocationCallOrder.at(-1)!);
  });

  test("with the focus elsewhere, the resume leaves the host and the terminal alone", async () => {
    const { target } = await mountGhostty();
    const host = target.querySelector<HTMLElement>(".terminal-host")!;
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    expect(document.activeElement).toBe(input);
    const blurred = vi.spyOn(host, "blur");
    observed.events.splice(0);

    await resume();
    expect(blurred).not.toHaveBeenCalled();
    expect(observed.events).not.toContain("focus");
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
    observed.events.splice(0);
    try {
      await resume();
      expect(blurred, "the host is not blurred under the launcher").not.toHaveBeenCalled();
      expect(observed.events, "the terminal is not focused under the launcher").not.toContain("focus");
      expect(document.activeElement, "the host keeps the DOM focus").toBe(host);
    } finally {
      document.documentElement.removeAttribute("data-launcher-shown");
    }

    await resume();
    expect(blurred, "once the launcher hides, a resume blurs the host").toHaveBeenCalledTimes(1);
    expect(observed.events, "and focuses the terminal").toContain("focus");
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
      expect(observed.events, "the terminal is not focused under the launcher").not.toContain("focus");
    } finally {
      document.documentElement.removeAttribute("data-launcher-shown");
    }
    bumpTabFocusPulse();
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observed.events, "the pane focus after the launcher hid focuses the terminal").toContain("focus");
  });
});

test("the VT reads current renderer metrics and sends a resize reply to its own PTY", async () => {
  const { term, socket } = await mountGhostty();
  expect(observed.hosts).toHaveLength(1);
  const host = observed.hosts[0]!;
  expect(host.cellSize?.()).toMatchObject({ width: 8, height: 19 * 1.2 });
  vi.spyOn(term.renderer!, "getMetrics").mockReturnValue({ ...term.renderer!.getMetrics(), width: 10, height: 20 });
  expect(host.cellSize?.()).toMatchObject({ width: 10, height: 20 });
  host.onResizeReply?.("\x1b[48;30;100;600;1000t");
  expect(inputs(socket)).toEqual(["\x1b[48;30;100;600;1000t"]);
});

// ghostty-web's open() takes no focus; focus() focuses the element it opened
// in, once and synchronously. A terminal that spawns or is
// restored in a background pane takes no keyboard: it leaves it with what
// held it. `TerminalTab.ghosttyOpen.test.ts` reads the same on the widget.
describe("a ghostty terminal opening in a background pane", () => {
  test("leaves the keyboard on the field that held it, once its mount has settled", async () => {
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    try {
      const { target } = await mountGhostty({ focused: false });
      expect(target.querySelector(".terminal-host")?.getAttribute("tabindex"), "the host opened focusable").toBe("0");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(document.activeElement).toBe(field);
    } finally {
      field.remove();
    }
  });

  test("a terminal in the focused pane takes the keyboard", async () => {
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    try {
      const { target } = await mountGhostty();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(document.activeElement).toBe(target.querySelector(".terminal-host"));
    } finally {
      field.remove();
    }
  });
});

describe("a ghostty terminal under the Team dialog", () => {
  test("a focused terminal finishing its mount leaves the keyboard in the dialog's field", async () => {
    const field = document.createElement("input");
    document.body.append(field);
    openTeamDialog({ leadTabId: "term-1", leadPaneId: TERMINAL_PANE });
    field.focus();
    try {
      const { target } = await mountGhostty();
      expect(target.querySelector(".terminal-host")?.getAttribute("tabindex"), "the terminal finishes opening focusable").toBe("0");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(document.activeElement, "the modal field keeps focus after terminal startup").toBe(field);
      expect(observed.events, "startup does not ask the terminal to take focus under a modal").not.toContain("focus");
    } finally {
      closeTeamDialog();
      field.remove();
    }
  });

  test("a pane focus pulse cannot focus the terminal until the dialog closes", async () => {
    const { target, tab } = await mountGhostty();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const field = document.createElement("input");
    document.body.append(field);
    openTeamDialog({ leadTabId: tab.id, leadPaneId: TERMINAL_PANE });
    field.focus();
    observed.events.splice(0);
    try {
      bumpTabFocusPulse();
      // These body assertions identify the pulse's own synchronous blur,
      // not the behavior under test. The terminal must leave focus unclaimed.
      expect(document.activeElement, "the pulse relinquishes the field before notifying tabs").toBe(document.body);
      await tick();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(observed.events, "the pane pulse does not ask the terminal to take focus under a modal").not.toContain("focus");
      expect(document.activeElement, "the terminal cannot take the keyboard parked by the pulse under a modal").toBe(document.body);

      closeTeamDialog();
      bumpTabFocusPulse();
      await tick();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(document.activeElement, "the ordinary pane pulse restores terminal focus after the modal closes").toBe(target.querySelector(".terminal-host"));
      expect(observed.events, "focus resumes once the modal releases the keyboard").toContain("focus");
    } finally {
      closeTeamDialog();
      field.remove();
    }
  });
});

// ghostty-web tracks DECSET 1004 and sends no report of its own, so the
// component reports focus at the element ghostty-web focuses.
// A launcher opened from the body menu's Commands records what holds the
// keyboard as it opens and focuses its own input a tick later, as the
// command deck does; nothing focuses the terminal after that.
describe("the body menu's Commands", () => {
  test("hands the launcher the terminal's host, and leaves the keyboard in the launcher", async () => {
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
    await output(socket, "\x1b[?1004h");

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
    await output(socket, "\x1b[?1004h");
    move(host, "focusin");
    await output(socket, "\x1b[?1004l");
    move(host, "focusout");
    expect(reports(socket), "after the mode came on and went off").toEqual([
      "\x1b[I",
    ]);
  });

  test("a resume reports each focus transition once despite retained browser events", async () => {
    const { target, socket } = await mountGhostty();
    const host = target.querySelector<HTMLElement>(".terminal-host")!;
    host.tabIndex = 0;
    await output(socket, "\x1b[?1004h");
    host.blur();
    socket.sent.splice(0);
    host.focus();
    expect(reports(socket)).toEqual(["\x1b[I"]);
    socket.sent.splice(0);
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
    await output(socket, "\x1b[?1004h");

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


});

describe("secret masking", () => {
  test("the painter hooks ghostty's renderer, and the row's check and the status line follow its toggle", async () => {
    const { target, term, socket } = await mountGhostty();
    await output(socket, "API_TOKEN=hunter2");
    expect(painted(term)).toEqual([]);
    expect(await spawned(target)).toMatchObject({ masking: false });
    menuRow(MASKING_ROW).click();
    await tick();
    expect(ui.status).toBe("Secret masking enabled for this terminal");
    expect(painted(term)).toEqual(Array.from({ length: 7 }, (_, i) => [i + 10, 0]));
    expect(await spawned(target)).toMatchObject({ masking: true });
    menuRow(MASKING_ROW).click();
    await tick();
    expect(ui.status).toBe("Secret masking disabled for this terminal");
    expect(painted(term)).toEqual([]);
  });

  // Read the mask itself over parsed output, beyond the menu check state.
  test("the launcher's command, the menu's row and Privacy mode each reach the painter", async () => {
    const { target, term, socket } = await mountGhostty();
    await output(socket, "API_TOKEN=hunter2");
    const frame = () => painted(term);
    const masked = Array.from({ length: 7 }, (_, i) => [i + 10, 0]);
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

  test("a renderer that refuses mask painting reports the failure and leaves masking off", async () => {
    __testSetStandalonePreferences(terminalPreferences({ font_size: 15, secret_masking: true }));
    const fill = SoftwareCanvasContext.prototype.fillRect;
    vi.spyOn(SoftwareCanvasContext.prototype, "fillRect").mockImplementation(function (this: SoftwareCanvasContext, ...args) {
      if (this.fillStyle === "#6c6c70") throw new Error("mask paint refused");
      fill.apply(this, args);
    });
    const { target, socket } = await mountGhostty();
    await output(socket, "API_TOKEN=hunter2");
    canvas.frame();
    await tick();
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
    const { target, socket } = await mountGhostty();
    await output(socket, "\x1b[?2004h");
    const host = target.querySelector(".terminal-host")!;
    const event = pasteOn(host, "");
    expect(event.defaultPrevented).toBe(true);
    expect(inputs(socket)).toEqual(["\x1b[200~\x1b[201~"]);
  });

  test("without bracketed paste an empty paste sends nothing; a paste with text is chan's, line ends converted", async () => {
    const { target, socket } = await mountGhostty();
    const host = target.querySelector(".terminal-host")!;
    expect(pasteOn(host, "").defaultPrevented).toBe(true);
    expect(inputs(socket)).toEqual([]);
    expect(pasteOn(host, "hello\nworld").defaultPrevented).toBe(true);
    expect(inputs(socket)).toEqual(["hello\rworld"]);
  });

  test("a paste outside the renderer host, the composer's, is not the terminal's", async () => {
    const { target, socket } = await mountGhostty();
    await output(socket, "\x1b[?2004h");
    const event = pasteOn(target.querySelector(".terminal-tab")!, "");
    expect(event.defaultPrevented).toBe(false);
    expect(inputs(socket)).toEqual([]);
  });
});

describe("a theme switch", () => {
  afterEach(() => {
    delete hybridSurfaceThemes.terminal;
  });

  test("reaches the live terminal through the widget's theme update, which replaces the theme it held", async () => {
    ui.theme = "dark";
    const { term } = await mountGhostty();
    const openedWith = term.options.theme;
    expect(openedWith.red, "opened dark").toBe("#ff6b6b");

    hybridSurfaceThemes.terminal = "light";
    flushSync();
    await tick();
    const switched = vi.mocked(applyGhosttyTheme).mock.calls.at(-1);
    expect(switched?.[0]).toBe(term);
    expect(switched?.[1].red, "the light palette").toBe("#cf222e");
    expect(term.options.theme.red).toBe("#cf222e");
    expect(term.options.theme, "the widget holds a new theme object").not.toBe(openedWith);
    expect(openedWith.red, "the theme held at open is not rewritten in place").toBe("#ff6b6b");

    delete hybridSurfaceThemes.terminal;
    flushSync();
    await tick();
    expect(vi.mocked(applyGhosttyTheme).mock.calls.at(-1)?.[1].red, "back to dark").toBe("#ff6b6b");
    expect(term.options.theme.red).toBe("#ff6b6b");
  });
});
