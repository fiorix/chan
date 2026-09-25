// @vitest-environment jsdom
//
// A terminal's colours follow its own Hybrid surface theme, not the page's,
// and a custom palette from the settings wins over both. xterm paints to its
// own canvas from a theme object, so the surface theme has to reach that
// object and follow it when it flips. A TerminalTab is mounted over the
// stand-in xterm; the assertions read the theme object it was handed, the
// body's data-theme and its background token.

import { flushSync, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import TerminalTab from "./TerminalTab.svelte";
// Build-time contract: the terminal body, host and xterm viewport paint --terminal-background over --bg; vitest drops component CSS.
import terminalTabSource from "./TerminalTab.svelte?raw";
import type { Preferences } from "../api/types";
import { __testSetStandalonePreferences, hybridSurfaceThemes, ui } from "../state/store.svelte";
import { installTerminalDom, mountTerminal, resetTerminals, seatTerminals, terminalTab } from "../__tests__/terminalTab";

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
  return mountTerminal(TerminalTab, tab!);
}

function ansi(theme: unknown): string[] {
  const t = theme as Record<string, string>;
  return ANSI_KEYS.map((k) => t[k]!);
}

describe("the xterm palette", () => {
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
    expect(term.options.minimumContrastRatio, "light raises the contrast floor").toBe(4.5);

    delete hybridSurfaceThemes.terminal;
    flushSync();
    await tick();
    expect(ansi(term.options.theme)).toEqual(DARK_ANSI);
    expect(term.options.minimumContrastRatio).toBe(1);
  });

  test("a custom palette sets background, foreground and cursor, and its contrast picks the ANSI set", async () => {
    __testSetStandalonePreferences({
      terminal_colors: {
        mode: "custom",
        custom: { background: "#fdf6e3", foreground: "#073642", cursor: "#dc322f", contrast: "light" },
      },
    } as unknown as Preferences);
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

  test("paints the custom background over the page background", () => {
    const css = terminalTabSource.slice(terminalTabSource.indexOf("<style>"));
    expect(css).toMatch(/\.terminal-tab \{[\s\S]*?background: var\(--terminal-background, var\(--bg\)\);/);
    expect(css).toMatch(/\.terminal-host \{[\s\S]*?background: var\(--terminal-background, var\(--bg\)\);/);
    expect(css).toMatch(
      /\.terminal-host :global\(\.xterm-viewport\) \{[\s\S]*?background-color: var\(--terminal-background, var\(--bg\)\);[\s\S]*?scrollbar-color: var\(--separator\) var\(--terminal-background, var\(--bg\)\);/,
    );
  });
});
