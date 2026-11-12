// The shared graph as a tab draws it: one drawn graph per view, a tab's
// spine laid under it, and the part of it a hidden tab keeps.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import type { GraphView, GraphViewEdge, GraphViewNode } from "../api/types";
import type { CanvasEdge, CanvasNode } from "./canvasNodes";
import { graphNodeIds, type Opened } from "./selectionView";
import { NO_GRAPH, drawnGraph, drawnPart, withSpine, type DrawnGraph } from "./sharedGraph";

const file = (path: string): GraphViewNode => ({ kind: "file", id: path, label: path, path });
const dir = (path: string): GraphViewNode => ({
  kind: "directory",
  id: path === "" ? "" : `directory:${path}`,
  label: path,
  path,
  files: 2,
  code: 7,
});
const edge = (source: string, target: string, kind: GraphViewEdge["kind"]): GraphViewEdge => ({
  source,
  target,
  kind,
});

const folder = (path: string): CanvasNode => ({
  kind: "folder",
  id: path === "" ? "" : `directory:${path}`,
  label: `${path || "workspace"}/`,
  path,
  files: 0,
  code: 0,
});
const spineFile = (path: string): CanvasNode => ({ kind: "file", id: path, label: path, path });
const spineEdge = (source: string, target: string, kind: CanvasEdge["kind"]): CanvasEdge => ({
  source,
  target,
  kind,
});

function view(): GraphView {
  return {
    nodes: [dir(""), dir("notes"), file("notes/a.md"), { kind: "tag", id: "#t", label: "#t" }],
    edges: [
      edge("", "directory:notes", "contains"),
      edge("directory:notes", "notes/a.md", "contains"),
      edge("notes/a.md", "#t", "tag"),
    ],
  };
}

test("a view is drawn once: asking again answers the same graph", () => {
  const v = view();
  expect(drawnGraph(v)).toBe(drawnGraph(v));
  expect(drawnGraph(view()), "another view, another graph").not.toBe(drawnGraph(v));
});

test("a file, a tag, a mention and a language are drawn as the view's own objects", () => {
  const v = view();
  const { nodes, edges } = drawnGraph(v);
  expect(nodes[2]).toBe(v.nodes[2]);
  expect(nodes[3]).toBe(v.nodes[3]);
  expect(edges[0]).toBe(v.edges[0]);
});

test("a directory is drawn as a folder, a media file as a file, and a date not at all", () => {
  const v: GraphView = {
    nodes: [
      dir(""),
      dir("img"),
      { kind: "media", id: "img/a.png", label: "a.png", path: "img/a.png", missing: true },
      { kind: "date", id: "date:2026-01-01", label: "2026-01-01" } as GraphViewNode,
    ],
    edges: [edge("img/a.png", "date:2026-01-01", "date"), edge("directory:img", "img/a.png", "contains")],
  };
  const { nodes, edges } = drawnGraph(v);
  expect(nodes).toEqual([
    { kind: "folder", id: "", label: "workspace/", path: "", files: 2, code: 7 },
    { kind: "folder", id: "directory:img", label: "img/", path: "img", files: 2, code: 7 },
    { kind: "file", id: "img/a.png", label: "a.png", path: "img/a.png", missing: true },
  ]);
  expect(edges).toEqual([edge("directory:img", "img/a.png", "contains")]);
});

test("a spine with nothing of its own adds nothing: the shared graph is answered itself", () => {
  const v = view();
  const spine: DrawnGraph = {
    nodes: [folder(""), folder("notes")],
    edges: [spineEdge("", "directory:notes", "contains")],
  };
  expect(withSpine(spine, v)).toBe(drawnGraph(v));
  expect(withSpine(NO_GRAPH, v)).toBe(drawnGraph(v));
});

test("what only the spine carries follows the shared graph, whose nodes and edges win a collision", () => {
  const v = view();
  const docs = folder("docs");
  const ghost = spineFile("outside:notes/link");
  const toDocs = spineEdge("", "directory:docs", "contains");
  const symlink = spineEdge("notes/a.md", "outside:notes/link", "symlink");
  const spine: DrawnGraph = {
    nodes: [folder(""), folder("notes"), docs, ghost],
    edges: [spineEdge("", "directory:notes", "contains"), toDocs, symlink],
  };
  const shared = drawnGraph(v);
  const merged = withSpine(spine, v);

  expect(merged.nodes).toEqual([...shared.nodes, docs, ghost]);
  expect(merged.nodes[0], "the shared root, with its counts").toBe(shared.nodes[0]);
  expect(merged.nodes.slice(-2).map((n) => n === docs || n === ghost)).toEqual([true, true]);
  expect(merged.edges).toEqual([...shared.edges, toDocs, symlink]);
  expect(merged.edges[0]).toBe(shared.edges[0]);
});

