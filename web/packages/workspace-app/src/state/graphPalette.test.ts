import { describe, expect, test } from "vitest";
import app from "../App.svelte?raw";
import canvas from "../components/GraphCanvas.svelte?raw";
import graphPanel from "../components/GraphPanel.svelte?raw";
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
// the canvas's runtime fallbacks import it directly. A retune that
// lands in only one place goes red.
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

  test("GraphCanvas carries no literal palette hexes", () => {
    // Its readTheme fallbacks and $state seed import the module, so no
    // default hex may appear in a palette declaration (`--g-doc: #...`)
    // or a readTheme fallback (`v("--g-doc", "#...")`). The bare-hex
    // form is NOT asserted: an unrelated token's fallback can share a
    // palette hex by coincidence (the dark --text-secondary fallback
    // equals the dark folder hue), and that is not a palette copy. The
    // contact hue is exempt: its readTheme fallback is the warn-text
    // chain (`--g-contact` -> `--warn-text` -> literal), and that
    // terminal literal belongs to the warning hue, not the palette.
    for (const theme of ["dark", "light"] as const) {
      for (const { kind, cssVar } of GRAPH_COLOR_ROWS) {
        if (kind === "contact") continue;
        const hex = GRAPH_PALETTE_DEFAULTS[theme][kind];
        expect(canvas).not.toContain(`${cssVar}: ${hex}`);
        expect(canvas).not.toContain(`v("${cssVar}", "${hex}"`);
      }
    }
    expect(canvas).toMatch(/from "\.\.\/state\/graphPalette\.svelte"/);
  });

  test("canvas mention slot reads --g-contact with the warn-text fallback chain", () => {
    // Contact and mention share one token: the canvas reads the
    // settable --g-contact first and falls back to the warning hue, so
    // a graph-scoped override repaints mentions while every surface
    // outside the graph keeps the warn default.
    expect(canvas).toMatch(/mention: v\("--g-contact", v\("--warn-text", "#e3b341"\)\)/);
  });

  test("GraphCanvas re-reads on a style change (palette override lands inline)", () => {
    expect(canvas).toMatch(/attributeFilter: \["data-theme", "style"\]/);
  });

  test("icon re-rasterisation is keyed on its two real inputs", () => {
    // rebuildIcons output is a function of (bg, ghostStroke) only; the
    // guard keeps a hue-only colour-picker drag from rebuilding twenty
    // byte-identical images per pointer move.
    expect(canvas).toMatch(/if \(iconKey === lastIconKey\) return;/);
  });

  test("the override is bound on exactly two elements, both inside the graph surface", () => {
    // The negative half of the containment contract: changing a graph
    // colour changes the graph and nothing outside it, and that rests
    // on .graph-tab and the portaled tab-menu bubble being the ONLY
    // bind sites. A third bind (or one on :root) must go red here.
    const binds = graphPanel.match(/style=\{paletteStyle \|\| undefined\}/g);
    expect(binds).toHaveLength(2);
    // No other component may bind the palette style block either.
    expect(app).not.toContain("graphPaletteStyleFor");
    expect(app).not.toMatch(/style=\{[^}]*--g-/);
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
