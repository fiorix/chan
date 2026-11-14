/// The Dashboard's Search slide draws the workspace's directories by level:
/// the root's, and the level of each directory the user has opened on the
/// slide. A directory's indexing state covers everything below it, so a
/// closed one stands for its whole subtree and the slide asks the server
/// for no more than the levels it draws.
///
/// The opened directories are workspace-relative paths. The root is always
/// open and never listed. Closing a directory keeps what was opened below
/// it for its next opening, so the list can hold more than is drawn.

import type { IndexingStateNode, IndexingStateResponse } from "../api/types";
import { parentDir } from "../state/format";
import { ancestorsExpanded } from "./pathVisibility";

/// The opened list as the map `ancestorsExpanded` reads. It has no
/// prototype, so a directory named for an `Object` member reads as closed
/// until it is opened.
function openedMap(opened: readonly string[]): Record<string, boolean> {
  const map: Record<string, boolean> = Object.create(null);
  for (const dir of opened) map[dir] = true;
  return map;
}

/// The directories above `path`, the nearest to the root first, without the
/// root: what has to be opened for the slide to draw the directory at
/// `path`.
export function dirsAbove(path: string): string[] {
  const above: string[] = [];
  for (let dir = parentDir(path); dir !== ""; dir = parentDir(dir)) above.unshift(dir);
  return above;
}

/// The opened directories whose level the slide draws, sorted: one with
/// every directory above it opened too. This is what the slide asks the
/// server for.
export function drawnOpenedDirs(opened: readonly string[]): string[] {
  const map = openedMap(opened);
  return [...new Set(opened)]
    .filter((dir) => dir !== "" && ancestorsExpanded("", dir, map))
    .sort();
}

/// The nodes of an answer the slide draws: the root, and each directory
/// with every directory above it opened. An answer can list more than
/// that: the one a slide is seeded with was asked for by another Dashboard
/// tab, with its own opened directories.
export function drawnIndexingNodes(
  nodes: readonly IndexingStateNode[],
  opened: readonly string[],
): IndexingStateNode[] {
  const map = openedMap(opened);
  return nodes.filter((n) => ancestorsExpanded("", n.path, map));
}

/// The opened list without what an answer shows gone from the workspace.
/// `asked` is what the answer's request named: every directory above one of
/// those was named too, so the answer lists its parent's level, and one the
/// answer does not list is no longer there. Such a directory leaves the
/// list with everything opened below it, so one deleted or renamed is not
/// asked for and saved for as long as the tab lives. The list itself is
/// answered when nothing is gone, and for an answer without the root, which
/// lists no level to read.
export function withoutVanishedDirs(
  opened: readonly string[],
  asked: readonly string[],
  nodes: readonly IndexingStateNode[],
): readonly string[] {
  const listed = new Set(nodes.map((n) => n.path));
  if (!listed.has("")) return opened;
  const gone = asked.filter((dir) => !listed.has(dir));
  if (gone.length === 0) return opened;
  return opened.filter((dir) => !gone.some((lost) => dir === lost || dir.startsWith(`${lost}/`)));
}

/// Whether two answers list the same directories in the same states. The
/// slide keeps the answer it holds when a poll brings an equal one, so a
/// poll that changed nothing hands the canvas nothing to lay out again.
export function sameIndexingState(
  a: IndexingStateResponse | null,
  b: IndexingStateResponse | null,
): boolean {
  if (!a || !b) return a === b;
  if (a.root !== b.root || a.nodes.length !== b.nodes.length) return false;
  return a.nodes.every((n, i) => {
    const m = b.nodes[i];
    return n.path === m.path && n.state === m.state && n.children_count === m.children_count;
  });
}
