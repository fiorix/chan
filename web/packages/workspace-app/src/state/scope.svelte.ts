// The scope type for the Graph overlay. `ScopeOption` is the
// discriminated union the graph uses to describe "what part of my
// world am I looking at": a file, directory, git repo, group of
// visible files, tag, contact, language, the whole workspace, or
// global cross-workspace scope.
//
// Each graph tab stores the chosen scope as a `scopeId` string
// (`file:<path>`, `dir:<path>`, `tag:<id>`, `language:<lang>`, ...);
// GraphPanel's `synthesizeScope` turns that id back into a typed
// ScopeOption and `graphTitle` renders it.
//
// The Search overlay has no scope picker (search is workspace-wide),
// so this module carries no dropdown-options builder.

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
