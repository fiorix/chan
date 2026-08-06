import { describe, expect, test } from "vitest";
import pillToggle from "./settings/PillToggle.svelte?raw";
import pillRadio from "./settings/PillRadio.svelte?raw";
import reportsControl from "./settings/workspace/ReportsControl.svelte?raw";
import semanticControl from "./settings/workspace/SemanticControl.svelte?raw";

// Checkbox and radio pills carry the same selected-state contract: shape,
// spacing, neutral border, and checked background stay, and the selected
// state does not switch the outer border to blue. Aligning the two controls
// is an explicit maintainer decision rather than an accident of the CSS, so
// the radio site is pinned by name alongside the checkbox ones. All four
// carry a `.pill.on` rule whose selector text is identical, which means
// nothing in the selector distinguishes them and a sweep across settings
// could reintroduce the blue border at one site and leave the rest
// inconsistent.
//
// Pinned against source rather than computed style. The vitest block in
// vite.config.ts runs jsdom with no `css` option and the svelte plugin emits
// component CSS externally, so a component <style> block never reaches a
// mounted node. getComputedStyle would report an empty border whether or not
// the rule exists, which is a check that cannot go red.

/// One CSS declaration block, so an assertion can neither be satisfied nor
/// defeated by an unrelated declaration elsewhere in the same component.
function ruleBlock(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped} \\{[\\s\\S]*?\\}`));
  if (match === null) throw new Error(`no \`${selector}\` rule in this component`);
  return match[0];
}

type PillSite = {
  name: string;
  source: string;
  /// Only the two workspace controls gate a disabled pill; PillToggle has
  /// no disabled rule and must not gain one.
  disabledRule: boolean;
};

const CHECKBOX_SITES: PillSite[] = [
  { name: "PillToggle", source: pillToggle, disabledRule: false },
  { name: "ReportsControl", source: reportsControl, disabledRule: true },
  { name: "SemanticControl", source: semanticControl, disabledRule: true },
];

describe("checked checkbox pills carry no outer border colour", () => {
  for (const site of CHECKBOX_SITES) {
    test(`${site.name}: .pill.on sets no border-color at all`, () => {
      // Not just `var(--link)`: the checked pill falls back to the base
      // rule's neutral border, so any border-color here is a regression.
      expect(ruleBlock(site.source, ".pill.on")).not.toMatch(/border-color:/);
    });

    test(`${site.name}: .pill.on keeps the checked background`, () => {
      expect(ruleBlock(site.source, ".pill.on")).toMatch(
        /background: var\(--hover-bg\);/,
      );
    });
  }
});

describe("checked radio pills carry no outer border colour either", () => {
  test("PillRadio: .pill.on sets no border-color at all", () => {
    // Same standard as the checkbox sites: the selected pill falls back to
    // the base rule's neutral border, so any border-color here is a
    // regression, not only `var(--link)`.
    expect(ruleBlock(pillRadio, ".pill.on")).not.toMatch(/border-color:/);
  });

  test("PillRadio: .pill.on keeps the checked background", () => {
    expect(ruleBlock(pillRadio, ".pill.on")).toMatch(
      /background: var\(--hover-bg\);/,
    );
  });

  test("PillRadio is the radio surface, so the rule above is the radio one", () => {
    expect(pillRadio).toMatch(/type="radio"/);
    expect(pillRadio).not.toMatch(/type="checkbox"/);
  });
});

describe("the surrounding checkbox pill rules are untouched", () => {
  for (const site of CHECKBOX_SITES) {
    test(`${site.name}: shape, spacing, and neutral border survive`, () => {
      const base = ruleBlock(site.source, ".pill");
      expect(base).toMatch(/padding: 4px 10px;/);
      expect(base).toMatch(/border: 1px solid var\(--btn-border\);/);
      expect(base).toMatch(/border-radius: 4px;/);
      expect(base).toMatch(/background: var\(--btn-bg\);/);
    });

    test(`${site.name}: the hover border rule survives`, () => {
      expect(ruleBlock(site.source, ".pill:hover")).toMatch(
        /border-color: var\(--btn-hover\);/,
      );
    });

    test(`${site.name}: the native checkbox reset survives`, () => {
      // Zeroes the input's own chrome only; the native control keeps its
      // checked rendering, and the wrapping label keeps focus and Space.
      expect(ruleBlock(site.source, '.pill input[type="checkbox"]')).toMatch(
        /border: 0;/,
      );
    });

    test(`${site.name}: a label.pill still wraps a native checkbox`, () => {
      // The item cannot be satisfied by dropping the pill chrome instead.
      expect(site.source).toMatch(/<label class="pill" class:on=/);
      expect(site.source).toMatch(/type="checkbox"/);
    });
  }

  for (const site of CHECKBOX_SITES.filter((s) => s.disabledRule)) {
    test(`${site.name}: the disabled pill rule survives`, () => {
      expect(ruleBlock(site.source, ".pill:has(input:disabled)")).toMatch(
        /cursor: not-allowed;[\s\S]*?opacity: 0\.7;/,
      );
    });
  }
});

describe("the surrounding radio pill rules are untouched", () => {
  test("PillRadio: shape, spacing, and neutral border survive", () => {
    const base = ruleBlock(pillRadio, ".pill");
    expect(base).toMatch(/padding: 4px 10px;/);
    expect(base).toMatch(/border: 1px solid var\(--btn-border\);/);
    expect(base).toMatch(/border-radius: 4px;/);
    expect(base).toMatch(/background: var\(--btn-bg\);/);
  });

  test("PillRadio: the hover border rule survives", () => {
    expect(ruleBlock(pillRadio, ".pill:hover")).toMatch(
      /border-color: var\(--btn-hover\);/,
    );
  });

  test("PillRadio: the native radio reset survives", () => {
    // Zeroes the input's own chrome only. The selected dot and the focus
    // ring are the native control's, and neither is expressed through
    // `.pill.on`, so they outlive the border-colour change.
    expect(ruleBlock(pillRadio, '.pill input[type="radio"]')).toMatch(
      /border: 0;/,
    );
  });

  test("PillRadio: a label.pill still wraps a native radio", () => {
    // The item cannot be satisfied by dropping the pill chrome instead, and
    // the label wrapper is what keeps the control keyboard-reachable.
    expect(pillRadio).toMatch(/<label class="pill" class:on=/);
    expect(pillRadio).toMatch(/type="radio"/);
  });
});
