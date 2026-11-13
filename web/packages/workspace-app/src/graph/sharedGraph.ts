// The window's shared graph as a graph tab draws it.
//
// Every graph tab reads the one view `state/graphData` holds. `drawnGraph`
// turns a view into the canvas's nodes and edges once, however many tabs
// read it, so the tabs of a window hold the same node and edge objects.
// `withSpine` lays that graph over a tab's own filesystem spine, which is
// the tree as deep as the tab has it opened, read straight from disk.
// `drawnPart` is what a hidden tab keeps of it once the window's graph has
// moved on.

import type { GraphView, GraphViewEdge, GraphViewNode } from "../api/types";
import type { CanvasEdge, CanvasNode } from "./canvasNodes";

export type DrawnGraph = { nodes: CanvasNode[]; edges: CanvasEdge[] };

/// The graph with nothing in it. One object, so a reader can tell "nothing
/// yet" by identity.
export const NO_GRAPH: DrawnGraph = { nodes: [], edges: [] };

/// What makes two edges one edge: the graph stream keys its edges the same
/// way, so an edge the spine and the stream both carry is drawn once.
export function graphEdgeKey(e: Pick<GraphViewEdge, "source" | "target" | "kind" | "rank">): string {
  return `${e.source}\u0000${e.target}\u0000${e.kind}\u0000${e.rank ?? ""}`;
}

/// The wire's node as the canvas takes it, or null for a kind the graph
/// does not draw (`date`). A media file is a file, and a directory is a
/// folder whose label ends in a slash.
function canvasNode(n: GraphViewNode): CanvasNode | null {
  if (n.kind === "file" || n.kind === "tag" || n.kind === "mention" || n.kind === "language") {
    return n;
  }
  if (n.kind === "media") {
    return { kind: "file", id: n.id, label: n.label, path: n.path, missing: n.missing };
  }
  if (n.kind === "directory") {
    return {
      kind: "folder",
      id: n.id,
      label: `${n.label || "workspace"}/`,
      path: n.path,
      files: n.files,
      code: n.code,
    };
  }
  return null;
}

type Drawn = {
  graph: DrawnGraph;
  /// Built when a spine is first laid under this view.
  nodeIds?: Set<string>;
  edgeKeys?: Set<string>;
};

// Keyed on the view object: the store replaces its view whole, so a new
// view is a new key and a dropped one takes its drawn graph with it.
const drawnByView = new WeakMap<GraphView, Drawn>();

function drawn(view: GraphView): Drawn {
  let d = drawnByView.get(view);
  if (!d) {
    const nodes: CanvasNode[] = [];
    for (const n of view.nodes) {
      const node = canvasNode(n);
      if (node) nodes.push(node);
    }
    // Every edge kind but `date` is one the canvas draws.
    const edges = view.edges.filter((e): e is CanvasEdge => e.kind !== "date");
    d = { graph: { nodes, edges } };
    drawnByView.set(view, d);
  }
  return d;
}

/// The canvas's nodes and edges for a view of the shared graph. Asking
/// again for the same view answers the same object.
export function drawnGraph(view: GraphView): DrawnGraph {
  return drawn(view).graph;
}

/// The shared graph laid over a tab's spine. A node or an edge both carry is
/// the shared graph's, which knows more of it; what only the spine carries
/// follows. With nothing of the spine's own to add, the answer is the
/// shared graph itself, so a tab holds no arrays of its own.
export function withSpine(spine: DrawnGraph, view: GraphView | null): DrawnGraph {
  if (view === null) return spine;
  const shared = drawn(view);
  if (spine.nodes.length === 0 && spine.edges.length === 0) return shared.graph;
  const nodeIds = (shared.nodeIds ??= new Set(shared.graph.nodes.map((n) => n.id)));
  const edgeKeys = (shared.edgeKeys ??= new Set(shared.graph.edges.map(graphEdgeKey)));
  const nodes = spine.nodes.filter((n) => !nodeIds.has(n.id));
  const edges = spine.edges.filter((e) => !edgeKeys.has(graphEdgeKey(e)));
  if (nodes.length === 0 && edges.length === 0) return shared.graph;
  return {
    nodes: nodes.length === 0 ? shared.graph.nodes : [...shared.graph.nodes, ...nodes],
    edges: edges.length === 0 ? shared.graph.edges : [...shared.graph.edges, ...edges],
  };
}

/// The part of `graph` a tab draws from, given the ids the graph includes
/// before the filter chips (`selectionView.graphNodeIds`): the included
/// files and folders, every edge between two included nodes, and the tags,
/// mentions and languages those edges reach, with the selected node. The
/// rules that choose what is drawn read no more than this, so over the part
/// they choose the same nodes and edges as over the whole graph. A hidden
/// tab keeps it in place of the view it took.
export function drawnPart(
  graph: DrawnGraph,
  included: ReadonlySet<string>,
  selectedId: string | null,
): DrawnGraph {
  const edges = graph.edges.filter((e) => included.has(e.source) && included.has(e.target));
  const reached = new Set<string>();
  for (const e of edges) {
    reached.add(e.source);
    reached.add(e.target);
  }
  const nodes = graph.nodes.filter((n) =>
    n.kind === "file" || n.kind === "folder"
      ? included.has(n.id)
      : reached.has(n.id) || n.id === selectedId,
  );
  return { nodes, edges };
}
