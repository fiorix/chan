// End-to-end coverage: scan, incremental update, JSONL round-trip,
// scope filtering. Uses tempdirs so nothing touches the developer's
// real filesystem.

use std::fs;
use std::io::Cursor;

use chan_report::{
    CocomoParams, FileBucket, FileStats, Index, LanguageStats, Report, ReportOptions, Scope,
    Totals, UpdateOutcome, SCHEMA_VERSION,
};

use tempfile::tempdir;

fn write(root: &std::path::Path, rel: &str, content: &str) {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, content).unwrap();
}

#[test]
fn scan_picks_up_known_languages() {
    let d = tempdir().unwrap();
    write(
        d.path(),
        "main.rs",
        "fn main() {\n    if true { println!(); }\n}\n",
    );
    write(d.path(), "notes.md", "# heading\n\ntext.\n");
    write(d.path(), "tool.py", "def foo():\n    return 1\n");

    let idx = Index::scan(&ReportOptions::new(d.path())).unwrap();
    assert_eq!(idx.len(), 3, "expected three counted files");

    let rs = idx.file("main.rs").expect("main.rs tracked");
    assert_eq!(rs.language, "Rust");
    assert!(rs.code >= 1);
    assert!(rs.complexity >= 1, "if-branch should contribute");
}

#[test]
fn update_outcomes_are_distinct() {
    let d = tempdir().unwrap();
    write(d.path(), "a.rs", "fn a() {}\n");
    let mut idx = Index::scan(&ReportOptions::new(d.path())).unwrap();

    write(d.path(), "b.rs", "fn b() {}\n");
    assert_eq!(idx.update("b.rs").unwrap(), UpdateOutcome::Inserted);

    // Re-running with no on-disk change should be Unchanged.
    assert_eq!(idx.update("a.rs").unwrap(), UpdateOutcome::Unchanged);

    write(d.path(), "a.rs", "fn a() { let _ = 1; }\n");
    assert_eq!(idx.update("a.rs").unwrap(), UpdateOutcome::Updated);

    fs::remove_file(d.path().join("b.rs")).unwrap();
    assert_eq!(idx.update("b.rs").unwrap(), UpdateOutcome::Removed);

    // remove() on something we never had: Unchanged.
    assert_eq!(idx.remove("never.rs"), UpdateOutcome::Unchanged);
}

#[test]
fn rename_moves_row() {
    let d = tempdir().unwrap();
    write(d.path(), "old.rs", "fn x() {}\n");
    let mut idx = Index::scan(&ReportOptions::new(d.path())).unwrap();
    assert!(idx.file("old.rs").is_some());

    fs::rename(d.path().join("old.rs"), d.path().join("new.rs")).unwrap();
    let out = idx.rename("old.rs", "new.rs").unwrap();
    // Either Inserted (rename hit the update path) or Removed (if
    // counter rejected). Both should result in the row moving.
    assert!(matches!(
        out,
        UpdateOutcome::Inserted | UpdateOutcome::Updated
    ));
    assert!(idx.file("old.rs").is_none());
    assert!(idx.file("new.rs").is_some());
}

#[test]
fn jsonl_round_trip_preserves_file_rows() {
    let d = tempdir().unwrap();
    write(d.path(), "x.py", "def foo():\n    pass\n");
    write(d.path(), "y.md", "# y\n");
    let idx = Index::scan(&ReportOptions::new(d.path())).unwrap();

    let mut buf = Vec::new();
    idx.write_jsonl(&mut buf, &Scope::All, &CocomoParams::default())
        .unwrap();

    // Smoke check: the first line is the meta record.
    let text = std::str::from_utf8(&buf).unwrap();
    let first = text.lines().next().unwrap();
    assert!(first.contains("\"kind\":\"meta\""));
    assert!(first.contains(&format!("\"schema\":{}", SCHEMA_VERSION)));

    let opts = ReportOptions::new(d.path());
    let reloaded = Index::load_jsonl(Cursor::new(buf), &opts).unwrap();
    assert_eq!(reloaded.len(), idx.len());
    assert_eq!(reloaded.file("x.py"), idx.file("x.py"));
}

