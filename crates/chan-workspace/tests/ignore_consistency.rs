// End-to-end ignore-set consistency (ignore-consistency-spec.md).
//
// A workspace pointed at a source tree must never index or graph the
// dependency-tree noise (`node_modules/`, `target/`, `venv/`, `.git/`).
// The default registry `index_excluded_dirs` is sane out of the box, so
// a freshly-registered workspace excludes them WITHOUT any config. This test
// seeds a small workspace with real `.md` notes plus fake ignored dirs (junk
// reachable on disk but written outside chan's API, the way a real repo
// tree would be) and asserts:
//   - the filtered listing (the File Browser spine / graph presence set)
//     excludes the ignored dirs;
//   - the search index does not surface their contents;
//   - the semantic graph holds only the real note files;
//   - the RAW unfiltered listing still SEES them, so a user can open a
//     file inside an ignored dir on demand (requirement 3).

use chan_workspace::{
    Library, RecoveryAction, SearchOpts, WalkFilter, WatchCallback, WatchEvent, WatchKind,
};
use std::fs;
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};
use tempfile::TempDir;

fn seed_junk(root: &std::path::Path, rel: &str, body: &str) {
    let abs = root.join(rel);
    fs::create_dir_all(abs.parent().unwrap()).unwrap();
    fs::write(abs, body).unwrap();
}

struct EventChannel(mpsc::Sender<WatchEvent>);

impl WatchCallback for EventChannel {
    fn on_event(&self, event: WatchEvent) {
        let _ = self.0.send(event);
    }
}

fn collect_until(
    rx: &mpsc::Receiver<WatchEvent>,
    timeout: Duration,
    done: impl Fn(&WatchEvent) -> bool,
) -> Vec<WatchEvent> {
    let deadline = Instant::now() + timeout;
    let mut events = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return events;
        }
        match rx.recv_timeout(remaining) {
            Ok(event) => {
                let finished = done(&event);
                events.push(event);
                if finished {
                    return events;
                }
            }
            Err(_) => return events,
        }
    }
}

fn collect_for(rx: &mpsc::Receiver<WatchEvent>, timeout: Duration) -> Vec<WatchEvent> {
    let deadline = Instant::now() + timeout;
    let mut events = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return events;
        }
        match rx.recv_timeout(remaining) {
            Ok(event) => events.push(event),
            Err(_) => return events,
        }
    }
}

