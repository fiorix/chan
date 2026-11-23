// @vitest-environment jsdom
//
// The widget palette follows the terminal's Hybrid surface and custom
// settings. The body carries the same theme and background token.

import { flushSync, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));
vi.mock("../terminal/ghosttyCompat", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyCompatModule(importOriginal));

import TerminalTab from "./TerminalTab.svelte";
import { terminalPreferences } from "../__tests__/standalone";
import { __testSetStandalonePreferences, hybridSurfaceThemes, ui } from "../state/store.svelte";
import { installTerminalDom, resetTerminals, seatTerminals, terminalTab } from "../__tests__/terminalTab";

import { mountGhosttyTerminal } from "../__tests__/ghosttyTab";

installTerminalDom();

const LIGHT_ANSI = [
  "#24292f", "#cf222e", "#1a7f37", "#8a6300", "#0969da", "#8250df", "#1b7c83", "#4b5563",
  "#57606a", "#a40e26", "#116329", "#6f4e00", "#0550ae", "#6639ba", "#0a6b73", "#6e7781",
];
const DARK_ANSI = [
  "#0c0c0d", "#ff6b6b", "#6cd07a", "#e3b341", "#58a6ff", "#b07dff", "#5dd8d8", "#d8d8de",
  "#6c6c70", "#ff8585", "#8be89a", "#f2d16b", "#7dbdff", "#c8a6ff", "#7df0f0", "#ffffff",
];
const ANSI_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];
const startTheme = ui.theme;

beforeEach(() => {
  ui.theme = "dark";
});

afterEach(() => {
  resetTerminals();
  delete hybridSurfaceThemes.terminal;
  __testSetStandalonePreferences(null);
  ui.theme = startTheme;
});

async function mounted() {
  const [tab] = seatTerminals([terminalTab()]);
  return mountGhosttyTerminal(TerminalTab, tab!);
}

function ansi(theme: unknown): string[] {
  const t = theme as Record<string, string>;
  return ANSI_KEYS.map((k) => t[k]!);
}

describe("the widget palette", () => {
  test("is the standard dark or light ANSI set, with the shared selection colour", async () => {
    const { term } = await mounted();
    expect(ansi(term.options.theme)).toEqual(DARK_ANSI);
    expect((term.options.theme as Record<string, string>).selectionBackground).toBe("rgba(88, 166, 255, 0.35)");

    hybridSurfaceThemes.terminal = "light";
    flushSync();
    await tick();
    expect(ansi(term.options.theme)).toEqual(LIGHT_ANSI);
  });

  test("follows the terminal surface's theme, not the page's", async () => {
    ui.theme = "dark";
    hybridSurfaceThemes.terminal = "light";
    const { term } = await mounted();
    expect(ansi(term.options.theme)).toEqual(LIGHT_ANSI);

    delete hybridSurfaceThemes.terminal;
    flushSync();
    await tick();
    expect(ansi(term.options.theme)).toEqual(DARK_ANSI);
  });

  test("a custom palette sets background, foreground and cursor, and its contrast picks the ANSI set", async () => {
    const noTerminalFields = {};
    __testSetStandalonePreferences(
      terminalPreferences(noTerminalFields, {
        terminal_colors: {
          mode: "custom",
          custom: { background: "#fdf6e3", foreground: "#073642", cursor: "#dc322f", contrast: "light" },
        },
      }),
    );
    const { term, target } = await mounted();
    expect(term.options.theme).toMatchObject({ background: "#fdf6e3", foreground: "#073642", cursor: "#dc322f" });
    expect(ansi(term.options.theme)).toEqual(LIGHT_ANSI);

    const body = target.querySelector<HTMLElement>(".terminal-tab")!;
    expect(body.dataset.theme).toBe("light");
    expect(body.style.getPropertyValue("--terminal-background")).toBe("#fdf6e3");
  });
});

describe("the terminal body", () => {
  test("carries the terminal surface's theme override, and none when unset", async () => {
    hybridSurfaceThemes.terminal = "light";
    const { target } = await mounted();
    const body = target.querySelector<HTMLElement>(".terminal-tab")!;
    expect(body.dataset.theme).toBe("light");

    delete hybridSurfaceThemes.terminal;
    flushSync();
    expect(body.hasAttribute("data-theme")).toBe(false);
  });
});