#[test]
fn scope_prefix_restricts_rollups() {
    let d = tempdir().unwrap();
    write(d.path(), "src/lib.rs", "fn x() { if true {} }\n");
    write(d.path(), "src/main.rs", "fn main() {}\n");
    write(d.path(), "README.md", "# h\n");

    let idx = Index::scan(&ReportOptions::new(d.path())).unwrap();
    let scoped: Report = idx.snapshot(&Scope::Prefix("src".into()), &CocomoParams::default());
    assert_eq!(scoped.files.len(), 2);
    assert!(scoped.files.iter().all(|f| f.path.starts_with("src/")));
    assert_eq!(scoped.totals.files, 2);
    assert!(scoped.totals.bytes > 0);
    // by_language for the scope contains Rust only.
    assert_eq!(scoped.by_language.len(), 1);
    assert_eq!(scoped.by_language[0].name, "Rust");
    assert!(scoped.by_language[0].bytes > 0);
}

#[test]
fn scope_files_picks_explicit_rows() {
    let d = tempdir().unwrap();
    write(d.path(), "a.rs", "fn a() {}\n");
    write(d.path(), "b.rs", "fn b() {}\n");
    write(d.path(), "c.rs", "fn c() {}\n");
    let idx = Index::scan(&ReportOptions::new(d.path())).unwrap();

    let scoped = idx.snapshot(
        &Scope::Files(vec!["a.rs".into(), "c.rs".into(), "missing.rs".into()]),
        &CocomoParams::default(),
    );
    assert_eq!(scoped.files.len(), 2);
    assert_eq!(scoped.totals.files, 2);
}

#[test]
fn gitignore_filters_during_scan_and_update() {
    let d = tempdir().unwrap();
    write(d.path(), ".gitignore", "target/\n");
    write(d.path(), "src/lib.rs", "fn x() {}\n");
    write(d.path(), "target/junk.rs", "fn junk() {}\n");

    let idx = Index::scan(&ReportOptions::new(d.path())).unwrap();
    assert!(idx.file("src/lib.rs").is_some());
    assert!(idx.file("target/junk.rs").is_none());

    // Incremental path should also reject the ignored file.
    let mut idx = idx;
    let outcome = idx.update("target/junk.rs").unwrap();
    assert_eq!(outcome, UpdateOutcome::Skipped);
}

#[test]
fn dir_report_root_matches_all_scope() {
    // The maintained cache at the empty-string key must agree
    // with the O(N) snapshot(All) path on every aggregate field.
    // This is the cache's load-bearing invariant -- any drift
    // here means the dir endpoint reports different numbers than
    // the existing prefix endpoint for the same set of files.
    let d = tempdir().unwrap();
    write(d.path(), "main.rs", "fn main() {}\n");
    write(d.path(), "lib.rs", "pub fn x() {}\n");
    write(d.path(), "notes.md", "# h\n\ntext.\n");
    write(d.path(), "src/util.rs", "pub fn u() {}\n");

    let idx = Index::scan(&ReportOptions::new(d.path())).unwrap();
    let params = CocomoParams::default();
    let dir_root = idx.dir_report("", &params).expect("root dir tracked");
    let all = idx.snapshot(&Scope::All, &params);

    assert_eq!(dir_root.totals, all.totals);
    assert_eq!(dir_root.by_language, all.by_language);
    // CocomoSummary is f64-fielded; compare effort_person_months as
    // the load-bearing output (the rest derives from it deterministically).
    assert_eq!(
        dir_root.cocomo.effort_person_months,
        all.cocomo.effort_person_months
    );
    assert!(
        dir_root.files.is_empty(),
        "dir_report does not enumerate files; consumers use Scope::Prefix for that"
    );
}

#[test]
fn dir_report_subdir_matches_prefix_scope() {
    // A subdirectory's cached aggregate must equal Scope::Prefix
    // for the same path. Tests the typical inspector use case:
    // "what's in crates/chan-workspace/?".
    let d = tempdir().unwrap();
    write(d.path(), "src/main.rs", "fn main() {}\n");
    write(d.path(), "src/lib.rs", "pub fn x() {}\n");
    write(d.path(), "src/util/helper.rs", "pub fn h() {}\n");
    write(d.path(), "README.md", "# h\n");

    let idx = Index::scan(&ReportOptions::new(d.path())).unwrap();
    let params = CocomoParams::default();

    let dir = idx.dir_report("src", &params).expect("src tracked");
    let prefix = idx.snapshot(&Scope::Prefix("src".into()), &params);

    assert_eq!(dir.totals, prefix.totals);
    assert_eq!(dir.by_language, prefix.by_language);
    assert_eq!(
        dir.cocomo.effort_person_months,
        prefix.cocomo.effort_person_months
    );
    assert_eq!(dir.totals.files, 3, "all three .rs files counted");
}

