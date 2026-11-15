// @vitest-environment jsdom
//
// Both backends use their real parser, input listeners and viewport. Only
// browser sizing, optional addons and the transport are supplied by the test.

import { readFileSync } from "node:fs";
import { mount, tick, unmount } from "svelte";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import { Terminal as GhosttyTerminal } from "@chan/ghostty-web-ng";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  terminals: [] as unknown[],
  module: null as WebAssembly.Module | null,
  paths: [] as string[],
  os: "mac",
}));

vi.mock("@xterm/xterm", async (original) => {
  const actual = await original<typeof import("@xterm/xterm")>();
  return { ...actual, Terminal: class extends actual.Terminal {
    constructor(options: ConstructorParameters<typeof actual.Terminal>[0]) {
      super(options);
      runtime.terminals.push(this);
    }
  } };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { activate() {} dispose() {} fit() {} proposeDimensions() { return undefined; } } }));
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (original) => {
  const actual = await original<typeof import("../terminal/backend")>();
  const { Terminal } = await import("@chan/ghostty-web-ng");
  return { ...actual, loadGhosttyKit: async () => actual.ghosttyKitFrom(runtime.module!, {
    Terminal: class extends Terminal {
      constructor(options: ConstructorParameters<typeof Terminal>[0]) {
        super(options);
        runtime.terminals.push(this);
      }
    },
  }) };
});
vi.mock("../api/desktop", async (original) => ({
  ...(await original<typeof import("../api/desktop")>()),
  readDroppedPaths: async () => runtime.paths,
}));
vi.mock("../state/shortcuts", async (original) => ({
  ...(await original<typeof import("../state/shortcuts")>()),
  currentOS: () => runtime.os,
}));

import TerminalTab from "./TerminalTab.svelte";
import { SoftwareCanvasContext } from "../__tests__/softwareCanvas";
import { terminalPreferences } from "../__tests__/standalone";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import { registerTerminalInputSink, sendPromptToTerminal } from "../state/tabs.svelte";
import {
  attach, installTerminalDom, output, receive, resetTerminals,
  seatTerminals, sentFrames, terminalTab, TERMINAL_PANE, TerminalSocket,
} from "../__tests__/terminalTab";

type Terminal = XtermTerminal | GhosttyTerminal;
let component: ReturnType<typeof mount> | undefined;

