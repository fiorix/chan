import type { TreeEntry } from "../api/types";
import { basename, parentDir } from "./format";

export type BrowserSort = "name" | "kind" | "size" | "modified";

export function directoryEntries(
  entries: TreeEntry[],
  directory: string,
  filter: string,
  sort: BrowserSort,
  descending: boolean,
  showHidden: boolean,
): TreeEntry[] {
  const seen = new Set<string>();
  const query = filter.toLocaleLowerCase();
  return entries.filter((entry) => {
    if (parentDir(entry.path) !== directory || seen.has(entry.path)) return false;
    seen.add(entry.path);
    const name = basename(entry.path);
    return (showHidden || !name.startsWith(".")) && name.toLocaleLowerCase().includes(query);
  }).sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    let order = 0;
    if (sort === "size") order = a.size - b.size;
    if (sort === "modified") order = (a.mtime ?? 0) - (b.mtime ?? 0);
    if (sort === "kind") order = (a.kind ?? "folder").localeCompare(b.kind ?? "folder");
    if (!order) order = basename(a.path).localeCompare(basename(b.path), undefined, { numeric: true });
    return descending ? -order : order;
  });
}

export function browserDirectoryInput(input: string, root: string): string {
  let path = input.trim();
  const prefix = root.replace(/\/+$/, "");
  if (prefix && (path === prefix || path.startsWith(`${prefix}/`))) path = path.slice(prefix.length);
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}
