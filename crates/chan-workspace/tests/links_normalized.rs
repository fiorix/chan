// End-to-end: workspace-rooted (`/images/x`) and parent-relative
// (`../images/x`) markdown links resolve to the same backlink target
// as bare workspace-relative paths after `reindex`. Backlinks are
// looked up by the stored target, so a link stored in its raw href
// form would leave an embedded image with no backlink from that
// page.

use chan_workspace::Library;
use tempfile::TempDir;

#[test]
fn abs_and_parent_relative_image_links_both_backlink_to_same_node() {
    let cfg = TempDir::new().unwrap();
    let workspace_root = TempDir::new().unwrap();

    let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
    lib.register_workspace(workspace_root.path()).unwrap();
    let workspace = lib.open_workspace(workspace_root.path()).unwrap();

    // One image placeholder at the workspace root referenced by three
    // sources that each pick a different href shape:
    //   - notes/abs.md         uses /images/foo.png  (workspace-rooted)
    //   - notes/rel.md         uses ../images/foo.png (parent-relative)
    //   - notes/wiki.md        uses [[/images/foo.png]] (wiki, abs)
    // All three backlink to the same canonical `images/foo.png` dst so
    // the inspector sees every source regardless of its href shape.
    workspace
        .write_bytes("images/foo.png", b"\x89PNG\r\n")
        .unwrap();
    workspace
        .write_text("notes/abs.md", "# Abs\n\n![cat](/images/foo.png)\n")
        .unwrap();
    workspace
        .write_text("notes/rel.md", "# Rel\n\n![cat](../images/foo.png)\n")
        .unwrap();
    workspace
        .write_text("notes/wiki.md", "# Wiki\n\n[[/images/foo.png]]\n")
        .unwrap();

    workspace.reindex(None).unwrap();

    let g = workspace.graph().unwrap();
    let back = g.backlinks("images/foo.png").unwrap();
    let mut srcs: Vec<&str> = back.iter().map(|e| e.src.as_str()).collect();
    srcs.sort();
    assert_eq!(
        srcs,
        vec!["notes/abs.md", "notes/rel.md", "notes/wiki.md"],
        "all three href shapes should backlink to the same image node",
    );

    // Negative control: the literal stale strings must not survive
    // as their own dst nodes; only the normalized form should.
    assert!(g.backlinks("/images/foo.png").unwrap().is_empty());
    assert!(g.backlinks("../images/foo.png").unwrap().is_empty());
}

#[test]
fn workspace_escape_link_is_dropped() {
    let cfg = TempDir::new().unwrap();
    let workspace_root = TempDir::new().unwrap();
    let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
    lib.register_workspace(workspace_root.path()).unwrap();
    let workspace = lib.open_workspace(workspace_root.path()).unwrap();

    // `../../etc/passwd` from a depth-1 file pops past the workspace
    // root and the indexer must drop the edge entirely rather than
    // store a literal escape path.
    workspace
        .write_text(
            "notes/post.md",
            "[escape](../../etc/passwd) and [ok](/x.md)\n",
        )
        .unwrap();
    workspace.reindex(None).unwrap();
    let g = workspace.graph().unwrap();
    let neighbors = g.neighbors("notes/post.md").unwrap();
    let dsts: Vec<&str> = neighbors.iter().map(|e| e.dst.as_str()).collect();
    assert_eq!(dsts, vec!["x.md"]);
}