#[test]
fn dir_report_handles_trailing_and_leading_slashes() {
    // Path normalization: "src", "src/", "/src", "/src/" all map
    // to the same cache key. Common in HTTP query strings; we
    // strip slashes rather than refuse the request.
    let d = tempdir().unwrap();
    write(d.path(), "src/lib.rs", "pub fn x() {}\n");
    let idx = Index::scan(&ReportOptions::new(d.path())).unwrap();
    let params = CocomoParams::default();

    let plain = idx.dir_report("src", &params).expect("plain");
    let trailing = idx.dir_report("src/", &params).expect("trailing");
    let leading = idx.dir_report("/src", &params).expect("leading");
    let both = idx.dir_report("/src/", &params).expect("both");

    // All four should agree on totals; generated_at differs per
    // call so we compare the meaningful fields only.
    assert_eq!(plain.totals, trailing.totals);
    assert_eq!(plain.totals, leading.totals);
    assert_eq!(plain.totals, both.totals);
}

#[test]
fn dir_report_missing_dir_is_none() {
    // A directory with no tracked files (gitignored target/,
    // misspelled path, or genuinely absent) yields None. Lets
    // chan-server return 404 cleanly instead of synthesizing an
    // empty roll-up that looks like a real dir.
    let d = tempdir().unwrap();
    write(d.path(), "src/lib.rs", "fn x() {}\n");
    let idx = Index::scan(&ReportOptions::new(d.path())).unwrap();
    assert!(idx
        .dir_report("does/not/exist", &CocomoParams::default())
        .is_none());
}

#[test]
fn dir_report_root_aggregates_multiple_languages() {
    // Per-language sub-rollup must surface all languages present
    // and reproduce the sort order (desc by bytes / files,
    // asc by name).
    let d = tempdir().unwrap();
    write(d.path(), "a.rs", "fn a() {}\nfn b() {}\nfn c() {}\n");
    write(d.path(), "b.py", "def x():\n    pass\n");
    write(d.path(), "c.md", "# h\n");

    let idx = Index::scan(&ReportOptions::new(d.path())).unwrap();
    let r = idx.dir_report("", &CocomoParams::default()).unwrap();
    let names: Vec<&str> = r.by_language.iter().map(|l| l.name.as_str()).collect();
    assert!(names.contains(&"Rust"));
    assert!(names.contains(&"Python"));
    assert!(names.contains(&"Markdown"));
    // Total file count across languages == totals.files.
    let total_files: u64 = r.by_language.iter().map(|l| l.files).sum();
    assert_eq!(total_files, r.totals.files);
}

#[test]
fn incremental_insert_updates_ancestor_chain() {
    // The cache must absorb a fresh insert without a full rescan;
    // every ancestor dir picks up the new stats.
    let d = tempdir().unwrap();
    let mut idx = Index::scan(&ReportOptions::new(d.path())).unwrap();
    assert!(idx.dir_report("", &CocomoParams::default()).is_none());

    write(d.path(), "a/b/c.rs", "fn x() {}\n");
    assert_eq!(idx.update("a/b/c.rs").unwrap(), UpdateOutcome::Inserted);

    let p = CocomoParams::default();
    // Root, a/, a/b/ all see the file.
    let root = idx.dir_report("", &p).expect("root tracks file");
    let a = idx.dir_report("a", &p).expect("a tracks file");
    let ab = idx.dir_report("a/b", &p).expect("a/b tracks file");
    assert_eq!(root.totals.files, 1);
    assert_eq!(a.totals.files, 1);
    assert_eq!(ab.totals.files, 1);
    // The file's own path is NOT a directory key.
    assert!(idx.dir_report("a/b/c.rs", &p).is_none());
}

#[test]
fn incremental_remove_clears_ancestor_chain_when_last_file_leaves() {
    // After the last file under a directory leaves, the dir
    // entry is dropped -- the cache mirrors "dirs that currently
    // contain tracked files". This prevents stale rows from
    // surfacing as ghost directories.
    let d = tempdir().unwrap();
    write(d.path(), "a/b/c.rs", "fn x() {}\n");
    let mut idx = Index::scan(&ReportOptions::new(d.path())).unwrap();
    let p = CocomoParams::default();
    assert!(idx.dir_report("a/b", &p).is_some());

    fs::remove_file(d.path().join("a/b/c.rs")).unwrap();
    assert_eq!(idx.update("a/b/c.rs").unwrap(), UpdateOutcome::Removed);

    assert!(idx.dir_report("a/b", &p).is_none());
    assert!(idx.dir_report("a", &p).is_none());
    assert!(idx.dir_report("", &p).is_none());
}

