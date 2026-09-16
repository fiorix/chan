// End-to-end test for the remove/restore + index/graph cleanup
// contract: deleting a file or directory through the Workspace API
// must drop the corresponding graph rows and search-index entries
// without waiting for the next reindex. Restoring the same entry
// must repopulate them.

use chan_workspace::{Library, SearchOpts};
use tempfile::TempDir;

#[test]
fn remove_single_file_drops_graph_and_index() {
    let cfg = TempDir::new().unwrap();
    let workspace_root = TempDir::new().unwrap();
    let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
    lib.register_workspace(workspace_root.path()).unwrap();
    let workspace = lib.open_workspace(workspace_root.path()).unwrap();

    // Markdown link with explicit `.md` so the stored edge `dst`
    // matches the path we'll later pass to `remove`. Wiki links
    // (`[[notes/x]]`) intentionally store an extensionless `dst`
    // (resolved through `Workspace::resolve_link` at query time), so
    // they wouldn't be cleaned up by a path-prefix delete; that's
    // a separate concern from this test.
    workspace
        .write_text(
            "intro.md",
            "# Intro\n\nLinks to [x](notes/x.md). unique-intro-token\n",
        )
        .unwrap();
    workspace
        .write_text("notes/x.md", "# X\n\n#tagged Body of x. unique-x-token\n")
        .unwrap();
    workspace.reindex(None).unwrap();

    // Sanity: both files indexed + linked.
    let g = workspace.graph().unwrap();
    assert!(g.files().unwrap().iter().any(|p| p == "notes/x.md"));
    assert_eq!(
        g.backlinks("notes/x.md").unwrap().len(),
        1,
        "intro -> notes/x.md markdown link should be a backlink",
    );
    assert!(!workspace
        .search("unique-x-token", &SearchOpts::default())
        .unwrap()
        .hits
        .is_empty());

    // Remove the target. Graph + index must reflect it immediately.
    workspace.remove("notes/x.md").unwrap();

    let files = g.files().unwrap();
    assert!(
        !files.iter().any(|p| p == "notes/x.md"),
        "graph node not dropped after remove: {files:?}",
    );
    // Inbound edge from intro.md -> notes/x.md is intentionally
    // preserved: it describes intro.md's body, which still contains
    // the link text. `backlinks("notes/x.md")` returns it as a
    // "broken link" until the source is edited or the entry is
    // restored.
    assert_eq!(
        g.backlinks("notes/x.md").unwrap().len(),
        1,
        "inbound edge from intro.md should survive (it reflects intro.md's body)",
    );
    let hits = workspace
        .search("unique-x-token", &SearchOpts::default())
        .unwrap()
        .hits;
    assert!(
        hits.is_empty(),
        "search must not return removed file: {hits:?}",
    );

    // Restoring brings everything back, no manual reindex.
    let id = workspace.trash_list().unwrap()[0].id.clone();
    workspace.trash_restore(&id).unwrap();

    assert!(workspace
        .graph()
        .unwrap()
        .files()
        .unwrap()
        .iter()
        .any(|p| p == "notes/x.md"));
    assert!(!workspace
        .search("unique-x-token", &SearchOpts::default())
        .unwrap()
        .hits
        .is_empty());
    assert_eq!(
        workspace
            .graph()
            .unwrap()
            .backlinks("notes/x.md")
            .unwrap()
            .len(),
        1,
        "backlink should still be present after restore",
    );
}

#[test]
fn remove_directory_cascades_through_graph_and_index() {
    let cfg = TempDir::new().unwrap();
    let workspace_root = TempDir::new().unwrap();
    let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
    lib.register_workspace(workspace_root.path()).unwrap();
    let workspace = lib.open_workspace(workspace_root.path()).unwrap();

    // A subtree mixing editable text, an image, and a PDF. An outside
    // file links into the subtree to verify backlinks clear too.
    workspace
        .write_text(
            "outside.md",
            "# Outside\n\n![diag](notes/media/diagram.png) and [[notes/inner]]\n",
        )
        .unwrap();
    workspace
        .write_text(
            "notes/inner.md",
            "# Inner\n\nUnique-inner-token. See ./other.txt\n",
        )
        .unwrap();
    workspace
        .write_text("notes/other.txt", "plain text body with sourdough\n")
        .unwrap();
    workspace
        .write_bytes("notes/media/diagram.png", &[0x89, 0x50, 0x4e, 0x47])
        .unwrap();
    workspace
        .write_bytes("notes/media/spec.pdf", b"%PDF-1.7\n")
        .unwrap();
    workspace.reindex(None).unwrap();

    // Sanity: every Markdown node present, backlink to image exists.
    let g = workspace.graph().unwrap();
    let files0 = g.files().unwrap();
    assert!(files0.iter().any(|p| p == "outside.md"));
    assert!(files0.iter().any(|p| p == "notes/inner.md"));
    // .txt is editable + BM25-searchable but not a graph document, so it
    // has no node; its removal/restore is verified through search below.
    assert!(
        !files0.iter().any(|p| p == "notes/other.txt"),
        ".txt must not be a graph node: {files0:?}",
    );
    assert!(
        !workspace
            .search("sourdough", &SearchOpts::default())
            .unwrap()
            .hits
            .is_empty(),
        ".txt content should be BM25-searchable before removal",
    );
    let img_back = g.backlinks("notes/media/diagram.png").unwrap();
    assert_eq!(img_back.len(), 1, "outside.md should backlink the image");

    // Remove the entire `notes` directory.
    workspace.remove("notes").unwrap();

    let files1 = g.files().unwrap();
    // .txt was never a graph node; the Markdown node must be gone (the
    // .txt's BM25 removal is asserted via search below).
    assert!(
        !files1.iter().any(|p| p == "notes/inner.md"),
        "node notes/inner.md still present after dir remove: {files1:?}",
    );
    assert!(
        files1.iter().any(|p| p == "outside.md"),
        "outside.md must survive a sibling-dir remove",
    );
    // The cross-subtree edge outside.md -> notes/media/diagram.png
    // is preserved: outside.md's body still embeds the image; the
    // edge correctly describes that. The target is a broken link
    // until the subtree is restored or outside.md is edited.
    assert_eq!(
        g.backlinks("notes/media/diagram.png").unwrap().len(),
        1,
        "inbound edge to removed image should survive (reflects outside.md's body)",
    );

    // Search: nothing under notes/ should hit, outside.md still does.
    let inner_hits = workspace
        .search("Unique-inner-token", &SearchOpts::default())
        .unwrap();
    assert!(
        inner_hits.hits.is_empty(),
        "stale BM25 row for notes/inner.md"
    );
    let txt_hits = workspace
        .search("sourdough", &SearchOpts::default())
        .unwrap();
    assert!(
        txt_hits.hits.is_empty(),
        "stale BM25 row for notes/other.txt"
    );
    let outside_hits = workspace.search("Outside", &SearchOpts::default()).unwrap();
    assert!(
        outside_hits.hits.iter().any(|h| h.path == "outside.md"),
        "outside file should still be searchable after sibling-dir remove",
    );

    // Restore brings the subtree back with graph + index repopulated.
    let id = workspace.trash_list().unwrap()[0].id.clone();
    workspace.trash_restore(&id).unwrap();
    let files2 = workspace.graph().unwrap().files().unwrap();
    // The Markdown node returns to the graph; the .txt returns to BM25
    // only (it is not a graph document), verified via search below.
    assert!(
        files2.iter().any(|p| p == "notes/inner.md"),
        "notes/inner.md did not return to graph after restore: {files2:?}",
    );
    assert!(!workspace
        .search("Unique-inner-token", &SearchOpts::default())
        .unwrap()
        .hits
        .is_empty());
    assert!(!workspace
        .search("sourdough", &SearchOpts::default())
        .unwrap()
        .hits
        .is_empty());
}

