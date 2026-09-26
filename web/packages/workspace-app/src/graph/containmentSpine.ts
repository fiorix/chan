/// Walk the `contains` parent chain up to the workspace root: from one
/// selected node for the focus-on-select spotlight, and from every node of
/// a visible set so no file renders without its directory spine.
///
/// `contains` edges run parent directory -> child (directory -> file or
/// directory -> subdirectory), so every file, directory, and contact
/// node has a parent chain, while tag / mention / language meta-nodes
/// carry no `contains` edge at all. Walking that chain therefore lights
/// the whole path home for a file / directory / contact selection and
/// yields nothing for a meta-node selection, with no kind check needed.

/// Child-node id -> parent-directory-node id, from the `contains` edges.
export function containmentParents(
  edges: readonly { source: string; target: string; kind: string }[],
): Map<string, string> {
  const parents = new Map<string, string>();
  for (const e of edges) {
    if (e.kind === "contains") parents.set(e.target, e.source);
  }
  return parents;
}

/// Stable, collision-free key for a parent -> child spine edge. JSON
/// encodes both ids so a delimiter can never clash with a path segment.
export function spineEdgeKey(parent: string, child: string): string {
  return JSON.stringify([parent, child]);
}

/// The ancestor directory node ids and the parent -> child edge keys on
/// the containment path from `startId` to the workspace root. A node with
/// no parent (the root, or a meta-node without a `contains` edge) yields
/// empty sets. Cycle-guarded so a malformed graph can't loop.
export function containmentSpine(
  startId: string,
  parents: ReadonlyMap<string, string>,
): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  const seen = new Set<string>([startId]);
  let cur: string | undefined = startId;
  while (cur !== undefined) {
    const parent = parents.get(cur);
    if (parent === undefined || seen.has(parent)) break;
    nodes.add(parent);
    edges.add(spineEdgeKey(parent, cur));
    seen.add(parent);
    cur = parent;
  }
  return { nodes, edges };
}

/// Add to `visited`, in place, every `contains` ancestor of a node already
/// in it, up to the workspace root. Repeats to a fixed point, so a nested
/// chain is pulled in whatever order its edges arrive; the contains
/// subgraph is a forest, so that takes O(depth) passes, and `visited` only
/// grows, so a malformed cycle still ends.
export function ancestorClosure(
  visited: Set<string>,
  edges: readonly { source: string; target: string; kind?: string }[],
): void {
  let pulled = true;
  while (pulled) {
    pulled = false;
    for (const e of edges) {
      if (e.kind === "contains" && visited.has(e.target) && !visited.has(e.source)) {
        visited.add(e.source);
        pulled = true;
      }
    }
  }
}