/// Sum the per-file rows field by field, independently of the crate's
/// own roll-up arithmetic, so a cache or roll-up that drops a field is
/// caught by name.
fn totals_of(rows: &[FileStats]) -> Totals {
    Totals {
        files: rows.len() as u64,
        bytes: rows.iter().map(|f| f.bytes).sum(),
        code: rows.iter().map(|f| f.code).sum(),
        comments: rows.iter().map(|f| f.comments).sum(),
        blanks: rows.iter().map(|f| f.blanks).sum(),
        complexity: rows.iter().map(|f| f.complexity).sum(),
    }
}

#[test]
fn incremental_update_applies_delta_to_ancestors() {
    // Modifying an existing file applies the *delta* against the
    // ancestor chain, not a re-add. Confirms the subtract-then-add
    // shape inside Index::update. Both versions of the file carry a
    // comment, a blank line and a branch keyword so every aggregate
    // field is non-zero on both sides of the delta: a subtraction that
    // skips a field leaves the old value behind, and an addition that
    // skips one never reaches the expected sum. A second file shares
    // every ancestor so the delta is applied to a surviving entry: a
    // directory whose last file is subtracted is dropped and rebuilt,
    // which would hide a skipped field.
    let d = tempdir().unwrap();
    write(
        d.path(),
        "src/lib.rs",
        "// x\n\nfn x() {\n    if true {}\n}\n",
    );
    write(
        d.path(),
        "src/other.rs",
        "// o\n\nfn o() {\n    if true {}\n}\n",
    );
    let mut idx = Index::scan(&ReportOptions::new(d.path())).unwrap();
    let p = CocomoParams::default();

    let before = idx.dir_report("src", &p).unwrap();
    assert_eq!(before.totals.files, 2);
    let old_row = idx.file("src/lib.rs").unwrap().clone();
    assert!(
        old_row.comments > 0 && old_row.blanks > 0 && old_row.complexity > 0,
        "fixture must exercise every field before the update: {old_row:?}"
    );

    write(
        d.path(),
        "src/lib.rs",
        "// x\n// y\n\n\nfn x() {\n    if true {}\n    if false {}\n}\nfn y() {}\n",
    );
    assert_eq!(idx.update("src/lib.rs").unwrap(), UpdateOutcome::Updated);

    let after = idx.dir_report("src", &p).unwrap();
    assert_eq!(after.totals.files, 2, "still two files, one just bigger");
    assert!(
        after.totals.code > before.totals.code,
        "code total reflects the larger file"
    );
    assert!(
        after.totals.bytes > before.totals.bytes,
        "bytes total reflects the larger file"
    );

    // The maintained cache and the whole-tree roll-up must both equal a
    // field-by-field sum of the rows, computed here rather than by the
    // crate.
    let new_row = idx.file("src/lib.rs").unwrap();
    assert!(
        new_row.comments > 0 && new_row.blanks > 0 && new_row.complexity > 0,
        "fixture must exercise every field after the update: {new_row:?}"
    );
    let all = idx.snapshot(&Scope::All, &p);
    let expected = totals_of(&all.files);
    let root = idx
        .dir_report("", &p)
        .expect("root tracked after the update");
    assert_eq!(root.totals, expected, "root cache after the update");
    assert_eq!(all.totals, expected, "whole-tree roll-up after the update");
    let expected_rust = LanguageStats {
        name: "Rust".into(),
        files: expected.files,
        bytes: expected.bytes,
        code: expected.code,
        comments: expected.comments,
        blanks: expected.blanks,
        complexity: expected.complexity,
    };
    assert_eq!(
        root.by_language,
        vec![expected_rust.clone()],
        "root per-language cache after the update"
    );
    assert_eq!(
        all.by_language,
        vec![expected_rust],
        "whole-tree per-language roll-up after the update"
    );
}

