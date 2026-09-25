import { describe, expect, test } from "vitest";
import source from "./GraphCanvas.svelte?raw";
import { DEFAULT_FORCE } from "../graph/force";

// Filesystem-hierarchy as graph spine. GraphCanvas's d3-force simulation
// places every node above its ancestor chain to the workspace root
// (the root anchors at the bottom; the spine grows up). Load-bearing
// pieces: DNode extended with depth + parentId; nodeHierarchy() derives
// those from kind + path; buildSim() wires a depth-aware forceY +
// parentXForce so files sit above their parent dir and siblings cluster
// horizontally. Tests pin the wiring shape.

describe("filesystem-hierarchy layout shape", () => {
  test("DNode carries depth + parentId fields", () => {
    expect(source).toMatch(
      /type DNode = \{[\s\S]*?depth: number;\s*\n\s*parentId: string \| null;/,
    );
  });

  test("force config (../graph/force) defines the hierarchy-spine params", () => {
    // The tuning object lives in the shared graph/force module so the
    // graph-tuner playground and the live graph read one source of
    // truth. GraphCanvas defaults its `force` prop to DEFAULT_FORCE.
    expect(source).toMatch(
      /import \{ DEFAULT_FORCE, type GraphForce \} from "\.\.\/graph\/force"/,
    );
    expect(source).toMatch(/force\?: GraphForce;/);
    expect(source).toMatch(/force = DEFAULT_FORCE,/);
    expect(DEFAULT_FORCE.hierarchyYSpacing).toBeGreaterThan(0);
    expect(DEFAULT_FORCE.hierarchyYStrength).toBeGreaterThan(0);
    expect(DEFAULT_FORCE.hierarchyYStrength).toBeLessThan(1);
    expect(DEFAULT_FORCE.parentXStrength).toBeGreaterThan(0);
    expect(DEFAULT_FORCE.parentXStrength).toBeLessThan(1);
  });

  test("nodeHierarchy: tag / mention / language nodes get depth = -1", () => {
    // Non-hierarchical kinds float on the center force rather than
    // anchoring to a depth band.
    expect(source).toMatch(
      /if \(n\.kind === "tag" \|\| n\.kind === "mention" \|\| n\.kind === "language"\)/,
    );
    expect(source).toMatch(/return \{ depth: -1, parentId: null \}/);
  });

  test("nodeHierarchy: workspace root (folder id \"\") sits at depth 0, no parent", () => {
    expect(source).toMatch(/if \(n\.id === "" \|\| n\.path === ""\)/);
    expect(source).toMatch(/return \{ depth: 0, parentId: null \}/);
  });

  test("nodeHierarchy: folder depth + parentId derived from path segments", () => {
    expect(source).toMatch(
      /const segs = n\.path\.split\("\/"\)\.filter\(\(s\) => s\.length > 0\)/,
    );
    expect(source).toMatch(/const depth = segs\.length/);
    expect(source).toMatch(
      /const parentId = parentPath === ""[\s\S]*?\? ""[\s\S]*?: `directory:\$\{parentPath\}`/,
    );
  });

  test("nodeHierarchy: file depth = path segment count; parent is parent dir node id", () => {
    // File at "docs/foo.md" -> depth 2, parent "directory:docs".
    // File at "README.md" -> depth 1, parent "" (workspace root).
    expect(source).toMatch(/const filePath = n\.path \?\? ""/);
  });

  test("rebuildWorkingSet populates depth + parentId on every DNode", () => {
    // Both the existing-node branch (mutate-in-place) and the
    // fresh-node branch (construct) must propagate depth +
    // parentId so the forces see the current shape.
    expect(source).toMatch(
      /const \{ depth, parentId \} = nodeHierarchy\(n\)/,
    );
    expect(source).toMatch(/existing\.depth = depth/);
    expect(source).toMatch(/existing\.parentId = parentId/);
    expect(source).toMatch(/const fresh: DNode = \{[\s\S]*?depth, parentId/);
  });

  test("buildSim wires depth-aware forceY for hierarchical nodes", () => {
    // Hierarchical nodes (depth >= 0) target -depth * hierarchyYSpacing
    // so the spine grows up from the workspace root at the bottom.
    // Non-hierarchical nodes (depth < 0) fall back to centerStrength.
    expect(source).toMatch(
      /forceY<DNode>\(\(d\) => \{[\s\S]*?return -d\.depth \* force\.hierarchyYSpacing/,
    );
    expect(source).toMatch(
      /\.strength\(\(d\) =>[\s\S]*?d\.depth < 0 \? force\.centerStrength : force\.hierarchyYStrength/,
    );
  });

  test("buildSim registers the parentX force", () => {
    expect(source).toMatch(/\.force\("parentX", parentXForce\(force\.parentXStrength\)\)/);
  });

  test("parentXForce pulls each hierarchical node toward its parent's X", () => {
    expect(source).toMatch(/function parentXForce\(strength: number\)/);
    // Skip non-hierarchical nodes (depth < 0).
    expect(source).toMatch(/if \(node\.depth < 0\) continue/);
    // Skip nodes with no parent.
    expect(source).toMatch(/if \(node\.parentId === null\) continue/);
    // Skip parent that's not in the working set (filtered out).
    expect(source).toMatch(/if \(!parent \|\| parent\.x == null\) continue/);
    // Velocity push proportional to alpha + strength * (parent.x - node.x).
    expect(source).toMatch(
      /node\.vx = \(node\.vx \?\? 0\) \+ dx \* strength \* alpha/,
    );
  });

  test("parentXForce.initialize wires the node array per d3-force convention", () => {
    expect(source).toMatch(/force\.initialize = \(n: DNode\[\]\) => \{[\s\S]*?initialized = n/);
  });
});

describe("dblclick on a node = graph from here", () => {
  test("Props expose an optional onSetAsScope callback", () => {
    expect(source).toMatch(
      /type Props = \{[\s\S]{1,2000}onSetAsScope\?: \(\) => void;/,
    );
    expect(source).toMatch(
      /let \{[\s\S]{1,800}onSetAsScope,[\s\S]{0,160}\}: Props = \$props\(\);/,
    );
  });

  test("canvas element binds ondblclick to onDoubleClick", () => {
    expect(source).toMatch(/ondblclick=\{onDoubleClick\}/);
  });

  test("onDoubleClick picks at click-slack + invokes onSetAsScope when a node sits under the cursor", () => {
    // Mirrors onMouseUp's tap path: localCoords + pickNode at the wider
    // click slack. Empty-space dblclicks must NOT rescope.
    expect(source).toMatch(
      /function onDoubleClick\(e: MouseEvent\): void \{[\s\S]{1,200}const p = localCoords\(e\);[\s\S]{1,200}const n = pickNode\(p\.x, p\.y, PICK_SLACK_CLICK_PX\);[\s\S]{1,200}if \(n && onSetAsScope\) onSetAsScope\(\);/,
    );
  });
});

describe("focus-on-select spotlights the 1st-degree neighbourhood", () => {
  test("emphasis constants are defined", () => {
    expect(source).toMatch(/const EDGE_ALPHA = 0\.18;/);
    expect(source).toMatch(/const FOCUS_DIM_NODE = 0\./);
    expect(source).toMatch(/const FOCUS_DIM_EDGE = 0\./);
    expect(source).toMatch(/const FOCUS_LIT_EDGE = 0\./);
  });

  test("a selection defines the spotlight + an incident-edge test", () => {
    expect(source).toMatch(/const hasSelection = selectedId !== null;/);
    expect(source).toMatch(/const isIncidentEdge = \(e: DEdge\): boolean =>/);
    // Incident = either endpoint is the selected node.
    expect(source).toMatch(/return sId === selectedId \|\| tId === selectedId;/);
  });

  test("edges dim to FOCUS_DIM_EDGE under selection, then incident edges are relit", () => {
    // Base pass dims the whole graph when a node is selected; a second
    // pass redraws only the incident edges at full strength on top. Both
    // passes draw pre-grouped buckets: the grouping depends on the
    // selection and the working set but never on node positions, so it is
    // memoised in selectionPaint() rather than rebuilt per frame.
    expect(source).toMatch(
      /drawEdgeBuckets\(sel\.base, hasSelection \? FOCUS_DIM_EDGE : EDGE_ALPHA\);/,
    );
    expect(source).toMatch(
      /if \(hasSelection && sel\.lit\) \{\s*drawEdgeBuckets\(sel\.lit, FOCUS_LIT_EDGE\);\s*\}/,
    );
  });

  test("the lit overlay is exactly the incident + spine edges", () => {
    // The membership rule is unchanged by the memoisation: an edge is relit
    // when it touches the selection or lies on its containment spine.
    expect(source).toMatch(
      /bucketEdges\(\s*visibleEdgeRefs\.filter\(\(e\) => isIncidentEdge\(e\) \|\| isSpineEdge\(e\)\),\s*\)/,
    );
  });

  test("selection-derived paint inputs are memoised on working set + selection", () => {
    // Guards the fix for the post-click stall: recomputing the spine walk,
    // the incident scan and the edge bucketing on every frame made a
    // selected node cost more to draw the larger the graph got.
    expect(source).toMatch(/let workingSetRev = 0;/);
    expect(source).toMatch(
      /paintCache\s*&& paintCache\.rev === workingSetRev\s*&& paintCache\.selected === selectedId/,
    );
  });

  test("non-neighbour nodes (outside the selection + spine) fade to FOCUS_DIM_NODE", () => {
    expect(source).toMatch(
      /const isDimmed = hasSelection && !isSel && !isAdj && !spine\.nodes\.has\(n\.id\);/,
    );
    expect(source).toMatch(/let baseAlpha = isDimmed \? FOCUS_DIM_NODE : 1;/);
  });

  test("a directory-tree selection lights its full containment spine", () => {
    // The spine (parent chain to the workspace root) joins the lit node
    // and edge sets; the walk itself is covered by
    // graph/containmentSpine.test.ts.
    expect(source).toMatch(/containmentSpine\(selectedId, containsParent\)/);
    expect(source).toMatch(/const isSpineEdge = \(e: DEdge\): boolean =>/);
    expect(source).toMatch(
      /if \(e\.kind === "contains"\) containsParent\.set\(e\.target, e\.source\)/,
    );
  });

  test("selection, 1st-degree neighbours, and spine directories get labels", () => {
    // Labels draw for the selection, its 1st-degree neighbours, and the
    // containment spine directories on the path to root, so the focus
    // spotlight stays readable and the path home reads by name.
    expect(source).toMatch(/if \(isSel \|\| isAdj \|\| spine\.nodes\.has\(n\.id\)\) \{/);
  });
});
