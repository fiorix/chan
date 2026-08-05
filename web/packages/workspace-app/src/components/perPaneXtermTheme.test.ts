import { describe, expect, test } from "vitest";
import terminalTab from "./TerminalTab.svelte?raw";
import graphCanvas from "./GraphCanvas.svelte?raw";

// Surface body theme overrides must propagate to JS-themed surfaces
// that don't follow the CSS cascade. xterm.js renders to its own
// canvas with a theme object set at construction; GraphCanvas
// re-reads CSS tokens on a MutationObserver tick. Both need to
// see surface-level data-theme changes, not just the document root.

describe("TerminalTab tracks terminal surface body theme", () => {
  test("$effect reads the effective terminal surface theme", () => {
    expect(terminalTab).toContain('effectiveHybridSurfaceTheme("terminal")');
    expect(terminalTab).toContain(
      "data-theme={terminalSurfaceThemeOverride()}",
    );
  });

  test("$effect subscribes to custom colours before the renderer guard", () => {
    expect(terminalTab).toMatch(
      /\$effect\(\(\) => \{\s*effectiveHybridSurfaceTheme\("terminal"\);\s*customTerminalColors;\s*applyTerminalTheme\(\);/,
    );
  });

  test("effective theme is resolved through the shared store", () => {
    expect(terminalTab).toContain("function effectiveTerminalTheme()");
    expect(terminalTab).toContain(
      'customTerminalColors?.contrast ?? effectiveHybridSurfaceTheme("terminal")',
    );
  });

  test("terminalTheme() branches on effective terminal theme", () => {
    expect(terminalTab).toContain("const effective = effectiveTerminalTheme()");
    expect(terminalTab).toContain('if (effective === "light")');
  });

  test("terminalTheme() reads CSS variables from host, not document root", () => {
    expect(terminalTab).toContain("getComputedStyle(host ?? document.documentElement)");
  });

  test("one resolved custom result drives palette and surface chrome", () => {
    expect(terminalTab).toContain(
      "resolveTerminalColors(workspace.info?.preferences?.terminal_colors)",
    );
    expect(terminalTab).toContain(
      'customTerminalColors?.contrast ?? surfaceThemeOverride("terminal")',
    );
    expect(terminalTab).toContain("customTerminalColors?.background");
    expect(terminalTab).toContain("customTerminalColors?.foreground");
    expect(terminalTab).toContain("customTerminalColors?.cursor");
  });

  test("custom background paints only the terminal body chrome", () => {
    expect(terminalTab).toContain(
      "style:--terminal-background={customTerminalColors?.background}",
    );
    expect(terminalTab).toMatch(
      /\.terminal-tab \{[\s\S]*?background: var\(--terminal-background, var\(--bg\)\);/,
    );
    expect(terminalTab).toMatch(
      /\.terminal-host \{[\s\S]*?background: var\(--terminal-background, var\(--bg\)\);/,
    );
    expect(terminalTab).toMatch(
      /\.terminal-host :global\(\.xterm-viewport\) \{[\s\S]*?background-color: var\(--terminal-background, var\(--bg\)\);[\s\S]*?scrollbar-color: var\(--separator\) var\(--terminal-background, var\(--bg\)\);/,
    );
  });

  test("standard mode retains selection and both exact ANSI palettes", () => {
    expect(terminalTab).toContain('selectionBackground: "rgba(88, 166, 255, 0.35)"');
    for (const colour of [
      "#24292f",
      "#cf222e",
      "#1a7f37",
      "#8a6300",
      "#0969da",
      "#8250df",
      "#1b7c83",
      "#4b5563",
      "#57606a",
      "#a40e26",
      "#116329",
      "#6f4e00",
      "#0550ae",
      "#6639ba",
      "#0a6b73",
      "#6e7781",
      "#0c0c0d",
      "#ff6b6b",
      "#6cd07a",
      "#e3b341",
      "#58a6ff",
      "#b07dff",
      "#5dd8d8",
      "#d8d8de",
      "#6c6c70",
      "#ff8585",
      "#8be89a",
      "#f2d16b",
      "#7dbdff",
      "#c8a6ff",
      "#7df0f0",
      "#ffffff",
    ]) {
      expect(terminalTab).toContain(colour);
    }
  });
});

describe("GraphCanvas MutationObserver watches graph body theme", () => {
  test("observer attaches to the nearest graph-tab in addition to documentElement", () => {
    expect(graphCanvas).toContain('containerEl.closest(".graph-tab")');
    expect(graphCanvas).toContain('attributeFilter: ["data-theme"]');
  });
});