#[test]
fn incremental_update_unchanged_does_not_drift_ancestors() {
    // An Unchanged update must not touch the cache at all -- drift
    // here would compound over a session of no-op writes.
    let d = tempdir().unwrap();
    write(d.path(), "src/lib.rs", "fn x() {}\n");
    let mut idx = Index::scan(&ReportOptions::new(d.path())).unwrap();
    let p = CocomoParams::default();
    let before = idx.dir_report("src", &p).unwrap();

    assert_eq!(idx.update("src/lib.rs").unwrap(), UpdateOutcome::Unchanged);
    let after = idx.dir_report("src", &p).unwrap();
    assert_eq!(before.totals, after.totals);
    assert_eq!(before.by_language, after.by_language);
}

#[test]
fn rename_moves_stats_between_ancestor_chains() {
    // A rename across directories must subtract from the old
    // ancestor chain AND add to the new one: a rename that only runs
    // update(to) without unwinding from's contribution leaves the old
    // chain's totals inflated.
    let d = tempdir().unwrap();
    write(d.path(), "old/a.rs", "fn a() {}\n");
    let mut idx = Index::scan(&ReportOptions::new(d.path())).unwrap();
    let p = CocomoParams::default();
    assert!(idx.dir_report("old", &p).is_some());
    assert!(idx.dir_report("new", &p).is_none());

    write(d.path(), "new/a.rs", "fn a() {}\n");
    fs::remove_file(d.path().join("old/a.rs")).unwrap();
    let out = idx.rename("old/a.rs", "new/a.rs").unwrap();
    assert!(matches!(
        out,
        UpdateOutcome::Inserted | UpdateOutcome::Updated
    ));

    assert!(idx.dir_report("old", &p).is_none(), "old dir empty");
    let new = idx.dir_report("new", &p).expect("new dir populated");
    assert_eq!(new.totals.files, 1);
    // Root sees the file too, unchanged from before the rename.
    assert_eq!(idx.dir_report("", &p).unwrap().totals.files, 1);
}

#[test]
fn deep_directory_chain_propagates() {
    // Five-level-deep file: every ancestor from root down to the
    // immediate parent reports the same single-file stats.
    let d = tempdir().unwrap();
    write(d.path(), "a/b/c/d/e/file.rs", "fn x() {}\n");
    let idx = Index::scan(&ReportOptions::new(d.path())).unwrap();
    let p = CocomoParams::default();
    for dir in ["", "a", "a/b", "a/b/c", "a/b/c/d", "a/b/c/d/e"] {
        let r = idx
            .dir_report(dir, &p)
            .unwrap_or_else(|| panic!("expected dir {dir} tracked"));
        assert_eq!(r.totals.files, 1, "dir {dir} sees the file");
        assert!(r.totals.code >= 1, "dir {dir} has code total");
    }
}

#[test]
fn dir_report_survives_jsonl_roundtrip() {
    // load_jsonl must rebuild the dirs cache from the file rows  --
    // we don't persist the cache. Round-trip equality on totals
    // is the load-bearing check.
    let d = tempdir().unwrap();
    write(d.path(), "src/a.rs", "fn a() {}\n");
    write(d.path(), "src/sub/b.py", "def b():\n    pass\n");
    let idx = Index::scan(&ReportOptions::new(d.path())).unwrap();
    let p = CocomoParams::default();
    let before = idx.dir_report("src", &p).unwrap();

    let mut buf = Vec::new();
    idx.write_jsonl(&mut buf, &Scope::All, &p).unwrap();

    let opts = ReportOptions::new(d.path());
    let reloaded = Index::load_jsonl(Cursor::new(buf), &opts).unwrap();
    let after = reloaded.dir_report("src", &p).unwrap();
    assert_eq!(before.totals, after.totals);
    assert_eq!(before.by_language, after.by_language);
}

#[test]
fn file_bucket_is_markdown_for_md_files() {
    // The graph colour scheme distinguishes
    // markdown notes (orange) from source code (royalblue).
    // chan-report carries the Markdown bucket explicitly so the
    // graph layer doesn't have to re-detect the language at
    // render time.
    let d = tempdir().unwrap();
    write(d.path(), "notes/intro.md", "# Intro\n\nbody.\n");
    let idx = Index::scan(&ReportOptions::new(d.path())).unwrap();
    let row = idx.file("notes/intro.md").expect("md tracked");
    assert_eq!(row.bucket, Some(FileBucket::Markdown));
}