#[test]
fn ignored_dirs_absent_from_index_and_graph_by_default() {
    let cfg = TempDir::new().unwrap();
    let workspace_root = TempDir::new().unwrap();
    let root = workspace_root.path();

    let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
    lib.register_workspace(root).unwrap();
    let workspace = lib.open_workspace(root).unwrap();

    // Real notes (through chan's API).
    workspace
        .write_text("intro.md", "# Welcome\n\nReal #notes content.\n")
        .unwrap();
    workspace
        .write_text("notes/today.md", "# Today\n\nMore #notes.\n")
        .unwrap();

    // Fake dependency / VCS trees seeded directly on disk, each holding
    // editable-text junk that WOULD be indexed if the walk descended
    // into it. node_modules nested under a real dir too (any depth).
    seed_junk(root, "node_modules/pkg/index.js", "console.log('dep')\n");
    seed_junk(root, "node_modules/pkg/readme.md", "# dep #notes\n");
    seed_junk(root, "target/debug/build.rs", "fn main() {}\n");
    seed_junk(root, ".venv/lib/site.py", "import os\n");
    seed_junk(root, ".git/HEAD", "ref: refs/heads/main\n");
    seed_junk(root, "notes/node_modules/dep/a.md", "# nested dep #notes\n");

    // --- Filtered listing (File Browser spine + graph presence set) ---
    let filtered: Vec<String> = workspace
        .list_tree_filtered_unified()
        .unwrap()
        .into_iter()
        .map(|e| e.path)
        .collect();
    assert!(filtered.iter().any(|p| p == "intro.md"));
    assert!(filtered.iter().any(|p| p == "notes/today.md"));
    for ignored in [
        "node_modules",
        "node_modules/pkg/index.js",
        "node_modules/pkg/readme.md",
        "target",
        "target/debug/build.rs",
        ".venv",
        ".venv/lib/site.py",
        "notes/node_modules",
        "notes/node_modules/dep/a.md",
    ] {
        assert!(
            !filtered.iter().any(|p| p == ignored),
            "ignored path leaked into filtered listing: {ignored}; got {filtered:?}"
        );
    }

    // --- Raw unfiltered listing still sees them (open-on-demand) ---
    let raw: Vec<String> = workspace
        .list_tree_unified()
        .unwrap()
        .into_iter()
        .map(|e| e.path)
        .collect();
    assert!(
        raw.iter().any(|p| p == "node_modules/pkg/index.js"),
        "raw listing must still see ignored-dir files for on-demand open"
    );

    // --- Index + graph build (the reindex path) ---
    let summary = workspace.reindex(None).unwrap();
    // Only the two real notes are indexed; the dependency-tree junk
    // (incl. node_modules/pkg/readme.md and the nested .md) is excluded.
    assert_eq!(summary.files, 2, "reindex must only see the real notes");
    assert_eq!(summary.indexed, 2);

    // Search index excludes ignored-dir content. "dep" appears only in
    // node_modules; it must not be searchable.
    let dep = workspace.search("dep", &SearchOpts::default()).unwrap();
    assert!(
        dep.hits.is_empty(),
        "node_modules content leaked into the search index: {:?}",
        dep.hits.iter().map(|h| &h.path).collect::<Vec<_>>()
    );

    // Graph holds only the real note files; no node_modules/target nodes.
    let g = workspace.graph().unwrap();
    let graph_files = g.files().unwrap();
    let mut expected = vec!["intro.md".to_string(), "notes/today.md".to_string()];
    expected.sort();
    let mut got = graph_files.clone();
    got.sort();
    assert_eq!(
        got, expected,
        "graph must hold only the real notes, got {graph_files:?}"
    );
    for ignored_prefix in ["node_modules", "target", ".venv", ".git"] {
        assert!(
            !graph_files
                .iter()
                .any(|p| p == ignored_prefix || p.starts_with(&format!("{ignored_prefix}/"))),
            "ignored dir surfaced in the graph: {ignored_prefix}; got {graph_files:?}"
        );
    }

    // --- chan-report language analysis excludes ignored dirs ---
    // The report engine does its own filesystem walk; it must honor the
    // same blocklist or the graph's language layer re-surfaces the
    // dependency trees (target/*.rs as Rust, node_modules/*.js as JS).
    let report = workspace.report().unwrap();
    let report_paths: Vec<&str> = report.files.iter().map(|f| f.path.as_str()).collect();
    for ignored_prefix in ["node_modules", "target", ".venv", ".git"] {
        assert!(
            !report_paths
                .iter()
                .any(|p| *p == ignored_prefix || p.starts_with(&format!("{ignored_prefix}/"))),
            "ignored dir surfaced in the chan-report scan: {ignored_prefix}; got {report_paths:?}"
        );
    }
    // The real Markdown notes ARE in the report.
    assert!(report_paths.contains(&"intro.md"));
    assert!(report_paths.contains(&"notes/today.md"));
}

