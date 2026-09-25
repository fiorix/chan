import { describe, expect, test } from "vitest";
import settingField from "./settings/SettingField.svelte?raw";
import pillToggle from "./settings/PillToggle.svelte?raw";
import pillRadio from "./settings/PillRadio.svelte?raw";
import reportsControl from "./settings/workspace/ReportsControl.svelte?raw";
import semanticControl from "./settings/workspace/SemanticControl.svelte?raw";

// Checkbox and radio pills carry the same selected-state contract: shape,
// spacing, neutral border, and checked background stay, and the selected
// state does not switch the outer border to blue. That contract used to be
// pinned at four identical `.pill.on` copies (PillToggle, PillRadio,
// ReportsControl, SemanticControl); the v0.89.0 settings reorganisation
// collapsed them into ONE block, living in SettingField, which every pill
// user nests inside. These pins now assert both halves of that: the one
// block keeps the contract, and the copies stay gone.
//
// Pinned against source rather than computed style. The vitest block in
// vite.config.ts runs jsdom with no `css` option and the svelte plugin emits
// component CSS externally, so a component <style> block never reaches a
// mounted node. getComputedStyle would report an empty border whether or not
// the rule exists, which is a check that cannot go red.

/// One CSS declaration block inside a :global(...) wrapper, so an assertion
/// can neither be satisfied nor defeated by an unrelated declaration
/// elsewhere in the same component. The selector may be one of a
/// comma-separated list sharing the block.
function globalRuleBlock(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(
    new RegExp(`:global\\(${escaped}\\)[^{]*\\{[\\s\\S]*?\\}`),
  );
  if (match === null) {
    throw new Error(`no \`:global(${selector})\` rule in this component`);
  }
  return match[0];
}

describe("the one .pill block carries the contract", () => {
  test("exactly one .pill.on block survives under components/settings/", () => {
    // The consolidation acceptance line: the four copies collapsed into
    // SettingField, so a second declaration anywhere is a fork regrowing.
    const sources = [settingField, pillToggle, pillRadio, reportsControl, semanticControl];
    const declarations = sources.flatMap((s) => s.match(/\.pill\.on[)\s]*\{/g) ?? []);
    expect(declarations).toHaveLength(1);
    expect(settingField).toMatch(/\.pill\.on/);
  });

  test(".pill.on sets no border-color at all", () => {
    // Not just `var(--link)`: the checked pill falls back to the base
    // rule's neutral border, so any border-color here is a regression.
    expect(globalRuleBlock(settingField, ".pill.on")).not.toMatch(/border-color:/);
  });

  test(".pill.on keeps the checked background", () => {
    expect(globalRuleBlock(settingField, ".pill.on")).toMatch(
      /background: var\(--hover-bg\);/,
    );
  });

  test(".pill keeps shape, spacing, and the neutral border", () => {
    const base = globalRuleBlock(settingField, ".pill");
    expect(base).toMatch(/padding: 4px 10px;/);
    expect(base).toMatch(/border: 1px solid var\(--btn-border\);/);
    expect(base).toMatch(/border-radius: 4px;/);
    expect(base).toMatch(/background: var\(--btn-bg\);/);
  });

  test("the hover border rule survives", () => {
    expect(globalRuleBlock(settingField, ".pill:hover")).toMatch(
      /border-color: var\(--btn-hover\);/,
    );
  });

  test("the native input reset survives for checkbox and radio", () => {
    // Zeroes the input's own chrome only; the native control keeps its
    // checked rendering, and the wrapping label keeps focus and Space.
    expect(globalRuleBlock(settingField, '.pill input[type="checkbox"]')).toMatch(
      /border: 0;/,
    );
    expect(globalRuleBlock(settingField, '.pill input[type="radio"]')).toMatch(
      /border: 0;/,
    );
  });

  test("the disabled pill rule survives", () => {
    // Both workspace toggles gate a disabled pill during their busy write.
    expect(globalRuleBlock(settingField, ".pill:has(input:disabled)")).toMatch(
      /cursor: not-allowed;[\s\S]*?opacity: 0\.7;/,
    );
  });
});

describe("the pill components render bare markup and the copies stay gone", () => {
  test("PillToggle: a label.pill still wraps a native checkbox", () => {
    // The item cannot be satisfied by dropping the pill chrome instead.
    expect(pillToggle).toMatch(/<label class="pill" class:on=/);
    expect(pillToggle).toMatch(/type="checkbox"/);
    // PillToggle carries the disabled prop the copies implemented.
    expect(pillToggle).toMatch(/disabled\?: boolean/);
  });

  test("PillRadio: a label.pill still wraps a native radio", () => {
    expect(pillRadio).toMatch(/<label class="pill" class:on=/);
    expect(pillRadio).toMatch(/type="radio"/);
    expect(pillRadio).not.toMatch(/type="checkbox"/);
  });

  test("the former copies declare no pill CSS of their own", () => {
    for (const [name, source] of [
      ["PillToggle", pillToggle],
      ["PillRadio", pillRadio],
      ["ReportsControl", reportsControl],
      ["SemanticControl", semanticControl],
    ] as const) {
      expect(source, `${name} must not redeclare .pill`).not.toMatch(/\.pill \{/);
    }
  });

  test("the workspace toggles are PillToggle call sites", () => {
    expect(reportsControl).toMatch(/<PillToggle/);
    expect(semanticControl).toMatch(/<PillToggle/);
  });
});