#[test]
fn file_bucket_is_source_code_for_known_languages() {
    // Rust / Python / TypeScript / TOML -- all source code from
    // tokei's perspective. The bucket carries the language name
    // through verbatim so consumers can group + display per-language
    // without re-parsing.
    let d = tempdir().unwrap();
    write(d.path(), "src/main.rs", "fn main() {}\n");
    write(d.path(), "tool.py", "def x():\n    return 1\n");
    write(d.path(), "ui.ts", "export const x = 1;\n");
    write(d.path(), "Cargo.toml", "[package]\nname = \"x\"\n");
    let idx = Index::scan(&ReportOptions::new(d.path())).unwrap();

    let rs = idx.file("src/main.rs").expect("rust tracked");
    assert!(
        matches!(&rs.bucket, Some(FileBucket::SourceCode { language }) if language == "Rust"),
        "expected SourceCode {{ Rust }}, got {:?}",
        rs.bucket
    );
    let py = idx.file("tool.py").expect("python tracked");
    assert!(
        matches!(&py.bucket, Some(FileBucket::SourceCode { language }) if language == "Python"),
        "expected SourceCode {{ Python }}, got {:?}",
        py.bucket
    );
    let ts = idx.file("ui.ts").expect("typescript tracked");
    assert!(
        matches!(&ts.bucket, Some(FileBucket::SourceCode { language }) if language == "TypeScript"),
        "expected SourceCode {{ TypeScript }}, got {:?}",
        ts.bucket
    );
    let toml = idx.file("Cargo.toml").expect("toml tracked");
    assert!(
        matches!(&toml.bucket, Some(FileBucket::SourceCode { language }) if language == "TOML"),
        "expected SourceCode {{ TOML }}, got {:?}",
        toml.bucket
    );
}

#[test]
fn file_bucket_round_trips_through_jsonl() {
    // The bucket field is additive on FileStats and must survive
    // write_jsonl → load_jsonl. Schema stays at v1 (backward-
    // compat via `#[serde(default, skip_serializing_if = "Option::is_none")]`).
    let d = tempdir().unwrap();
    write(d.path(), "notes/a.md", "# a\n");
    write(d.path(), "src/lib.rs", "fn x() {}\n");

    let idx = Index::scan(&ReportOptions::new(d.path())).unwrap();
    let mut buf = Vec::new();
    idx.write_jsonl(&mut buf, &Scope::All, &CocomoParams::default())
        .unwrap();

    let opts = ReportOptions::new(d.path());
    let reloaded = Index::load_jsonl(Cursor::new(buf), &opts).unwrap();
    assert_eq!(
        reloaded.file("notes/a.md").unwrap().bucket,
        Some(FileBucket::Markdown)
    );
    let rs_bucket = reloaded.file("src/lib.rs").unwrap().bucket.clone();
    assert!(
        matches!(rs_bucket, Some(FileBucket::SourceCode { language }) if language == "Rust"),
        "Rust bucket lost across JSONL round-trip; got {:?}",
        reloaded.file("src/lib.rs").unwrap().bucket
    );
}

#[test]
fn file_bucket_absent_in_old_jsonl_loads_as_none() {
    // Backward-compat invariant: a JSONL file written before the
    // bucket field existed doesn't have it. The loader must
    // accept it cleanly + default the missing field to None, so
    // older workspaces don't trip schema-mismatch on first open.
    let d = tempdir().unwrap();
    // Hand-write a JSONL stream with the legacy file-row
    // shape (no `bucket` field). One meta + one file row.
    let old = format!(
        "{{\"kind\":\"meta\",\"schema\":{},\"root\":\"/abs\",\"generated_at\":\"2026-05-12T12:00:00Z\"}}\n\
         {{\"kind\":\"file\",\"path\":\"src/lib.rs\",\"language\":\"Rust\",\"code\":10,\"comments\":2,\"blanks\":1,\"complexity\":3,\"bytes\":120}}\n",
        SCHEMA_VERSION
    );
    let opts = ReportOptions::new(d.path());
    let idx = Index::load_jsonl(Cursor::new(old.as_bytes()), &opts).unwrap();
    let row = idx.file("src/lib.rs").expect("file row loaded");
    assert_eq!(
        row.bucket, None,
        "missing bucket field must default to None"
    );
    assert_eq!(row.language, "Rust", "other fields unaffected");
}