installTerminalDom();
beforeAll(async () => {
  runtime.module = await WebAssembly.compile(readFileSync("../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm"));
});
beforeEach(() => {
  runtime.os = "mac";
  runtime.paths = [];
  runtime.terminals.length = 0;
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  // jsdom has no font layout; xterm derives its viewport pixels from these.
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("xterm-char-measure-element") ? 256 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("xterm-char-measure-element") ? 17 : 0;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return new SoftwareCanvasContext(this, 8) as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  resetTerminals();
  __testSetStandalonePreferences(null);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function history(term: Terminal): number {
  return term instanceof GhosttyTerminal
    ? term.getViewportY()
    : term.buffer.active.baseY - term.buffer.active.viewportY;
}
function inputFrames(socket: TerminalSocket): unknown[] {
  return sentFrames(socket).filter((f) => f.type === "input").map((f) => f.data);
}
async function scrolled(backend: "xterm" | "ghostty", mouseCapture = false, broadcast = false) {
  __testSetStandalonePreferences(terminalPreferences({ ghostty: backend === "ghostty", secret_masking: false, mouse_capture: mouseCapture }));
  const [tab, sibling] = seatTerminals(broadcast ? [
    terminalTab({ broadcastEnabled: true, group: "input-scroll" }),
    terminalTab({ id: "term-sibling", broadcastEnabled: true, group: "input-scroll" }),
  ] : [terminalTab()]);
  const target = document.createElement("div");
  document.body.append(target);
  component = mount(TerminalTab, { target, props: { tab: tab!, paneId: TERMINAL_PANE, side: "a", active: true, focused: true } });
  await vi.waitFor(() => expect(TerminalSocket.all).toHaveLength(1));
  const term = runtime.terminals[0] as Terminal;
  expect(term instanceof GhosttyTerminal).toBe(backend === "ghostty");
  const socket = TerminalSocket.all[0]!;
  await attach(socket);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  await output(socket, Array.from({ length: 100 }, (_, i) => `history ${i}\r\n`).join("") + "$ ");
  await vi.waitFor(() => expect(term instanceof GhosttyTerminal ? term.getScrollbackLength() : term.buffer.active.baseY).toBeGreaterThan(50));
  term.scrollLines(-7);
  expect(history(term)).toBe(7);
  socket.sent.length = 0;
  const inputHistory: number[] = [];
  const promptHistory: number[] = [];
  const send = socket.send.bind(socket);
  vi.spyOn(socket, "send").mockImplementation((data) => {
    const type = (JSON.parse(data) as { type: string }).type;
    if (type === "input") inputHistory.push(history(term));
    if (type === "prompt") promptHistory.push(history(term));
    send(data);
  });
  const host = target.querySelector<HTMLElement>(".terminal-host")!;
  const input = term instanceof GhosttyTerminal ? host : term.textarea!;
  return { tab: tab!, sibling, target, term, socket, host, input, inputHistory, promptHistory };
}
function key(input: HTMLElement, init: KeyboardEventInit): void {
  input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}
function drop(target: HTMLElement): Event {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"] } });
  target.querySelector(".terminal-host")!.dispatchEvent(event);
  return event;
}

describe.each(["xterm", "ghostty"] as const)("%s terminal input viewport", (backend) => {
  test("a Rich Prompt returns to the live cursor before sending its queued frame", async () => {
    const { tab, term, socket, promptHistory } = await scrolled(backend);
    expect(sendPromptToTerminal(tab.id, "run it", "claude", "prompt-scroll")).toBe(true);
    expect(sentFrames(socket)).toEqual([
      { type: "prompt", data: "run it", agent: "claude", id: "prompt-scroll" },
    ]);
    expect(promptHistory).toEqual([0]);
    expect(history(term)).toBe(0);
  });

  test.each([0, 2, 3])("a prompt rejected by socket state %s preserves history", async (readyState) => {
    const { tab, term, socket, promptHistory } = await scrolled(backend);
    socket.readyState = readyState;
    expect(sendPromptToTerminal(tab.id, "run it", "claude", "prompt-offline")).toBe(false);
    expect(sentFrames(socket)).toEqual([]);
    expect(promptHistory).toEqual([]);
    expect(history(term)).toBe(7);
  });

  test.each([
    { name: "Ctrl+/ while connecting", readyState: 0, key: { key: "/", code: "Slash", ctrlKey: true } },
    { name: "Option+Left while closing", readyState: 2, key: { key: "ArrowLeft", code: "ArrowLeft", altKey: true } },
    { name: "a file drop while closed", readyState: 3, key: null },
  ])("$name sends nothing and preserves history", async ({ readyState, key: init }) => {
    const { target, term, socket, input, inputHistory } = await scrolled(backend);
    socket.readyState = readyState;
    if (init) {
      key(input, init);
    } else {
      runtime.paths = ["/tmp/offline path"];
      expect(drop(target).defaultPrevented).toBe(true);
      await tick();
    }
    expect(sentFrames(socket)).toEqual([]);
    expect(inputHistory).toEqual([]);
    expect(history(term)).toBe(7);
  });

  test.each([0, 2, 3].flatMap((readyState) =>
    ["direct key", "dropped path"].map((kind) => ({ readyState, kind })),
  ))("$kind reaches the same-window group while socket state $readyState preserves local history", async ({ readyState, kind }) => {
    const { sibling, target, term, socket, input, inputHistory } = await scrolled(backend, false, true);
    const received: Array<[string, boolean | undefined]> = [];
    const unregister = registerTerminalInputSink(sibling!.id, (data, binary) => received.push([data, binary]));
    try {
      socket.readyState = readyState;
      let bytes: string;
      if (kind === "direct key") {
        bytes = backend === "ghostty" ? "\r" : "\x1f";
        key(input, backend === "ghostty"
          ? { key: "Enter", code: "Enter", keyCode: 13 }
          : { key: "/", code: "Slash", ctrlKey: true });
      } else {
        bytes = "'/tmp/group path' ";
        runtime.paths = ["/tmp/group path"];
        expect(drop(target).defaultPrevented).toBe(true);
        await tick();
      }
      expect(sentFrames(socket), "the disconnected source has no local or cross-window frame").toEqual([]);
      expect(inputHistory).toEqual([]);
      expect(history(term)).toBe(7);
      expect(received, "the same-window sibling still receives the input").toEqual([[bytes, false]]);
    } finally {
      unregister();
    }
  });

  test.each([
    { name: "SGR mouse", sgr: true, wheel: false, bytes: "\x1b[<0;1;1M" },
    { name: "X10 mouse", sgr: false, wheel: false, bytes: "\x1b[M !!" },
    { name: "SGR wheel", sgr: true, wheel: true, bytes: "\x1b[<64;1;1M" },
    { name: "X10 wheel", sgr: false, wheel: true, bytes: "\x1b[M`!!" },
  ])("a native $name report follows the backend's input-scroll rule", async ({ sgr, wheel, bytes }) => {
    const { term, socket, host, inputHistory } = await scrolled(backend, true);
    await output(socket, `\x1b[?1000h\x1b[?1006${sgr ? "h" : "l"}`);
    await vi.waitFor(() => expect(term instanceof GhosttyTerminal
      ? term.hasMouseTracking()
      : term.modes.mouseTrackingMode === "vt200").toBe(true));
    const surface = host.querySelector<HTMLElement>(backend === "ghostty" ? "canvas" : ".xterm-screen")!;
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 480));
    const position = { bubbles: true, cancelable: true, clientX: 1, clientY: 1 };
    surface.dispatchEvent(wheel
      ? new WheelEvent("wheel", { ...position, deltaY: -1, deltaMode: 1 })
      : new MouseEvent("mousedown", { ...position, button: 0 }));
    expect(inputFrames(socket)).toEqual([bytes]);
    // xterm marks SGR reports as user data; its X10 reports use onBinary.
    const expectedHistory = backend === "xterm" && sgr ? 0 : 7;
    expect(inputHistory, "the viewport when the report reaches the socket").toEqual([expectedHistory]);
    expect(history(term)).toBe(expectedHistory);
  });

  test("a file drop types its escaped path and returns to the live cursor", async () => {
    const { target, term, socket, inputHistory } = await scrolled(backend);
    runtime.paths = ["/tmp/file with spaces"];
    expect(drop(target).defaultPrevented).toBe(true);
    await tick();
    expect(inputFrames(socket)).toEqual(["'/tmp/file with spaces' "]);
    expect(inputHistory).toEqual([0]);
    expect(history(term)).toBe(0);
  });
  test("an empty drop leaves the history view and sends nothing", async () => {
    const { target, term, socket } = await scrolled(backend);
    drop(target);
    await tick();
    expect(inputFrames(socket)).toEqual([]);
    expect(history(term)).toBe(7);
  });
  test.each([
    ["Ctrl+/", { key: "/", code: "Slash", ctrlKey: true }, "\x1f"],
    ["Option+Left", { key: "ArrowLeft", code: "ArrowLeft", altKey: true }, "\x1bb"],
  ] as const)("%s returns to the live cursor before sending its bytes", async (_name, init, bytes) => {
    const { term, socket, input, inputHistory } = await scrolled(backend);
    key(input, init);
    expect(inputFrames(socket)).toEqual([bytes]);
    expect(inputHistory).toEqual([0]);
    expect(history(term)).toBe(0);
  });
  test("copy leaves history where it was and sends no bytes", async () => {
    const { term, socket, input } = await scrolled(backend);
    key(input, { key: "c", code: "KeyC", metaKey: true });
    expect(inputFrames(socket)).toEqual([]);
    expect(history(term)).toBe(7);
  });
  test("output and a terminal query reply preserve the anchored history", async () => {
    const { term, socket, inputHistory } = await scrolled(backend);
    await output(socket, "background output\x1b[5n");
    await vi.waitFor(() => expect(inputFrames(socket)).toEqual(["\x1b[0n"]));
    expect(inputHistory, "the reply itself leaves the view alone").toEqual([7]);
    expect(history(term)).toBe(7);
  });
});

