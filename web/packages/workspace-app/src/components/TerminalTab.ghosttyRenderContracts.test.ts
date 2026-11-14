// @vitest-environment jsdom

import type { Terminal } from "@chan/ghostty-web-ng";
import { VtCells, VtTerminal } from "@chan/ghostty-web-ng/vt";
import { flushSync, tick, unmount } from "svelte";
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
  const { recordingKit } = await import("../__tests__/ghosttyTab");
  return { ...actual, loadGhosttyKit: async () => recordingKit(ghostty, actual.ghosttyKitFrom) };
});
vi.mock("../terminal/ghosttyCompat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../terminal/ghosttyCompat")>()),
  ...(await import("../__tests__/ghosttyTab")).ghosttyCompatStubs(),
}));

import TerminalTab from "./TerminalTab.svelte";
import {
  compileGhosttyCore, ghosttyCore, ghosttyCursorColor, ghosttyFontFamily,
  installSoftwareCanvas, mountGhostty,
} from "../__tests__/ghosttyTab";
import type { TerminalCustomColors } from "../api/types";
import { terminalPreferences } from "../__tests__/standalone";
import {
  attach,
  installTerminalDom,
  output,
  receive,
  resetTerminals,
  seatTerminals,
  terminalTab,
  TerminalSocket,
} from "../__tests__/terminalTab";
import { __testSetStandalonePreferences, ui } from "../state/store.svelte";

installTerminalDom();

const mounted: Array<Record<string, unknown>> = [];
const startTheme = ui.theme;
let canvas: ReturnType<typeof installSoftwareCanvas>;

beforeAll(async () => {
  await compileGhosttyCore(ghostty);
});

beforeEach(() => {
  ghostty.events.length = 0;
  canvas = installSoftwareCanvas();
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

function mountGhosttyTab(): HTMLElement {
  const [tab] = seatTerminals([terminalTab()]);
  const { target, component } = mountGhostty(TerminalTab, tab!, { focused: false });
  mounted.push(component);
  return target;
}

test("waits for the bundled face before constructing or opening the Ghostty widget", async () => {
  let loaded!: (faces: FontFace[]) => void;
  vi.mocked(document.fonts.load).mockImplementationOnce(() => new Promise<FontFace[]>((resolve) => (loaded = resolve)));
  const target = mountGhosttyTab();
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
  expect(ghosttyCore(term)).toBeInstanceOf(VtTerminal);
  expect(target.querySelector("canvas"), "the real widget opened after the font loaded").not.toBeNull();
  expect(ghosttyFontFamily(term)).toContain("Source Code Pro");
});

test("live custom colors reach Ghostty's core, next painted frame and terminal body", async () => {
  const target = mountGhosttyTab();
  await vi.waitFor(() => expect(TerminalSocket.all).toHaveLength(1));
  const term = ghostty.terminals[0]!;
  const socket = TerminalSocket.all[0]!;
  await attach(socket);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  await output(socket, "\x1b[31mR\x1b[0mD");
  canvas.frame();
  const body = target.querySelector<HTMLElement>(".terminal-tab")!;
  const core = ghosttyCore(term);
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
    canvas.frame();

    expect(ghostty.terminals, "the live widget is reused").toHaveLength(1);
    expect(colors()).toEqual({
      red: custom.contrast === "light" ? 0xcf222e : 0xff6b6b,
      foreground: Number.parseInt(custom.foreground.slice(1), 16),
      background: Number.parseInt(custom.background.slice(1), 16),
    });
    expect(ghosttyCursorColor(term)).toBe(custom.cursor);
    expect(body.style.getPropertyValue("--terminal-background"), "the body and scrollbar share the canvas background").toBe(custom.background);
    const context = canvas.context(target);
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
