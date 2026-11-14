// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { mount, tick, unmount } from "svelte";
import { Terminal as GhosttyTerminal } from "@chan/ghostty-web-ng";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  module: null as WebAssembly.Module | null,
  terminals: [] as unknown[],
}));

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
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
vi.mock("../terminal/ghosttyCompat", async (original) => ({
  ...(await original<typeof import("../terminal/ghosttyCompat")>()),
  measureXtermCellDimensions: () => ({ width: 8, height: 16 }),
  alignGhosttyRendererToXterm: () => true,
  installGhosttyCustomGlyphs: () => true,
  installGhosttyOverlayScrollbar: () => true,
  gateGhosttyScrollbarClicks: () => () => {},
}));

import TerminalTab from "./TerminalTab.svelte";
import { SoftwareCanvasContext } from "../__tests__/softwareCanvas";
import { terminalPreferences } from "../__tests__/standalone";
import {
  attach, installTerminalDom, output, receive, resetTerminals,
  seatTerminals, sentFrames, terminalTab, TERMINAL_PANE, TerminalSocket,
} from "../__tests__/terminalTab";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import { showSurvey, surveyState } from "../state/survey.svelte";

installTerminalDom();

const RENDERER_TEXT = "old terminal output";
const writeText = vi.fn(async (_text: string) => {});
let component: ReturnType<typeof mount> | undefined;

beforeAll(async () => {
  runtime.module = await WebAssembly.compile(readFileSync("../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm"));
});

beforeEach(() => {
  runtime.terminals.length = 0;
  writeText.mockClear();
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return new SoftwareCanvasContext(this, 8) as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  __testSetStandalonePreferences(terminalPreferences({ ghostty: true, secret_masking: false }));
});

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  resetTerminals();
  surveyState.byTab = {};
  surveyState.windowWide = null;
  document.getSelection()?.removeAllRanges();
  __testSetStandalonePreferences(null);
  delete (navigator as { clipboard?: unknown }).clipboard;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

async function attached() {
  const [tab] = seatTerminals([terminalTab()]);
  const target = document.createElement("div");
  document.body.append(target);
  component = mount(TerminalTab, { target, props: {
    tab: tab!, paneId: TERMINAL_PANE, side: "a", active: true, focused: true,
  } });
  await vi.waitFor(() => expect(TerminalSocket.all).toHaveLength(1));
  const term = runtime.terminals[0] as GhosttyTerminal;
  expect(term).toBeInstanceOf(GhosttyTerminal);
  const socket = TerminalSocket.all[0]!;
  await attach(socket);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  await output(socket, RENDERER_TEXT + "\r\n");
  term.select(0, 0, RENDERER_TEXT.length);
  expect(term.getSelection()).toBe(RENDERER_TEXT);
  socket.sent.length = 0;
  const host = target.querySelector<HTMLElement>(".terminal-host")!;
  expect(host.querySelector("canvas")).not.toBeNull();
  return { tab: tab!, target, term, socket, host };
}

function copy(target: HTMLElement, chord: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "c", code: "KeyC", ...chord, bubbles: true, cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

describe.each([
  ["Cmd+C", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", { metaKey: true }],
  ["Ctrl+Shift+C", "Mozilla/5.0 (X11; Linux x86_64)", { ctrlKey: true, shiftKey: true }],
] as const)("copy ownership on a real Ghostty terminal with %s", (_name, agent, chord) => {
  beforeEach(() => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(agent);
  });

  test.each([true, false])("selected survey text keeps native copy with a renderer selection: %s", async (selected) => {
    const { tab, target, term, socket } = await attached();
    if (!selected) term.clearSelection();
    expect(term.getSelection()).toBe(selected ? RENDERER_TEXT : "");
    showSurvey({ surveyId: "copy-ownership", title: null, bodyMarkdown: "Copy this survey text", options: ["OK"] }, tab.id);
    await tick();
    const card = target.querySelector<HTMLElement>(".survey-card")!;
    const body = card.querySelector<HTMLElement>(".survey-body")!;
    const range = document.createRange();
    range.selectNodeContents(body);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    card.focus();
    expect(document.activeElement).toBe(card);
    expect(selection.toString().trim()).toBe("Copy this survey text");

    const event = copy(card, chord);
    await tick();
    expect(event.defaultPrevented, "the selected DOM text retains native copy").toBe(false);
    expect(writeText, "terminal output must not replace selected survey text").not.toHaveBeenCalled();
    expect(sentFrames(socket).filter((frame) => frame.type === "input")).toEqual([]);
  });

  test("selected find input text keeps native copy", async () => {
    const { target, term, socket } = await attached();
    window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.find.open" } }));
    await tick();
    const input = target.querySelector<HTMLInputElement>(".terminal-find input")!;
    expect(input).not.toBeNull();
    input.value = "find text";
    input.focus();
    input.setSelectionRange(0, 4);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(4);
    expect(term.getSelection(), "the renderer still has a competing selection").toBe(RENDERER_TEXT);

    const event = copy(input, chord);
    await tick();
    expect(event.defaultPrevented).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(sentFrames(socket).filter((frame) => frame.type === "input")).toEqual([]);
  });

  test("the same chord on the renderer copies its selection once", async () => {
    const { host, socket } = await attached();
    host.focus();
    const event = copy(host, chord);
    await tick();
    expect(event.defaultPrevented).toBe(true);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(RENDERER_TEXT);
    expect(sentFrames(socket).filter((frame) => frame.type === "input")).toEqual([]);
  });
});