describe("ghostty terminal key parity viewport", () => {
  test.each([
    ["arrow", "keydown", { key: "ArrowUp", code: "ArrowUp", keyCode: 38 }, "\x1b[A"],
    ["host text", "beforeinput", { inputType: "insertText", data: "word" }, "word"],
    ["delete", "beforeinput", { inputType: "deleteContentBackward" }, "\x7f"],
  ] as const)("%s returns to the live cursor", async (_name, type, init, bytes) => {
    const { term, socket, host, inputHistory } = await scrolled("ghostty");
    const options = { bubbles: true, cancelable: true, ...init };
    host.dispatchEvent(type === "keydown" ? new KeyboardEvent(type, options) : new InputEvent(type, options));
    expect(inputFrames(socket)).toEqual([bytes]);
    expect(inputHistory).toEqual([0]);
    expect(history(term)).toBe(0);
  });
  test("a Windows dead key's deferred Enter returns to the live cursor", async () => {
    runtime.os = "windows";
    const { term, socket, host, inputHistory } = await scrolled("ghostty");
    key(host, { key: "Dead", code: "Quote", keyCode: 222 });
    key(host, { key: "Enter", code: "Enter", keyCode: 13 });
    expect(inputFrames(socket), "the line-break input still owns Enter").toEqual([]);
    expect(history(term)).toBe(7);
    host.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertLineBreak" }));
    expect(inputFrames(socket)).toEqual(["\r"]);
    expect(inputHistory).toEqual([0]);
    expect(history(term)).toBe(0);
  });
});

