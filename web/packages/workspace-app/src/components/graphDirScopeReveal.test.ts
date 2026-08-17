import { describe, expect, test } from "vitest";
import panel from "./GraphPanel.svelte?raw";

// "Graph from here" on a directory opens a `dir:` scoped tab at depth 1, and
// a directory-scoped graph renders one level at a time through the expanded
// set. A directory whose immediate children are all directories therefore
// came up as folder bubbles with no file on screen, while the payload that
// same tab fetched already carried the files and the inspector beside it
// counted them. These pins hold the arrival-time reveal that closes it; the
// depth arithmetic itself is unit-tested in graph/depth.test.ts.

describe("a directory-scoped graph opens deep enough to show its files", () => {
  test("the reveal raises the depth to the shallowest level holding a file", () => {
    expect(panel).toMatch(/function revealDirScopeFiles\(\): void \{/);
    expect(panel).toMatch(
      /const reveal = shallowestFileDepth\(root, nodes\);\s*if \(reveal <= graphState\.depth\) return;\s*graphState\.depth = Math\.min\(reveal, FS_GRAPH_DEPTH_MAX\);/,
    );
  });

  test("it applies to directory scopes in semantic mode only", () => {
    // A workspace graph is the whole tree's overview and opens at its root;
    // filesystem mode is the directories-only view with its own reseed.
    expect(panel).toMatch(
      /function revealDirScopeFiles\(\): void \{\s*if \(filesystemMode\) return;\s*if \(currentScope\?\.kind !== "dir"\) return;/,
    );
  });

  test("a user expansion below the scope root suppresses it", () => {
    // A restored tab carries the user's own expand / collapse state, and
    // anything expanded below the root means they have already navigated.
    expect(panel).toMatch(
      /const below = `\$\{root\}\/`;\s*if \(\s*Object\.keys\(expanded\)\.some\(\(dir\) => expanded\[dir\] && dir\.startsWith\(below\)\),?\s*\)\s*\{\s*return;\s*\}/,
    );
  });

  test("it fires on arrival at a scope, not on a depth change", () => {
    // Dragging the slider down to a level with no files is a request, not a
    // defect to correct, so only a first load or a re-scope reveals.
    expect(panel).toMatch(
      /const firstLoad = appliedDepth === null;\s*const scopeChanged = firstLoad \|\| scopeKey !== appliedScopeKey;/,
    );
    expect(panel).toMatch(/if \(scopeChanged\) revealDirScopeFiles\(\);/);
  });

  test("the first load still trusts the stored expanded set", () => {
    // The reseed is what a restored tab must not get: its serialized
    // expansion is the user's, and the reveal above is gated separately.
    expect(panel).toMatch(
      /if \(!firstLoad && \(graphState\.depth !== appliedDepth \|\| scopeChanged\)\) \{\s*seedExpandedFromSelected\(graphState\.depth\);\s*\}/,
    );
  });
});
