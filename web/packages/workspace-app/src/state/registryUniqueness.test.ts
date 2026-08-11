// Registry chord uniqueness: no two SHORTCUTS entries may resolve to the
// same chord for any (platform, os) pair. This is the guard the
// ctrl-shift-w item needs in order to be safe - it moves two chords
// within one letter - and no such test existed: keymapConflicts checks a
// candidate user assignment against resolved entries, which is a
// different question.
//
// The assertion is EQUALITY against a declared exception table, not a
// bare "no collisions" and not a delta: the shipped table already
// carries one collision (below), so bare uniqueness is red on arrival,
// and a delta cannot see a collision that predates it. Equality reddens
// in BOTH directions - a new collision fails, and so does an exception
// whose pair no longer collides, which is what stops the table from
// silently fossilising into a permanent allowlist.

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  chordsEqual,
  osChord,
  SHORTCUTS,
  type OS,
  type Platform,
} from "./shortcuts";

/// The one sanctioned-looking duplicate in the shipped registry, recorded
/// with its reason rather than resolved: changing a shipped default chord
/// or adding a sanctioned-duplicate registry field are both design
/// rulings, and out of this item's scope.
///
/// app.find.open carries a NATIVE-only Mod+F (web find is the browser's
/// own dialog); terminal.find carries Mod+F on web AND native. So the
/// collision exists on the three native (platform, os) pairs only.
/// Plausibly deliberate surface-scoped dispatch - editor find vs terminal
/// find dispatch in different contexts - but the registry has no field
/// that says so; the defect may be the missing declaration, not the
/// duplicate. Found 2026-08-11 by the swap item's first (absolute)
/// uniqueness draft, which went red on arrival on shipped defaults.
const KNOWN_COLLISIONS: { a: string; b: string; reason: string }[] = [
  {
    a: "app.find.open",
    b: "terminal.find",
    reason:
      "surface-scoped find (editor vs terminal); declared here because the registry has no sanctioned-duplicate field",
  },
];

const PLATFORMS: Platform[] = ["web", "native"];
const OSES: OS[] = ["mac", "linux", "windows"];

function uaFor(os: OS): string {
  if (os === "mac") return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
  if (os === "windows") return "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
  return "Mozilla/5.0 (X11; Linux x86_64)";
}

/// Every colliding pair for one (platform, os), as sorted "idA|idB" keys.
/// chordsEqual is physical-modifier aware and resolves `Mod` through the
/// CLIENT's OS, so the navigator stub must match the pair under test.
function collisionsFor(platform: Platform, os: OS): Set<string> {
  vi.stubGlobal("navigator", { userAgent: uaFor(os) });
  const entries = SHORTCUTS.flatMap((s) => {
    const chord = osChord(s, platform, os);
    return chord ? [{ id: s.id, chord }] : [];
  });
  const pairs = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (chordsEqual(entries[i].chord, entries[j].chord)) {
        const [a, b] = [entries[i].id, entries[j].id].sort();
        pairs.add(`${a}|${b}`);
      }
    }
  }
  return pairs;
}

describe("registry chord uniqueness", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("no two entries resolve to the same chord for any (platform, os), modulo the declared exceptions", () => {
    const declared = new Set(
      KNOWN_COLLISIONS.map(({ a, b }) => [a, b].sort().join("|")),
    );
    for (const platform of PLATFORMS) {
      for (const os of OSES) {
        const actual = collisionsFor(platform, os);
        // The web pairs carry no declared exception: app.find.open has
        // no web chord, so its Mod+F never meets terminal.find's there.
        const expected = platform === "native" ? declared : new Set<string>();
        expect(
          actual,
          `${platform}/${os}: collisions ${[...actual]} vs declared ${[...expected]} ` +
            `- a NEW collision means this change (or another) put two commands on one chord; ` +
            `a MISSING one means the exception table is stale and must be updated`,
        ).toEqual(expected);
      }
    }
  });

  test("the declared exception records the pair it sanctions", () => {
    // Non-vacuity pin: the exception table names a pair that REALLY
    // collides today on the native pairs, so the equality assertion
    // above is exercising its accept arm rather than comparing two
    // empty sets.
    for (const os of OSES) {
      expect(collisionsFor("native", os)).toContain("app.find.open|terminal.find");
    }
    expect(KNOWN_COLLISIONS[0].reason.length).toBeGreaterThan(0);
  });
});
