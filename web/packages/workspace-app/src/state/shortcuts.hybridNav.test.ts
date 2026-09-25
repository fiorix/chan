import { describe, expect, test } from "vitest";
import shortcuts from "./shortcuts.ts?raw";

// Pins the title-case "Hybrid Nav" label in shortcuts.ts: no
// "NAV" (all-caps) variant should remain anywhere in the registry.

describe("shortcuts.ts Hybrid Nav label casing", () => {
  test("no `Hybrid NAV` literal remains in shortcuts.ts", () => {
    expect(shortcuts).not.toContain("Hybrid NAV");
  });

  test("no `Hybrid NaV` (intermediate case) literal remains", () => {
    expect(shortcuts).not.toContain("Hybrid NaV");
  });

  test("registry notes carry the title-case `Hybrid Nav` form", () => {
    // Spot-check a surviving Hybrid Nav note: the spawn-alt notes went with
    // their commands in the no-defaults round, but New terminal is kept and
    // keeps its Mod+. t alias in the title-case form.
    expect(shortcuts).toContain("Mod+. t (Hybrid Nav)");
  });

  test("`Hybrid Nav` label reads title-case", () => {
    expect(shortcuts).toContain('"Hybrid Nav"');
  });
});
