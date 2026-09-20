// Shared lazy-loaded graph view, used by both GraphPanel (canvas)
// and FileInfoBody (browser inspector references). One network call
// per session-or-watch-event; both consumers read the same payload.
//
// The graph is small per chan (a single workspace's wiki/tag/mention
// edges), so caching the whole thing is cheaper than per-file
// metadata round-trips. Watcher events invalidate the cache so a
// freshly-saved tag shows up in the inspector without a manual
// reload.

import { api } from "../api/client";
import type { GraphView, GraphViewEdge, GraphViewNode } from "../api/types";

type GraphState = {
  view: GraphView | null;
  loading: boolean;
  error: string | null;
};

export const graphData = $state<GraphState>({
  view: null,
  loading: false,
  error: null,
});

let inflight: Promise<void> | null = null;
let inflightAbort: AbortController | null = null;
let inflightSeq = 0;

function edgeKey(e: GraphViewEdge): string {
  return `${e.source}\u0000${e.target}\u0000${e.kind}\u0000${e.rank ?? ""}`;
}

function publishGraphView(view: GraphView): void {
  graphData.view = {
    nodes: [...view.nodes],
    edges: [...view.edges],
  };
}

/// Fetch the graph if we don't already have it. Idempotent;
/// concurrent callers share a single network round-trip. After a
/// successful fetch (or a cached hit) the promise resolves; on
/// failure `graphData.error` is set and the promise still resolves
/// (consumers should branch on `graphData.view`).
export function ensureGraphLoaded(): Promise<void> {
  if (graphData.view && !graphData.error) return Promise.resolve();
  if (inflight) return inflight;
  const seq = ++inflightSeq;
  inflightAbort = new AbortController();
  graphData.loading = true;
  graphData.error = null;
  inflight = (async () => {
    try {
      const nodesById = new Map<string, GraphViewNode>();
      const edgesByKey = new Map<string, GraphViewEdge>();
      const view = (): GraphView => ({
        nodes: [...nodesById.values()],
        edges: [...edgesByKey.values()],
      });
      graphData.view = { nodes: [], edges: [] };
      graphData.view = await api.graphStream(
        {},
        {
          signal: inflightAbort?.signal,
          onNodes(nodes) {
            if (seq !== inflightSeq) return;
            for (const node of nodes) nodesById.set(node.id, node);
            publishGraphView(view());
          },
          onEdges(edges) {
            if (seq !== inflightSeq) return;
            for (const edge of edges) edgesByKey.set(edgeKey(edge), edge);
            publishGraphView(view());
          },
        },
      );
    } catch (e) {
      if (seq === inflightSeq && (e as DOMException).name !== "AbortError") {
        graphData.error = (e as Error).message;
      }
    } finally {
      if (seq === inflightSeq) {
        graphData.loading = false;
        inflightAbort = null;
        inflight = null;
      }
    }
  })();
  return inflight;
}

/// Drop the cached graph so the next `ensureGraphLoaded` (or
/// `reloadGraph`) re-fetches. Called from the watcher on filesystem
/// events.
export function invalidateGraph(): void {
  inflightSeq++;
  inflightAbort?.abort();
  inflightAbort = null;
  inflight = null;
  graphData.view = null;
  graphData.error = null;
}

/// Re-fetch unconditionally. Useful when we know the payload is
/// stale (after `invalidateGraph`) and a consumer is currently
/// looking at it.
export function reloadGraph(): Promise<void> {
  invalidateGraph();
  return ensureGraphLoaded();
}

/// Outgoing-edge groupings for a file path. Returns
/// empty arrays if the graph hasn't loaded yet or the file has no
/// node in the graph (e.g. non-markdown files).
export function selectionEdgesFor(path: string): {
  tags: GraphViewNode[];
  mentions: GraphViewNode[];
  dates: GraphViewNode[];
  links: GraphViewNode[];
} {
  const out = {
    tags: [] as GraphViewNode[],
    mentions: [] as GraphViewNode[],
    dates: [] as GraphViewNode[],
    links: [] as GraphViewNode[],
  };
  const view = graphData.view;
  if (!view) return out;
  const fileNode = view.nodes.find(
    (n) => n.kind === "file" && n.path === path,
  );
  if (!fileNode) return out;
  const nodeById = new Map(view.nodes.map((n) => [n.id, n]));
  // One bucket entry per target node, not per edge. The edges table's key is
  // (src, dst, kind, anchor), so a document that links one target twice, or
  // carries one tag twice, sends two edges to the same node; the consumer keys
  // these lists on the node id, where a repeat is a duplicate Svelte key.
  const seen = new Set<string>();
  for (const e of view.edges) {
    if (e.source !== fileNode.id) continue;
    const target = nodeById.get(e.target);
    if (!target) continue;
    const bucket =
      e.kind === "tag"
        ? out.tags
        : e.kind === "mention"
          ? out.mentions
          : e.kind === "date"
            ? out.dates
            : e.kind === "link"
              ? out.links
              : null;
    if (!bucket) continue;
    const key = `${e.kind}\u0000${target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bucket.push(target);
  }
  return out;
}

/// Documents that reference the given non-file node (a tag /
/// mention / date). Mirrors the inline lookup that GraphPanel does
/// for its tag-node inspector branch but reads the global graph
/// store, so the search overlay can use the same data without
/// having to render the whole canvas first.
///
/// Returns an empty array when the graph isn't loaded yet or the
/// node id doesn't exist (the typical "tag was deleted between
/// search hit and click" case).
export function documentsReferencing(nodeId: string): GraphViewNode[] {
  const view = graphData.view;
  if (!view) return [];
  const target = view.nodes.find((n) => n.id === nodeId);
  if (!target) return [];
  const nodeById = new Map(view.nodes.map((n) => [n.id, n]));
  const out: GraphViewNode[] = [];
  for (const e of view.edges) {
    if (e.target !== nodeId) continue;
    const src = nodeById.get(e.source);
    if (src && src.kind === "file") out.push(src);
  }
  return out;
}

/// Re-export so consumers don't need a second import.
export type { GraphViewEdge, GraphViewNode };
