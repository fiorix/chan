// @vitest-environment jsdom
//
// The widget palette follows the terminal's Hybrid surface and custom
// settings. The body carries the same theme and background token.

import { flushSync, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));

import TerminalTab from "./TerminalTab.svelte";
import { terminalPreferences } from "../__tests__/standalone";
import { __testSetStandalonePreferences, hybridSurfaceThemes, ui } from "../state/store.svelte";
import { TRANSPARENT_WINDOW_PARAM } from "../terminal/backgroundOpacity";
import {
  applyDesktopTerminalOpacity,
  resetDesktopTerminalOpacityForTests,
} from "../terminal/desktopTerminalOpacity.svelte";
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
const startUrl = window.location.href;

beforeEach(() => {
  ui.theme = "dark";
});

afterEach(() => {
  resetTerminals();
  delete hybridSurfaceThemes.terminal;
  __testSetStandalonePreferences(null);
  ui.theme = startTheme;
  resetDesktopTerminalOpacityForTests();
  window.history.replaceState(null, "", startUrl);
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

/// The floor under a cell's ink against its background (WCAG AA on the
/// light theme), as the widget holds it in its theme. 1 changes no ink.
describe("the widget's contrast floor", () => {
  function floor(term: { options: { theme: unknown } }): unknown {
    return (term.options.theme as { minimumContrastRatio?: number }).minimumContrastRatio;
  }

  test("a terminal opened on the light theme has the floor, and loses it on a switch to dark", async () => {
    hybridSurfaceThemes.terminal = "light";
    const { term } = await mounted();
    expect(floor(term), "opened light").toBe(4.5);
    expect((term.options.theme as { contrastBackdrop?: string }).contrastBackdrop,
      "an opaque window paints its own background and names no backdrop").toBeUndefined();

    delete hybridSurfaceThemes.terminal;
    flushSync();
    await tick();
    expect(ansi(term.options.theme), "switched to dark").toEqual(DARK_ANSI);
    expect(floor(term), "switched to dark").toBe(1);
  });

  test("a terminal opened on the dark theme has none, and gains it on a switch to light", async () => {
    const { term } = await mounted();
    expect(floor(term), "opened dark").toBe(1);

    hybridSurfaceThemes.terminal = "light";
    flushSync();
    await tick();
    expect(ansi(term.options.theme), "switched to light").toEqual(LIGHT_ANSI);
    expect(floor(term), "switched to light").toBe(4.5);
  });

  test("a custom palette of light contrast has the floor", async () => {
    const noTerminalFields = {};
    __testSetStandalonePreferences(
      terminalPreferences(noTerminalFields, {
        terminal_colors: {
          mode: "custom",
          custom: { background: "#fdf6e3", foreground: "#073642", cursor: "#dc322f", contrast: "light" },
        },
      }),
    );
    const { term } = await mounted();
    expect(floor(term)).toBe(4.5);
  });

  test("a see-through background has none on the light theme, until the desktop's opacity is back at 100", async () => {
    window.history.replaceState(null, "", `?${TRANSPARENT_WINDOW_PARAM}=1`);
    applyDesktopTerminalOpacity(90);
    hybridSurfaceThemes.terminal = "light";
    const { term } = await mounted();
    expect(ansi(term.options.theme), "the light palette").toEqual(LIGHT_ANSI);
    expect(floor(term), "the desktop shows through").toBe(1);

    applyDesktopTerminalOpacity(100);
    flushSync();
    await tick();
    expect(floor(term), "the tint is opaque").toBe(4.5);
    const theme = term.options.theme as { background?: string; contrastBackdrop?: string };
    expect(theme.contrastBackdrop, "the floor is measured against the tint behind the clear background")
      .toBe(getComputedStyle(term.element!).getPropertyValue("--bg").trim() || "#1c1c1e");
    expect(theme.background, "the widget's own background stays clear").not.toBe(theme.contrastBackdrop);

    applyDesktopTerminalOpacity(85);
    flushSync();
    await tick();
    expect(floor(term), "see-through again").toBe(1);
  });
});

/// The WCAG contrast of two opaque `#rrggbb` colours.
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const SEARCH_KEYS = [
  "searchMatchBackground", "searchMatchForeground", "searchActiveMatchBackground", "searchActiveMatchForeground",
] as const;

/// Find paints every match and the active one in these theme keys. Each
/// carries its own ink: a cell's inherited ink on a match background can
/// fall near 1:1, and the dark theme and a see-through window take no
/// contrast floor to lift it.
describe("find's colours", () => {
  function search(term: { options: { theme: unknown } }): Record<(typeof SEARCH_KEYS)[number], string | undefined> {
    const theme = term.options.theme as Record<string, string | undefined>;
    return Object.fromEntries(SEARCH_KEYS.map((key) => [key, theme[key]])) as Record<(typeof SEARCH_KEYS)[number], string | undefined>;
  }

  function expectReadable(term: { options: { theme: unknown } }, label: string): void {
    const colors = search(term);
    for (const key of SEARCH_KEYS) expect(colors[key], `${label}: ${key}`).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrast(colors.searchMatchBackground!, colors.searchMatchForeground!), `${label}: a match`)
      .toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.searchActiveMatchBackground!, colors.searchActiveMatchForeground!), `${label}: the active match`)
      .toBeGreaterThanOrEqual(4.5);
    expect(colors.searchActiveMatchBackground, `${label}: the active match stands apart`).not.toBe(colors.searchMatchBackground);
  }

  test("set a background and an ink at 4.5:1 for a match and the active one, and follow a switch of theme", async () => {
    const { term } = await mounted();
    expectReadable(term, "dark");
    const dark = search(term);

    hybridSurfaceThemes.terminal = "light";
    flushSync();
    await tick();
    expectReadable(term, "light");
    expect(search(term), "the light theme has its own").not.toEqual(dark);
  });

  test("are the same in a see-through window, which takes no floor", async () => {
    window.history.replaceState(null, "", `?${TRANSPARENT_WINDOW_PARAM}=1`);
    applyDesktopTerminalOpacity(90);
    hybridSurfaceThemes.terminal = "light";
    const { term } = await mounted();
    expect((term.options.theme as { minimumContrastRatio?: number }).minimumContrastRatio).toBe(1);
    expectReadable(term, "see-through light");
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
