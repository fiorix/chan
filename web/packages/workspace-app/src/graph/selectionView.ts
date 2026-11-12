// The one graph: the workspace's directory tree as far as it is opened, with
// what the selected node reveals laid over it. There is one layout and one
// root; a tag, a mention, a contact, a language, a file or a directory is a
// selection in it, not a graph of its own.
//
// Two things decide what is drawn. The opened set is the tree's state: a
// file or folder shows when every directory above it is opened, and it
// changes only when the user opens or closes a directory. The selection is
// laid over that: a selected file, tag, mention or language also shows what
// it refers to and what refers to it, each with its directories up to the
// root, and that part follows the selection.
//
// The depth is always the selected node's. On a directory it is how many
// levels below it are opened, read from and written to the opened set. On
// any other node it is how many hops of references the selection reveals.

import { ancestorClosure } from "./containmentSpine";
import { ancestorsExpanded } from "./pathVisibility";

/// The node and edge fields the rules read. A file's or a folder's node
/// carries its workspace-relative `path`; the workspace's own node is the
/// folder whose path is "".
export type ViewNode = { id: string; kind: string; path?: string };
export type ViewEdge = { source: string; target: string; kind?: string };

/// Directories whose children show, by path. The root is always opened.
export type Opened = Record<string, boolean>;

/// Edge kinds a selection's walk follows: what a note says about another
/// note, a tag or a person, and what the filesystem says of a file, that it
/// is a symlink to another or another name of the same one. `contains` is
/// the tree, which the opened set draws, and a `language` edge joins every
/// file of a language, so a walk through either would reach unrelated files
/// in one hop. The workspace search walks the first three; it has no
/// symlink or hardlink relationship.
const REFERENCE_KINDS: ReadonlySet<string> = new Set([
  "link",
  "tag",
  "mention",
  "symlink",
  "hardlink",
]);

/// The most hops a selection's depth offers.
export const SELECTION_HOPS_MAX = 6;

/// Levels `path` sits below the directory `dir`: 0 for the directory
/// itself, -1 for a path outside it.
function levelsBelow(dir: string, path: string): number {
  if (path === dir) return 0;
  if (dir === "") return path.split("/").length;
  if (!path.startsWith(`${dir}/`)) return -1;
  return path.slice(dir.length + 1).split("/").length;
}

function isFolder(n: ViewNode): n is ViewNode & { path: string } {
  return n.kind === "folder" && n.path !== undefined;
}

/// The path of the directory the depth acts on when `selectedId` names a
/// folder, "" (the root) when nothing is selected, and null when the
/// selection is any other node.
export function selectedDirectory(
  nodes: readonly ViewNode[],
  selectedId: string | null,
): string | null {
  if (selectedId === null) return "";
  for (const n of nodes) {
    if (n.id === selectedId) return isFolder(n) ? n.path : null;
  }
  return null;
}

/// The nodes one hop from `frontier` along the reference edges, in either
/// direction, that `visited` does not hold yet.
function referenceHop(
  edges: readonly ViewEdge[],
  frontier: ReadonlySet<string>,
  visited: ReadonlySet<string>,
): Set<string> {
  const next = new Set<string>();
  for (const e of edges) {
    if (e.kind === undefined || !REFERENCE_KINDS.has(e.kind)) continue;
    if (frontier.has(e.source) && !visited.has(e.target)) next.add(e.target);
    if (frontier.has(e.target) && !visited.has(e.source)) next.add(e.source);
  }
  return next;
}

/// What the selection shows beyond the opened tree: the selected node, what
/// it reveals, and the directories of all of it up to the root.
///
/// A file, tag or mention reveals `depth` hops of references in both
/// directions. A language reveals its files, one hop whatever the depth. A
/// directory reveals nothing here: its depth opens levels of the tree
/// (`openBelow`). An id no node has reveals nothing.
export function selectionReveal(
  nodes: readonly ViewNode[],
  edges: readonly ViewEdge[],
  selectedId: string | null,
  depth: number,
): Set<string> {
  const selected = selectedId === null ? undefined : nodes.find((n) => n.id === selectedId);
  if (!selected) return new Set();
  const visited = new Set<string>([selected.id]);
  if (selected.kind === "language") {
    for (const e of edges) {
      if (e.kind !== "language") continue;
      if (e.source === selected.id) visited.add(e.target);
      if (e.target === selected.id) visited.add(e.source);
    }
  } else if (selected.kind !== "folder") {
    let frontier: Set<string> = new Set([selected.id]);
    for (let hop = 0; hop < depth && frontier.size > 0; hop += 1) {
      frontier = referenceHop(edges, frontier, visited);
      for (const id of frontier) visited.add(id);
    }
  }
  ancestorClosure(visited, edges);
  return visited;
}

