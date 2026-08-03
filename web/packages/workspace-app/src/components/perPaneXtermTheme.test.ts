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
});

describe("GraphCanvas MutationObserver watches graph body theme", () => {
  test("observer attaches to the nearest graph-tab in addition to documentElement", () => {
    expect(graphCanvas).toContain('containerEl.closest(".graph-tab")');
    expect(graphCanvas).toContain('attributeFilter: ["data-theme"]');
  });
});
