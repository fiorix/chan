// @vitest-environment node

// The config-reference inventory, checked against the shipped rail
// rather than remembered: every field in the server and editor
// preference tables must carry either a `Settings -> <section>`
// destination whose section is on the rail, or an explicit
// not-surfaced with the reason. The four stale rows corrected in
// step 1 are the evidence this was never checked before.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { SETTINGS_SECTIONS } from "./sections";

// Repo-root doc; the vitest cwd is the package root (TerminalTab.font
// reads its fixtures the same way).
const doc = readFileSync("../../../docs/config-reference.md", "utf8");

function preferenceTableRows(): string[] {
  const rows: string[] = [];
  let section = "";
  for (const line of doc.split("\n")) {
    if (line.startsWith("### ")) section = line;
    if (
      /^\| `/.test(line) &&
      (section.includes("server.toml") || section.includes("preferences.toml"))
    ) {
      rows.push(line);
    }
  }
  return rows;
}

const railLabels = new Set(SETTINGS_SECTIONS.map((s) => s.label));

describe("config-reference preference inventory", () => {
  const rows = preferenceTableRows();

  test("both tables are present and non-trivial", () => {
    // Server table (~14 rows) plus editor table (~45 rows).
    expect(rows.length).toBeGreaterThan(50);
  });

  test("every field carries a rail destination or an explicit not-surfaced", () => {
    for (const row of rows) {
      // First hop after each "Settings →": the section the field lives in.
      const destinations = [...row.matchAll(/Settings → ([^→;|()]+?)(?:→|;|\||\()/g)];
      if (destinations.length === 0) {
        expect(
          row,
          `row has no Settings destination and no recorded reason: ${row}`,
        ).toMatch(/Not surfaced|Read-only display/);
        continue;
      }
      for (const [, label] of destinations) {
        expect(
          railLabels.has(label!.trim()),
          `"${label!.trim()}" is not a rail section, in row: ${row}`,
        ).toBe(true);
      }
    }
  });

  test("every rail section with surfaced fields is named by at least one row", () => {
    // The derived rail's promise: no section is decoration. Keyboard
    // Shortcuts and This workspace are covered below by their own rows
    // (shortcuts) and endpoints (workspace band is endpoint-driven).
    const named = new Set<string>();
    for (const row of rows) {
      for (const [, label] of row.matchAll(/Settings → ([^→;|()]+?)(?:→|;|\||\()/g)) {
        named.add(label!.trim());
      }
    }
    for (const label of [
      "Global",
      "Editor",
      "Terminal",
      "File browser",
      "Graph",
      "Dashboard",
      "Search",
      "Keyboard Shortcuts",
    ]) {
      expect(named.has(label), `no field is filed under ${label}`).toBe(true);
    }
  });
});
