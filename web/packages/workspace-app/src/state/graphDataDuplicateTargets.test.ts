// The server keeps two edges that differ only by anchor or kind: the edges
// table's key is (src, dst, kind, anchor), asserted by
// `replace_file_keeps_two_anchors_to_the_same_target` in
// crates/chan-workspace/src/graph.rs. A document that links one target twice
// therefore reaches the frontend as two edges to the same node.
//
// selectionEdgesFor turns edges into target NODES, and FileInfoBody keys the
// lists it returns on the node id. Two edges to one target must not become two
// entries, or the keyed `{#each}` throws each_key_duplicate and the section is
// dead until the inspector is reopened.

import { describe, expect, test, beforeEach } from "vitest";
import { graphData, selectionEdgesFor } from "./graphData.svelte";
import type { GraphView } from "../api/types";

function fileNode(id: string, path: string) {
  return { kind: "file" as const, id, label: path, path };
}

function view(): GraphView {
  return {
    nodes: [
      fileNode("f:a.md", "a.md"),
      fileNode("f:b.md", "b.md"),
      { kind: "tag" as const, id: "#t", label: "#t" },
    ],
    edges: [],
  };
}

beforeEach(() => {
  graphData.view = null;
});

describe("selectionEdgesFor deduplicates targets", () => {
  test("a target linked twice from one document lists once", () => {
    const v = view();
    // Two link edges, same source and target, differing only by rank. Both
    // survive the loader's edgesByKey dedupe, whose key carries rank.
    v.edges = [
      { source: "f:a.md", target: "f:b.md", kind: "link", rank: 1 },
      { source: "f:a.md", target: "f:b.md", kind: "link", rank: 2 },
    ];
    graphData.view = v;

    const links = selectionEdgesFor("a.md").links;
    const ids = links.map((n) => n.id);
    expect(new Set(ids).size, `duplicate keys would throw each_key_duplicate: ${ids}`).toBe(
      ids.length,
    );
    expect(ids).toEqual(["f:b.md"]);
  });

  test("a tag applied twice lists once", () => {
    const v = view();
    v.edges = [
      { source: "f:a.md", target: "#t", kind: "tag", rank: 1 },
      { source: "f:a.md", target: "#t", kind: "tag", rank: 2 },
    ];
    graphData.view = v;

    const ids = selectionEdgesFor("a.md").tags.map((n) => n.id);
    expect(new Set(ids).size, `duplicate keys: ${ids}`).toBe(ids.length);
  });

  test("distinct targets still all list", () => {
    const v = view();
    v.edges = [
      { source: "f:a.md", target: "f:b.md", kind: "link", rank: 1 },
      { source: "f:a.md", target: "#t", kind: "tag", rank: 1 },
    ];
    graphData.view = v;

    const out = selectionEdgesFor("a.md");
    expect(out.links.map((n) => n.id)).toEqual(["f:b.md"]);
    expect(out.tags.map((n) => n.id)).toEqual(["#t"]);
  });
});
