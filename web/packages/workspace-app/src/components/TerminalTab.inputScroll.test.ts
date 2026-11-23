// @vitest-environment jsdom
//
// The widget uses its real parser, input listeners and viewport. Only
// browser sizing, optional addons and the transport are supplied by the test.

import { tick } from "svelte";
import type { Terminal } from "@chan/ghostty-web-ng";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  paths: [] as string[],
  os: "mac",
}));

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));
vi.mock("../api/desktop", async (original) => ({
  ...(await original<typeof import("../api/desktop")>()),
  readDroppedPaths: async () => runtime.paths,
}));
vi.mock("../state/shortcuts", async (original) => ({
  ...(await original<typeof import("../state/shortcuts")>()),
  currentOS: () => runtime.os,
}));

import TerminalTab from "./TerminalTab.svelte";
import { mountGhosttyTerminal } from "../__tests__/ghosttyTab";
import { modelPointerCapture, mousePointer } from "../__tests__/pointer";
import { terminalPreferences } from "../__tests__/standalone";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import { registerTerminalInputSink, sendPromptToTerminal } from "../state/tabs.svelte";
import {
  attach, installTerminalDom, output, receive, resetTerminals,
  seatTerminals, sentFrames, terminalTab, TerminalSocket,
} from "../__tests__/terminalTab";

installTerminalDom();
beforeEach(() => {
  runtime.os = "mac";
  runtime.paths = [];
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  resetTerminals();
  __testSetStandalonePreferences(null);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function history(term: Terminal): number {
  return term.getViewportY();
}
function inputFrames(socket: TerminalSocket): unknown[] {
  return sentFrames(socket).filter((f) => f.type === "input").map((f) => f.data);
}
async function scrolled(mouseCapture = false, broadcast = false) {
  __testSetStandalonePreferences(terminalPreferences({ secret_masking: false, mouse_capture: mouseCapture }));
  const [tab, sibling] = seatTerminals(broadcast ? [
    terminalTab({ broadcastEnabled: true, group: "input-scroll" }),
    terminalTab({ id: "term-sibling", broadcastEnabled: true, group: "input-scroll" }),
  ] : [terminalTab()]);
  const { target, term } = await mountGhosttyTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all[0]!;
  await attach(socket);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  await output(socket, Array.from({ length: 100 }, (_, i) => `history ${i}\r\n`).join("") + "$ ");
  await vi.waitFor(() => expect(term.getScrollbackLength()).toBeGreaterThan(50));
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
  const input = host;
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

describe("terminal input viewport", () => {
  test("a Rich Prompt returns to the live cursor before sending its queued frame", async () => {
    const { tab, term, socket, promptHistory } = await scrolled();
    expect(sendPromptToTerminal(tab.id, "run it", "claude", "prompt-scroll")).toBe(true);
    expect(sentFrames(socket)).toEqual([
      { type: "prompt", data: "run it", agent: "claude", id: "prompt-scroll" },
    ]);
    expect(promptHistory).toEqual([0]);
    expect(history(term)).toBe(0);
  });

  test.each([0, 2, 3])("a prompt rejected by socket state %s preserves history", async (readyState) => {
    const { tab, term, socket, promptHistory } = await scrolled();
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
    const { target, term, socket, input, inputHistory } = await scrolled();
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
    const { sibling, target, term, socket, input, inputHistory } = await scrolled(false, true);
    const received: Array<[string, boolean | undefined]> = [];
    const unregister = registerTerminalInputSink(sibling!.id, (data, binary) => received.push([data, binary]));
    try {
      socket.readyState = readyState;
      let bytes: string;
      if (kind === "direct key") {
        bytes = "\r";
        key(input, { key: "Enter", code: "Enter", keyCode: 13 });
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
    const { term, socket, host, inputHistory } = await scrolled(true);
    await output(socket, `\x1b[?1000h\x1b[?1006${sgr ? "h" : "l"}`);
    await vi.waitFor(() => expect(term.hasMouseTracking()).toBe(true));
    const surface = host.querySelector<HTMLElement>("canvas")!;
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 480));
    const position = { bubbles: true, cancelable: true, clientX: 1, clientY: 1 };
    if (wheel) surface.dispatchEvent(new WheelEvent("wheel", { ...position, deltaY: -1, deltaMode: 1 }));
    else {
      modelPointerCapture(surface);
      mousePointer(surface, "pointerdown", position);
    }
    expect(inputFrames(socket)).toEqual([bytes]);
    const expectedHistory = 7;
    expect(inputHistory, "the viewport when the report reaches the socket").toEqual([expectedHistory]);
    expect(history(term)).toBe(expectedHistory);
  });

  test("a file drop types its escaped path and returns to the live cursor", async () => {
    const { target, term, socket, inputHistory } = await scrolled();
    runtime.paths = ["/tmp/file with spaces"];
    expect(drop(target).defaultPrevented).toBe(true);
    await tick();
    expect(inputFrames(socket)).toEqual(["'/tmp/file with spaces' "]);
    expect(inputHistory).toEqual([0]);
    expect(history(term)).toBe(0);
  });
  test("an empty drop leaves the history view and sends nothing", async () => {
    const { target, term, socket } = await scrolled();
    drop(target);
    await tick();
    expect(inputFrames(socket)).toEqual([]);
    expect(history(term)).toBe(7);
  });
  test.each([
    ["Ctrl+/", { key: "/", code: "Slash", ctrlKey: true }, "\x1f"],
    ["Option+Left", { key: "ArrowLeft", code: "ArrowLeft", altKey: true }, "\x1bb"],
  ] as const)("%s returns to the live cursor before sending its bytes", async (_name, init, bytes) => {
    const { term, socket, input, inputHistory } = await scrolled();
    key(input, init);
    expect(inputFrames(socket)).toEqual([bytes]);
    expect(inputHistory).toEqual([0]);
    expect(history(term)).toBe(0);
  });
  test("copy leaves history where it was and sends no bytes", async () => {
    const { term, socket, input } = await scrolled();
    key(input, { key: "c", code: "KeyC", metaKey: true });
    expect(inputFrames(socket)).toEqual([]);
    expect(history(term)).toBe(7);
  });
  test("output and a terminal query reply preserve the anchored history", async () => {
    const { term, socket, inputHistory } = await scrolled();
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
    const { term, socket, host, inputHistory } = await scrolled();
    const options = { bubbles: true, cancelable: true, ...init };
    host.dispatchEvent(type === "keydown" ? new KeyboardEvent(type, options) : new InputEvent(type, options));
    expect(inputFrames(socket)).toEqual([bytes]);
    expect(inputHistory).toEqual([0]);
    expect(history(term)).toBe(0);
  });
  test("a Windows dead key's deferred Enter returns to the live cursor", async () => {
    runtime.os = "windows";
    const { term, socket, host, inputHistory } = await scrolled();
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
    const { term, socket } = await scrolled();
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
    const { term, socket, host, target, inputHistory } = await scrolled();
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
    const { term, socket, host, inputHistory } = await scrolled();
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
