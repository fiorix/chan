use super::*;
use crate::library::Library;
use tempfile::TempDir;

/// A workspace where `bad.md` links `good.md`, both indexed by a first full
/// rebuild before any test makes `bad.md` unreadable.
struct Fixture {
    workspace: Arc<Workspace>,
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
        for (rel, content) in [
            ("bad.md", "# Source\n\nsourceoldtoken [neighbor](good.md)\n"),
            ("good.md", "# Neighbor\n\nneighbortoken\n"),
        ] {
            std::fs::write(workspace.root().join(rel), content).unwrap();
        }
        workspace.reindex(None).unwrap();
        Self {
            workspace,
            _root: root,
            _config: config,
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

/// The positive controls, read before `bad.md` is made unreadable.
fn assert_seeded(workspace: &Workspace) {
    assert_eq!(hits(workspace, "sourceoldtoken"), ["bad.md"]);
    assert_eq!(hits(workspace, "neighbortoken"), ["good.md"]);
    let graph = workspace.graph().unwrap();
    assert!(graph.files().unwrap().contains(&"bad.md".to_owned()));
    assert_eq!(graph.backlinks("good.md").unwrap().len(), 1);
}

/// The readable neighbour keeps its rows through the rebuild.
fn assert_neighbor_intact(workspace: &Workspace) {
    assert_eq!(hits(workspace, "neighbortoken"), ["good.md"]);
    let files = workspace.graph().unwrap().files().unwrap();
    assert!(files.contains(&"good.md".to_owned()));
    assert!(!files.contains(&"bad.md".to_owned()));
}

#[cfg(unix)]
struct RestorePermissions(std::path::PathBuf, std::fs::Permissions);

#[cfg(unix)]
impl RestorePermissions {
    fn set(path: &Path, mode: u32) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let guard = Self(
            path.to_path_buf(),
            std::fs::metadata(path).unwrap().permissions(),
        );
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
        guard
    }
}

#[cfg(unix)]
impl Drop for RestorePermissions {
    fn drop(&mut self) {
        std::fs::set_permissions(&self.0, self.1.clone()).unwrap();
    }
}

#[test]
fn rebuild_drops_the_search_rows_of_an_undecodable_file() {
    let fixture = Fixture::new();
    let workspace = &fixture.workspace;
    assert_seeded(workspace);
    std::fs::write(workspace.root().join("bad.md"), [0xff, 0xfe]).unwrap();
    workspace.reindex(None).unwrap();
    assert_eq!(
        hits(workspace, "sourceoldtoken"),
        Vec::<String>::new(),
        "stale search row of a file the rebuild could not decode"
    );
    assert_neighbor_intact(workspace);
}

#[cfg(unix)]
#[test]
fn rebuild_drops_the_search_rows_of_an_unreadable_file() {
    let fixture = Fixture::new();
    let workspace = &fixture.workspace;
    assert_seeded(workspace);
    let path = workspace.root().join("bad.md");
    let _permissions = RestorePermissions::set(&path, 0);
    assert_eq!(
        std::fs::read(&path).unwrap_err().kind(),
        std::io::ErrorKind::PermissionDenied,
        "the fixture must deny a plain read by this non-root test user"
    );
    workspace.reindex(None).unwrap();
    assert_eq!(
        hits(workspace, "sourceoldtoken"),
        Vec::<String>::new(),
        "stale search row of a file the rebuild could not read"
    );
    assert_neighbor_intact(workspace);
}

#[cfg(unix)]
#[test]
fn rebuild_over_a_refused_graph_directory_is_an_error() {
    let fixture = Fixture::new();
    let workspace = &fixture.workspace;
    let graph_dir = workspace.paths().graph_dir.clone();
    let _permissions = RestorePermissions::set(&graph_dir, 0o500);
    assert_eq!(
        std::fs::write(graph_dir.join("refused-probe"), b"probe")
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::PermissionDenied,
        "the fixture must deny a plain write by this non-root test user"
    );
    let (events, result) = capture(|| workspace.reindex(None));
    assert!(
        result.is_err(),
        "a derived-state failure stays an error: {result:?}"
    );
    assert!(with_message(&events, SKIP).is_empty(), "{events:?}");
}

const SKIP: &str = "reindex: skipped unreadable source file";
const FAILED: &str = "reindex: failed to index file";

/// One captured event: its level and its fields as formatted text.
#[derive(Debug)]
struct Event {
    level: tracing::Level,
    fields: std::collections::BTreeMap<String, String>,
}

impl tracing::field::Visit for Event {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        self.fields
            .insert(field.name().to_owned(), format!("{value:?}"));
    }
}

struct Capture(Arc<std::sync::Mutex<Vec<Event>>>);

impl tracing::Subscriber for Capture {
    fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
        true
    }
    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }
    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn event(&self, event: &tracing::Event<'_>) {
        let mut recorded = Event {
            level: *event.metadata().level(),
            fields: Default::default(),
        };
        event.record(&mut recorded);
        self.0.lock().unwrap().push(recorded);
    }
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
}

