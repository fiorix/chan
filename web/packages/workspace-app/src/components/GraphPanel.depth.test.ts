import { describe, expect, test } from "vitest";
import graph from "./GraphPanel.svelte?raw";

// BFS is forward-only so the depth slider reveals OUTGOING nodes
// from the root. Previously the bidirectional walk hid the
// "expand from the root" mental model encoded in the depth slider.
// The `link` filter is dropped from the chip set: link edges always
// render, and visibility is implicit (edge visible iff both
// endpoints are visible under the node-type filters + depth).

describe("forward-only BFS", () => {
  test("BFS does NOT walk the reverse edge direction", () => {
    // Forward-only collapse: only the source-direction branch
    // survives at both BFS sites (tag-scope + general-scope).
    // Strip line comments so context comments don't trip the guard.
    const stripped = graph
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(stripped).not.toMatch(
      /else if \(frontier\.has\(e\.target\) && !visited\.has\(e\.source\)\)/,
    );
  });

  test("BFS still walks the forward edge direction", () => {
    // Forward source → target traversal is still the load-bearing
    // step. Two BFS sites (tag-scope + general-scope) share the
    // shape.
    const matches = graph.match(
      /if \(frontier\.has\(e\.source\) && !visited\.has\(e\.target\)\)/g,
    );
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  test("BFS uses next.add(e.target) from the source side, not visited.add(e.source)", () => {
    // The general-scope BFS only adds e.target when frontier contains
    // e.source. Confirm the next.add call sites are for e.target only
    // (no e.source additions in a next.add call within the general BFS).
    // This is a distinct structural invariant from the reverse-check
    // absence above.
    expect(graph).toMatch(
      /frontier\.has\(e\.source\) && !visited\.has\(e\.target\)[\s\S]*?next\.add\(e\.target\)/,
    );
  });
});

describe("link filter dropped", () => {
  test("FilterKind union no longer includes 'link'", () => {
    // FilterKind deliberately has no `link` member; bucket kinds
    // extend the union over time. Pin the load-bearing absence
    // (link) rather than the exact union shape so growing the kind
    // set doesn't trip this guard.
    expect(graph).toMatch(/type FilterKind =/);
    expect(graph).toMatch(/\| "tag"/);
    expect(graph).toMatch(/\| "mention"/);
    expect(graph).toMatch(/\| "language"/);
    expect(graph).toMatch(/\| "img"/);
    expect(graph).toMatch(/\| "folder"/);
    // No `link` arm in the FilterKind union; tolerate
    // surrounding whitespace + leading separator.
    expect(graph).not.toMatch(/type FilterKind =[\s\S]*?\| "link"/);
    expect(graph).not.toMatch(/type FilterKind = "link"/);
  });

  test("link is short-circuited to always visible in edgeVisibleByChip", () => {
    expect(graph).toMatch(/if \(kind === "link"\) return true/);
  });

  test("chip iteration no longer ships a 'link' entry", () => {
    // The tab-menu bubble is the single chip-iteration site. Pin
    // the load-bearing absence (link) + the leading-kind shape
    // (starts with tag) so the guard tolerates future additions.
    const matches = graph.match(/\["tag", "mention"[^\]]*\] as const/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
    expect(graph).not.toMatch(/\["link",\s*"tag"/);
  });

  test("FILTER_COLORS no longer maps link", () => {
    // Pin the literal-mapping block; the `link` key shouldn't
    // appear inside FILTER_COLORS' object literal.
    expect(graph).toMatch(
      /FILTER_COLORS: Record<FilterKind, string> = \{[\s\S]*?tag: EDGE_COLORS\.tag/,
    );
    expect(graph).not.toMatch(
      /FILTER_COLORS: Record<FilterKind, string> = \{[\s\S]{0,40}link:/,
    );
  });

  test("filesystem-mode label dispatch no longer branches on 'link'", () => {
    // The filesystem-mode chip-label dispatch used to map link →
    // "contains". With link dropped from the iteration, that
    // branch is dead. Confirm it's gone from the chip-label
    // ladder.
    expect(graph).not.toMatch(
      /\{kind === "link"\s*\?\s*"contains"\s*:/,
    );
  });
});

describe("depth slider works in workspace path-scope", () => {
  test("depthDisabled no longer pins workspace path-scope to disabled", () => {
    // Pre-fix shape was:
    //   `!languageMode && (!currentScope || currentScope.kind === "workspace")`
    // The workspace branch made the default landing graph's slider
    // unmovable. Post-fix drops the workspace guard so the slider
    // tracks `workspaceDepthProbe`-driven `depthCap` the same way
    // the dir scope does.
    expect(graph).toMatch(
      /\{@const depthDisabled = !languageMode && !currentScope\}/,
    );
    expect(graph).not.toMatch(
      /depthDisabled =\s*\n?\s*!languageMode && \(!currentScope \|\| currentScope\.kind === "workspace"\)/,
    );
  });

  test("depthShallow falls through to depthCap <= 1 for workspace scope too", () => {
    expect(graph).toMatch(
      /const depthShallow = \$derived\.by\(\(\) => \{[\s\S]{1,1200}if \(!currentScope\) return false;[\s\S]{1,200}return depthCap <= 1;/,
    );
    expect(graph).not.toMatch(
      /const disabled = !currentScope \|\| currentScope\.kind === "workspace";\s*\n\s*if \(disabled\) return false;/,
    );
  });
});

describe("directory expand/collapse in the rich semantic graph", () => {
  test("workspace + dir scope render the expanded-ancestor tree, keeping every layer", () => {
    // The fresh Cmd+Shift+M graph is semantic and
    // supports directory expand/collapse without flipping to the
    // directories-only filesystem mode. Workspace + dir scope gate
    // file / folder visibility on `ancestorsExpanded` (the same tree
    // model the filesystem mode uses); tag / mention / language
    // meta-nodes always pass through so the rich layers survive; the
    // workspace-root anchor is unconditional so the spine has a root.
    expect(graph).toMatch(
      /currentScope\.kind === "workspace" \|\| currentScope\.kind === "dir"/,
    );
    expect(graph).toMatch(
      /n\.kind === "tag" \|\| n\.kind === "mention" \|\| n\.kind === "language"/,
    );
    expect(graph).toMatch(
      /n\.kind === "folder" && \(n\.id === "" \|\| n\.path === ""\)/,
    );
    expect(graph).toMatch(
      /ancestorsExpanded\(rootPath, n\.path, expanded\)/,
    );
    // No flat depth filter remains in the semantic branch.
    expect(graph).not.toMatch(
      /relativeDepth\(rootPath, nodePath\) <= graphState\.depth/,
    );
  });

  test("double-click toggles a directory in semantic mode (no fetch, no mode flip)", () => {
    // Bug (a): on the fresh semantic graph a directory double-click
    // toggles the spine client-side via toggleSemanticDirExpand; it no
    // longer requires a "Graph from here" mode flip first.
    expect(graph).toMatch(/function toggleSemanticDirExpand\(path: string\): void/);
    expect(graph).toMatch(
      /if \(selectedNode && selectedNode\.kind === "folder"\) \{\s*toggleSemanticDirExpand\(selectedNode\.path\);/,
    );
  });

  test("the depth slider seeds the expanded set FROM THE SELECTED directory", () => {
    // Bug (b): the slider expands from the currently selected directory
    // downward by N levels, keeping that node's ancestors expanded.
    // Selecting the workspace root + max reveals everything; a deep
    // node expands only its subtree.
    expect(graph).toMatch(/function seedExpandedFromSelected\(depth: number\): void/);
    expect(graph).toMatch(/const seedRoot = selectedDirPath \?\? scopeRoot;/);
    expect(graph).toMatch(/seedExpandedFromSelected\(graphState\.depth\)/);
  });

  test("graph-from-here spawns a new semantic graph tab seeded at the node", () => {
    // Nav contract: "Graph from here" spawns a NEW graph tab (never an
    // in-place re-root). It opens in semantic mode so a directory from-here
    // keeps the rich graph (all layers) instead of the directories-only
    // filesystem mode, and pendingSelectId lands the tab selected on the node.
    expect(graph).toMatch(
      /function graphFromHere\(path: string, isDir: boolean\): void \{[\s\S]{1,800}openGraphInActivePane\(\{\s*mode: "semantic",[\s\S]{1,200}pendingSelectId: path,/,
    );
    expect(graph).not.toMatch(/graphState\.mode = "filesystem"/);
  });
});
