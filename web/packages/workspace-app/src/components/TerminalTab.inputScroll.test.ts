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
async function scrolled(backend: "xterm" | "ghostty") {
  __testSetStandalonePreferences(terminalPreferences({ ghostty: backend === "ghostty", secret_masking: false }));
  const [tab] = seatTerminals([terminalTab()]);
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
  const send = socket.send.bind(socket);
  vi.spyOn(socket, "send").mockImplementation((data) => {
    if ((JSON.parse(data) as { type: string }).type === "input") inputHistory.push(history(term));
    send(data);
  });
  const host = target.querySelector<HTMLElement>(".terminal-host")!;
  const input = term instanceof GhosttyTerminal ? host : term.textarea!;
  return { target, term, socket, host, input, inputHistory };
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
  test.each([true, false])("a native mouse report preserves history (SGR %s)", async (sgr) => {
    const { term, socket, host, inputHistory } = await scrolled("ghostty");
    await output(socket, `\x1b[?1000h\x1b[?1006${sgr ? "h" : "l"}`);
    const canvas = host.querySelector("canvas")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 480));
    canvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10 }));
    expect(inputFrames(socket)).toHaveLength(1);
    expect(inputHistory, "the report itself leaves the view alone").toEqual([7]);
    expect(history(term)).toBe(7);
  });
  test.each([true, false])("a program's wheel report preserves history (SGR %s)", async (sgr) => {
    const { term, socket, host, inputHistory } = await scrolled("ghostty");
    await output(socket, `\x1b[?1000h\x1b[?1006${sgr ? "h" : "l"}`);
    const canvas = host.querySelector("canvas")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 480));
    canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -1, deltaMode: 1, clientX: 10, clientY: 10 }));
    expect(inputFrames(socket)).toHaveLength(1);
    expect(inputHistory, "the report itself leaves the view alone").toEqual([7]);
    expect(history(term)).toBe(7);
  });
});
