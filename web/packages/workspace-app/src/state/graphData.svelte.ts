// Shared lazy-loaded graph view, used by both GraphPanel (canvas)
// and FileInfoBody (browser inspector references). One network call
// per cached view; both consumers read the same payload.
//
// The graph is small per chan (a single workspace's wiki/tag/mention
// edges), so caching the whole thing is cheaper than per-file
// metadata round-trips. A burst of watcher events refetches it once,
// after the burst, so a freshly-saved tag shows up in the inspector
// without a manual reload. Index readiness invalidates a view fetched
// while the graph route answered empty during recovery. A graph
// answer marked gated also waits for the next idle index-status poll.

import { api } from "../api/client";
import type { GraphView, GraphViewEdge, GraphViewNode } from "../api/types";

type GraphState = {
  view: GraphView | null;
  loading: boolean;
  error: string | null;
  gated: boolean;
};

export const graphData = $state<GraphState>({
  view: null,
  loading: false,
  error: null,
  gated: false,
});

let inflight: Promise<void> | null = null;
let inflightAbort: AbortController | null = null;
let inflightSeq = 0;
// True while the view is a first load's accumulation that no stream has
// completed, as after that load fails: the next load streams afresh instead of
// refreshing it as complete.
let viewPartial = false;

/// A burst of filesystem changes ends when this long passes with no change;
/// the graph is then fetched once. GraphPanel's own reload and the file
/// tree's watch relists keep the same step.
export const GRAPH_QUIET_MS = 250;
/// A stream that delivers no event for this long is aborted as stalled and
/// fails, so a fetch the burst's end waits on always ends. It must outlast
/// the route's quiet gap between its `meta` event and its first batch, which
/// on a large workspace is the server's whole graph build.
export const GRAPH_STALL_MS = 30_000;

let quietTimer: ReturnType<typeof setTimeout> | null = null;
let quietOpen: (() => boolean) | null = null;
// Moves on every explicit invalidation, so a burst's end that is waiting on
// a fetch in flight learns that its fetch is no longer wanted.
let changeEpoch = 0;
// Each burst's end takes a number; of two ends waiting on one fetch, only the
// later goes on after it.
let settleSeq = 0;

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
  return loadGraph();
}

/// One stream of `/api/graph`. Over a complete view it is a refresh, which
/// keeps that view on screen and replaces it once, when the answer completes,
/// or keeps it and sets `error` when the stream fails. Otherwise it is a first
/// load, which publishes the view as it streams; one that fails keeps what it
/// streamed, so a surface's drop effect does not start it again.
function loadGraph(): Promise<void> {
  const mode = graphData.view !== null && !viewPartial ? "refresh" : "first";
  const seq = ++inflightSeq;
  const abort = new AbortController();
  inflightAbort = abort;
  graphData.loading = true;
  if (mode === "first") graphData.error = null;
  let stalled = false;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const progress = () => {
    if (stallTimer !== null) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      abort.abort();
    }, GRAPH_STALL_MS);
  };
  progress();
  inflight = (async () => {
    try {
      let gated = false;
      if (mode === "first") {
        graphData.view = { nodes: [], edges: [] };
        viewPartial = true;
      }
      const view = await api.graphStream(
        {},
        {
          signal: abort.signal,
          onMeta(meta) {
            progress();
            if (seq !== inflightSeq) return;
            gated = meta.gated === true;
          },
          // graphStream passes the view it has accumulated so far.
          onNodes(_nodes, view) {
            progress();
            if (seq !== inflightSeq || mode === "refresh") return;
            publishGraphView(view);
          },
          onEdges(_edges, view) {
            progress();
            if (seq !== inflightSeq || mode === "refresh") return;
            publishGraphView(view);
          },
          onDone() {
            progress();
          },
        },
      );
      // A load an invalidate dropped publishes nothing over the drop.
      if (seq === inflightSeq) {
        graphData.view = view;
        viewPartial = false;
        graphData.gated = gated;
        graphData.error = null;
      }
    } catch (e) {
      if (seq === inflightSeq && (stalled || (e as DOMException).name !== "AbortError")) {
        graphData.error = stalled
          ? `the graph stream sent nothing for ${GRAPH_STALL_MS / 1000} s`
          : (e as Error).message;
      }
    } finally {
      if (stallTimer !== null) clearTimeout(stallTimer);
      if (seq === inflightSeq) {
        graphData.loading = false;
        inflightAbort = null;
        inflight = null;
      }
    }
  })();
  return inflight;
}

/// A filesystem change that can move what the graph holds. The cached view
/// stays on screen and nothing in flight is aborted; when GRAPH_QUIET_MS pass
/// with no further change, the burst's end waits for any fetch in flight
/// (it began before the last change) and then, if `open()` still says a
/// surface shows the graph, fetches it once. With none open it drops the
/// view, so the next surface fetches it.
export function noteGraphChanged(open: () => boolean): void {
  quietOpen = open;
  if (quietTimer !== null) clearTimeout(quietTimer);
  quietTimer = setTimeout(() => {
    quietTimer = null;
    void settleGraphChange();
  }, GRAPH_QUIET_MS);
}

async function settleGraphChange(): Promise<void> {
  const epoch = changeEpoch;
  const mine = ++settleSeq;
  // Wait out every fetch in flight, a surface's own load included; a fetch
  // that settles leaves `inflight` to the next one or to null.
  for (let pending = inflight; pending !== null; pending = inflight === pending ? null : inflight) {
    await pending;
  }
  // A newer change re-armed the window, or a later end waits on the same
  // fetch, and that end settles the burst; an explicit invalidation took the
  // burst over.
  if (quietTimer !== null || mine !== settleSeq || epoch !== changeEpoch) return;
  const open = quietOpen;
  quietOpen = null;
  if (!open?.()) {
    invalidateGraph();
    return;
  }
  void loadGraph();
}

/// Forget a burst whose end has not come, so it fetches nothing.
export function cancelGraphRefresh(): void {
  changeEpoch += 1;
  if (quietTimer !== null) clearTimeout(quietTimer);
  quietTimer = null;
  quietOpen = null;
}

/// Drop the cached graph so the next `ensureGraphLoaded` (or
/// `reloadGraph`) re-fetches, and forget a burst whose end has not come.
/// Called at a burst's end with no surface open and when index recovery
/// finishes or a gated answer reaches an idle poll.
export function invalidateGraph(): void {
  cancelGraphRefresh();
  inflightSeq++;
  inflightAbort?.abort();
  inflightAbort = null;
  inflight = null;
  graphData.view = null;
  graphData.error = null;
  graphData.gated = false;
  // The dropped load's own finally skips it as stale.
  graphData.loading = false;
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
