import { describe, expect, test } from "vitest";
import graph from "./GraphPanel.svelte?raw";

// Chip counts are node tallies, not edge tallies. Iterating edges and
// bumping per edge kind makes a mention chip show the edge count (~1973)
// instead of the distinct contact node count (~48). The correct UX is
// "how many of THIS thing is in the graph".
//
// Source-pin tests match the raw string of the counts $derived block,
// which is short and distinctive enough to pin without the Svelte runtime.

describe("chip count loop is node-tally", () => {
  test("counts derive iterates `nodes` not `edges` for chip totals", () => {
    // Pin the absence of the old edge-iteration form.
    const stripped = graph
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("///"))
      .join("\n");
    expect(stripped).not.toMatch(
      /const counts = \$derived\.by\([\s\S]*?for \(const e of edges\) \{[\s\S]*?c\[kind\]\+\+;/,
    );
  });

  test("counts derive walks nodes + bumps tag / mention / language by kind", () => {
    expect(graph).toMatch(
      /const counts = \$derived\.by\(\(\) => \{[\s\S]*?for \(const n of nodes\) \{[\s\S]*?if \(n\.kind === "tag"\) \{[\s\S]*?c\.tag\+\+;/,
    );
    expect(graph).toMatch(/if \(n\.kind === "mention"\) \{[\s\S]*?c\.mention\+\+;/);
    expect(graph).toMatch(/if \(n\.kind === "language"\) \{[\s\S]*?c\.language\+\+;/);
  });

  test("contact-discriminated file nodes add to mention count (chip toggle scope)", () => {
    // Mention chip hides BOTH mention-kind nodes AND contact-flagged
    // file nodes (see hiddenContactIds). Both bump c.mention so the
    // displayed count reflects everything the toggle hides.
    expect(graph).toMatch(/else if \(cls === "contact"\) c\.mention\+\+/);
  });

  test("img + markdown + source counts are node tallies", () => {
    expect(graph).toMatch(/if \(cls === "img"\) c\.img\+\+/);
    expect(graph).toMatch(/else if \(cls === "doc"\) c\.markdown\+\+/);
    expect(graph).toMatch(/else if \(cls === "source"\) c\.source\+\+/);
  });

  test("folder count uses the folder-node walk (no edge tally)", () => {
    expect(graph).toMatch(/if \(n\.kind === "folder"\) \{[\s\S]*?c\.folder\+\+;/);
  });

  test("comment block documents the semantic correction (chip counts are NODE tallies)", () => {
    expect(graph).toMatch(/Counts are NODE counts, not edge counts/i);
  });
});
