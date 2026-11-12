// What a graph scope shows, which of its nodes the canvas pins, and how the
// canvas frames them. GraphPanel derives these for its tab's scope and the
// graph tuner for the scope its controls pick, so the tuner lays a scope out
// from the same rules as the Graph tab.

import type { ScopeOption } from "../state/scope";
import { lensClosure } from "./lensClosure";
import { ancestorsExpanded } from "./pathVisibility";

/// The node and edge fields the rules read. GraphPanel's rendered nodes and
/// the tuner's synthetic ones satisfy them by structure. A file's or a
/// folder's node carries its workspace-relative `path`.
export type ScopeNode = { id: string; kind: string; path?: string };
export type ScopeEdge = { source: string; target: string; kind?: string };

export type ScopeViewInput = {
  scope: ScopeOption | null;
  /// The filesystem graph of a workspace, directory or file scope, as
  /// opposed to the semantic graph every scope kind has.
  filesystemMode: boolean;
  nodes: readonly ScopeNode[];
  edges: readonly ScopeEdge[];
  /// Directories whose children show, by path. The workspace and directory
  /// scopes read it; a lens's set comes from its walk.
  expanded: Record<string, boolean>;
  /// Hops a lens or a file scope walks from its seed. The workspace and
  /// directory scopes show by `expanded` instead, and the language lens
  /// always takes one hop.
  depth: number;
};

/// The ids of the file nodes at `path`.
function fileNodeIds(nodes: readonly ScopeNode[], path: string): string[] {
  const ids: string[] = [];
  for (const n of nodes) {
    if (n.kind === "file" && n.path === path) ids.push(n.id);
  }
  return ids;
}

/// The node ids a scope includes, before the filter chips. `null` means no
/// scope filter: an unresolved scope, or a file scope in filesystem mode.
export function scopeNodeIds(input: ScopeViewInput): Set<string> | null {
  const { scope, filesystemMode, nodes, edges, expanded, depth } = input;
  if (!scope) return null;
  // The semantic workspace and directory scopes draw the whole rich graph
  // (files, tags, mentions, languages and the directory spine) with the
  // directory tree opened and closed as the File Browser's is: a file or
  // folder shows when every ancestor directory up to the scope root is
  // expanded. The meta nodes always pass, and the chips drop the ones no
  // visible file reaches. The workspace's own node is unconditional, so the
  // spine always has a root to hang from.
  if (!filesystemMode && (scope.kind === "workspace" || scope.kind === "dir")) {
    const rootPath = scope.kind === "workspace" ? "" : scope.path;
    const visible = new Set<string>();
    for (const n of nodes) {
      if (n.kind === "tag" || n.kind === "mention" || n.kind === "language") {
        visible.add(n.id);
        continue;
      }
      if (n.kind === "folder" && (n.id === "" || n.path === "")) {
        visible.add(n.id);
        continue;
      }
      // Files and folders remain. A media file is a file node here, so the
      // same gate covers it.
      if (ancestorsExpanded(rootPath, n.path ?? "", expanded)) visible.add(n.id);
    }
    return visible;
  }
  // Filesystem mode shows the spine by the same expanded set. A file scope
  // there is one file's view with no tree to open, so it is not filtered.
  if (filesystemMode) {
    if (scope.kind === "file") return null;
    const fsRoot = scope.kind === "dir" ? scope.path : "";
    const visible = new Set<string>();
    for (const n of nodes) {
      if (n.kind !== "file" && n.kind !== "folder") {
        visible.add(n.id);
        continue;
      }
      if (ancestorsExpanded(fsRoot, n.path ?? "", expanded)) visible.add(n.id);
    }
    return visible;
  }
  // Tag and mention lenses seed with the meta node itself. The server emits
  // their edges as file -> tag and file -> mention, so the walk goes both
  // ways: one hop reaches every document that references the node, and
  // further hops follow those documents' own edges.
  if (scope.kind === "tag" || scope.kind === "mention") {
    return lensClosure(nodes, edges, {
      seedIds: [scope.nodeId],
      depth,
      direction: "both",
      metaClosure: true,
    });
  }
  // The contact lens seeds with the contact's file node and walks both
  // ways, so it holds every document that references the contact as well as
  // what the contact's own file links to.
  if (scope.kind === "contact") {
    const seedIds = fileNodeIds(nodes, scope.relPath);
    if (seedIds.length === 0) return new Set();
    return lensClosure(nodes, edges, {
      seedIds,
      depth,
      direction: "both",
      metaClosure: true,
    });
  }
  // The language lens is the language's node and its direct neighbours,
  // which are the files of that language. It takes a fixed hop: language
  // mode reads depth 0 as "max", and the lens takes its hop there too.
  if (scope.kind === "language") {
    return lensClosure(nodes, edges, {
      seedIds: [`language:${scope.language}`],
      depth: 1,
      direction: "both",
    });
  }
  // A semantic file scope walks forward only, so the depth reads as "expand
  // from this file in the direction its edges point". The closure adds the
  // file's directories up to the workspace root, so every file it shows
  // hangs from its parent.
  const seedIds = scope.kind === "file" ? fileNodeIds(nodes, scope.path) : [];
  if (seedIds.length === 0) return new Set();
  return lensClosure(nodes, edges, { seedIds, depth, direction: "out" });
}

/// The node ids the canvas pins. A tag, mention or language lens pins its
/// own node and a contact lens the contact's file node; a file scope pins
/// its file, and a directory scope every file at or under its path. The
/// canvas seats one pinned node at the world origin and fans several around
/// it. The workspace scope pins none.
export function scopeFocalIds(scope: ScopeOption | null, nodes: readonly ScopeNode[]): string[] {
  if (!scope) return [];
  if (scope.kind === "tag" || scope.kind === "mention") return [scope.nodeId];
  if (scope.kind === "contact") return fileNodeIds(nodes, scope.relPath);
  if (scope.kind === "language") return [`language:${scope.language}`];
  if (scope.kind !== "file" && scope.kind !== "dir") return [];
  const directory = scope.kind === "dir";
  const root = directory ? scope.path.replace(/\/+$/, "") : scope.path;
  const withSlash = root + "/";
  const ids: string[] = [];
  for (const n of nodes) {
    if (
      n.kind === "file" &&
      n.path !== undefined &&
      (n.path === root || (directory && n.path.startsWith(withSlash)))
    ) {
      ids.push(n.id);
    }
  }
  return ids;
}

/// Lens kinds that pin a node of their own. Their walk splays what they show
/// around that node in every direction, with the directory spine below it,
/// so the canvas's default framing, which seats the pinned node near the
/// bottom edge, leaves half the canvas empty and drops nodes below it.
const BOUNDS_FRAMED_LENSES: ReadonlySet<ScopeOption["kind"]> = new Set([
  "tag",
  "mention",
  "contact",
  "language",
]);

/// How the canvas frames a scope: "bounds" (the drawn box in the middle of
/// the canvas) for the lenses that pin their own node, and the canvas's
/// default for the workspace, directory and file scopes.
export function scopeFocalAnchor(scope: ScopeOption | null): "bounds" | undefined {
  return scope !== null && BOUNDS_FRAMED_LENSES.has(scope.kind) ? "bounds" : undefined;
}
