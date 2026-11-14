// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { Terminal } from "@chan/ghostty-web-ng";
import { GhosttyVt } from "@chan/ghostty-web-ng/vt";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { SoftwareCanvasContext } from "../__tests__/softwareCanvas";
import { pasteIntoGhostty } from "./ghosttyPaste";
import { GhosttyViewportController } from "./ghosttyViewport";

const VENDORED = "../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm";
const HISTORY_OFFSET = 7;
let vendored: WebAssembly.Module;
const opened: Terminal[] = [];

beforeAll(async () => {
  vendored = await WebAssembly.compile(readFileSync(VENDORED));
});

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return new SoftwareCanvasContext(this, 8) as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  for (const term of opened.splice(0)) term.dispose();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openTerminal(options: { smoothScrollDuration?: number } = { smoothScrollDuration: 0 }) {
  const vt = new GhosttyVt(await WebAssembly.instantiate(vendored, {}));
  const term = new Terminal({ cols: 40, rows: 6, ghostty: vt, cursorBlink: false, ...options });
  const host = document.createElement("div");
  document.body.append(host);
  term.open(host);
  opened.push(term);
  const textarea = host.querySelector("textarea");
  const canvas = host.querySelector("canvas");
  if (!textarea || !canvas) throw new Error("ghostty-web opened no textarea or canvas");
  const viewport = new GhosttyViewportController(term, {
    os: () => "linux",
    hasMouseTracking: () => false,
    isAlternateScreen: () => false,
    cellHeight: () => 16,
  });
  viewport.write(Array.from({ length: 40 }, (_, row) => `history ${row}\r\n`).join(""));
  viewport.write("prompt> ");
  expect(term.getScrollbackLength()).toBeGreaterThan(HISTORY_OFFSET);
  term.scrollToLine(HISTORY_OFFSET);
  expect(term.getViewportY()).toBe(HISTORY_OFFSET);
  const sent: Array<{ data: string; viewport: number }> = [];
  term.onData((data) => sent.push({ data, viewport: term.getViewportY() }));
  return { term, host, textarea, canvas, viewport, sent };
}

type OpenTerminal = Awaited<ReturnType<typeof openTerminal>>;

function typeLetter({ host }: OpenTerminal): void {
  host.dispatchEvent(new KeyboardEvent("keydown", {
    key: "a", code: "KeyA", bubbles: true, cancelable: true,
  }));
}

function commitComposition({ host }: OpenTerminal): void {
  host.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  host.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "\u00e9" }));
}

function queueFrames() {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  return {
    frames,
    advance() {
      const batch = [...frames.values()];
      frames.clear();
      for (const callback of batch) callback(performance.now());
    },
  };
}

function wheelIntoHistory({ canvas }: OpenTerminal): void {
  canvas.dispatchEvent(new WheelEvent("wheel", {
    bubbles: true, cancelable: true, deltaY: -3, deltaMode: 1,
  }));
}

const INPUTS: Array<{ name: string; send(state: OpenTerminal): void; bytes: string }> = [
  { name: "a letter through the widget's input handler", send: typeLetter, bytes: "a" },
  { name: "a composition commit", send: commitComposition, bytes: "\u00e9" },
  { name: "the widget's paste", send: ({ term }) => term.paste("paste"), bytes: "paste" },
  { name: "input marked as the user's", send: ({ term }) => term.input("input", true), bytes: "input" },
  { name: "chan's paste encoder", send: ({ term }) => pasteIntoGhostty(term, "paste\nline"), bytes: "paste\rline" },
];

