// @vitest-environment jsdom

import { tick, unmount } from "svelte";
import { Terminal as GhosttyTerminal } from "@chan/ghostty-web-ng";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  module: null as WebAssembly.Module | null,
  terminals: [] as GhosttyTerminal[],
}));

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../terminal/backend")>();
  const { recordingKit } = await import("../__tests__/ghosttyTab");
  return { ...actual, loadGhosttyKit: async () => recordingKit(runtime, actual.ghosttyKitFrom) };
});

import TerminalTab from "./TerminalTab.svelte";
import {
  attachGhostty, compileGhosttyCore, ghosttyClearSelection, ghosttySelect, ghosttySelection,
  installSoftwareCanvas, mountGhostty,
} from "../__tests__/ghosttyTab";
import { terminalPreferences } from "../__tests__/standalone";
import {
  installTerminalDom, output, resetTerminals, seatTerminals, sentFrames, terminalTab,
} from "../__tests__/terminalTab";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import { showSurvey, surveyState } from "../state/survey.svelte";

installTerminalDom();

const RENDERER_TEXT = "old terminal output";
const writeText = vi.fn(async (_text: string) => {});
let component: Record<string, unknown> | undefined;

beforeAll(async () => {
  await compileGhosttyCore(runtime);
});

beforeEach(() => {
  runtime.terminals.length = 0;
  writeText.mockClear();
  installSoftwareCanvas();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  __testSetStandalonePreferences(terminalPreferences({ secret_masking: false }));
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
  const opened = mountGhostty(TerminalTab, tab!);
  component = opened.component;
  const { target } = opened;
  const { term, socket, host } = await attachGhostty(runtime, opened);
  expect(term).toBeInstanceOf(GhosttyTerminal);
  await output(socket, RENDERER_TEXT + "\r\n");
  ghosttySelect(term, 0, 0, RENDERER_TEXT.length);
  expect(ghosttySelection(term)).toBe(RENDERER_TEXT);
  socket.sent.length = 0;
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
    if (!selected) ghosttyClearSelection(term);
    expect(ghosttySelection(term)).toBe(selected ? RENDERER_TEXT : "");
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
    expect(ghosttySelection(term), "the renderer still has a competing selection").toBe(RENDERER_TEXT);

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
