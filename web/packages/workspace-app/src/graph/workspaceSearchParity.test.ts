// The graph and the workspace search answer one question the same way: what
// does this node show? `fixtures/workspace-search` holds a small workspace,
// its graph as the app loads it (graph.json), and for each kind of node, at
// depths 0 to 2, the nodes and relationships the answer holds
// (expected.json). This test holds the app's rules (graph/selectionView) to
// it; `crates/chan-workspace/tests/workspace_search_golden.rs` indexes the
// same workspace and holds `Workspace::workspace_search` to it.
//
// The answer, as the search states it and the graph draws it:
//   - a file, tag, mention or contact: `depth` hops of references (links,
//     tags, mentions) in both directions;
//   - a language: its files, one hop whatever the depth;
//   - a directory: the files and directories `depth` levels below it;
//   - every file reached comes with its tags, mentions and language, and
//     every node with its directories up to the root;
//   - depth 0: the node alone, with its directories;
//   - the relationships are every one the graph holds between those nodes.
//
// The two sides differ in one place, on purpose: the graph's selection also
// walks a symlink to its target and a file to its other names (the `symlink`
// and `hardlink` edges, graph/selectionView), which come from a walk of the
// filesystem, and the search has no such relationship to walk (its
// `WorkspaceRelationshipKind`). The golden therefore holds neither edge, and
// the first test below fails when one is added to it.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { ancestorClosure } from "./containmentSpine";
import { ancestorsExpanded } from "./pathVisibility";
import { openBelow, selectionReveal, type ViewEdge, type ViewNode } from "./selectionView";

type GraphFixture = { nodes: ViewNode[]; edges: Array<ViewEdge & { kind: string }> };
type ExpectedCase = {
  kind: "file" | "directory" | "tag" | "mention" | "contact" | "language";
  depth: number;
  seed: string;
  visible_node_ids: string[];
  relationship_keys: string[];
};

const fixtureRoot = "../../../fixtures/workspace-search";
const fixtureGraph = JSON.parse(readFileSync(`${fixtureRoot}/graph.json`, "utf8")) as {
  nodes: Array<{ id: string; kind: string }>;
  edges: GraphFixture["edges"];
};
const expected = JSON.parse(readFileSync(`${fixtureRoot}/expected.json`, "utf8")) as {
  cases: ExpectedCase[];
};

/// The fixture names a file and a folder by id alone. The app's nodes carry
/// the path: a file's id is its path, a folder's is `directory:<path>`, and
/// the root's is "".
const graph: GraphFixture = {
  nodes: fixtureGraph.nodes.map((n) =>
    n.kind === "folder"
      ? { id: n.id, kind: "folder", path: n.id.replace(/^directory:/, "") }
      : n.kind === "file"
        ? { id: n.id, kind: "file", path: n.id }
        : { id: n.id, kind: n.kind },
  ),
  edges: fixtureGraph.edges,
};

const META_KINDS = new Set(["tag", "mention", "language"]);
const metaIds = new Set(graph.nodes.filter((n) => META_KINDS.has(n.kind)).map((n) => n.id));

/// The node ids the graph shows for `seed` at `depth`, with nothing of the
/// tree opened but what the node itself opens.
function shown(seed: string, depth: number): Set<string> {
  const node = graph.nodes.find((n) => n.id === seed);
  if (!node) throw new Error(`the fixture graph has no node ${seed}`);
  const ids = new Set<string>([seed]);
  if (depth > 0 && node.kind === "folder") {
    // A directory's depth opens that many levels of the tree below it.
    const dir = node.path!;
    const opened = openBelow(graph.nodes, { "": true }, dir, depth);
    for (const n of graph.nodes) {
      if (n.path !== undefined && n.path.startsWith(`${dir}/`) && ancestorsExpanded(dir, n.path, opened)) {
        ids.add(n.id);
      }
    }
  } else if (depth > 0) {
    for (const id of selectionReveal(graph.nodes, graph.edges, seed, depth)) ids.add(id);
  }
  if (depth > 0) {
    // A tag, mention or language is drawn wherever an edge joins it to a
    // file that is. A mention that resolves to a contact is an edge to the
    // contact's file, which is drawn only when the walk reaches it.
    const files = new Set(graph.nodes.filter((n) => n.kind === "file" && ids.has(n.id)).map((n) => n.id));
    for (const e of graph.edges) {
      if (files.has(e.source) && metaIds.has(e.target)) ids.add(e.target);
      if (files.has(e.target) && metaIds.has(e.source)) ids.add(e.source);
    }
  }
  ancestorClosure(ids, graph.edges);
  return ids;
}

describe("the graph and the workspace search show the same for a node", () => {
  // Only the graph walks these; a golden holding one would hold the two
  // sides to answers they are meant to differ on.
  test("the golden holds no symlink or hardlink edge", () => {
    expect(graph.edges.filter((e) => e.kind === "symlink" || e.kind === "hardlink")).toEqual([]);
  });

  test("the golden pins all 18 kind x depth cases", () => {
    expect(expected.cases.length).toBe(18);
    expect(new Set(expected.cases.map((c) => `${c.kind}:${c.depth}`)).size).toBe(18);
  });

  for (const golden of expected.cases) {
    test(`${golden.kind} ${golden.seed} at depth ${golden.depth}`, () => {
      const ids = shown(golden.seed, golden.depth);
      const relationshipKeys = graph.edges
        .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
        .map((edge) => JSON.stringify([edge.source, edge.target, edge.kind]))
        .sort();
      expect([...ids].sort()).toEqual(golden.visible_node_ids);
      expect(relationshipKeys).toEqual(golden.relationship_keys);
    });
  }
});