/// Run `f` with this thread's events captured.
///
/// With one dispatcher registered, tracing-core caches a callsite's interest
/// from whichever thread reaches it first, so another test's thread reaching
/// a warning first while this capture is the only dispatcher would cache it as
/// disabled. A second registered dispatcher, held for the capture, makes that
/// registration consult every dispatcher, and the rebuild under the capture
/// corrects a callsite cached before it existed.
fn capture<T>(f: impl FnOnce() -> T) -> (Vec<Event>, T) {
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let dispatch = tracing::Dispatch::new(Capture(Arc::clone(&events)));
    let _registered = tracing::Dispatch::new(tracing::subscriber::NoSubscriber::default());
    let result = tracing::dispatcher::with_default(&dispatch, || {
        tracing::callsite::rebuild_interest_cache();
        tracing::info!("rebuild-capture-control");
        f()
    });
    let captured = std::mem::take(&mut *events.lock().unwrap());
    assert!(captured.iter().any(|event| event
        .fields
        .get("message")
        .is_some_and(|message| message == "rebuild-capture-control")));
    (captured, result)
}

fn with_message<'a>(events: &'a [Event], message: &str) -> Vec<&'a Event> {
    events
        .iter()
        .filter(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|text| text == message)
        })
        .collect()
}

#[test]
fn rebuild_names_a_skipped_file_apart_from_index_failures() {
    let fixture = Fixture::new();
    let workspace = &fixture.workspace;
    std::fs::write(workspace.root().join("bad.md"), [0xff, 0xfe]).unwrap();
    let summary = workspace.reindex(None).unwrap();
    assert!(
        summary.errors.is_empty(),
        "a failed read is not an index failure: {:?}",
        summary.errors
    );
    let skipped: Vec<(&str, std::io::ErrorKind)> = summary
        .skipped
        .iter()
        .map(|(rel, error)| (rel.as_str(), error.kind()))
        .collect();
    assert_eq!(skipped, [("bad.md", std::io::ErrorKind::InvalidData)]);
}

#[test]
fn rebuild_warns_once_naming_the_skipped_file() {
    let fixture = Fixture::new();
    let workspace = &fixture.workspace;
    let path = workspace.root().join("bad.md");
    std::fs::write(&path, [0xff, 0xfe]).unwrap();
    let expected_error = std::fs::read_to_string(&path).unwrap_err().to_string();
    let (events, _summary) = capture(|| workspace.reindex(None).unwrap());
    let skips = with_message(&events, SKIP);
    assert_eq!(skips.len(), 1, "one skip warning: {events:?}");
    assert_eq!(skips[0].level, tracing::Level::WARN);
    assert_eq!(
        skips[0].fields.get("path").map(String::as_str),
        Some("bad.md"),
        "skip warning path"
    );
    assert_eq!(skips[0].fields.get("error"), Some(&expected_error));
    assert!(with_message(&events, FAILED).is_empty(), "{events:?}");
}

#[test]
fn rebuild_reports_an_index_failure_apart_from_skips() {
    let fixture = Fixture::new();
    let workspace = &fixture.workspace;
    crate::index::facade::fail_next_build_index_write("good.md");
    let (events, summary) = capture(|| workspace.reindex(None).unwrap());
    let failed: Vec<&str> = summary.errors.iter().map(|(rel, _)| rel.as_str()).collect();
    assert_eq!(
        failed,
        ["good.md"],
        "a BM25 write failure is an index failure"
    );
    assert!(summary.skipped.is_empty(), "{:?}", summary.skipped);
    let warnings = with_message(&events, FAILED);
    assert_eq!(warnings.len(), 1, "one index-failure warning: {events:?}");
    assert_eq!(warnings[0].level, tracing::Level::WARN);
    assert_eq!(
        warnings[0].fields.get("path").map(String::as_str),
        Some("good.md")
    );
    assert!(warnings[0].fields["error"].contains("injected BM25 write failure"));
    assert!(with_message(&events, SKIP).is_empty(), "{events:?}");
}

#[test]
fn rebuild_forgets_a_file_that_vanishes_during_the_walk_without_a_warning() {
    let fixture = Fixture::new();
    let workspace = &fixture.workspace;
    assert_seeded(workspace);
    let path = workspace.root().join("bad.md");
    crate::index::facade::after_next_build_listing(move || std::fs::remove_file(path).unwrap());
    let (events, summary) = capture(|| workspace.reindex(None).unwrap());
    let skipped: Vec<(&str, std::io::ErrorKind)> = summary
        .skipped
        .iter()
        .map(|(rel, error)| (rel.as_str(), error.kind()))
        .collect();
    assert_eq!(skipped, [("bad.md", std::io::ErrorKind::NotFound)]);
    assert!(
        !events
            .iter()
            .any(|event| event.level == tracing::Level::WARN
                && event.fields.get("path").map(String::as_str) == Some("bad.md")),
        "no warning names a file that vanished during the walk: {events:?}"
    );
    assert_eq!(hits(workspace, "sourceoldtoken"), Vec::<String>::new());
    assert_eq!(hits(workspace, "neighbortoken"), ["good.md"]);
}