describe("the ghostty widget's input scroll", () => {
  test("typing interrupts default smooth scrolling and stays at the cursor as frames run", async () => {
    const scheduler = queueFrames();
    const state = await openTerminal({});
    expect(state.term.options.smoothScrollDuration).toBe(100);
    wheelIntoHistory(state);
    expect(state.term.getViewportY()).toBeGreaterThan(HISTORY_OFFSET);
    expect(state.term.getViewportY(), "the wheel's target has not been reached").toBeLessThan(HISTORY_OFFSET + 3);
    typeLetter(state);
    expect(state.sent).toEqual([{ data: "a", viewport: 0 }]);
    for (let frame = 0; frame < 6; frame++) {
      scheduler.advance();
      expect(state.term.getViewportY(), `after frame ${frame + 1}`).toBe(0);
    }
  });

  test("typing removes the pending smooth-scroll frame and a later wheel can animate", async () => {
    const { frames } = queueFrames();
    const state = await openTerminal({});
    const beforeWheel = new Set(frames.keys());
    wheelIntoHistory(state);
    const wheelFrames = [...frames.keys()].filter((id) => !beforeWheel.has(id));
    expect(wheelFrames, "the wheel schedules a scroll frame").toHaveLength(1);
    typeLetter(state);
    expect(wheelFrames.some((id) => frames.has(id)), "the interrupted animation leaves no pending callback").toBe(false);
    expect(state.term.getViewportY()).toBe(0);
    wheelIntoHistory(state);
    expect(state.term.getViewportY(), "a subsequent wheel starts a fresh animation").toBeGreaterThan(0);
    expect(state.term.getViewportY()).toBeLessThan(3);
    expect(state.sent).toEqual([{ data: "a", viewport: 0 }]);
  });

  test.each(INPUTS)("$name reveals the cursor before sending bytes", async ({ send, bytes }) => {
    const state = await openTerminal();
    send(state);
    expect(state.sent.map(({ data }) => data)).toEqual([bytes]);
    expect(state.term.getViewportY()).toBe(0);
    expect(state.sent[0].viewport, "the program sees input after the view reaches the cursor").toBe(0);
    state.viewport.write(bytes);
    expect(state.term.getViewportY(), "the echo follows the live view").toBe(0);
  });

  test.each(INPUTS)("disabled stdin leaves $name and the viewport alone", async ({ send }) => {
    const state = await openTerminal();
    state.term.options.disableStdin = true;
    send(state);
    expect(state.sent).toEqual([]);
    expect(state.term.getViewportY()).toBe(HISTORY_OFFSET);
  });

  test("a chord claimed by chan sends nothing and leaves the view in history", async () => {
    const state = await openTerminal();
    const handled = vi.fn(() => true);
    state.term.attachCustomKeyEventHandler(handled);
    state.host.dispatchEvent(new KeyboardEvent("keydown", {
      key: "a", code: "KeyA", ctrlKey: true, bubbles: true, cancelable: true,
    }));
    expect(handled).toHaveBeenCalledOnce();
    expect(state.sent).toEqual([]);
    expect(state.term.getViewportY()).toBe(HISTORY_OFFSET);
  });

  test("the widget's copy chord sends nothing and preserves history", async () => {
    const state = await openTerminal();
    state.host.dispatchEvent(new KeyboardEvent("keydown", {
      key: "c", code: "KeyC", metaKey: true, bubbles: true, cancelable: true,
    }));
    expect(state.sent).toEqual([]);
    expect(state.term.getViewportY()).toBe(HISTORY_OFFSET);
  });

  test("an empty composition commit sends nothing and preserves history", async () => {
    const state = await openTerminal();
    state.host.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    state.host.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
    expect(state.sent).toEqual([]);
    expect(state.term.getViewportY()).toBe(HISTORY_OFFSET);
  });

  test.each([
    { name: "input marked as the user's", send: ({ term }: OpenTerminal) => term.input("", true) },
    { name: "the widget's paste", send: ({ term }: OpenTerminal) => term.paste("") },
    { name: "chan's paste encoder", send: ({ term }: OpenTerminal) => pasteIntoGhostty(term, "") },
  ])("empty $name without bracketed paste sends no bytes and preserves history", async ({ send }) => {
    const state = await openTerminal();
    expect(state.term.hasBracketedPaste()).toBe(false);
    send(state);
    expect(state.sent.map(({ data }) => data).join("")).toBe("");
    expect(state.term.getViewportY()).toBe(HISTORY_OFFSET);
  });

  test.each([
    { name: "the widget's paste", send: ({ term }: OpenTerminal) => term.paste("") },
    { name: "chan's paste encoder", send: ({ term }: OpenTerminal) => pasteIntoGhostty(term, "") },
  ])("empty $name under bracketed paste reveals the cursor before sending its frames", async ({ send }) => {
    const state = await openTerminal();
    state.viewport.write("\x1b[?2004h");
    expect(state.term.hasBracketedPaste()).toBe(true);
    send(state);
    expect(state.sent.map(({ data }) => data)).toEqual(["\x1b[200~\x1b[201~"]);
    expect(state.term.getViewportY()).toBe(0);
    expect(state.sent[0].viewport).toBe(0);
  });

  test("output keeps the same history rows visible", async () => {
    const state = await openTerminal();
    const before = state.term.getScrollbackLength();
    state.viewport.write("background\r\nmore output\r\n");
    const appended = state.term.getScrollbackLength() - before;
    expect(appended).toBe(2);
    expect(state.term.getViewportY()).toBe(HISTORY_OFFSET + appended);
    expect(state.sent).toEqual([]);
  });

  test("a program's status query replies through onData without becoming user input", async () => {
    const state = await openTerminal();
    state.viewport.write("\x1b[5n");
    expect(state.sent.map(({ data }) => data)).toEqual(["\x1b[0n"]);
    expect(state.sent[0].viewport, "reply emission must not reveal the live cursor").toBe(HISTORY_OFFSET);
    expect(state.term.getViewportY()).toBe(HISTORY_OFFSET);
  });

  test.each([
    { name: "SGR", mode: "\x1b[?1006h", bytes: "\x1b[<0;1;1M" },
    { name: "X10", mode: "\x1b[?1006l", bytes: "\x1b[M !!" },
  ])("a native $name mouse report sends its coordinates without revealing the live cursor", async ({ mode, bytes }) => {
    const state = await openTerminal();
    state.viewport.write("\x1b[?1000h" + mode);
    expect(state.term.getViewportY()).toBe(HISTORY_OFFSET);
    state.canvas.dispatchEvent(new MouseEvent("mousedown", {
      button: 0, clientX: 1, clientY: 1, bubbles: true, cancelable: true,
    }));
    expect(state.sent.map(({ data }) => data)).toEqual([bytes]);
    expect(state.sent[0].viewport).toBe(HISTORY_OFFSET);
    expect(state.term.getViewportY()).toBe(HISTORY_OFFSET);
  });
});
