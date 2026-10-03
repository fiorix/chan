// GraphPanel resolves each graph tab's scopeId into this type.

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
  | { id: "workspace"; kind: "workspace"; label: string; enabled?: boolean };