test("spine edges alone leave the shared nodes as they are", () => {
  const v = view();
  const hardlink = spineEdge("notes/a.md", "notes/a.md", "hardlink");
  const merged = withSpine({ nodes: [folder("")], edges: [hardlink] }, v);
  expect(merged.nodes).toBe(drawnGraph(v).nodes);
  expect(merged.edges).toEqual([...drawnGraph(v).edges, hardlink]);
});

test("with no shared view the spine is the graph", () => {
  const spine: DrawnGraph = { nodes: [folder("")], edges: [] };
  expect(withSpine(spine, null)).toBe(spine);
  expect(withSpine(NO_GRAPH, null)).toBe(NO_GRAPH);
});

test("under an empty view, as an index that cannot answer gives, the spine is drawn whole", () => {
  const spine: DrawnGraph = {
    nodes: [folder(""), folder("notes")],
    edges: [spineEdge("", "directory:notes", "contains")],
  };
  const merged = withSpine(spine, { nodes: [], edges: [] });
  expect(merged.nodes).toEqual(spine.nodes);
  expect(merged.edges).toEqual(spine.edges);
});

describe("the part of the graph a tab draws from", () => {
  // The workspace-search fixture's graph, as the canvas takes it: a tree
  // three levels deep, links between its notes, tags, a mention and
  // languages.
  const fixture = JSON.parse(
    readFileSync("../../../fixtures/workspace-search/graph.json", "utf8"),
  ) as { nodes: Array<{ id: string; kind: string }>; edges: CanvasEdge[] };
  const whole: DrawnGraph = {
    nodes: fixture.nodes.map((n) =>
      n.kind === "folder"
        ? folder(n.id.replace(/^directory:/, ""))
        : n.kind === "file"
          ? spineFile(n.id)
          : ({ kind: n.kind, id: n.id, label: n.id } as CanvasNode),
    ),
    edges: fixture.edges,
  };
  const isTree = (n: CanvasNode) => n.kind === "file" || n.kind === "folder";

  /// What is drawn from `graph`: the included files and folders, and the
  /// edges between two included nodes with the nodes they reach, which is
  /// what the panel's chips start from.
  function drawn(graph: DrawnGraph, opened: Opened, selectedId: string | null, depth: number) {
    const included = graphNodeIds({ ...graph, opened, selectedId, depth });
    const edges = graph.edges.filter((e) => included.has(e.source) && included.has(e.target));
    const ids = new Set(graph.nodes.filter((n) => isTree(n) && included.has(n.id)).map((n) => n.id));
    for (const e of edges) {
      ids.add(e.source);
      ids.add(e.target);
    }
    return {
      included,
      ids: [...ids].sort(),
      edges: edges.map((e) => `${e.source} ${e.kind} ${e.target}`).sort(),
    };
  }

  const openings: Opened[] = [
    { "": true },
    { "": true, docs: true },
    { "": true, docs: true, "docs/nested": true, contacts: true },
  ];
  const selections = [null, "", "directory:docs/nested", "docs/start.md", "contacts/alice.md", "#shared", "@@unresolved", "language:Markdown"];

  test("draws the same nodes and edges as the whole graph, for every selection, depth and opened tree", () => {
    let smaller = 0;
    for (const opened of openings) {
      for (const selectedId of selections) {
        for (const depth of [1, 2, 3]) {
          const from = drawn(whole, opened, selectedId, depth);
          const part = drawnPart(whole, from.included, selectedId);
          const again = drawn(part, opened, selectedId, depth);
          const where = `${JSON.stringify(Object.keys(opened))} ${selectedId} depth ${depth}`;
          expect(again.ids, `nodes: ${where}`).toEqual(from.ids);
          expect(again.edges, `edges: ${where}`).toEqual(from.edges);
          if (part.nodes.length < whole.nodes.length) smaller += 1;
        }
      }
    }
    expect(smaller, "the part is a part").toBeGreaterThan(openings.length * selections.length);
  });

  test("holds the drawn files and folders, the edges between included nodes and the meta nodes they reach", () => {
    const from = drawn(whole, { "": true }, "docs/start.md", 1);
    const part = drawnPart(whole, from.included, "docs/start.md");
    expect(part.nodes.map((n) => n.id).sort()).toEqual(from.ids);
    expect(part.nodes.every((n) => whole.nodes.includes(n)), "the graph's own node objects").toBe(true);
    expect(part.edges.every((e) => whole.edges.includes(e))).toBe(true);
    expect(part.nodes.map((n) => n.id)).not.toContain("#deep");
  });

  test("keeps a selected tag no file of the part carries", () => {
    const lonely: DrawnGraph = {
      nodes: [...whole.nodes, { kind: "tag", id: "#lonely", label: "#lonely" }],
      edges: whole.edges,
    };
    const from = drawn(lonely, { "": true }, "#lonely", 1);
    expect(drawnPart(lonely, from.included, "#lonely").nodes.map((n) => n.id)).toContain("#lonely");
  });
});
