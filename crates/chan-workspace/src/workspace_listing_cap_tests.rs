use super::*;
use crate::library::Library;
use tempfile::TempDir;

/// The lowered bound every test here rebuilds under.
const LIMIT: usize = 5;

/// One search word per note, so a hit names the one note that holds it.
const WORDS: [&str; LIMIT + 1] = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];

/// A workspace with its startup recovery stopped, so each test drives the
/// full rebuild itself, and the rebuild's listing bound lowered to [`LIMIT`].
struct Fixture {
    workspace: Arc<Workspace>,
    _limit: listing_limit_test_hooks::LimitGuard,
    _root: TempDir,
    _config: TempDir,
}

impl Fixture {
    fn new() -> Self {
        let config = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let library = Library::open_at(config.path().join("config.toml")).unwrap();
        library.register_workspace(root.path()).unwrap();
        let workspace = library.open_workspace(root.path()).unwrap();
        workspace.stop_open_recovery();
        let limit = listing_limit_test_hooks::lower(&workspace, LIMIT);
        Self {
            workspace,
            _limit: limit,
            _root: root,
            _config: config,
        }
    }

    fn write(&self, rel: &str, content: &str) {
        let path = self.workspace.root().join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    /// `notes` indexable files, each holding its word from [`WORDS`],
    /// beside forty directories whose files the index never reads: ten
    /// times the bound in entries the full walk sees.
    fn seed(&self, notes: usize) {
        for (n, word) in WORDS.iter().enumerate().take(notes) {
            let rel = match n % 3 {
                0 => format!("note{n}.md"),
                1 => format!("deep/a/b/note{n}.md"),
                _ => format!("plain/note{n}.txt"),
            };
            self.write(&rel, &format!("# Note\n\n{word}token\n"));
        }
        for d in 0..40 {
            self.write(&format!("evidence/run{d}/shot.png"), "png");
            self.write(&format!("evidence/run{d}/trace.json"), "{}");
        }
    }
}

fn hits(workspace: &Workspace, token: &str) -> Vec<String> {
    workspace
        .search(
            token,
            &SearchOpts {
                mode: SearchMode::Bm25,
                limit: 10,
                scope: None,
            },
        )
        .unwrap()
        .hits
        .into_iter()
        .map(|hit| hit.path)
        .collect()
}

#[test]
fn a_rebuild_under_entries_past_the_cap_builds_when_its_files_fit() {
    let fixture = Fixture::new();
    fixture.seed(LIMIT);
    let walked =
        fs_ops::list_tree_scoped(fixture.workspace.root(), &fixture.workspace.scope_policy())
            .unwrap()
            .len();
    assert!(
        walked > 10 * LIMIT,
        "the fixture must hold many more entries than the bound: {walked}"
    );

    fixture.workspace.reindex(None).unwrap();

    let files = fixture.workspace.graph().unwrap().files().unwrap();
    for rel in [
        "note0.md",
        "deep/a/b/note1.md",
        "note3.md",
        "deep/a/b/note4.md",
    ] {
        assert!(
            files.contains(&rel.to_owned()),
            "{rel} not in the graph: {files:?}"
        );
    }
    assert_eq!(hits(&fixture.workspace, "echotoken"), ["deep/a/b/note4.md"]);
    assert_eq!(
        hits(&fixture.workspace, "charlietoken"),
        ["plain/note2.txt"]
    );
}

#[test]
fn a_rebuild_refuses_once_its_indexable_files_pass_the_cap() {
    let fixture = Fixture::new();
    fixture.seed(LIMIT + 1);

    let refused = fixture.workspace.reindex(None);

    assert!(
        matches!(
            refused,
            Err(ChanError::ListingTooLarge {
                observed: LIMIT,
                limit: LIMIT
            })
        ),
        "{refused:?}"
    );
}

#[test]
fn a_rebuild_over_the_cap_leaves_no_marker_of_its_own() {
    let fixture = Fixture::new();
    fixture.seed(LIMIT + 1);
    let marker = fixture.workspace.paths().graph_dir.join(REBUILD_MARKER);
    assert!(!marker.exists());

    assert!(fixture.workspace.reindex(None).is_err());

    assert!(
        !marker.exists(),
        "a refusal that touched neither store left a marker for the next open"
    );
}

#[test]
fn a_rebuild_over_the_cap_keeps_a_marker_an_earlier_pass_left() {
    let fixture = Fixture::new();
    fixture.seed(LIMIT + 1);
    let marker = fixture.workspace.paths().graph_dir.join(REBUILD_MARKER);
    std::fs::create_dir_all(marker.parent().unwrap()).unwrap();
    std::fs::write(&marker, b"started_at = 1\n").unwrap();

    assert!(fixture.workspace.reindex(None).is_err());

    assert!(
        marker.exists(),
        "the earlier pass's marker says the stores may disagree, and still does"
    );
}

#[test]
fn a_failed_pass_completes_its_generation_without_a_retry() {
    let fixture = Fixture::new();
    let workspace = &fixture.workspace;
    let generation = workspace.request_recovery(RecoveryAction::FullRebuild);
    let pass = workspace.begin_recovery().expect("the pass is claimable");

    let status = workspace
        .finish_recovery(pass, RecoveryOutcome::Failed)
        .unwrap();

    assert!(status.is_ready(), "{status:?}");
    assert_eq!(status.completed_generation, generation);
    assert_eq!(status.pending, None, "the failed pass was requeued");
}
