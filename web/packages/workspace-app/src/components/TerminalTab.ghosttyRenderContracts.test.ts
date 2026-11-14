// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import type { Terminal } from "@chan/ghostty-web-ng";
import { VtCells, VtTerminal } from "@chan/ghostty-web-ng/vt";
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

const ghostty = vi.hoisted(() => ({
  module: null as WebAssembly.Module | null,
  terminals: [] as Terminal[],
  events: [] as string[],
}));

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../terminal/backend")>();
  const widget = await import("@chan/ghostty-web-ng");
  class RecordedTerminal extends widget.Terminal {
    constructor(...args: ConstructorParameters<typeof widget.Terminal>) {
      super(...args);
      ghostty.terminals.push(this);
    }
  }
  return { ...actual, loadGhosttyKit: async () => {
    ghostty.events.push("kit-load");
    return actual.ghosttyKitFrom(ghostty.module!, { Terminal: RecordedTerminal });
  } };
});
vi.mock("../terminal/ghosttyCompat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../terminal/ghosttyCompat")>()),
  measureXtermCellDimensions: () => ({ width: 8, height: 16 }),
  alignGhosttyRendererToXterm: () => true,
  installGhosttyCustomGlyphs: () => true,
  installGhosttyOverlayScrollbar: () => true,
  gateGhosttyScrollbarClicks: () => () => {},
}));

import TerminalTab from "./TerminalTab.svelte";
import type { TerminalCustomColors } from "../api/types";
import { terminalPreferences } from "../__tests__/standalone";
import { SoftwareCanvasContext } from "../__tests__/softwareCanvas";
import {
  attach,
  installTerminalDom,
  output,
  receive,
  resetTerminals,
  seatTerminals,
  terminalTab,
  TERMINAL_PANE,
  TerminalSocket,
} from "../__tests__/terminalTab";
import { __testSetStandalonePreferences, ui } from "../state/store.svelte";

installTerminalDom();

const mounted: Array<Record<string, unknown>> = [];
const startTheme = ui.theme;
let contexts: WeakMap<HTMLCanvasElement, SoftwareCanvasContext>;
let frames: FrameRequestCallback[] = [];

beforeAll(async () => {
  ghostty.module = await WebAssembly.compile(readFileSync("../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm"));
});

beforeEach(() => {
  ghostty.events.length = 0;
  contexts = new WeakMap<HTMLCanvasElement, SoftwareCanvasContext>();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    let context = contexts.get(this);
    if (!context) contexts.set(this, (context = new SoftwareCanvasContext(this, 8)));
    return context as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.mocked(document.fonts.load).mockReset().mockResolvedValue([{} as FontFace]);
  ui.theme = "dark";
  __testSetStandalonePreferences(terminalPreferences({ ghostty: true }));
});

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  ghostty.terminals.splice(0);
  resetTerminals();
  __testSetStandalonePreferences(null);
  ui.theme = startTheme;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function mountGhostty(): HTMLElement {
  const [tab] = seatTerminals([terminalTab()]);
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(TerminalTab, {
    target,
    props: { tab: tab!, paneId: TERMINAL_PANE, side: "a", active: true, focused: false },
  }));
  return target;
}

function frame(): void {
  for (const callback of frames.splice(0)) callback(performance.now());
}

test("waits for the bundled face before constructing or opening the Ghostty widget", async () => {
  let loaded!: (faces: FontFace[]) => void;
  vi.mocked(document.fonts.load).mockImplementationOnce(() => new Promise<FontFace[]>((resolve) => (loaded = resolve)));
  const target = mountGhostty();
  await vi.waitFor(() => expect(document.fonts.load).toHaveBeenCalled());
  await tick();
  const beforeFont = { widgets: ghostty.terminals.length, canvas: target.querySelector("canvas") };

  ghostty.events.push("font-resolved");
  loaded([{} as FontFace]);
  await vi.waitFor(() => expect(ghostty.terminals).toHaveLength(1));
  expect(ghostty.events, "the font resolves before loading the widget or instantiating WASM").toEqual([
    "font-resolved", "kit-load",
  ]);
  expect(beforeFont.widgets, "no widget is measured while the font is loading").toBe(0);
  expect(beforeFont.canvas, "the renderer has not opened").toBeNull();
  const term = ghostty.terminals[0]!;
  expect(term.wasmTerm).toBeInstanceOf(VtTerminal);
  expect(target.querySelector("canvas"), "the real widget opened after the font loaded").not.toBeNull();
  expect(term.options.fontFamily).toContain("Source Code Pro");
});

test("live custom colors reach Ghostty's core, next painted frame and terminal body", async () => {
  const target = mountGhostty();
  await vi.waitFor(() => expect(TerminalSocket.all).toHaveLength(1));
  const term = ghostty.terminals[0]!;
  const socket = TerminalSocket.all[0]!;
  await attach(socket);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  await output(socket, "\x1b[31mR\x1b[0mD");
  frame();
  const body = target.querySelector<HTMLElement>(".terminal-tab")!;
  const core = term.wasmTerm;
  expect(core).toBeInstanceOf(VtTerminal);
  const colors = () => {
    const cells = new VtCells();
    expect(core!.readRow(0, cells)).toBe(true);
    return { red: cells.at(0)!.fg, foreground: cells.at(1)!.fg, background: cells.at(1)!.bg };
  };
  const initial = colors();
  expect(initial.red).toBe(0xff6b6b);

  for (const custom of [
    { background: "#edf3f7", foreground: "#102030", cursor: "#234567", contrast: "light" },
    { background: "#132435", foreground: "#e0d0c0", cursor: "#bada55", contrast: "dark" },
  ] satisfies TerminalCustomColors[]) {
    __testSetStandalonePreferences(terminalPreferences({ ghostty: true }, {
      terminal_colors: { mode: "custom", custom },
    }));
    flushSync();
    await tick();
    frame();

    expect(ghostty.terminals, "the live widget is reused").toHaveLength(1);
    expect(colors()).toEqual({
      red: custom.contrast === "light" ? 0xcf222e : 0xff6b6b,
      foreground: Number.parseInt(custom.foreground.slice(1), 16),
      background: Number.parseInt(custom.background.slice(1), 16),
    });
    expect(term.options.theme.cursor).toBe(custom.cursor);
    expect(body.style.getPropertyValue("--terminal-background"), "the body and scrollbar share the canvas background").toBe(custom.background);
    const context = contexts.get(target.querySelector("canvas")!)!;
    const rgb = Number.parseInt(custom.background.slice(1), 16);
    expect(context.pixelAt(4, 20), "an empty row is repainted in the new background").toEqual({
      r: (rgb >> 16) & 255, g: (rgb >> 8) & 255, b: rgb & 255, a: 1,
    });
  }

  __testSetStandalonePreferences(terminalPreferences({ ghostty: true }, { terminal_colors: { mode: "standard" } }));
  flushSync();
  await tick();
  expect(colors(), "standard mode restores the theme defaults").toEqual(initial);
  expect(body.style.getPropertyValue("--terminal-background"), "the body follows the theme again").toBe("");
});
