// Scope helpers for the Graph overlay. `ScopeOption` is the
// discriminated union the graph uses to describe "what part of my
// world am I looking at": a file, directory, git repo, group of
// visible files, tag, contact, language, the whole workspace, or
// global cross-workspace scope.
//
// Each graph tab stores the chosen scope as a `scopeId` string
// (`file:<path>`, `dir:<path>`, `tag:<id>`, `language:<lang>`, ...);
// GraphPanel's `synthesizeScope` turns that id back into a typed
// ScopeOption and `graphTitle` renders it. `defaultScopeId` picks the
// id matching what is in front of the user; `scopeKey` / `parentDir` /
// `visibleFilePaths` are small path helpers used by the graph open
// paths.
//
// The Search overlay has no scope picker (search is workspace-wide),
// so this module carries no dropdown-options builder.

import { layout } from "./tabs.svelte";
// The `dir` scope reads the file browser's current selection and looks
// the entry up in the tree to distinguish directory from file.
// store.svelte imports from this module too, so the cycle is real;
// both reads happen lazily inside functions (not at module init),
// which Vite resolves cleanly.
import { browserSelection, tree } from "./store.svelte";

/// Picker option, as a discriminated union so consumers can
/// pattern-match on `kind` and access the kind-specific fields
/// (path for file/dir, repo path for git_repo, key+paths for
/// group, nothing extra for workspace or global). `enabled` defaults
/// true; consumers render it as disabled in the dropdown when
/// false (e.g. global before cross-workspace indexing ships).
export type ScopeOption =
  | {
      id: string;
      kind: "file";
      label: string;
      path: string;
      enabled?: boolean;
      /// True when the underlying tab is read-only (filesystem-
      /// locked or user-toggled). Read-only files stay searchable
      /// and visible; consumers can mark them in their dropdowns.
      readOnly?: boolean;
    }
  | {
      id: string;
      kind: "dir";
      label: string;
      /// Directory path relative to the workspace root. Empty string
      /// means the workspace root itself; consumers should treat that
      /// case the same as `workspace` scope.
      path: string;
      enabled?: boolean;
    }
  | {
      id: string;
      kind: "git_repo";
      label: string;
      /// Repo path relative to the workspace root.
      root: string;
      enabled?: boolean;
    }
  | {
      id: string;
      kind: "group";
      label: string;
      key: string;
      paths: string[];
      enabled?: boolean;
    }
  | {
      id: string;
      kind: "tag";
      label: string;
      /// Graph node id of the tag (e.g. `#search`). The graph
      /// scoping logic seeds BFS from this id directly - no need to
      /// resolve to a path list like the file-kind scopes do.
      nodeId: string;
      enabled?: boolean;
    }
  | {
      id: string;
      kind: "mention";
      label: string;
      /// Graph node id of the mention (e.g. `@@Lead`). Like the tag
      /// lens, BFS seeds from this id directly - no path resolution,
      /// since the backend emits a standalone Mention node plus a
      /// `file -> @@Name` edge per referencing document.
      nodeId: string;
      enabled?: boolean;
    }
  | {
      /// Contact lens. The seed is a file node (contact-kind .md
      /// frontmatter or a workspace file referenced via a mention);
      /// the graph lens centers on this file and expands
      /// BIDIRECTIONALLY so the resulting subgraph contains every doc
      /// that references the contact (backlinks) plus everything the
      /// contact's own file links out to. `openGraphForContact(relPath)`
      /// sets scopeId = `contact:<rel_path>`; the GraphPanel maps that
      /// to this option.
      id: string;
      kind: "contact";
      label: string;
      relPath: string;
      enabled?: boolean;
    }
  | {
      /// Language lens. The seed is the language bubble node
      /// (id = `language:<lang>`); the graph lens shows the bubble
      /// plus its direct neighbours (every file of that language).
      /// The lens is always 1-hop; depth does not apply.
      id: string;
      kind: "language";
      label: string;
      language: string;
      enabled?: boolean;
    }
  | { id: "workspace"; kind: "workspace"; label: string; enabled?: boolean }
  | { id: "global"; kind: "global"; label: string; enabled?: boolean };

/// Stable group key from a list of paths: sorted + joined with `|`
/// so two groups with the same set produce the same key. Used to
/// detect "the same group as before" across layout shuffles.
export function scopeKey(paths: readonly string[]): string {
  return [...paths].sort().join("|");
}

/// Workspace-relative parent directory of `path`. Returns "" for paths
/// at the workspace root (no parent) and for the empty string. Directories
/// follow the same rule as files; the caller decides whether to
/// treat the empty parent as "workspace scope" or skip.
export function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/// Paths for every file tab currently active in any leaf pane.
/// Returns each path at most once, sorted alphabetically. Workspaces
/// every overlay's "context dropdown" + the cleanup pass that
/// prunes group state whose context no longer exists.
export function visibleFilePaths(): string[] {
  const out = new Set<string>();
  for (const node of Object.values(layout.nodes)) {
    if (node.kind !== "leaf") continue;
    const active = node.tabs.find((t) => t.id === node.activeTabId);
    if (active?.kind === "file" && active.path) out.add(active.path);
  }
  return [...out].sort();
}

/// Pick a default scope id matching what's "in front of" the user
/// right now: the active pane's active file when it's a file tab,
/// the selected file or directory when the active tab is a browser,
/// else "workspace" (always present). Shared between every overlay's
/// open-from-toolbar entry point and global keybinding so both
/// snap to the same pick.
export function defaultScopeId(): string {
  // Active pane is a file browser: its current selection wins (the
  // user is looking at the tree, so route the next overlay action at
  // the selected dir/file).
  const activeNode = layout.nodes[layout.activePaneId];
  const activeTab =
    activeNode && activeNode.kind === "leaf"
      ? activeNode.tabs.find((tab) => tab.id === activeNode.activeTabId)
      : undefined;
  if (activeTab?.kind === "browser") {
    const sel = browserSelection.path;
    if (sel) {
      const entry = tree.entries.find((e) => e.path === sel);
      if (entry?.is_dir) return `dir:${sel}`;
      if (entry && !entry.is_dir) return `file:${sel}`;
    }
  }
  // Two or more leaf panes with distinct active files: the group
  // scope is the natural "everything in front of me" pick. Without
  // this, opening an overlay from a multi-pane layout would default
  // to whichever pane happened to be focused last, hiding the other
  // panes' files from the result set.
  const visible = visibleFilePaths();
  if (visible.length >= 2) return `group:${scopeKey(visible)}`;
  // Otherwise: the active pane's active file.
  if (activeTab?.kind === "file" && activeTab.path) return `file:${activeTab.path}`;
  return "workspace";
}
