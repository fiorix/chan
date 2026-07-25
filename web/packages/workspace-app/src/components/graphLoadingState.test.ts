import { describe, expect, test } from "vitest";
import graph from "./GraphPanel.svelte?raw";

// The graph must signal an in-flight index so a not-yet-complete
// semantic graph (dead-end "missing" nodes that may simply be
// unindexed) is not read as final. The workspace-global `indexStatus`
// is wired into the graph to show an "indexing" cue in the status bar;
// per-scope ghost pull-back + parent-dir pulse is a follow-up.

describe("graph loading-state: indexing cue", () => {
  test("GraphPanel imports indexStatus from the store", () => {
    expect(graph).toMatch(/import \{[\s\S]*?\bindexStatus\b[\s\S]*?\} from "\.\.\/state\/store\.svelte"/);
  });

  test("indexBuilding includes workspace recovery as an incomplete state", () => {
    expect(graph).toMatch(
      /const indexBuilding = \$derived\(\s*indexStatus\.value\?\.state === "building" \|\|\s*indexStatus\.value\?\.state === "reindexing" \|\|\s*workspaceRecovering,?\s*\)/,
    );
  });

  test("the status bar distinguishes recovery from ordinary indexing", () => {
    expect(graph).toMatch(
      /\{#if indexBuilding\}[\s\S]*?class="indexing"[\s\S]*?\{workspaceRecovering \? "workspace recovering…" : "indexing…"\}/,
    );
  });

  test("the indexing cue pulses (and respects reduced-motion)", () => {
    expect(graph).toMatch(/\.indexing \{[\s\S]*?animation: graph-indexing-pulse/);
    expect(graph).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.indexing \{[\s\S]*?animation: none/);
  });
});

// The canvas empty-state copy distinguishes "still indexing" from
// "genuinely empty". A zero-node markdown/language graph during indexing
// is "not ready yet", not "no files"; filesystem mode is structural and
// keeps its scope message regardless of index state.
describe("graph empty-state: indexing vs genuinely-empty copy", () => {
  test("emptyStateMessage gates the index-derived modes on indexBuilding", () => {
    expect(graph).toMatch(
      /const emptyStateMessage = \$derived\(\s*filesystemMode\s*\?\s*"no filesystem graph nodes for this scope"\s*:\s*workspaceRecovering\s*\?\s*"graph unavailable while the workspace recovers"\s*:\s*indexBuilding\s*\?\s*"graph temporarily unavailable while indexing the workspace"/,
    );
  });

  test("the empty-state placeholder renders the derived message", () => {
    expect(graph).toMatch(
      /\{:else if !loading && nodes\.length === 0\}[\s\S]*?<div class="placeholder">\s*\{emptyStateMessage\}/,
    );
  });

  test("filesystem mode is not gated on indexBuilding (structural, not index-derived)", () => {
    // filesystemMode resolves before the indexBuilding branch, so a
    // filesystem graph never shows the indexing copy.
    expect(graph).toMatch(
      /filesystemMode\s*\?\s*"no filesystem graph nodes for this scope"\s*:\s*workspaceRecovering/,
    );
  });
});

// Once indexing finishes, the index-derived edges must layer onto the
// always-seeded fs spine, so a graph opened mid-index upgrades to its
// rich form. An $effect fires reloadGraph() on the indexBuilding
// true->false edge.
describe("graph index-complete: re-layer the index-derived edges", () => {
  test("an effect tracks indexBuilding and fires only on the true->false edge", () => {
    // prevIndexBuilding latches the prior value; the effect bails unless
    // the transition is building -> not-building (no reload loop).
    expect(graph).toMatch(/let prevIndexBuilding = false;/);
    expect(graph).toMatch(
      /\$effect\(\(\) => \{\s*const building = indexBuilding;\s*const wasBuilding = prevIndexBuilding;\s*prevIndexBuilding = building;\s*if \(!wasBuilding \|\| building\) return;/,
    );
  });

  test("the edge reload is visible-only, semantic-mode-only, and reuses reloadGraph", () => {
    // NOT gated on nodes.length === 0: the fs spine keeps `nodes`
    // non-empty, so the re-layer must fire regardless of node count, in
    // semantic mode only (filesystem / language modes have their own
    // surfaces).
    expect(graph).toMatch(
      /untrack\(\(\) => \{\s*if \(visible && !filesystemMode && !languageMode\) void reloadGraph\(\);\s*\}\)/,
    );
    expect(graph).not.toMatch(
      /if \(visible && nodes\.length === 0\) void reloadGraph\(\)/,
    );
  });
});

// While the index is building, dead-end ("missing") nodes may just be
// not-yet-indexed link targets, so they are pulled back (with their
// edges) until the index settles; once idle they render as real
// broken links (the established dashed-ghost styling).
describe("graph loading-state: pull back dead-ends while indexing", () => {
  test("hiddenMissingIds collects missing file nodes only while indexBuilding", () => {
    expect(graph).toMatch(
      /const hiddenMissingIds = \$derived\.by\(\(\) => \{[\s\S]*?if \(!indexBuilding\) return ids;[\s\S]*?n\.kind === "file" && n\.missing/,
    );
  });

  test("visibleNodeIds excludes pulled-back dead-end nodes", () => {
    expect(graph).toMatch(/!hiddenMissingIds\.has\(n\.id\)/);
  });

  test("visibleEdges drops edges touching pulled-back dead-end nodes", () => {
    expect(graph).toMatch(/!hiddenMissingIds\.has\(e\.source\)/);
    expect(graph).toMatch(/!hiddenMissingIds\.has\(e\.target\)/);
  });
});
