// The shared graph as a tab draws it: one drawn graph per view, and a tab's
// spine laid under it.

import { expect, test } from "vitest";

import type { GraphView, GraphViewEdge, GraphViewNode } from "../api/types";
import type { CanvasEdge, CanvasNode } from "./canvasNodes";
import { NO_GRAPH, drawnGraph, withSpine, type DrawnGraph } from "./sharedGraph";

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