#[test]
fn a_meta_record_without_a_skip_count_loads_as_zero() {
    // A `meta` record without `skipped_entries` describes a scan that
    // skipped nothing, so the loaded index reports zero.
    let d = tempdir().unwrap();
    let complete = format!(
        "{{\"kind\":\"meta\",\"schema\":{},\"root\":\"/abs\",\"generated_at\":\"2026-05-12T12:00:00Z\"}}\n\
         {{\"kind\":\"file\",\"path\":\"src/lib.rs\",\"language\":\"Rust\",\"code\":10,\"comments\":2,\"blanks\":1,\"complexity\":3,\"bytes\":120}}\n",
        SCHEMA_VERSION
    );
    let opts = ReportOptions::new(d.path());
    let idx = Index::load_jsonl(Cursor::new(complete.as_bytes()), &opts).unwrap();
    assert_eq!(idx.skipped_entries(), 0);
    assert!(idx.file("src/lib.rs").is_some(), "other records unaffected");
}

#[test]
fn a_persisted_skip_count_is_restored_on_load() {
    let d = tempdir().unwrap();
    let partial = format!(
        "{{\"kind\":\"meta\",\"schema\":{},\"root\":\"/abs\",\"generated_at\":\"2026-05-12T12:00:00Z\",\"skipped_entries\":2}}\n\
         {{\"kind\":\"file\",\"path\":\"src/lib.rs\",\"language\":\"Rust\",\"code\":10,\"comments\":2,\"blanks\":1,\"complexity\":3,\"bytes\":120}}\n",
        SCHEMA_VERSION
    );
    let opts = ReportOptions::new(d.path());
    let idx = Index::load_jsonl(Cursor::new(partial.as_bytes()), &opts).unwrap();
    assert_eq!(
        idx.skipped_entries(),
        2,
        "the loaded index must report the stored count"
    );
}

#[test]
fn a_complete_index_writes_no_skip_count() {
    let d = tempdir().unwrap();
    write(d.path(), "x.py", "def foo():\n    pass\n");
    let idx = Index::scan(&ReportOptions::new(d.path())).unwrap();
    assert_eq!(idx.skipped_entries(), 0);
    let mut buf = Vec::new();
    idx.write_jsonl(&mut buf, &Scope::All, &CocomoParams::default())
        .unwrap();
    let text = std::str::from_utf8(&buf).unwrap();
    let meta = text.lines().next().unwrap();
    assert!(meta.contains("\"kind\":\"meta\""));
    assert!(
        !meta.contains("skipped_entries"),
        "a complete index must write no skip count: {meta}"
    );
}

#[test]
fn schema_mismatch_is_reported() {
    let d = tempdir().unwrap();
    let opts = ReportOptions::new(d.path());
    let bogus = format!(
        "{{\"kind\":\"meta\",\"schema\":{},\"root\":\"/x\",\"generated_at\":\"2026-01-01T00:00:00Z\"}}\n",
        SCHEMA_VERSION + 99
    );
    let err = Index::load_jsonl(Cursor::new(bogus), &opts).err().unwrap();
    assert!(matches!(
        err,
        chan_report::ChanReportError::SchemaMismatch { .. }
    ));
}

#[test]
fn a_tracked_file_growing_over_read_cap_keeps_metadata_only() {
    let dir = tempdir().unwrap();
    write(dir.path(), "large.rs", "fn main() { if true {} }\n");
    let mut index = Index::scan(&ReportOptions::new(dir.path())).unwrap();
    assert!(index.file("large.rs").unwrap().code > 0);
    let bytes = 17 * 1024 * 1024;
    fs::OpenOptions::new()
        .write(true)
        .open(dir.path().join("large.rs"))
        .unwrap()
        .set_len(bytes)
        .unwrap();
    assert_eq!(index.update("large.rs").unwrap(), UpdateOutcome::Updated);
    let stats = index.file("large.rs").expect("oversized row is retained");
    assert_eq!(stats.bytes, bytes);
    assert_eq!(stats.language, "Rust");
    assert_eq!(
        stats.bucket,
        Some(FileBucket::SourceCode {
            language: "Rust".into()
        })
    );
    assert_eq!(
        (stats.code, stats.comments, stats.blanks, stats.complexity),
        (0, 0, 0, 0)
    );
    let report = index.snapshot(&Scope::All, &CocomoParams::default());
    assert_eq!(report.totals.files, 1);
    assert_eq!(report.totals.bytes, bytes);
    assert_eq!(report.totals.code, 0);
}
