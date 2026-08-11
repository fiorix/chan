// The rail is derived, not typed: the section list must agree with the
// command registry's category set. What fails when this is false is the
// next surface somebody adds - it will get commands and no section,
// exactly as the Graph and the Dashboard did before the reorganisation.

import { describe, expect, test } from "vitest";

import "../../state/commands/install";
import { allCommands } from "../../state/commands";
import { EXCLUDED_CATEGORIES, SETTINGS_SECTIONS } from "./sections";

describe("settings rail derivation", () => {
  test("every registry category has a section or a recorded exclusion", () => {
    const registryCategories = new Set(allCommands().map((c) => c.category));
    const sectionCategories = new Set(SETTINGS_SECTIONS.map((s) => s.category));
    for (const category of registryCategories) {
      if (sectionCategories.has(category)) continue;
      expect(
        EXCLUDED_CATEGORIES[category],
        `"${category}" has registered commands but no Settings section; ` +
          `add one to SETTINGS_SECTIONS or record the reason in EXCLUDED_CATEGORIES`,
      ).toBeDefined();
    }
  });

  test("every section category actually has commands registered", () => {
    const registryCategories = new Set(allCommands().map((c) => c.category));
    for (const section of SETTINGS_SECTIONS) {
      if (section.category === null) continue; // Keyboard Shortcuts: meta
      expect(
        registryCategories.has(section.category),
        `section "${section.label}" answers to category "${section.category}", which has no registered commands`,
      ).toBe(true);
    }
  });

  test("every excluded category is named with its reason and has no section", () => {
    const sectionCategories = new Set(SETTINGS_SECTIONS.map((s) => s.category));
    for (const [category, reason] of Object.entries(EXCLUDED_CATEGORIES)) {
      expect(reason?.length, `exclusion for "${category}" must state the reason`).toBeGreaterThan(0);
      expect(sectionCategories.has(category as never)).toBe(false);
    }
    // The current exclusion set, pinned so adding one is a deliberate act:
    expect(Object.keys(EXCLUDED_CATEGORIES).sort()).toEqual(["Apps", "Panes", "Tabs"]);
  });

  test("the rail order is the registry's surface order, shortcuts and workspace last", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual([
      "global",
      "editor",
      "terminal",
      "browser",
      "graph",
      "dashboard",
      "search",
      "shortcuts",
      "workspace",
    ]);
  });
});
