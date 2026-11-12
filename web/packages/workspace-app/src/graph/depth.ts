/// The most levels of the filesystem spine one graph load fetches. Each
/// fs-graph request stays bounded by the server's MAX_NODES cap
/// regardless.
export const FS_GRAPH_DEPTH_MAX = 10;

export function relativeDepth(root: string, path: string): number {
  const cleanRoot = root.replace(/^\/+|\/+$/g, "");
  const cleanPath = path.replace(/^\/+|\/+$/g, "");
  if (!cleanPath) return 1;
  if (!cleanRoot) return cleanPath.split("/").filter(Boolean).length;
  if (cleanPath === cleanRoot) return 1;
  const prefix = `${cleanRoot}/`;
  if (!cleanPath.startsWith(prefix)) return 0;
  return cleanPath.slice(prefix.length).split("/").filter(Boolean).length;
}

/// A node carrying a workspace-relative path, structurally typed so both
/// the wire nodes (`GraphViewNode`) and the panel's rendered nodes satisfy
/// it. Media files are files here: "show me this directory" means its
/// contents, not its markdown.
type PathedNode = { kind: string; path?: string | null };

/// The shallowest depth BELOW `root` at which a file sits, or 0 when the
/// set holds none under that root.
///
/// The graph draws a directory one opened level at a time, so a directory
/// whose immediate children are all directories opens with no file on
/// screen even though its subtree is already loaded. This is what "Graph
/// from here" on a directory has to reach to answer the question it was
/// asked: the first level that actually holds content.
/// Paths outside `root` score 0 in `relativeDepth` and are skipped, so a
/// workspace-wide node set can be passed as-is.
export function shallowestFileDepth(
  root: string,
  nodes: readonly PathedNode[],
): number {
  let best = 0;
  for (const node of nodes) {
    if (node.kind !== "file" && node.kind !== "media") continue;
    if (!node.path) continue;
    const depth = relativeDepth(root, node.path);
    if (depth < 1) continue;
    if (best === 0 || depth < best) best = depth;
  }
  return best;
}
