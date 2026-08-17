import type { FsGraphNode, GraphViewNode } from "../api/types";

export const GRAPH_DEPTH_HARD_MAX = 10;
/// Depth the fs-graph probe fetches AND the workspace/dir depth-slider
/// cap. Set equal to GRAPH_DEPTH_HARD_MAX so the cap is effectively the
/// tree's real depth: `graphDepthCap` clamps to
/// `min(actualReachableDepth, this)`, so a deep (source-style) tree
/// reveals in full while a shallow notes tree only reaches its own
/// depth. Each fs-graph request stays bounded by the server's MAX_NODES
/// cap regardless.
export const FS_GRAPH_DEPTH_MAX = 10;

type GraphDepthScope =
  | { kind: "file" }
  | { kind: "group"; paths: readonly string[] }
  | { kind: "dir"; path: string }
  | { kind: "workspace" }
  | { kind: "global" }
  | { kind: "tag" }
  | { kind: "mention" }
  | { kind: "contact" }
  | { kind: "language" }
  | { kind: "git_repo" };

type FsGraphProbe = {
  nodes: readonly Pick<FsGraphNode, "path">[];
  truncated: boolean;
};

export type GraphDepthCapInput = {
  scope: GraphDepthScope | null;
  nodes: readonly GraphViewNode[];
  fsGraph?: FsGraphProbe | null;
  hardMax?: number;
  fsMax?: number;
};

function clampDepth(value: number, max: number): number {
  return Math.max(1, Math.min(max, Math.max(1, value)));
}

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
/// A directory-scoped graph renders one level at a time (the expanded-set
/// gate), so a directory whose immediate children are all directories opens
/// with no file on screen even though its subtree is already in the
/// payload. This is what "Graph from here" has to reach to answer the
/// question it was asked: the first level that actually holds content.
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

function maxDepthFromPaths(root: string, paths: readonly string[]): number {
  let max = 1;
  for (const path of paths) {
    max = Math.max(max, relativeDepth(root, path));
  }
  return max;
}

function filePaths(nodes: readonly GraphViewNode[]): string[] {
  return nodes.flatMap((node) => (node.kind === "file" ? [node.path] : []));
}

function fsPaths(fsGraph: FsGraphProbe): string[] {
  return fsGraph.nodes.map((node) => node.path).filter((path) => path.length > 0);
}

export function graphDepthCap({
  scope,
  nodes,
  fsGraph = null,
  hardMax = GRAPH_DEPTH_HARD_MAX,
  fsMax = FS_GRAPH_DEPTH_MAX,
}: GraphDepthCapInput): number {
  if (!scope) return hardMax;
  if (scope.kind === "file") return 1;
  if (scope.kind === "group") return clampDepth(scope.paths.length, hardMax);
  if (scope.kind === "tag" || scope.kind === "git_repo") return hardMax;
  // Mention lens uses depth meaningfully (bidirectional BFS from the
  // mention meta-node), same as the tag lens, so it lifts the cap to
  // the hard max rather than pinning the slider.
  if (scope.kind === "mention") return hardMax;
  // Contact lens uses depth meaningfully (BFS-from-center
  // bidirectional) so it lifts the hard cap. Language lens is
  // always 1-hop, so the cap is pinned to 1 so the slider reads
  // `[max]` and the user sees there's nothing more to reveal.
  if (scope.kind === "contact") return hardMax;
  if (scope.kind === "language") return 1;
  if (scope.kind === "workspace" || scope.kind === "global") {
    if (!fsGraph) return hardMax;
    if (fsGraph.truncated) return fsMax;
    return clampDepth(maxDepthFromPaths("", fsPaths(fsGraph)), fsMax);
  }
  if (scope.kind === "dir") {
    if (fsGraph) {
      if (fsGraph.truncated) return fsMax;
      return clampDepth(maxDepthFromPaths(scope.path, fsPaths(fsGraph)), fsMax);
    }
    return clampDepth(maxDepthFromPaths(scope.path, filePaths(nodes)), hardMax);
  }
  return hardMax;
}
