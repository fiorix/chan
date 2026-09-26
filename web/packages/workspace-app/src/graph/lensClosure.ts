import { ancestorClosure } from "./containmentSpine";

/// Structural node / edge shapes the lens closure needs. GraphPanel's
/// RenderedNode / RenderedEdge satisfy these by structure, so the helper
/// stays decoupled from the component's larger types.
export interface LensNode {
  id: string;
  kind: string;
}
export interface LensEdge {
  source: string;
  target: string;
  kind?: string;
}

export type LensDirection = "out" | "both";

export interface LensClosureOptions {
  seedIds: readonly string[];
  depth: number;
  direction: LensDirection;
  metaClosure?: boolean;
  languageOneHop?: boolean;
  containmentOnly?: boolean;
}

/// Semantic meta-node kinds: a `#tag`, an `@@mention` handle, or a
/// `language:` bubble. Each attaches to files through a single semantic
/// edge and carries no directory spine of its own.
const META_KINDS = new Set(["tag", "mention", "language"]);

/// Pull every meta-node (tag / mention / language) that sits one hop off
/// an already-visited node into `visited`, in place.
///
/// The semantic lenses (mention / tag / contact) BFS out from their seed
/// to the documents in its neighbourhood and stop there. A surfaced
/// document's OTHER `@@handle` / `#tag` / language edges point at
/// meta-nodes one hop further out, which a depth-bounded BFS never
/// reaches; the both-endpoints edge filter then drops those edges, so a
/// document renders in the lens missing half its semantic edges. Adding
/// the incident meta-nodes lets each surfaced document show its full
/// first-order semantic edge set.
///
/// Bounded by construction: only meta-nodes join `visited`, and
/// meta-nodes never connect to other meta-nodes, so a single pass is
/// exact and the neighbourhood cannot fan out through unrelated files.
export function pullMetaNeighbours(
  visited: Set<string>,
  nodes: readonly LensNode[],
  edges: readonly LensEdge[],
): void {
  const metaIds = new Set<string>();
  for (const n of nodes) {
    if (META_KINDS.has(n.kind)) metaIds.add(n.id);
  }
  for (const e of edges) {
    const srcVisited = visited.has(e.source);
    const tgtVisited = visited.has(e.target);
    if (srcVisited === tgtVisited) continue;
    const candidate = srcVisited ? e.target : e.source;
    if (metaIds.has(candidate)) visited.add(candidate);
  }
}

/// The node ids a semantic lens shows: the seeds, a walk of `depth` hops
/// along edges in `direction` (at most one hop with `languageOneHop`, and
/// along contains edges alone with `containmentOnly`), the meta nodes one
/// hop off what the walk reached when `metaClosure` is set, and every
/// contains ancestor of all of that. It exists so the shared Rust/SPA
/// golden fixture can exercise GraphPanel's lens rules without mounting
/// the canvas.
export function lensClosure(
  nodes: readonly LensNode[],
  edges: readonly LensEdge[],
  options: LensClosureOptions,
): Set<string> {
  const visited = new Set(options.seedIds);
  let frontier = new Set(options.seedIds);
  const depth = options.languageOneHop
    ? Math.min(options.depth, 1)
    : options.depth;
  for (let hop = 0; hop < depth; hop++) {
    const next = new Set<string>();
    for (const edge of edges) {
      if (options.containmentOnly && edge.kind !== "contains") continue;
      if (frontier.has(edge.source) && !visited.has(edge.target)) {
        visited.add(edge.target);
        next.add(edge.target);
      }
      if (
        options.direction === "both" &&
        frontier.has(edge.target) &&
        !visited.has(edge.source)
      ) {
        visited.add(edge.source);
        next.add(edge.source);
      }
    }
    if (next.size === 0) break;
    frontier = next;
  }

  if (options.metaClosure) pullMetaNeighbours(visited, nodes, edges);

  // Anchor every surfaced node to its directory spine.
  ancestorClosure(visited, edges);
  return visited;
}
