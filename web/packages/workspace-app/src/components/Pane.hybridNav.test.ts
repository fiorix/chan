import { describe, expect, test } from "vitest";
import pane from "./Pane.svelte?raw";
import paneModeHelp from "./PaneModeHelp.svelte?raw";

// User-facing copy uses "Hybrid Nav" (title-case). Internal symbols
// (paneMode, paneModeKeymap, etc.), CSS class names, and comments are
// unchanged. These pins guard the visible-text form.

function stripCommentsAndCss(src: string): string {
  // Strip multi-line comments (/* ... */) so JSDoc explanations
  // about "Pane Mode" semantics don't trip the negative match.
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "");
  // Strip line comments (// ...).
  const noLine = noBlock.replace(/\/\/.*$/gm, "");
  // Drop HTML / Svelte comments (<!-- ... -->) which discuss
  // historical phase work, also not user-facing.
  const noHtml = noLine.replace(/<!--[\s\S]*?-->/g, "");
  // Strip the <style> block - class names like `pane-mode-flash`
  // are internal CSS hooks, not user copy.
  const noStyle = noHtml.replace(/<style[\s\S]*?<\/style>/g, "");
  return noStyle;
}

describe("Hybrid Nav user-facing copy", () => {
  test("Pane.svelte hamburger offers Hybrid Nav in title case", () => {
    expect(pane).toContain(">Hybrid Nav<");
    expect(pane).not.toContain(">Enter Hybrid NAV<");
    expect(pane).toContain(">Commands<");
  });

  test("Pane.svelte Hybrid Nav preview aria-label uses the new copy", () => {
    expect(pane).toContain('aria-label="Hybrid Nav preview"');
  });

  test("Pane.svelte renders no user-facing 'Pane Mode' string", () => {
    const visible = stripCommentsAndCss(pane);
    // Visible text in Svelte templates lives between tags
    // (`>Pane Mode<`) or inside attribute values
    // (`aria-label="Pane Mode ..."`). Internal references like
    // `paneMode.active` (variable access) survive the strip and
    // are intentional; they're not rendered to the user.
    expect(visible).not.toContain(">Pane Mode<");
    expect(visible).not.toMatch(/aria-label="[^"]*Pane Mode[^"]*"/);
    expect(visible).not.toMatch(/title="[^"]*Pane Mode[^"]*"/);
  });

  test("Pane.svelte renders no all-caps 'Hybrid NAV' in visible copy", () => {
    // Title-case "Nav" is the canonical form; all-caps is a regression.
    const visible = stripCommentsAndCss(pane);
    expect(visible).not.toContain(">Enter Hybrid NAV<");
    expect(visible).not.toMatch(/aria-label="[^"]*Hybrid NAV[^"]*"/);
  });

  test("PaneModeHelp.svelte title + aria-label use Hybrid Nav", () => {
    expect(paneModeHelp).toContain('aria-label="Hybrid Nav help"');
    // Title includes the entry chord so the cheatsheet header also
    // documents the binding.
    expect(paneModeHelp).toContain(">Hybrid Nav (Cmd+.)<");
  });

  test("PaneModeHelp.svelte renders no user-facing 'Pane Mode' string", () => {
    const visible = stripCommentsAndCss(paneModeHelp);
    expect(visible).not.toContain(">Pane Mode<");
    expect(visible).not.toMatch(/aria-label="[^"]*Pane Mode[^"]*"/);
  });

  test("PaneModeHelp.svelte renders no all-caps 'Hybrid NAV' in visible copy", () => {
    const visible = stripCommentsAndCss(paneModeHelp);
    expect(visible).not.toContain(">Hybrid NAV (Cmd+.)<");
    expect(visible).not.toMatch(/aria-label="[^"]*Hybrid NAV[^"]*"/);
  });
});