#[test]
fn per_workspace_exclusion_governs_generation_watch_reconcile_and_report() {
    let cfg = TempDir::new().unwrap();
    let workspace_root = TempDir::new().unwrap();
    let root = workspace_root.path();

    let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
    lib.register_workspace(root).unwrap();
    let workspace = lib.open_workspace(root).unwrap();

    let before = workspace.generation();
    workspace
        .set_excluded_dirs(vec!["generated".to_string()])
        .unwrap();
    assert!(
        workspace.generation() > before,
        "policy replacement must advance the shared workspace generation"
    );
    assert_eq!(
        workspace.recovery_status().required_action(),
        Some(RecoveryAction::Reconcile)
    );

    let (tx, rx) = mpsc::channel();
    let watcher = workspace.watch(Arc::new(EventChannel(tx))).unwrap();
    seed_junk(root, "generated/live.md", "# ignored live event\n");
    seed_junk(root, "kept/live.md", "# kept live event\n");

    let mut events = collect_until(&rx, Duration::from_secs(3), |event| {
        event.kind == WatchKind::Created && event.path.as_deref() == Some("kept/live.md")
    });
    assert!(
        events
            .iter()
            .any(|event| event.path.as_deref() == Some("kept/live.md")),
        "included file did not reach watcher dispatch"
    );
    events.extend(collect_for(&rx, Duration::from_millis(500)));
    let leaked = events.iter().find(|event| {
        event
            .path
            .as_deref()
            .is_some_and(|path| path == "generated" || path.starts_with("generated/"))
    });
    assert!(
        leaked.is_none(),
        "per-workspace exclusion leaked through watcher dispatch: {leaked:?}"
    );
    watcher.stop();

    workspace.reindex(None).unwrap();
    seed_junk(root, "generated/offline.md", "# ignored offline\n");
    seed_junk(root, "kept/offline.md", "# kept offline\n");
    let reconciled = workspace.reconcile().unwrap();
    assert!(reconciled.upserted.contains(&"kept/offline.md".to_string()));
    assert!(
        !reconciled
            .upserted
            .iter()
            .any(|path| path.starts_with("generated/")),
        "per-workspace exclusion leaked through reconcile: {reconciled:?}"
    );

    let report = workspace.report().unwrap();
    assert!(
        !report
            .files
            .iter()
            .any(|file| file.path.starts_with("generated/")),
        "per-workspace exclusion leaked through report scan"
    );
    assert!(report.files.iter().any(|file| file.path == "kept/live.md"));
}

#[test]
fn warm_report_reloads_when_scope_generation_changes() {
    let cfg = TempDir::new().unwrap();
    let workspace_root = TempDir::new().unwrap();
    let root = workspace_root.path();

    let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
    lib.register_workspace(root).unwrap();
    let workspace = lib.open_workspace(root).unwrap();

    seed_junk(root, "generated/before.rs", "fn generated() {}\n");
    seed_junk(root, "kept.rs", "fn kept() {}\n");
    let before = workspace.report().unwrap();
    assert!(
        before
            .files
            .iter()
            .any(|file| file.path == "generated/before.rs"),
        "fixture must warm the report with the soon-to-be-excluded path"
    );

    workspace
        .set_excluded_dirs(vec!["generated".to_string()])
        .unwrap();
    let after = workspace.report().unwrap();
    assert!(
        !after
            .files
            .iter()
            .any(|file| file.path.starts_with("generated/")),
        "warm report retained rows from the previous scope generation"
    );
    assert!(after.files.iter().any(|file| file.path == "kept.rs"));
}

#[test]
fn gitignore_nested_anchored_and_negated_rules_share_workspace_scope() {
    let cfg = TempDir::new().unwrap();
    let workspace_root = TempDir::new().unwrap();
    let root = workspace_root.path();

    seed_junk(
        root,
        ".gitignore",
        "/root-only.md\n*.tmp\n!.git/objects/leak.md\n",
    );
    seed_junk(
        root,
        "docs/.gitignore",
        "/private.md\n*.draft.md\n!important.draft.md\n",
    );
    seed_junk(root, "generated/.gitignore", "*\n!keep.md\n");
    for path in [
        "root-only.md",
        "nested/root-only.md",
        "notes.tmp",
        "private.md",
        "docs/private.md",
        "docs/other.draft.md",
        "docs/important.draft.md",
        "generated/drop.md",
        "generated/keep.md",
        ".git/objects/leak.md",
    ] {
        seed_junk(root, path, &format!("# {path}\n"));
    }

    let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
    lib.register_workspace(root).unwrap();
    let workspace = lib.open_workspace(root).unwrap();
    workspace
        .set_excluded_dirs(vec!["generated".to_string()])
        .unwrap();

    let listed: Vec<String> = workspace
        .list_tree_filtered_unified()
        .unwrap()
        .into_iter()
        .filter(|entry| !entry.is_dir)
        .map(|entry| entry.path)
        .collect();
    for expected in [
        "nested/root-only.md",
        "private.md",
        "docs/important.draft.md",
        "generated/keep.md",
    ] {
        assert!(
            listed.iter().any(|path| path == expected),
            "gitignore include missing from shared scope: {expected}; got {listed:?}"
        );
    }
    for excluded in [
        "root-only.md",
        "notes.tmp",
        "docs/private.md",
        "docs/other.draft.md",
        "generated/drop.md",
        ".git/objects/leak.md",
    ] {
        assert!(
            !listed.iter().any(|path| path == excluded),
            "gitignore exclusion leaked into shared scope: {excluded}; got {listed:?}"
        );
    }

    let report_paths: Vec<String> = workspace
        .report()
        .unwrap()
        .files
        .into_iter()
        .map(|file| file.path)
        .collect();
    for expected in [
        "nested/root-only.md",
        "private.md",
        "docs/important.draft.md",
        "generated/keep.md",
    ] {
        assert!(
            report_paths.iter().any(|path| path == expected),
            "gitignore include missing from report scope: {expected}; got {report_paths:?}"
        );
    }
    for excluded in [
        "root-only.md",
        "docs/private.md",
        "docs/other.draft.md",
        "generated/drop.md",
        ".git/objects/leak.md",
    ] {
        assert!(
            !report_paths.iter().any(|path| path == excluded),
            "gitignore exclusion leaked into report scope: {excluded}; got {report_paths:?}"
        );
    }
}