/// The node ids the graph includes, before the filter chips: the opened
/// tree, what the selection reveals, and every tag, mention and language.
/// The meta nodes all pass here, as they do in a workspace scope; the chips'
/// stage keeps the ones an edge joins to a file that is shown.
export function graphNodeIds(input: {
  nodes: readonly ViewNode[];
  edges: readonly ViewEdge[];
  opened: Opened;
  selectedId: string | null;
  depth: number;
}): Set<string> {
  const { nodes, edges, opened, selectedId, depth } = input;
  const visible = selectionReveal(nodes, edges, selectedId, depth);
  for (const n of nodes) {
    if (n.kind !== "file" && n.kind !== "folder") {
      visible.add(n.id);
    } else if (ancestorsExpanded("", n.path ?? "", opened)) {
      visible.add(n.id);
    }
  }
  return visible;
}

/// The largest depth the selected node can use. A directory: the deepest
/// level any file or folder sits below it. A language: 1. A file, tag or
/// mention: the hops its references run before they reach nothing new, held
/// to `SELECTION_HOPS_MAX`. At least 1 in every case.
export function selectionDepthCap(
  nodes: readonly ViewNode[],
  edges: readonly ViewEdge[],
  selectedId: string | null,
): number {
  const dir = selectedDirectory(nodes, selectedId);
  if (dir !== null) {
    let deepest = 1;
    for (const n of nodes) {
      if ((n.kind !== "file" && n.kind !== "folder") || n.path === undefined) continue;
      deepest = Math.max(deepest, levelsBelow(dir, n.path));
    }
    return deepest;
  }
  const selected = nodes.find((n) => n.id === selectedId);
  if (!selected || selected.kind === "language") return 1;
  const visited = new Set<string>([selected.id]);
  let frontier: Set<string> = new Set([selected.id]);
  let hops = 0;
  while (hops < SELECTION_HOPS_MAX) {
    frontier = referenceHop(edges, frontier, visited);
    if (frontier.size === 0) break;
    for (const id of frontier) visited.add(id);
    hops += 1;
  }
  return Math.max(1, hops);
}

/// How many levels below the directory `dir` are opened: 0 when it is
/// closed, 1 when its children show, and one more for each further level
/// whose directories are all opened.
export function openedDepth(nodes: readonly ViewNode[], opened: Opened, dir: string): number {
  if (dir !== "" && !opened[dir]) return 0;
  const byLevel = new Map<number, string[]>();
  for (const n of nodes) {
    if (!isFolder(n)) continue;
    const level = levelsBelow(dir, n.path);
    if (level < 1) continue;
    const paths = byLevel.get(level);
    if (paths) paths.push(n.path);
    else byLevel.set(level, [n.path]);
  }
  let depth = 1;
  for (;;) {
    const paths = byLevel.get(depth);
    if (!paths || !paths.every((p) => opened[p])) return depth;
    depth += 1;
  }
}

/// The opened set with `depth` levels opened below the directory `dir` and
/// every deeper directory under it closed; 0 closes `dir` itself. The rest
/// of the tree is left as it was, and the directories above `dir` are
/// opened so it shows. The root never closes.
export function openBelow(
  nodes: readonly ViewNode[],
  opened: Opened,
  dir: string,
  depth: number,
): Opened {
  const next: Opened = { ...opened };
  for (const n of nodes) {
    if (!isFolder(n)) continue;
    const level = levelsBelow(dir, n.path);
    if (level < 0) continue;
    if (level < depth) next[n.path] = true;
    else delete next[n.path];
  }
  const parts = dir === "" ? [] : dir.split("/");
  for (let i = 1; i < parts.length; i += 1) next[parts.slice(0, i).join("/")] = true;
  next[""] = true;
  return next;
}

/// The opened set with the directory `dir` showing its children: the root,
/// every directory above `dir`, and `dir` itself. Needs no loaded graph, so
/// a tab can be opened on a directory before its nodes arrive.
export function openedForPath(dir: string): Opened {
  const opened: Opened = { "": true };
  const parts = dir === "" ? [] : dir.split("/").filter(Boolean);
  for (let i = 1; i <= parts.length; i += 1) opened[parts.slice(0, i).join("/")] = true;
  return opened;
}

/// The opened set a graph starts with when it opens on `selectedId`: the
/// root's own level, and for a directory the path down to it with its own
/// children showing. Any other node needs no directory opened; the
/// selection reveals it with its directories.
export function openedFor(nodes: readonly ViewNode[], selectedId: string | null): Opened {
  return openedForPath(selectedDirectory(nodes, selectedId) ?? "");
}

/// What a graph tab scoped the way tabs once were (`dir:<path>`,
/// `file:<path>`, `tag:<id>`, `mention:<id>`, `contact:<path>`,
/// `language:<name>`) reads as in the one graph: the node to select, named
/// as a pending selection names it (a path for a file or directory, an id
/// otherwise), and the directory to open when the scope was one. Null for
/// the workspace scope and for a scope id of no known shape.
export function selectionOfScope(scopeId: string): { select: string; dir: string | null } | null {
  const at = scopeId.indexOf(":");
  if (at <= 0) return null;
  const kind = scopeId.slice(0, at);
  const rest = scopeId.slice(at + 1);
  if (!rest) return null;
  switch (kind) {
    case "dir":
      return { select: rest, dir: rest.replace(/\/+$/, "") };
    case "file":
    case "contact":
    case "tag":
    case "mention":
      return { select: rest, dir: null };
    case "language":
      return { select: scopeId, dir: null };
    default:
      return null;
  }
}
