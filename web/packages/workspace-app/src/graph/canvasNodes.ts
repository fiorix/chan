// What the graph canvas draws, named in one place for the components that
// feed it.

/// The id of a directory's node, as the server's `directory_node_id` gives
/// it: `directory:<path>`, where the bare path is the id of a file's node.
/// The workspace root is `""` in every source, and the canvas tells the
/// workspace's node by that id.
export function directoryNodeId(path: string): string {
  return path === "" ? "" : `directory:${path}`;
}
