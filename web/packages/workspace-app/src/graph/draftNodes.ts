// The workspace's drafts as the graph draws them.
//
// A draft is kept outside the workspace, so the server's graph has no node
// for one and nothing in it links to one. The graph still shows that drafts
// exist: a Drafts group hung from the workspace's node, and one node per
// listed draft hung from the group. They are drawn and can be selected, and
// that is all. The panel hands them to the canvas beside the graph it loaded
// and never adds them to it, so no count, depth or lens of the graph sees
// them.

import type { DraftListEntry } from "../api/types";
import type { CanvasEdge, DraftNode } from "./canvasNodes";

/// The id of the group's node.
export const DRAFTS_GROUP_NODE_ID = "drafts:";

/// The id of a draft's node: its name, never its path or the id of its
/// lifetime.
export function draftNodeId(name: string): string {
  return `draft:${name}`;
}

export type DraftLayer = {
  nodes: DraftNode[];
  edges: CanvasEdge[];
  /// The listed draft behind each draft's node, by node id. The group's
  /// node has no entry.
  rows: Map<string, DraftListEntry>;
};

export const NO_DRAFT_LAYER: DraftLayer = { nodes: [], edges: [], rows: new Map() };

/// The group and one node per listed draft, hung from the node `rootId`.
/// An id the loaded graph already uses (`taken`) stays that graph's: a
/// draft whose id is taken is not drawn, and when the group's id is taken
/// nothing is.
export function draftLayer(
  listed: DraftListEntry[],
  rootId: string,
  taken: (id: string) => boolean,
): DraftLayer {
  if (listed.length === 0 || taken(DRAFTS_GROUP_NODE_ID)) return NO_DRAFT_LAYER;
  const nodes: DraftNode[] = [
    { kind: "draft", id: DRAFTS_GROUP_NODE_ID, label: "Drafts", group: true },
  ];
  const edges: CanvasEdge[] = [
    { source: rootId, target: DRAFTS_GROUP_NODE_ID, kind: "contains" },
  ];
  const rows = new Map<string, DraftListEntry>();
  for (const row of listed) {
    const id = draftNodeId(row.name);
    if (taken(id) || rows.has(id)) continue;
    rows.set(id, row);
    nodes.push({ kind: "draft", id, label: row.name, group: false });
    edges.push({ source: DRAFTS_GROUP_NODE_ID, target: id, kind: "contains" });
  }
  return { nodes, edges, rows };
}
