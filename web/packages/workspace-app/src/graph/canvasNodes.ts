// What the graph canvas draws, named in one place for the components that
// feed it.

import type { GraphViewEdge, GraphViewNode } from "../api/types";

/// The nodes the canvas takes: files, folders, tags, mentions and languages,
/// out of the wider union the wire names.
export type CanvasNode = Extract<
  GraphViewNode,
  { kind: "file" | "tag" | "mention" | "language" | "folder" }
>;
export type CanvasEdgeKind = "link" | "tag" | "mention" | "contains" | "language";
/// The edges the canvas takes, between those nodes.
export type CanvasEdge = GraphViewEdge & { kind: CanvasEdgeKind };

/// A node the canvas draws for something the workspace's graph does not hold:
/// the drafts group (`group`), or one draft under it. It carries no path, so
/// nothing that reads a node's path can take it for a workspace file.
export type DraftNode = { kind: "draft"; id: string; label: string; group: boolean };
/// Every node the canvas can be handed.
export type DrawnNode = CanvasNode | DraftNode;

/// The id of a directory's node, as the server's `directory_node_id` gives
/// it: `directory:<path>`, where the bare path is the id of a file's node.
/// The workspace root is `""` in every source, and the canvas tells the
/// workspace's node by that id.
export function directoryNodeId(path: string): string {
  return path === "" ? "" : `directory:${path}`;
}