describe("ghostty fractional and queued viewport movement", () => {
  test("output advances the live screen and retains a half-row scroll fraction", async () => {
    const { term, socket } = await scrolled("ghostty");
    if (!(term instanceof GhosttyTerminal)) throw new Error("expected the Ghostty backend");
    term.viewport.scrollTo(0.5);
    const scrollback = term.getScrollbackLength();
    await output(socket, "background output\r\n");
    expect(term.getScrollbackLength()).toBe(scrollback + 1);
    expect(term.getViewportY()).toBe(0.5);
    expect(inputFrames(socket)).toEqual([]);
  });

  test.each([
    ["typed text", "a"],
    ["arrow", "\x1b[A"],
    ["paste", "pasted"],
    ["file drop", "'/tmp/fraction' "],
  ] as const)("%s clears a half-row scroll fraction before sending", async (kind, bytes) => {
    const { term, socket, host, target, inputHistory } = await scrolled("ghostty");
    if (!(term instanceof GhosttyTerminal)) throw new Error("expected the Ghostty backend");
    term.viewport.scrollTo(0.5);
    expect(term.getViewportY()).toBe(0.5);
    if (kind === "typed text") key(host, { key: "a", code: "KeyA", keyCode: 65 });
    if (kind === "arrow") key(host, { key: "ArrowUp", code: "ArrowUp", keyCode: 38 });
    if (kind === "paste") {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { getData: () => "pasted" } });
      host.dispatchEvent(event);
    }
    if (kind === "file drop") {
      runtime.paths = ["/tmp/fraction"];
      drop(target);
      await tick();
    }
    expect(inputFrames(socket)).toEqual([bytes]);
    expect(inputHistory).toEqual([0]);
    expect(term.getViewportY()).toBe(0);
  });

  test("a wheel followed by typing stays at the cursor when queued frames run", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const { term, socket, host, inputHistory } = await scrolled("ghostty");
    const canvas = host.querySelector("canvas")!;
    // Line-mode scrolling takes the widget's own wheel path; its pending
    // render frames also run after input returns the view to the cursor.
    canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -3, deltaMode: 1 }));
    expect(history(term), "the wheel moved farther into history").toBeGreaterThan(7);
    expect(frames.size, "the renderer has pending frames when the key arrives").toBeGreaterThan(0);
    key(host, { key: "a", code: "KeyA", keyCode: 65 });
    expect(inputFrames(socket)).toEqual(["a"]);
    expect(inputHistory).toEqual([0]);
    expect(history(term)).toBe(0);
    for (let frame = 0; frame < 6; frame++) {
      const batch = [...frames.values()];
      frames.clear();
      for (const callback of batch) callback(performance.now() + frame * 16);
      expect(history(term), `after frame ${frame + 1}`).toBe(0);
    }
  });
});
