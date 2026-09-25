import { describe, expect, test } from "vitest";
// Build-time contract: App's literal CSS palette blocks equal the TS defaults; vitest drops component CSS.
import app from "../App.svelte?raw";
// Build-time contract: the tuner's literal CSS palette blocks equal the TS defaults; vitest drops component CSS.
import tuner from "../graph-tuner/GraphTuner.svelte?raw";

import {
  applyGraphColorPrefs,
  GRAPH_COLOR_ROWS,
  GRAPH_PALETTE_DEFAULTS,
  graphColorMode,
  graphPaletteStyleFor,
} from "./graphPalette.svelte";

// The graph palette has ONE definition (GRAPH_PALETTE_DEFAULTS). The
// copies that must stay literal CSS - App.svelte's theme blocks and the
// standalone GraphTuner's mirror - are asserted equal to it here, and
// GraphCanvas.svelte.test.ts checks that the canvas falls back to it. A
// retune that lands in only one place goes red.
//
// The unit half pins the override mechanics: per-key hex rejection (a
// hand-edited preferences.toml can carry anything), standard mode
// applying nothing, and the style block the two application sites
// (.graph-tab + the portaled tab-menu bubble) bind.

describe("graph palette defaults: single definition", () => {
  const appDark = app.split(':global([data-theme="light"])')[0]!;
  const appLight = app.split(':global([data-theme="light"])')[1]!;
  const tunerDark = tuner.split(':global(:root[data-theme="light"])')[0]!;
  const tunerLight = tuner.split(':global(:root[data-theme="light"])')[1]!;

  for (const { kind, cssVar } of GRAPH_COLOR_ROWS) {
    // contact + language are alias tokens, pinned separately below.
    if (kind === "contact" || kind === "language") continue;
    test(`${cssVar} dark default matches App.svelte + GraphTuner`, () => {
      const hex = GRAPH_PALETTE_DEFAULTS.dark[kind];
      expect(appDark).toContain(`${cssVar}: ${hex};`);
      expect(tunerDark).toContain(`${cssVar}: ${hex};`);
    });

    test(`${cssVar} light default matches App.svelte + GraphTuner`, () => {
      const hex = GRAPH_PALETTE_DEFAULTS.light[kind];
      expect(appLight).toContain(`${cssVar}: ${hex};`);
      expect(tunerLight).toContain(`${cssVar}: ${hex};`);
    });
  }

  test("--g-contact is a zero-pixel alias of --warn-text in all four theme blocks", () => {
    // The contact default is not a palette hex of its own: the token
    // resolves to the warning hue until a user override lands. The
    // record's contact entries mirror the --warn-text literals, and
    // this pins both sides of that equality so a warn retune cannot
    // silently detach the contact default the Settings swatch shows.
    for (const block of [appDark, tunerDark]) {
      expect(block).toContain("--g-contact: var(--warn-text);");
      expect(block).toContain(`--warn-text: ${GRAPH_PALETTE_DEFAULTS.dark.contact};`);
    }
    for (const block of [appLight, tunerLight]) {
      expect(block).toContain("--g-contact: var(--warn-text);");
      expect(block).toContain(`--warn-text: ${GRAPH_PALETTE_DEFAULTS.light.contact};`);
    }
  });

  test("the --chan-color-language alias survives, not flattened", () => {
    // --g-language and --chan-color-code both alias the brand token;
    // flattening either to a hex detaches code from the language hue.
    // App.svelte carries the alias; GraphTuner carries the literal, so
    // the alias test and the record pin both forms against each other.
    expect(appDark).toContain(`--chan-color-language: ${GRAPH_PALETTE_DEFAULTS.dark.language};`);
    expect(appLight).toContain(`--chan-color-language: ${GRAPH_PALETTE_DEFAULTS.light.language};`);
    expect(tunerDark).toContain(`--g-language: ${GRAPH_PALETTE_DEFAULTS.dark.language};`);
    expect(tunerLight).toContain(`--g-language: ${GRAPH_PALETTE_DEFAULTS.light.language};`);
    const aliases = app.match(/--g-language: var\(--chan-color-language\);/g);
    expect(aliases).toHaveLength(2);
    const codeAliases = app.match(/--chan-color-code: var\(--chan-color-language\);/g);
    expect(codeAliases).toHaveLength(2);
  });





});

describe("graph palette overrides", () => {
  test("standard mode applies nothing", () => {
    applyGraphColorPrefs({
      mode: "standard",
      dark: { doc: "#ff0000" },
    });
    expect(graphColorMode()).toBe("standard");
    expect(graphPaletteStyleFor("dark")).toBe("");
    expect(graphPaletteStyleFor("light")).toBe("");
  });

  test("custom mode emits only the overridden hues, per scheme", () => {
    applyGraphColorPrefs({
      mode: "custom",
      dark: { doc: "#ff0000", tag: "#112233", contact: "#00ff00" },
      light: { img: "#abcdef" },
    });
    expect(graphPaletteStyleFor("dark")).toBe(
      "--g-doc:#ff0000;--g-contact:#00ff00;--g-tag:#112233;",
    );
    expect(graphPaletteStyleFor("light")).toBe("--g-img:#abcdef;");
  });

  test("a malformed hue drops to the default; neighbours survive", () => {
    // The load path has no sanitize (terminal precedent), so this is
    // the boundary that keeps a hand-edited preferences.toml's garbage
    // out of ctx.fillStyle: the bad key falls back to the theme
    // palette rather than painting a stale hue.
    applyGraphColorPrefs({
      mode: "custom",
      dark: { doc: "chartreuse", source: "#4169E1", binary: "" },
    });
    expect(graphPaletteStyleFor("dark")).toBe("--g-source:#4169e1;");
  });

  test("absent prefs render the theme palette", () => {
    applyGraphColorPrefs(undefined);
    expect(graphColorMode()).toBe("standard");
    expect(graphPaletteStyleFor("dark")).toBe("");
  });
});