#[test]
fn gitignore_change_replaces_policy_generation_and_warm_report() {
    let cfg = TempDir::new().unwrap();
    let workspace_root = TempDir::new().unwrap();
    let root = workspace_root.path();
    seed_junk(root, "ignored/before.md", "# Before\n");
    seed_junk(root, "kept.md", "# Kept\n");

    let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
    lib.register_workspace(root).unwrap();
    let workspace = lib.open_workspace(root).unwrap();
    assert!(
        workspace
            .report()
            .unwrap()
            .files
            .iter()
            .any(|file| file.path == "ignored/before.md"),
        "fixture must warm the report before repository policy changes"
    );

    let generation = workspace.generation();
    let (tx, rx) = mpsc::channel();
    let watcher = workspace.watch(Arc::new(EventChannel(tx))).unwrap();
    fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
    let events = collect_until(&rx, Duration::from_secs(3), |event| {
        event.path.as_deref() == Some(".gitignore")
    });
    assert!(
        events
            .iter()
            .any(|event| event.path.as_deref() == Some(".gitignore")),
        "repository policy file change did not reach the watcher"
    );

    let deadline = Instant::now() + Duration::from_secs(3);
    while workspace.generation() == generation && Instant::now() < deadline {
        std::thread::yield_now();
    }
    assert!(
        workspace.generation() > generation,
        ".gitignore change did not replace the policy generation"
    );
    assert!(
        !workspace
            .report()
            .unwrap()
            .files
            .iter()
            .any(|file| file.path.starts_with("ignored/")),
        "warm report retained repository-ignored rows after policy replacement"
    );
    watcher.stop();
}

#[test]
fn vcs_internals_remain_hard_excluded_when_configured_list_is_empty() {
    let cfg = TempDir::new().unwrap();
    let workspace_root = TempDir::new().unwrap();
    let root = workspace_root.path();

    let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
    lib.set_walk_filter(WalkFilter::default());
    lib.register_workspace(root).unwrap();
    fs::create_dir_all(root.join(".git/objects")).unwrap();
    let workspace = lib.open_workspace(root).unwrap();

    let (tx, rx) = mpsc::channel();
    let watcher = workspace.watch(Arc::new(EventChannel(tx))).unwrap();
    seed_junk(root, ".git/objects/pack-test", "object noise\n");
    seed_junk(root, ".git/HEAD", "ref: refs/heads/main\n");

    let mut events = collect_until(&rx, Duration::from_secs(3), |event| {
        event.path.as_deref() == Some(".git/HEAD")
    });
    assert!(
        events
            .iter()
            .any(|event| event.path.as_deref() == Some(".git/HEAD")),
        "narrow VCS control event was not forwarded"
    );
    events.extend(collect_for(&rx, Duration::from_millis(500)));
    let leaked = events.iter().find(|event| {
        event
            .path
            .as_deref()
            .is_some_and(|path| path.starts_with(".git/objects"))
    });
    assert!(
        leaked.is_none(),
        "hard VCS internals leaked through watcher dispatch: {leaked:?}"
    );
    watcher.stop();
}