#[test]
fn remove_non_editable_file_keeps_inbound_edges() {
    // Removing an image preserves the embedding markdown's outgoing
    // edge: that edge correctly describes the source body. The
    // image has no node row anyway (only editable-text files do),
    // so there's nothing to drop on the graph node side.
    let cfg = TempDir::new().unwrap();
    let workspace_root = TempDir::new().unwrap();
    let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
    lib.register_workspace(workspace_root.path()).unwrap();
    let workspace = lib.open_workspace(workspace_root.path()).unwrap();

    workspace
        .write_text("post.md", "# Post\n\n![diag](media/diagram.png)\n")
        .unwrap();
    workspace
        .write_bytes("media/diagram.png", &[0x89, 0x50, 0x4e, 0x47])
        .unwrap();
    workspace.reindex(None).unwrap();

    let g = workspace.graph().unwrap();
    assert_eq!(g.backlinks("media/diagram.png").unwrap().len(), 1);

    workspace.remove("media/diagram.png").unwrap();
    // The inbound edge survives the remove; it describes post.md's
    // body, which still says ![](media/diagram.png).
    assert_eq!(
        g.backlinks("media/diagram.png").unwrap().len(),
        1,
        "inbound edge from post.md should survive removing the image",
    );
    let post_edges: Vec<String> = g
        .neighbors("post.md")
        .unwrap()
        .into_iter()
        .map(|e| e.dst)
        .collect();
    assert!(
        post_edges.contains(&"media/diagram.png".to_string()),
        "post.md's outgoing edge is preserved: {post_edges:?}",
    );
}

#[test]
fn restore_directory_indexes_only_in_scope_indexable_text() {
    let cfg = TempDir::new().unwrap();
    let workspace_root = TempDir::new().unwrap();
    let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
    lib.register_workspace(workspace_root.path()).unwrap();
    let workspace = lib.open_workspace(workspace_root.path()).unwrap();

    // One file of each kind the restore walk has to decide on: indexable
    // text in scope, indexable text under an excluded directory name, and
    // a non-text file in scope.
    workspace
        .write_text("pkg/keep.md", "# Keep\n\nkeeptoken body\n")
        .unwrap();
    workspace
        .write_text("pkg/node_modules/dep.md", "# Dep\n\ndeptoken body\n")
        .unwrap();
    workspace
        .write_bytes("pkg/blob.bin", b"blobtoken\n")
        .unwrap();
    workspace.reindex(None).unwrap();

    let paths = |term: &str| -> Vec<String> {
        workspace
            .search(term, &SearchOpts::default())
            .unwrap()
            .hits
            .into_iter()
            .map(|h| h.path)
            .collect()
    };
    assert_eq!(paths("keeptoken"), ["pkg/keep.md"]);
    assert!(
        paths("deptoken").is_empty(),
        "the rebuild indexed under an excluded directory name"
    );
    assert!(
        paths("blobtoken").is_empty(),
        "the rebuild indexed a non-text file"
    );

    workspace.remove("pkg").unwrap();
    assert!(
        paths("keeptoken").is_empty(),
        "stale BM25 row for pkg/keep.md after dir remove"
    );

    let id = workspace.trash_list().unwrap()[0].id.clone();
    workspace.trash_restore(&id).unwrap();
    assert_eq!(paths("keeptoken"), ["pkg/keep.md"]);
    assert!(
        paths("deptoken").is_empty(),
        "restore must not index under an excluded directory name"
    );
    assert!(
        paths("blobtoken").is_empty(),
        "restore must not index a non-text file"
    );
}
