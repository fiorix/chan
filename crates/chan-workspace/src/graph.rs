// Graph DB: relations between files via wiki-links, mentions, and tags,
// plus each file's headings. Backed by sqlite (rusqlite, bundled feature).
//
// `GraphView::migrate` is the schema of record, applied on open through a
// PRAGMA user_version chain. The shape it builds rests on three decisions:
//
// - One writer connection behind a Mutex and a pool of read-only WAL
//   readers, so the per-keystroke `[[` typeahead never waits on another read.
// - `anchor` is part of the `edges` primary key and is '' (never NULL) when
//   absent, so one file can link the same target through two distinct
//   anchors without the rows colliding.
// - A full rebuild stages each file into the `staging_*` tables and swaps
//   them into the live tables in one transaction (`stage_file`,
//   `swap_staging_with_text_files`), so a crashed rebuild resumes from the
//   staging cursor and readers never see a half-built graph.
//
// Node rows are files and contacts (`NodeKind`); a tag is an edge `dst`
// string, never a node.

use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::{ChanError, Result};
use crate::markdown;

type ReaderPool = r2d2::Pool<SqliteConnectionManager>;
type ReaderConn = r2d2::PooledConnection<SqliteConnectionManager>;

/// Default reader-pool size. SQLite under WAL serves concurrent readers
/// with no inter-reader blocking. The hot path is the editor's
/// `[[` typeahead, which fires per-keystroke; 4 connections covers
/// a single user's typeahead + status endpoint + an ad-hoc query
/// without queueing on hosts with enough descriptor headroom. The
/// writer is single-threaded by SQLite contract and lives on its own
/// Mutex<Connection> outside the pool.
const READER_POOL_SIZE: u32 = 4;

/// How long a `readers.get()` checkout waits for a free pooled
/// connection before giving up with an error. r2d2's default is 30s,
/// which is catastrophic here: during a cold reindex the graph DB is
/// busy (the writer churns through the bulk `swap_staging` transaction
/// and per-file staging), so the inspector/backlinks/graph reads a
/// workspace window fires on file-open queue behind it. With the 30s
/// default each of those reads parks for up to half a minute and the
/// whole graph-reading surface of the window appears frozen -- most
/// visibly on Windows, where reindex pacing is otherwise a no-op (see
/// `fd_budget::pace_reindex_worker`) so the rebuild runs flat-out and
/// monopolises the DB. A short bound makes a contended read fail FAST;
/// the route handlers already degrade a graph error into a (now
/// near-instant) response instead of blocking the UI, and
/// `is_reindexing()`-gated handlers skip the read entirely while the
/// first build runs. 2s is comfortably longer than a healthy checkout
/// (sub-millisecond) yet short enough that a stalled panel recovers
/// quickly rather than hanging.
const READER_CHECKOUT_TIMEOUT: Duration = Duration::from_secs(2);

/// Node kind. Distinguishes a regular markdown file from one that
/// the contacts importer dropped (frontmatter `chan.kind: contact`).
/// The graph stores both as `nodes` rows; the kind drives downstream
/// filtering (the editor's `@` picker reads only contacts; backlinks
/// and link-autocomplete read both). Aliasing a contact onto its
/// file row keeps the graph free of double-counted edges.
/// JSON serialization is lowercase (`"file"` / `"contact"`) so the
/// wire form matches the SQL `nodes.kind` column and consumers can
/// switch on it without locale games. Default is `File` so legacy
/// payloads (and the `ResolvedLink` fallback) deserialize cleanly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    #[default]
    File,
    Contact,
}

impl NodeKind {
    fn as_str(self) -> &'static str {
        match self {
            NodeKind::File => "file",
            NodeKind::Contact => "contact",
        }
    }

    /// The inverse of `as_str` for a stored `nodes.kind`. Any value other
    /// than `contact` reads as a file, the column's default kind.
    fn from_db(s: &str) -> Self {
        match s {
            "contact" => NodeKind::Contact,
            _ => NodeKind::File,
        }
    }
}

/// Per-file graph row written by `GraphView::replace_file`: the
/// node's metadata plus the outgoing edges and headings owned by
/// `rel`.
#[derive(Debug, Clone, Copy)]
pub struct FileRecord<'a> {
    pub rel: &'a str,
    /// The file's display title (h1 or frontmatter `title`); stored
    /// on the node for the link-autocomplete query (`link_targets`).
    pub title: Option<&'a str>,
    pub mtime: Option<i64>,
    pub size: Option<i64>,
    /// Tags the file as a regular note or as an imported contact;
    /// the contact tag drives the editor `@` picker and lets graph
    /// consumers filter without re-parsing frontmatter.
    pub node_kind: NodeKind,
    pub outgoing: &'a [Edge],
    pub headings: &'a [markdown::Heading],
    /// Pre-joined, space-separated lowercased address list for
    /// contact-kind files (`None` for File-kind, and `None` for
    /// contacts with no extractable address); see `FileGraph.emails`.
    pub emails: Option<&'a str>,
    /// Same shape as `emails` for the top-level `aliases:`
    /// frontmatter array (mention resolution).
    pub aliases: Option<&'a str>,
}

/// Lightweight projection of a contact-kind node, surfaced through
/// `GraphView::contacts` for the editor `@` picker and
/// `GET /api/contacts` (the wiki-link target the picker inserts is
/// what the link extractor then resolves back to a Contact node, so
/// the round-trip is consistent).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContactNode {
    pub rel_path: String,
    pub basename: String,
    pub title: Option<String>,
    /// Email addresses pulled from the contact note's body at index
    /// time. Empty for contacts with no extractable address (e.g.,
    /// phone-only entries) and for contacts indexed before the v3
    /// schema bump until the next index pass repopulates them.
    /// Surfaced so the picker can render a secondary line under the
    /// contact's name and so callers can confirm an email-substring
    /// match on the result.
    #[serde(default)]
    pub emails: Vec<String>,
    /// Alternate names declared in the contact note's top-level
    /// `aliases:` frontmatter array. Resolves `@@<alias>` mentions
    /// to this contact at graph query time (see
    /// [`crate::graph_normalize::MentionContactResolver`]). Empty for contacts
    /// without an aliases declaration and for contacts indexed
    /// before the v6 schema bump until the next index pass.
    #[serde(default)]
    pub aliases: Vec<String>,
}

/// Edge kind. Mirrors the wiki-link / mention / tag distinction
/// that the editor already exposes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EdgeKind {
    /// `[[wiki-link]]` or markdown `[label](path)` from src to dst.
    /// Anchor is the optional `#section` fragment on dst.
    Link,
    /// `@@mention`. dst is `@@name` until the mention resolves to
    /// a real file.
    Mention,
    /// `#tag` applied to src. dst is `#name`.
    Tag,
}

impl EdgeKind {
    fn as_str(self) -> &'static str {
        match self {
            EdgeKind::Link => "link",
            EdgeKind::Mention => "mention",
            EdgeKind::Tag => "tag",
        }
    }

    fn from_str(s: &str) -> Option<Self> {
        match s {
            "link" => Some(EdgeKind::Link),
            "mention" => Some(EdgeKind::Mention),
            "tag" => Some(EdgeKind::Tag),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Edge {
    pub src: String,
    pub dst: String,
    pub kind: EdgeKind,
    pub anchor: Option<String>,
}

/// One row from `GraphView::files_with_stat`: a rel-path plus the
/// last-stamped `(mtime, size)` tuple, either component nullable
/// (legacy rows from pre-v5 schemas, or files the indexer couldn't
/// stat). Owned `String` so the value crosses thread boundaries
/// without lifetimes.
pub type FileStatRow = (String, Option<i64>, Option<i64>);

/// Borrow-only payload describing one file's graph state, used by
/// `GraphView::stage_file` for the staged rebuild path (and by
/// `GraphView::replace_all`). It borrows
/// from the caller's parsed data and is not re-exported from the crate
/// root.
pub struct FileGraph<'a> {
    pub rel: &'a str,
    pub title: Option<&'a str>,
    pub mtime: Option<i64>,
    /// File size in bytes from `std::fs::Metadata::len`. `None`
    /// when the indexer couldn't stat the file. Stored alongside
    /// `mtime` so `Workspace::reconcile` can catch
    /// same-mtime-different-content rewrites: comparing the
    /// `(mtime, size)` tuple against disk is strictly tighter than
    /// mtime alone, at the cost of one extra `INTEGER` column.
    pub size: Option<i64>,
    pub node_kind: NodeKind,
    pub edges: &'a [Edge],
    pub headings: &'a [markdown::Heading],
    /// Pre-joined, space-separated lowercased email addresses for
    /// contact-kind files. `None` for File-kind nodes and for
    /// contact-kind files with no extractable address. The space
    /// separator is intentional: it lets the picker run a single
    /// `LIKE '%alice%' COLLATE NOCASE` against the column instead
    /// of joining a side table on every keystroke. Email shape is
    /// narrow enough (no spaces) that the join is unambiguous.
    pub emails: Option<&'a str>,
    /// Pre-joined, space-separated lowercased alias list (top-level
    /// frontmatter `aliases:` array). Same storage shape as
    /// `emails`: a single column, space-separated, so the
    /// mention-resolution path can run a substring scan without a
    /// join. `None` for File-kind nodes and for contacts without an
    /// aliases declaration. Aliases without spaces are required for
    /// the join to be unambiguous; the indexer normalizes input by
    /// trimming + lowercasing.
    pub aliases: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub name: String,
    pub count: u32,
}

/// One unique `@@<Name>` mention extracted from
/// the graph's mention edges. `name` carries the bare label
/// (without the `@@` sigil); `count` is the number of mention
/// edges in the graph that target it (i.e. how often the user
/// mentions this handle across markdown bodies).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Mention {
    pub name: String,
    pub count: u32,
}

/// Owns the sqlite handles and exposes the read + write API. Two
/// channels into the same DB:
///   * `writer`: single Connection behind a Mutex. Carries every
///     write transaction. SQLite's contract is one writer at a
///     time; the Mutex enforces it inside the process and the
///     per-workspace flock enforces it cross-process.
///   * `readers`: r2d2 pool of read-only connections (each opened
///     with `query_only = ON` as belt-and-braces). Editor
///     typeahead, backlinks, and status reads draw from the pool
///     so they don't block on each other or on the writer.
///
/// Errors are wrapped in `ChanError::Graph` with enough context to
/// attribute them to a specific operation in `tracing` output.
pub struct GraphView {
    writer: Mutex<Connection>,
    readers: ReaderPool,
}

impl GraphView {
    /// Open or create the graph DB for this workspace.
    pub fn open(graph_db_path: &Path) -> Result<Self> {
        if let Some(parent) = graph_db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Writer first: it runs migrations on a unique handle so
        // the first reader pulled from the pool sees the post-
        // migration schema.
        let writer = Connection::open(graph_db_path)?;
        Self::tune_writer(&writer)?;
        Self::migrate(&writer)?;

        // Reader pool. `with_init` runs the same WAL / busy_timeout
        // pragmas every time r2d2 opens a fresh connection, plus
        // `query_only = ON` to make accidental writes through a
        // pooled connection fail fast (SQLITE_READONLY) instead of
        // racing the writer.
        let manager = SqliteConnectionManager::file(graph_db_path).with_init(|conn| {
            let _: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
            conn.execute_batch(
                "PRAGMA synchronous = NORMAL; \
                 PRAGMA busy_timeout = 5000; \
                 PRAGMA foreign_keys = ON; \
                 PRAGMA query_only = ON;",
            )?;
            Ok(())
        });
        let reader_pool_size = crate::fd_budget::graph_reader_pool_size(READER_POOL_SIZE);
        let readers = r2d2::Pool::builder()
            // Bound the checkout wait. The r2d2 default is 30s; under a
            // cold reindex that turns every contended graph read into a
            // half-minute UI hang (see READER_CHECKOUT_TIMEOUT).
            .connection_timeout(READER_CHECKOUT_TIMEOUT)
            .max_size(reader_pool_size)
            // Pre-open the full set so the first burst of concurrent
            // reads on file-open (inspector + backlinks + graph) don't
            // each pay sqlite connect + WAL/pragma init latency while
            // the DB is already busy. `min_idle == max_size` keeps the
            // pool warm; idle connections cost a fd apiece, which the
            // fd-budget already accounts for when it sizes the pool.
            .min_idle(Some(reader_pool_size))
            .build(manager)
            .map_err(|e| ChanError::Graph(format!("graph reader pool: {e}")))?;
        tracing::debug!(
            db = %graph_db_path.display(),
            pool = reader_pool_size,
            "graph: opened",
        );
        Ok(Self {
            writer: Mutex::new(writer),
            readers,
        })
    }

    fn reader(&self) -> Result<ReaderConn> {
        self.readers
            .get()
            .map_err(|e| ChanError::Graph(format!("graph reader checkout: {e}")))
    }

    /// Per-connection sqlite tuning for the writer. Run once at open
    /// before any schema work so the migration itself benefits from
    /// WAL. Reader connections receive the same set (plus
    /// `query_only`) via `SqliteConnectionManager::with_init`.
    ///
    ///   journal_mode = WAL       readers don't block writers, single
    ///                            writer at a time (we already gate
    ///                            that with the per-workspace flock); WAL
    ///                            also crash-recovers cleanly because
    ///                            the WAL file is the durable record
    ///                            of in-flight commits.
    ///   synchronous  = NORMAL    under WAL this is the standard
    ///                            durability/perf trade. Survives a
    ///                            process crash; can lose the last
    ///                            committed tx on a kernel/power
    ///                            crash within the WAL flush window.
    ///                            Acceptable for a regenerable graph.
    ///   busy_timeout = 5000      readers (e.g. the status endpoint
    ///                            during a reindex) wait briefly
    ///                            instead of failing immediately on
    ///                            SQLITE_BUSY.
    ///   foreign_keys = ON        cheap insurance; the schema doesn't
    ///                            declare FKs today but the toggle
    ///                            stops a future schema change from
    ///                            silently bypassing them.
    fn tune_writer(conn: &Connection) -> Result<()> {
        // journal_mode is a query-shaped pragma (returns the new mode).
        // pragma_update would error; query_row drops the result row.
        let _: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
        conn.execute_batch(
            "PRAGMA synchronous = NORMAL; \
             PRAGMA busy_timeout = 5000; \
             PRAGMA foreign_keys = ON;",
        )?;
        Ok(())
    }

    /// True iff `table` has a column named `column`. Used by the
    /// idempotent guard in v3 / v5 migrations: a crash between
    /// `ALTER TABLE ADD COLUMN` and the matching `PRAGMA
    /// user_version` bump leaves user_version at the prior value
    /// with the column already present; on re-open this returns
    /// `true` and the ALTER is skipped.
    fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool> {
        // `PRAGMA table_info(<table>)` cannot take a bound parameter
        // (PRAGMA syntax limitation); we format the table name in.
        // Callers pass static strings only.
        let sql = format!("PRAGMA table_info({table})");
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let name: String = row.get(1)?;
            if name == column {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn migrate(conn: &Connection) -> Result<()> {
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if v == 0 {
            tracing::info!("graph: initializing schema at v1");
        } else if v < 3 {
            tracing::info!(from = v, to = 3, "graph: migrating schema");
        }
        if v < 1 {
            conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS nodes (
                    rel_path TEXT PRIMARY KEY,
                    kind     TEXT NOT NULL,
                    mtime    INTEGER
                );
                CREATE TABLE IF NOT EXISTS edges (
                    src    TEXT NOT NULL,
                    dst    TEXT NOT NULL,
                    kind   TEXT NOT NULL,
                    anchor TEXT NOT NULL DEFAULT '',
                    PRIMARY KEY (src, dst, kind, anchor)
                );
                CREATE INDEX IF NOT EXISTS edges_dst_idx ON edges(dst);
                CREATE TABLE IF NOT EXISTS headings (
                    rel_path TEXT NOT NULL,
                    level    INTEGER NOT NULL,
                    text     TEXT NOT NULL,
                    anchor   TEXT NOT NULL,
                    ord      INTEGER NOT NULL,
                    PRIMARY KEY (rel_path, ord)
                );
                PRAGMA user_version = 1;
                "#,
            )?;
        }
        if v < 2 {
            // v2: add title + basename to nodes for link_targets.
            // basename is derived from rel_path (no file IO needed)
            // and backfilled here. title stays NULL until the next
            // index_file / reindex pass repopulates it from content.
            //
            // ALTER TABLE in sqlite is not transactional with the DDL
            // sense most users expect, but it is atomic per statement.
            // We run schema mutations first (they cannot be rolled
            // back into the v1 shape), then do the basename backfill
            // and the user_version bump in a single transaction. If a
            // crash lands before the commit, user_version stays at 1
            // and the next open re-runs the backfill against a schema
            // that already has the columns (the IF NOT EXISTS / no-op
            // ALTER TABLE pattern). That's why we tolerate "column
            // already exists" by inspecting PRAGMA before re-ALTERing.
            if !Self::column_exists(conn, "nodes", "title")? {
                conn.execute_batch("ALTER TABLE nodes ADD COLUMN title TEXT;")?;
            }
            if !Self::column_exists(conn, "nodes", "basename")? {
                conn.execute_batch("ALTER TABLE nodes ADD COLUMN basename TEXT;")?;
            }
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS nodes_basename_idx ON nodes(basename);",
            )?;

            let paths: Vec<String> = {
                let mut stmt = conn.prepare("SELECT rel_path FROM nodes WHERE kind = 'file'")?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
                let mut out = Vec::new();
                for row in rows {
                    out.push(row?);
                }
                out
            };
            let tx = conn.unchecked_transaction()?;
            {
                let mut stmt = tx.prepare("UPDATE nodes SET basename = ?2 WHERE rel_path = ?1")?;
                for p in &paths {
                    let bn = std::path::Path::new(p)
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or(p)
                        .to_string();
                    stmt.execute(params![p, bn])?;
                }
            }
            // Bump user_version inside the same tx as the backfill so
            // a crash mid-migration leaves user_version at 1 with a
            // schema that's idempotently safe to re-migrate.
            tx.execute_batch("PRAGMA user_version = 2;")?;
            tx.commit()?;
        }
        if v < 3 {
            // v3: add `emails` to nodes for the @ picker's email-
            // substring match. ALTER + user_version bump live inside
            // one transaction so a crash before the commit leaves
            // user_version = 2 with the column already idempotently
            // re-addable on the next open (the column_exists guard).
            // Fresh installs build the column straight through this
            // migration chain; no file-level backfill is required
            // since the indexer parses every contact at first walk.
            let tx = conn.unchecked_transaction()?;
            if !Self::column_exists(&tx, "nodes", "emails")? {
                tx.execute_batch("ALTER TABLE nodes ADD COLUMN emails TEXT;")?;
            }
            tx.execute_batch("PRAGMA user_version = 3;")?;
            tx.commit()?;
        }
        if v < 4 {
            // v4: staging tables for `Workspace::reindex_with`. Each
            // full rebuild stages parse output into these tables
            // per-file (committed by the writer thread), then
            // executes a single atomic swap into the live tables
            // at the end of the parse phase. A crash mid-rebuild
            // leaves staging with the parse output for files
            // processed so far; the next reindex reads the cursor
            // (MAX rel_path in staging_nodes) and resumes the walk
            // past it, skipping the redo. The swap is the durable
            // commit boundary for the rebuild.
            //
            // Shape mirrors the live tables exactly; we avoid
            // computed columns or denormalization so the swap is
            // a straight INSERT INTO ... SELECT.
            //
            // All four CREATEs + the user_version bump commit
            // together so a crash before the commit leaves
            // user_version = 3 with idempotent re-creation on the
            // next open.
            let tx = conn.unchecked_transaction()?;
            tx.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS staging_nodes (
                    rel_path TEXT PRIMARY KEY,
                    kind     TEXT NOT NULL,
                    mtime    INTEGER,
                    title    TEXT,
                    basename TEXT,
                    emails   TEXT
                );
                CREATE TABLE IF NOT EXISTS staging_edges (
                    src    TEXT NOT NULL,
                    dst    TEXT NOT NULL,
                    kind   TEXT NOT NULL,
                    anchor TEXT NOT NULL DEFAULT '',
                    PRIMARY KEY (src, dst, kind, anchor)
                );
                CREATE INDEX IF NOT EXISTS staging_edges_dst_idx ON staging_edges(dst);
                CREATE TABLE IF NOT EXISTS staging_headings (
                    rel_path TEXT NOT NULL,
                    level    INTEGER NOT NULL,
                    text     TEXT NOT NULL,
                    anchor   TEXT NOT NULL,
                    ord      INTEGER NOT NULL,
                    PRIMARY KEY (rel_path, ord)
                );
                PRAGMA user_version = 4;
                "#,
            )?;
            tx.commit()?;
        }
        if v < 5 {
            // v5: persist file size on nodes / staging_nodes so
            // `Workspace::reconcile`'s diff compares the (mtime, size)
            // tuple rather than mtime alone. Catches rewrites that
            // happen to land on the same mtime (rapid back-to-back
            // saves on coarse-mtime filesystems, or tools that
            // explicitly preserve mtime across edits).
            //
            // NULL on legacy rows so the migration doesn't need to
            // walk the filesystem; reconcile treats `None` size as
            // "skip the size check" and a single subsequent
            // index_file call backfills the row.
            //
            // Both ALTERs + user_version bump commit together, same
            // pattern as v2 / v3 / v4: a crash before commit leaves
            // user_version = 4 with the (idempotent) ALTERs safe to
            // re-run on the next open.
            let tx = conn.unchecked_transaction()?;
            if !Self::column_exists(&tx, "nodes", "size")? {
                tx.execute_batch("ALTER TABLE nodes ADD COLUMN size INTEGER;")?;
            }
            if !Self::column_exists(&tx, "staging_nodes", "size")? {
                tx.execute_batch("ALTER TABLE staging_nodes ADD COLUMN size INTEGER;")?;
            }
            tx.execute_batch("PRAGMA user_version = 5;")?;
            tx.commit()?;
        }
        if v < 6 {
            // v6: persist top-level `aliases:` frontmatter on nodes
            // / staging_nodes so the mention resolver can
            // map `@@<alias>` to a contact file without re-parsing
            // every contact's frontmatter on each graph query. NULL
            // on legacy rows; reconcile / index_file backfill them
            // by re-parsing the file on the next ingest pass.
            //
            // Same idempotent-ALTER pattern as v3 / v5: crash before
            // commit leaves user_version = 5 with the ALTERs safe
            // to re-run on the next open.
            let tx = conn.unchecked_transaction()?;
            if !Self::column_exists(&tx, "nodes", "aliases")? {
                tx.execute_batch("ALTER TABLE nodes ADD COLUMN aliases TEXT;")?;
            }
            if !Self::column_exists(&tx, "staging_nodes", "aliases")? {
                tx.execute_batch("ALTER TABLE staging_nodes ADD COLUMN aliases TEXT;")?;
            }
            tx.execute_batch("PRAGMA user_version = 6;")?;
            tx.commit()?;
        }
        if v < 7 {
            let tx = conn.unchecked_transaction()?;
            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS text_files (
                    rel_path TEXT PRIMARY KEY,
                    mtime INTEGER,
                    size INTEGER
                );
                PRAGMA user_version = 7;",
            )?;
            tx.commit()?;
        }
        if v < 8 {
            // v8: `no_index_entry` on nodes and text_files. A row records
            // the stat its content was seen at; this flag records that the
            // content puts nothing in the search index (no chunks, or bytes
            // that do not decode as UTF-8), so reconcile can tell that from
            // an index entry that went missing without reading the file on
            // every pass. Rows from before the column, like the rows a full
            // rebuild writes, default to unset and are read once when the
            // index lacks them.
            //
            // Same idempotent-ALTER pattern as v5 / v6: a crash before
            // commit leaves user_version = 7 with the ALTERs safe to re-run
            // on the next open.
            let tx = conn.unchecked_transaction()?;
            if !Self::column_exists(&tx, "nodes", "no_index_entry")? {
                tx.execute_batch(
                    "ALTER TABLE nodes ADD COLUMN no_index_entry INTEGER NOT NULL DEFAULT 0;",
                )?;
            }
            if !Self::column_exists(&tx, "text_files", "no_index_entry")? {
                tx.execute_batch(
                    "ALTER TABLE text_files ADD COLUMN no_index_entry INTEGER NOT NULL DEFAULT 0;",
                )?;
            }
            tx.execute_batch("PRAGMA user_version = 8;")?;
            tx.commit()?;
        }
        Ok(())
    }

    /// Outgoing edges from `rel`. Document order is not preserved;
    /// callers that need stable order should sort by (kind, dst).
    pub fn neighbors(&self, rel: &str) -> Result<Vec<Edge>> {
        tracing::debug!(rel, "graph::neighbors");
        let conn = self.reader()?;
        let mut stmt = conn.prepare_cached(
            "SELECT dst, kind, anchor FROM edges WHERE src = ? ORDER BY kind, dst",
        )?;
        let rows = stmt.query_map(params![rel], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                // '' (the NOT NULL no-anchor sentinel) reads back as None
                // so Edge.anchor keeps its "Some(x) iff a real anchor"
                // contract for callers.
                row.get::<_, String>(2)
                    .map(|a| (!a.is_empty()).then_some(a))?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (dst, kind_str, anchor) = row?;
            if let Some(kind) = EdgeKind::from_str(&kind_str) {
                out.push(Edge {
                    src: rel.to_string(),
                    dst,
                    kind,
                    anchor,
                });
            }
        }
        Ok(out)
    }

    /// Incoming edges into `rel` (other files that link to it).
    pub fn backlinks(&self, rel: &str) -> Result<Vec<Edge>> {
        tracing::debug!(rel, "graph::backlinks");
        let conn = self.reader()?;
        let mut stmt = conn.prepare_cached(
            "SELECT src, kind, anchor FROM edges WHERE dst = ? AND kind = 'link' ORDER BY src",
        )?;
        let rows = stmt.query_map(params![rel], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                // '' (the NOT NULL no-anchor sentinel) reads back as None
                // so Edge.anchor keeps its "Some(x) iff a real anchor"
                // contract for callers.
                row.get::<_, String>(2)
                    .map(|a| (!a.is_empty()).then_some(a))?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (src, kind_str, anchor) = row?;
            if let Some(kind) = EdgeKind::from_str(&kind_str) {
                out.push(Edge {
                    src,
                    dst: rel.to_string(),
                    kind,
                    anchor,
                });
            }
        }
        Ok(out)
    }

    /// Fetch outgoing semantic edges for a frontier in bounded SQL batches.
    ///
    /// An empty `kinds` slice selects every semantic edge kind. Results are
    /// stable by source, kind, destination, and anchor across chunk boundaries.
    pub fn edges_from(&self, nodes: &[String], kinds: &[EdgeKind]) -> Result<Vec<Edge>> {
        self.edges_for_nodes("src", nodes, kinds)
    }

    /// Fetch incoming semantic edges for a frontier in bounded SQL batches.
    ///
    /// Unlike [`GraphView::backlinks`], this returns tag and mention edges when
    /// requested and never applies the compatibility link-only filter.
    pub fn edges_to(&self, nodes: &[String], kinds: &[EdgeKind]) -> Result<Vec<Edge>> {
        self.edges_for_nodes("dst", nodes, kinds)
    }

    fn edges_for_nodes(
        &self,
        column: &'static str,
        nodes: &[String],
        kinds: &[EdgeKind],
    ) -> Result<Vec<Edge>> {
        if nodes.is_empty() {
            return Ok(Vec::new());
        }
        debug_assert!(matches!(column, "src" | "dst"));
        const SQLITE_BIND_BUDGET: usize = 900;

        let unique_nodes: Vec<String> = nodes
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .cloned()
            .collect();
        let mut kind_names = Vec::new();
        for kind in kinds {
            let name = kind.as_str().to_string();
            if !kind_names.contains(&name) {
                kind_names.push(name);
            }
        }
        let chunk_size = SQLITE_BIND_BUDGET.saturating_sub(kind_names.len()).max(1);
        let conn = self.reader()?;
        let mut out = Vec::new();
        for chunk in unique_nodes.chunks(chunk_size) {
            let node_params = std::iter::repeat_n("?", chunk.len())
                .collect::<Vec<_>>()
                .join(",");
            let kind_clause = if kind_names.is_empty() {
                String::new()
            } else {
                let kind_params = std::iter::repeat_n("?", kind_names.len())
                    .collect::<Vec<_>>()
                    .join(",");
                format!(" AND kind IN ({kind_params})")
            };
            let sql = format!(
                "SELECT src, dst, kind, anchor FROM edges \
                 WHERE {column} IN ({node_params}){kind_clause} \
                 ORDER BY src, kind, dst, anchor"
            );
            let mut values = chunk.to_vec();
            values.extend(kind_names.iter().cloned());
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params_from_iter(values.iter()), |row| {
                let kind: String = row.get(2)?;
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    kind,
                    row.get::<_, String>(3)?,
                ))
            })?;
            for row in rows {
                let (src, dst, kind, anchor) = row?;
                if let Some(kind) = EdgeKind::from_str(&kind) {
                    out.push(Edge {
                        src,
                        dst,
                        kind,
                        anchor: (!anchor.is_empty()).then_some(anchor),
                    });
                }
            }
        }
        out.sort_by(|left, right| {
            (
                left.src.as_str(),
                left.kind.as_str(),
                left.dst.as_str(),
                left.anchor.as_deref().unwrap_or(""),
            )
                .cmp(&(
                    right.src.as_str(),
                    right.kind.as_str(),
                    right.dst.as_str(),
                    right.anchor.as_deref().unwrap_or(""),
                ))
        });
        Ok(out)
    }

    /// All tags in the workspace with their reference counts. Tag dst
    /// nodes are stored as `#name`; we strip the prefix in the result.
    pub fn tags(&self) -> Result<Vec<Tag>> {
        tracing::debug!("graph::tags");
        let conn = self.reader()?;
        let mut stmt = conn.prepare_cached(
            "SELECT dst, COUNT(*) FROM edges WHERE kind = 'tag' GROUP BY dst ORDER BY 2 DESC, 1",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u32))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (dst, count) = row?;
            let name = dst.strip_prefix('#').unwrap_or(&dst).to_string();
            out.push(Tag { name, count });
        }
        Ok(out)
    }

    /// Enumerate unique `@@<Name>` mentions across
    /// the graph's mention edges, sorted by count desc + label
    /// asc (mirrors `tags()`'s shape). `name` is the bare label
    /// without the `@@` sigil. Consumers (e.g. chan-server's
    /// `/api/mentions` endpoint for the editor's mention
    /// completion) filter / cap as needed.
    ///
    /// Includes BOTH unresolved mentions (where `dst` is the raw
    /// `@@<Name>` string) AND resolved mentions whose `dst` was
    /// rewritten to a contact file path at query time by
    /// [`crate::graph_normalize::normalize_graph_edges`]. Resolved mentions in
    /// the graph DB keep the raw `@@<Name>` dst -- the rewrite is per-call,
    /// not persisted -- so the SQL filter on `kind = 'mention'`
    /// captures every reference.
    pub fn mentions(&self) -> Result<Vec<Mention>> {
        tracing::debug!("graph::mentions");
        let conn = self.reader()?;
        let mut stmt = conn.prepare_cached(
            "SELECT dst, COUNT(*) FROM edges WHERE kind = 'mention' GROUP BY dst ORDER BY 2 DESC, 1",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u32))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (dst, count) = row?;
            let name = dst.strip_prefix("@@").unwrap_or(&dst).to_string();
            out.push(Mention { name, count });
        }
        Ok(out)
    }

    /// Files tagged with `tag` (without the leading `#`).
    pub fn files_with_tag(&self, tag: &str) -> Result<Vec<String>> {
        tracing::debug!(tag, "graph::files_with_tag");
        let dst = format!("#{tag}");
        let conn = self.reader()?;
        let mut stmt = conn.prepare_cached(
            "SELECT DISTINCT src FROM edges WHERE kind = 'tag' AND dst = ? ORDER BY src",
        )?;
        let rows = stmt.query_map(params![dst], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Replace the graph data for one file: removes existing
    /// edges/headings owned by `record.rel` and inserts the supplied
    /// ones in a single transaction. See [`FileRecord`] for field
    /// semantics.
    pub fn replace_file(&self, record: FileRecord<'_>) -> Result<()> {
        let FileRecord {
            rel,
            title,
            mtime,
            size,
            node_kind,
            outgoing,
            headings,
            emails,
            aliases,
        } = record;
        tracing::debug!(
            rel,
            kind = node_kind.as_str(),
            edges = outgoing.len(),
            headings = headings.len(),
            "graph::replace_file",
        );
        let conn = self.writer.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let basename = std::path::Path::new(rel)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(rel);
        tx.execute(
            "INSERT OR REPLACE INTO nodes(rel_path, kind, mtime, title, basename, emails, size, aliases) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                rel,
                node_kind.as_str(),
                mtime,
                title,
                basename,
                emails,
                size,
                aliases,
            ],
        )?;
        tx.execute("DELETE FROM edges WHERE src = ?", params![rel])?;
        tx.execute("DELETE FROM headings WHERE rel_path = ?", params![rel])?;
        {
            let mut ins_edge = tx.prepare_cached(
                "INSERT OR IGNORE INTO edges(src, dst, kind, anchor) VALUES (?, ?, ?, ?)",
            )?;
            for e in outgoing {
                // anchor is NOT NULL DEFAULT ''; bind '' for the no-anchor
                // case so the (src,dst,kind,anchor) PK dedups correctly.
                ins_edge.execute(params![
                    rel,
                    e.dst,
                    e.kind.as_str(),
                    e.anchor.as_deref().unwrap_or("")
                ])?;
            }
            let mut ins_heading = tx.prepare_cached(
                "INSERT INTO headings(rel_path, level, text, anchor, ord) VALUES (?, ?, ?, ?, ?)",
            )?;
            for h in headings {
                let anchor = markdown::heading_anchor(&h.text);
                ins_heading.execute(params![rel, h.level as i64, h.text, anchor, h.ord as i64])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Stamp a non-Markdown text file without making it a graph document.
    /// Inbound edges belong to their source notes and remain intact. The
    /// replaced row starts with `no_index_entry` unset, like a document row
    /// written by `replace_file`: what the index holds for the new content
    /// is known only once it is indexed.
    pub(crate) fn stamp_text_file(
        &self,
        rel: &str,
        mtime: Option<i64>,
        size: Option<i64>,
    ) -> Result<()> {
        let conn = self.writer.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM edges WHERE src = ?", params![rel])?;
        tx.execute("DELETE FROM headings WHERE rel_path = ?", params![rel])?;
        tx.execute("DELETE FROM nodes WHERE rel_path = ?", params![rel])?;
        tx.execute(
            "INSERT OR REPLACE INTO text_files(rel_path, mtime, size) VALUES (?, ?, ?)",
            params![rel, mtime, size],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Record that the content behind `rel`'s row, document or text stamp,
    /// puts nothing in the search index: it chunks to nothing, or its bytes
    /// do not decode. Reconcile then knows the missing index entry is not
    /// damage and does not read the file again at that stat.
    pub(crate) fn mark_no_index_entry(&self, rel: &str) -> Result<()> {
        let conn = self.writer.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE nodes SET no_index_entry = 1 WHERE rel_path = ?",
            params![rel],
        )?;
        tx.execute(
            "UPDATE text_files SET no_index_entry = 1 WHERE rel_path = ?",
            params![rel],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Paths whose row carries the `mark_no_index_entry` mark, sorted.
    pub(crate) fn paths_without_index_entry(&self) -> Result<Vec<String>> {
        let conn = self.reader()?;
        let mut stmt = conn.prepare_cached(
            "SELECT rel_path FROM nodes WHERE no_index_entry = 1 \
             UNION ALL SELECT rel_path FROM text_files WHERE no_index_entry = 1 \
             ORDER BY rel_path",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Drop a file from the graph entirely. Edges with `rel` as
    /// either endpoint go too; no dangling references.
    pub fn forget_file(&self, rel: &str) -> Result<()> {
        tracing::debug!(rel, "graph::forget_file");
        let conn = self.writer.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM edges WHERE src = ? OR dst = ?",
            params![rel, rel],
        )?;
        tx.execute("DELETE FROM headings WHERE rel_path = ?", params![rel])?;
        tx.execute("DELETE FROM nodes WHERE rel_path = ?", params![rel])?;
        tx.execute("DELETE FROM text_files WHERE rel_path = ?", params![rel])?;
        tx.commit()?;
        Ok(())
    }

    /// Drop every node, heading, and outgoing edge under `prefix`
    /// in one transaction. Matches either an exact path
    /// (`notes/x.md`) or a directory subtree (`notes` -> everything
    /// under `notes/`).
    ///
    /// Inbound edges (where `dst` is in the removed set but `src`
    /// is not) are deliberately left in place: they describe the
    /// source file's body, which still contains the link text. A
    /// `backlinks(removed)` query then returns "files that point
    /// here as a broken link" rather than lying about the source's
    /// content. Restoring the removed entry via `trash_restore` is
    /// also lossless: the inbound edges that survived continue to
    /// surface as backlinks the moment the restored node row
    /// reappears.
    ///
    /// Used by `Workspace::remove` to cascade a soft-delete into the
    /// graph without waiting for the next full reindex. The op is
    /// idempotent: re-running on an empty subtree is a no-op.
    pub fn forget_under(&self, prefix: &str) -> Result<()> {
        tracing::debug!(prefix, "graph::forget_under");
        let conn = self.writer.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        // LIKE-escape the prefix so a literal `_` or `%` in a path
        // doesn't widen the match. Pair with `ESCAPE '\\'`.
        let subtree_like = format!("{}/%", like_escape(prefix));
        tx.execute(
            "DELETE FROM edges WHERE src = ?1 \
             OR src LIKE ?2 ESCAPE '\\'",
            params![prefix, subtree_like],
        )?;
        tx.execute(
            "DELETE FROM headings WHERE rel_path = ?1 \
             OR rel_path LIKE ?2 ESCAPE '\\'",
            params![prefix, subtree_like],
        )?;
        tx.execute(
            "DELETE FROM nodes WHERE rel_path = ?1 \
             OR rel_path LIKE ?2 ESCAPE '\\'",
            params![prefix, subtree_like],
        )?;
        tx.execute(
            "DELETE FROM text_files WHERE rel_path = ?1 \
             OR rel_path LIKE ?2 ESCAPE '\\'",
            params![prefix, subtree_like],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Reindex staging support: clear every staging table. Use
    /// before starting a reindex on a clean workspace; resume paths
    /// skip this so partial parse state from a prior crash is
    /// preserved.
    pub fn clear_staging(&self) -> Result<()> {
        tracing::debug!("graph::clear_staging");
        let conn = self.writer.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM staging_edges", [])?;
        tx.execute("DELETE FROM staging_headings", [])?;
        tx.execute("DELETE FROM staging_nodes", [])?;
        tx.commit()?;
        Ok(())
    }

    /// Stage one file's parse output into the staging tables.
    /// Each call commits its own transaction; on a crash mid-call
    /// the in-flight row gets rolled back and the cursor stays at
    /// the last fully-staged file. Use for `Workspace::reindex_with`'s
    /// resumable parse phase; the swap into live tables happens
    /// once at the end via `swap_staging`.
    pub fn stage_file(&self, fg: &FileGraph<'_>) -> Result<()> {
        let conn = self.writer.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let basename = std::path::Path::new(fg.rel)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(fg.rel);
        tx.execute(
            "INSERT OR REPLACE INTO staging_nodes(rel_path, kind, mtime, title, basename, emails, size, aliases) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                fg.rel,
                fg.node_kind.as_str(),
                fg.mtime,
                fg.title,
                basename,
                fg.emails,
                fg.size,
                fg.aliases,
            ],
        )?;
        // Re-stage clears previous edges + headings for this file
        // so a partial-parse retry (file content changed since the
        // crash) leaves the staged row consistent with the new
        // parse.
        tx.execute("DELETE FROM staging_edges WHERE src = ?", params![fg.rel])?;
        tx.execute(
            "DELETE FROM staging_headings WHERE rel_path = ?",
            params![fg.rel],
        )?;
        {
            let mut ins_edge = tx.prepare_cached(
                "INSERT OR IGNORE INTO staging_edges(src, dst, kind, anchor) VALUES (?, ?, ?, ?)",
            )?;
            for e in fg.edges {
                ins_edge.execute(params![
                    fg.rel,
                    e.dst,
                    e.kind.as_str(),
                    e.anchor.as_deref().unwrap_or("")
                ])?;
            }
            let mut ins_heading = tx.prepare_cached(
                "INSERT INTO staging_headings(rel_path, level, text, anchor, ord) \
                 VALUES (?, ?, ?, ?, ?)",
            )?;
            for h in fg.headings {
                let anchor = markdown::heading_anchor(&h.text);
                ins_heading.execute(params![
                    fg.rel,
                    h.level as i64,
                    h.text,
                    anchor,
                    h.ord as i64,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Lexicographically-greatest rel_path currently in the staging
    /// node table. `None` when staging is empty; used by reindex
    /// to decide where to resume the walk. The walk produces files
    /// in sorted order, so a strictly-greater comparison against
    /// this cursor skips every file already staged.
    pub fn staging_cursor(&self) -> Result<Option<String>> {
        let conn = self.reader()?;
        let v: Option<String> = conn
            .query_row("SELECT MAX(rel_path) FROM staging_nodes", [], |r| r.get(0))
            .optional()?
            .flatten();
        Ok(v)
    }

    /// Drop staging rows whose rel_path is not in `live_files`.
    /// Used at the top of a resumed reindex: a file staged in a
    /// prior incomplete run that has since been deleted from disk
    /// would otherwise survive into the live tables at swap time
    /// as a ghost row pointing at a missing path.
    pub fn sanitize_staging(
        &self,
        live_files: &std::collections::HashSet<String>,
    ) -> Result<usize> {
        let live: std::collections::HashMap<String, (Option<i64>, Option<i64>)> = live_files
            .iter()
            .map(|rel| (rel.clone(), (None, None)))
            .collect();
        self.sanitize_staging_against_live(&live, false)
    }

    /// Drop staging rows that either disappeared from disk or no
    /// longer match the current disk stat tuple. Used by resumed full
    /// reindex after a checkout/sync storm: already-staged rows are
    /// only safe to skip when they still describe the current file.
    pub fn sanitize_staging_against_live(
        &self,
        live_files: &std::collections::HashMap<String, (Option<i64>, Option<i64>)>,
        compare_stats: bool,
    ) -> Result<usize> {
        let conn = self.writer.lock().unwrap();
        let staged: Vec<(String, Option<i64>, Option<i64>)> = {
            let mut stmt = conn.prepare("SELECT rel_path, mtime, size FROM staging_nodes")?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<i64>>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                ))
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            out
        };
        let stale: Vec<&String> = staged
            .iter()
            .filter_map(
                |(rel, staged_mtime, staged_size)| match live_files.get(rel) {
                    None => Some(rel),
                    Some((live_mtime, live_size)) if compare_stats => {
                        if staged_mtime != live_mtime || staged_size != live_size {
                            Some(rel)
                        } else {
                            None
                        }
                    }
                    Some(_) => None,
                },
            )
            .collect();
        if stale.is_empty() {
            return Ok(0);
        }
        let tx = conn.unchecked_transaction()?;
        for rel in &stale {
            tx.execute("DELETE FROM staging_edges WHERE src = ?", params![rel])?;
            tx.execute(
                "DELETE FROM staging_headings WHERE rel_path = ?",
                params![rel],
            )?;
            tx.execute("DELETE FROM staging_nodes WHERE rel_path = ?", params![rel])?;
        }
        tx.commit()?;
        Ok(stale.len())
    }

    /// Atomically swap staging into the live tables. Clears live,
    /// copies from staging, clears staging. Single transaction so
    /// a crash mid-swap leaves either the old live state intact
    /// (transaction rolled back) or the new one fully committed.
    pub fn swap_staging(&self) -> Result<()> {
        self.swap_staging_with_text_files(&[])
    }

    pub(crate) fn swap_staging_with_text_files(&self, text_files: &[FileStatRow]) -> Result<()> {
        tracing::debug!("graph::swap_staging");
        let conn = self.writer.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        // Delete-then-insert vs. drop-and-rename: ALTER TABLE
        // RENAME is sqlite-supported, but we keep the schema
        // shape stable (callers might be holding readers against
        // the live tables; renaming would break them mid-query).
        // Delete-then-insert inside one transaction gives the same
        // atomicity without touching the schema.
        tx.execute("DELETE FROM edges", [])?;
        tx.execute("DELETE FROM headings", [])?;
        tx.execute("DELETE FROM nodes", [])?;
        tx.execute(
            "INSERT INTO nodes(rel_path, kind, mtime, title, basename, emails, size, aliases) \
             SELECT rel_path, kind, mtime, title, basename, emails, size, aliases FROM staging_nodes",
            [],
        )?;
        tx.execute(
            "INSERT INTO edges(src, dst, kind, anchor) \
             SELECT src, dst, kind, anchor FROM staging_edges",
            [],
        )?;
        tx.execute(
            "INSERT INTO headings(rel_path, level, text, anchor, ord) \
             SELECT rel_path, level, text, anchor, ord FROM staging_headings",
            [],
        )?;
        tx.execute("DELETE FROM staging_edges", [])?;
        tx.execute("DELETE FROM staging_headings", [])?;
        tx.execute("DELETE FROM staging_nodes", [])?;
        tx.execute("DELETE FROM text_files", [])?;
        {
            let mut insert = tx
                .prepare_cached("INSERT INTO text_files(rel_path, mtime, size) VALUES (?, ?, ?)")?;
            for (rel, mtime, size) in text_files {
                insert.execute(params![rel, mtime, size])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Atomic rebuild: clear the graph and re-insert `entries` in a
    /// single transaction. If any insert fails, the transaction
    /// rolls back and the graph stays in its previous state.
    ///
    /// One transaction matters because a wipe followed by per-file
    /// `replace_file()` calls (one transaction each, the path for
    /// incremental updates) leaves the graph half-populated when a
    /// write errors partway. The server's boot-time check requests a
    /// full rebuild when the graph is empty, and a half-populated
    /// graph is not empty. `Workspace::reindex` does not call this: it
    /// stages each Markdown file (`stage_file`, one commit per file,
    /// so a crashed rebuild resumes) and swaps the staged tables in
    /// with one transaction (`swap_staging_with_text_files`).
    pub fn replace_all(&self, entries: &[FileGraph<'_>]) -> Result<()> {
        tracing::debug!(files = entries.len(), "graph::replace_all");
        let conn = self.writer.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM edges", [])?;
        tx.execute("DELETE FROM headings", [])?;
        tx.execute("DELETE FROM nodes", [])?;
        tx.execute("DELETE FROM text_files", [])?;
        {
            let mut ins_node = tx.prepare_cached(
                "INSERT OR REPLACE INTO nodes(rel_path, kind, mtime, title, basename, emails, size, aliases) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )?;
            let mut ins_edge = tx.prepare_cached(
                "INSERT OR IGNORE INTO edges(src, dst, kind, anchor) VALUES (?, ?, ?, ?)",
            )?;
            let mut ins_heading = tx.prepare_cached(
                "INSERT INTO headings(rel_path, level, text, anchor, ord) VALUES (?, ?, ?, ?, ?)",
            )?;
            for fg in entries {
                let basename = std::path::Path::new(fg.rel)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or(fg.rel);
                ins_node.execute(params![
                    fg.rel,
                    fg.node_kind.as_str(),
                    fg.mtime,
                    fg.title,
                    basename,
                    fg.emails,
                    fg.size,
                    fg.aliases,
                ])?;
                for e in fg.edges {
                    ins_edge.execute(params![
                        fg.rel,
                        e.dst,
                        e.kind.as_str(),
                        e.anchor.as_deref().unwrap_or("")
                    ])?;
                }
                for h in fg.headings {
                    let anchor = markdown::heading_anchor(&h.text);
                    ins_heading.execute(params![
                        fg.rel,
                        h.level as i64,
                        h.text,
                        anchor,
                        h.ord as i64
                    ])?;
                }
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// All files known to the graph, sorted by path.
    pub fn files(&self) -> Result<Vec<String>> {
        tracing::debug!("graph::files");
        let conn = self.reader()?;
        // Contacts are markdown files with a more specific kind tag;
        // include them so callers iterating the workspace's notes see
        // them too.
        let mut stmt = conn.prepare_cached(
            "SELECT rel_path FROM nodes WHERE kind IN ('file', 'contact') ORDER BY rel_path",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// All indexed files, including non-document text files, with their last-seen
    /// `(mtime, size)` tuple. Either component is `None` when the
    /// indexer couldn't stat the file or the row predates the v5
    /// migration (size column NULL). Sorted by path. Used by
    /// `Workspace::reconcile` to compute a strictly tighter diff than mtime
    /// alone: a same-mtime rewrite that changes the size is caught; same mtime
    /// and same size still slips by.
    pub fn files_with_stat(&self) -> Result<Vec<FileStatRow>> {
        tracing::debug!("graph::files_with_stat");
        let conn = self.reader()?;
        let mut stmt = conn.prepare_cached(
            "SELECT rel_path, mtime, size FROM nodes \
             WHERE kind IN ('file', 'contact') \
             UNION ALL SELECT rel_path, mtime, size FROM text_files ORDER BY rel_path",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<i64>>(2)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Look up the node kind for a single rel path. Returns `None`
    /// when no row exists (file isn't indexed yet, was deleted, or
    /// the caller passed a path that isn't a markdown note). Used by
    /// `Workspace::resolve_link` so the editor can stamp a kind-aware
    /// pill (e.g. contact pill vs generic doc link) on a wiki-link
    /// without re-parsing the target's frontmatter.
    pub fn node_kind(&self, rel: &str) -> Result<Option<NodeKind>> {
        let conn = self.reader()?;
        let mut stmt = conn.prepare_cached("SELECT kind FROM nodes WHERE rel_path = ?1")?;
        let row: Option<String> = stmt
            .query_row(params![rel], |r| r.get::<_, String>(0))
            .optional()?;
        Ok(row.map(|s| NodeKind::from_db(&s)))
    }

    /// All contact-kind nodes, sorted by display name. Convenience
    /// wrapper on `contacts_filtered(None, usize::MAX)` for callers
    /// (CLI, tests) that want the whole list.
    pub fn contacts(&self) -> Result<Vec<ContactNode>> {
        self.contacts_filtered(None, usize::MAX)
    }

    /// Contact-kind nodes filtered + capped at the SQL layer. Backs
    /// the editor's `@` picker and `GET /api/contacts`.
    ///
    /// `query`: case-insensitive substring matched against `title`
    /// (the `# H1` of the imported note), `basename` (the file name
    /// minus directory), and the space-joined `emails` and `aliases`
    /// columns, LIKE-escaped. `None` or empty matches everything.
    /// `limit`: hard cap on rows returned. Callers that want
    /// "everything" pass `usize::MAX`.
    ///
    /// Push-down rationale: the picker fires per-keystroke, and
    /// loading the full list + lowercasing every row in Rust is O(N)
    /// per request. SQLite's `LIKE` with `COLLATE NOCASE` does the
    /// same case-insensitive contains check at the storage layer and
    /// stops walking once `limit` rows match.
    pub fn contacts_filtered(&self, query: Option<&str>, limit: usize) -> Result<Vec<ContactNode>> {
        let needle = query.map(|s| s.trim()).filter(|s| !s.is_empty());
        tracing::debug!(?needle, limit, "graph::contacts_filtered");
        let conn = self.reader()?;
        let limit_sql: i64 = limit.min(i64::MAX as usize) as i64;

        // Two SQL shapes so the unfiltered path stays a clean
        // `WHERE kind = 'contact'` (planner picks the kind index, no
        // wasted LIKE work), and the filtered path adds
        // case-insensitive contains predicates against title,
        // basename, emails, and aliases.
        if let Some(q) = needle {
            // Use the same LIKE-wildcard escape pair (`like_escape` +
            // `ESCAPE '\\'`) the link-targets path uses so a query of
            // "100%off" matches literally instead of as a wildcard.
            // The emails column carries every address joined by spaces,
            // so a substring match on it is enough to surface
            // `alice@example.com` for a typed `alice` (or even
            // `example.com`) without a side-table join.
            let pattern = format!("%{}%", like_escape(q));
            let mut stmt = conn.prepare_cached(
                "SELECT rel_path, basename, title, emails, aliases FROM nodes \
                 WHERE kind = 'contact' \
                   AND (title LIKE ?1 ESCAPE '\\' COLLATE NOCASE \
                        OR basename LIKE ?1 ESCAPE '\\' COLLATE NOCASE \
                        OR emails LIKE ?1 ESCAPE '\\' COLLATE NOCASE \
                        OR aliases LIKE ?1 ESCAPE '\\' COLLATE NOCASE) \
                 ORDER BY COALESCE(title, basename, rel_path) COLLATE NOCASE \
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![pattern, limit_sql], row_to_contact)?;
            let mut out = Vec::with_capacity(limit.min(64));
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        } else {
            let mut stmt = conn.prepare_cached(
                "SELECT rel_path, basename, title, emails, aliases FROM nodes \
                 WHERE kind = 'contact' \
                 ORDER BY COALESCE(title, basename, rel_path) COLLATE NOCASE \
                 LIMIT ?1",
            )?;
            let rows = stmt.query_map(params![limit_sql], row_to_contact)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        }
    }

    /// Link-autocomplete lookup. Drives the `[[` typeahead in the
    /// editor: the user types a fragment and gets back files and
    /// headings to link to.
    ///
    /// Empty `q`: most-recently-edited files first, up to `limit`.
    /// Useful as the initial state of the picker before any keystroke.
    ///
    /// Non-empty `q`: four-tier ASCII case-insensitive match.
    ///
    ///   rank 1  basename starts with q   (e.g. "carb" -> "carbonara.md")
    ///   rank 2  basename contains q      (e.g. "bona" -> "carbonara.md")
    ///   rank 3  title contains q         (e.g. "pasta" -> "2026-05-06.md"
    ///                                     when its h1 is "Pasta night")
    ///   rank 4  heading text contains q  (anchor target inside a file)
    ///
    /// Within a rank, files sort by `mtime DESC NULLS LAST, rel_path
    /// ASC`; headings sort by `rel_path, ord`. Heading hits are
    /// capped at half the limit so a single noisy file with many
    /// heading hits cannot drown out file matches.
    ///
    /// LIKE wildcards (`%`, `_`) and the escape char (`\`) in `q`
    /// are escaped so a filename "100%off.md" is never matched by a
    /// raw "%" query. Case-folding is ASCII-only (SQLite's `LOWER`);
    /// non-ASCII queries match case-sensitively. Sufficient for v1
    /// English/Western notes; revisit when a real Unicode-aware
    /// backend becomes a priority.
    pub fn link_targets(&self, q: &str, limit: u32) -> Result<Vec<LinkTarget>> {
        tracing::debug!(q, limit, "graph::link_targets");
        let limit = if limit == 0 { 50 } else { limit } as i64;
        let conn = self.reader()?;
        if q.is_empty() {
            return recent_files(&conn, limit);
        }
        let escaped = like_escape(q);
        let prefix_pat = format!("{escaped}%");
        let contains_pat = format!("%{escaped}%");

        let mut out = Vec::new();
        // Files: ranks 1-3.
        let mut stmt = conn.prepare_cached(
            "SELECT rel_path, title, mtime, rank FROM ( \
                SELECT rel_path, title, mtime, \
                    CASE \
                        WHEN LOWER(IFNULL(basename, rel_path)) LIKE LOWER(?1) ESCAPE '\\' THEN 1 \
                        WHEN LOWER(IFNULL(basename, rel_path)) LIKE LOWER(?2) ESCAPE '\\' THEN 2 \
                        WHEN title IS NOT NULL AND LOWER(title) LIKE LOWER(?2) ESCAPE '\\' THEN 3 \
                        ELSE 99 \
                    END AS rank \
                FROM nodes WHERE kind IN ('file', 'contact') \
             ) WHERE rank < 99 \
             ORDER BY rank ASC, mtime DESC, rel_path ASC \
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![prefix_pat, contains_pat, limit], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<i64>>(2)?,
            ))
        })?;
        for row in rows {
            let (rel_path, title, mtime) = row?;
            out.push(LinkTarget {
                kind: LinkTargetKind::File,
                path: rel_path,
                title,
                heading: None,
                anchor: None,
                level: None,
                mtime,
            });
        }

        // Headings: rank 4. Capped at limit/2 so a single TOC-heavy
        // file doesn't drown out file matches.
        let heading_cap = (limit / 2).max(1);
        let mut stmt = conn.prepare_cached(
            "SELECT rel_path, level, text, anchor \
             FROM headings \
             WHERE LOWER(text) LIKE LOWER(?1) ESCAPE '\\' \
             ORDER BY rel_path ASC, ord ASC \
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![contains_pat, heading_cap], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)? as u8,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        for row in rows {
            let (rel_path, level, text, anchor) = row?;
            out.push(LinkTarget {
                kind: LinkTargetKind::Heading,
                path: rel_path,
                title: None,
                heading: Some(text),
                anchor: Some(anchor),
                level: Some(level),
                mtime: None,
            });
        }
        if out.len() > limit as usize {
            out.truncate(limit as usize);
        }
        Ok(out)
    }

    /// Headings of one file in document order.
    pub fn headings_of(&self, rel: &str) -> Result<Vec<HeadingRow>> {
        tracing::debug!(rel, "graph::headings_of");
        let conn = self.reader()?;
        let mut stmt = conn.prepare_cached(
            "SELECT level, text, anchor, ord FROM headings \
             WHERE rel_path = ? ORDER BY ord",
        )?;
        let rows = stmt.query_map(params![rel], |row| {
            Ok(HeadingRow {
                level: row.get::<_, i64>(0)? as u8,
                text: row.get::<_, String>(1)?,
                anchor: row.get::<_, String>(2)?,
                ord: row.get::<_, i64>(3)? as u32,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }
}

/// A heading as stored in the graph DB. Differs from
/// `markdown::Heading` by carrying the computed anchor and not the
/// source line number (we don't need it for graph queries).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeadingRow {
    pub level: u8,
    pub text: String,
    pub anchor: String,
    pub ord: u32,
}

/// Whether a `LinkTarget` row represents a file or a heading inside
/// a file. The fields populated on `LinkTarget` depend on this.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LinkTargetKind {
    /// A file. `path` + `title` + `mtime` are populated; the
    /// heading-specific fields are None.
    File,
    /// A heading inside a file. `path` is the file's rel_path;
    /// `heading` / `anchor` / `level` describe the heading.
    Heading,
}

/// One row in `link_targets` output. Owned strings and primitives with
/// serde derives, so a row crosses threads and serializes as is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkTarget {
    pub kind: LinkTargetKind,
    /// Rel path of the file (for both kinds).
    pub path: String,
    /// File's display title (h1 / frontmatter `title`). None for
    /// heading rows or for files whose title hasn't been indexed yet
    /// (the v2 graph migration leaves title NULL until the next
    /// index_file pass).
    pub title: Option<String>,
    /// Heading text. None for file rows.
    pub heading: Option<String>,
    /// Heading anchor (the URL fragment after `#`). None for files.
    pub anchor: Option<String>,
    /// Heading depth (1..=6). None for files.
    pub level: Option<u8>,
    /// File mtime as Unix seconds. None for headings.
    pub mtime: Option<i64>,
}

/// Most-recently-edited files first, up to `limit`. Used as the
/// empty-query state of the link picker.
fn recent_files(conn: &Connection, limit: i64) -> Result<Vec<LinkTarget>> {
    let mut stmt = conn.prepare_cached(
        "SELECT rel_path, title, mtime FROM nodes \
         WHERE kind IN ('file', 'contact') \
         ORDER BY mtime DESC, rel_path ASC \
         LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<i64>>(2)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (rel_path, title, mtime) = row?;
        out.push(LinkTarget {
            kind: LinkTargetKind::File,
            path: rel_path,
            title,
            heading: None,
            anchor: None,
            level: None,
            mtime,
        });
    }
    Ok(out)
}

/// rusqlite row -> ContactNode. Shared between `contacts` and
/// `contacts_filtered` so the basename fallback (derive from
/// `rel_path` when the column is NULL, e.g., for v2 rows the
/// indexer hasn't refreshed yet) lives in one place. `emails`
/// is the joined column: empty / NULL maps to an empty vec.
fn row_to_contact(row: &rusqlite::Row<'_>) -> rusqlite::Result<ContactNode> {
    let rel_path: String = row.get(0)?;
    let basename: Option<String> = row.get(1)?;
    let title: Option<String> = row.get(2)?;
    let emails_raw: Option<String> = row.get(3)?;
    let aliases_raw: Option<String> = row.get(4)?;
    let basename = basename.unwrap_or_else(|| {
        std::path::Path::new(&rel_path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(&rel_path)
            .to_string()
    });
    let emails = split_space_joined(emails_raw.as_deref());
    let aliases = split_space_joined(aliases_raw.as_deref());
    Ok(ContactNode {
        rel_path,
        basename,
        title,
        emails,
        aliases,
    })
}

/// Split a "space-joined" column (emails / aliases) back into a
/// Vec<String>. Empty / NULL returns an empty vec.
fn split_space_joined(raw: Option<&str>) -> Vec<String> {
    raw.map(|s| {
        s.split_whitespace()
            .filter(|t| !t.is_empty())
            .map(str::to_owned)
            .collect()
    })
    .unwrap_or_default()
}

/// Escape SQL LIKE wildcards (`%`, `_`) and the escape character
/// (`\`) so user-typed queries are matched literally. Pair with
/// `ESCAPE '\\'` in the SQL.
fn like_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn count(g: &GraphView, sql: &str) -> i64 {
        let conn = g.reader().unwrap();
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn migration_v6_preserves_graph_and_adds_text_stamps() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("graph.sqlite");
        {
            let g = GraphView::open(&db).unwrap();
            let conn = g.writer.lock().unwrap();
            conn.execute_batch(
                "DROP TABLE IF EXISTS text_files;
                INSERT INTO nodes(rel_path, kind, mtime, size) VALUES ('source.md', 'file', 1, 20);
                INSERT INTO edges(src, dst, kind) VALUES ('source.md', 'notes.txt', 'link');
                PRAGMA user_version = 6;",
            )
            .unwrap();
        }
        let g = GraphView::open(&db).unwrap();
        assert_eq!(count(&g, "PRAGMA user_version"), 8);
        assert_eq!(g.files().unwrap(), ["source.md"]);
        assert_eq!(g.backlinks("notes.txt").unwrap().len(), 1);
        assert_eq!(count(&g, "SELECT COUNT(*) FROM text_files"), 0);
        {
            let conn = g.writer.lock().unwrap();
            conn.execute(
                "INSERT INTO text_files(rel_path, mtime, size) VALUES ('notes.txt', 2, 10)",
                [],
            )
            .unwrap();
        }
        drop(g);
        let g = GraphView::open(&db).unwrap();
        assert_eq!(count(&g, "SELECT COUNT(*) FROM text_files"), 1);
        assert_eq!(g.backlinks("notes.txt").unwrap().len(), 1);
    }

    #[test]
    fn migration_v8_adds_the_no_index_entry_mark_unset() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("graph.sqlite");
        {
            let g = GraphView::open(&db).unwrap();
            let conn = g.writer.lock().unwrap();
            conn.execute_batch(
                "ALTER TABLE nodes DROP COLUMN no_index_entry;
                ALTER TABLE text_files DROP COLUMN no_index_entry;
                INSERT INTO nodes(rel_path, kind, mtime, size) VALUES ('source.md', 'file', 1, 20);
                INSERT INTO text_files(rel_path, mtime, size) VALUES ('notes.txt', 2, 10);
                PRAGMA user_version = 7;",
            )
            .unwrap();
        }
        let g = GraphView::open(&db).unwrap();
        assert_eq!(count(&g, "PRAGMA user_version"), 8);
        // Rows from before the column are treated like the rows a full
        // rebuild writes: unmarked, so reconcile reads each once when the
        // index lacks it.
        assert!(g.paths_without_index_entry().unwrap().is_empty());
        assert_eq!(g.files_with_stat().unwrap().len(), 2);

        g.mark_no_index_entry("source.md").unwrap();
        g.mark_no_index_entry("notes.txt").unwrap();
        assert_eq!(
            g.paths_without_index_entry().unwrap(),
            ["notes.txt", "source.md"]
        );

        // A rewritten row's content is not known to be empty until it is
        // indexed, so both writers leave the mark unset.
        g.stamp_text_file("notes.txt", Some(3), Some(11)).unwrap();
        assert_eq!(g.paths_without_index_entry().unwrap(), ["source.md"]);
        g.replace_file(FileRecord {
            rel: "source.md",
            title: None,
            mtime: Some(4),
            size: Some(21),
            node_kind: NodeKind::File,
            outgoing: &[],
            headings: &[],
            emails: None,
            aliases: None,
        })
        .unwrap();
        assert!(g.paths_without_index_entry().unwrap().is_empty());
    }

    #[test]
    fn open_creates_schema() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("graph.sqlite");
        let g = GraphView::open(&db).unwrap();
        assert_eq!(count(&g, "PRAGMA user_version"), 8);
    }

    #[test]
    fn workspace_search_batched_edges_cross_bind_limit_and_incoming_is_not_link_only() {
        let tmp = TempDir::new().unwrap();
        let g = GraphView::open(&tmp.path().join("g.sqlite")).unwrap();
        let nodes: Vec<String> = (0..905).map(|i| format!("notes/{i}.md")).collect();
        {
            let conn = g.writer.lock().unwrap();
            let tx = conn.unchecked_transaction().unwrap();
            {
                let mut insert = tx
                    .prepare("INSERT INTO edges(src, dst, kind, anchor) VALUES (?1, '#shared', 'tag', '')")
                    .unwrap();
                for node in &nodes {
                    insert.execute(params![node]).unwrap();
                }
            }
            tx.commit().unwrap();
        }

        let outgoing = g.edges_from(&nodes, &[EdgeKind::Tag]).unwrap();
        assert_eq!(outgoing.len(), nodes.len());
        assert_eq!(outgoing.first().unwrap().src, "notes/0.md");
        assert_eq!(outgoing.last().unwrap().src, "notes/99.md");

        let incoming = g
            .edges_to(&["#shared".to_string()], &[EdgeKind::Tag])
            .unwrap();
        assert_eq!(incoming, outgoing);
        assert!(g.backlinks("#shared").unwrap().is_empty());
    }

    #[test]
    fn reader_pool_is_query_only() {
        // Defense-in-depth: every pooled reader has query_only=ON,
        // so a stray write attempted through a reader connection
        // fails fast with SQLITE_READONLY instead of racing the
        // writer's tx. If this assertion ever flips, a reader-side
        // mutation could land on disk and skip the writer mutex.
        let tmp = TempDir::new().unwrap();
        let g = GraphView::open(&tmp.path().join("g.sqlite")).unwrap();
        assert_eq!(count(&g, "PRAGMA query_only"), 1);
        let conn = g.reader().unwrap();
        let err = conn
            .execute("INSERT INTO nodes(rel_path, kind) VALUES ('x','file')", [])
            .unwrap_err();
        let msg = err.to_string().to_ascii_lowercase();
        assert!(
            msg.contains("readonly") || msg.contains("read-only"),
            "expected readonly rejection, got: {msg}",
        );
    }

    #[test]
    fn reads_run_concurrently_with_writes() {
        // Single writer, multi-reader: a write tx in progress on
        // one thread must not block readers on another. WAL +
        // reader pool are what buy us this; the test shape pins
        // the contract so a future regression to one connection
        // would fail loudly instead of silently re-serializing.
        use std::sync::Barrier;
        use std::thread;

        let tmp = TempDir::new().unwrap();
        let g = std::sync::Arc::new(GraphView::open(&tmp.path().join("g.sqlite")).unwrap());
        // Seed a row so the read returns predictable data.
        g.replace_file(FileRecord {
            rel: "a.md",
            title: Some("Alpha"),
            mtime: Some(1),
            size: None,
            node_kind: NodeKind::File,
            outgoing: &[],
            headings: &[],
            emails: None,
            aliases: None,
        })
        .unwrap();

        // Three concurrent readers, one writer. Each reader does
        // many small queries; if the pool serialised them through
        // a single connection the wall-time would be the sum.
        let barrier = std::sync::Arc::new(Barrier::new(4));
        let mut handles = Vec::new();
        for _ in 0..3 {
            let g = std::sync::Arc::clone(&g);
            let b = std::sync::Arc::clone(&barrier);
            handles.push(thread::spawn(move || {
                b.wait();
                for _ in 0..50 {
                    let files = g.files().expect("read");
                    assert!(files.contains(&"a.md".to_string()));
                }
            }));
        }
        // Writer thread: keep replacing the same row so the writer
        // mutex is contended for the duration of the reads.
        let writer = {
            let g = std::sync::Arc::clone(&g);
            let b = std::sync::Arc::clone(&barrier);
            thread::spawn(move || {
                b.wait();
                for i in 0..50 {
                    g.replace_file(FileRecord {
                        rel: "a.md",
                        title: Some("Alpha"),
                        mtime: Some(i),
                        size: None,
                        node_kind: NodeKind::File,
                        outgoing: &[],
                        headings: &[],
                        emails: None,
                        aliases: None,
                    })
                    .expect("write");
                }
            })
        };
        for h in handles {
            h.join().expect("reader thread panicked");
        }
        writer.join().expect("writer thread panicked");
    }

    /// Regression guard for the Windows file-open hang: a reader
    /// checkout that can't get a free connection must FAIL FAST, not
    /// park on r2d2's 30s default.
    ///
    /// Reproduces the contention shape without a real reindex: hold
    /// every connection in the pool (the cold-rebuild equivalent of the
    /// DB being saturated) and then time a further checkout. With the
    /// 30s default this call blocks for half a minute -- the exact stall
    /// that froze the workspace window's inspector/backlinks/graph reads
    /// on file-open. With the explicit `READER_CHECKOUT_TIMEOUT` bound
    /// it returns an `Err` promptly. We assert it returns in well under
    /// the 30s default (so the bound is actually applied) and at/after
    /// the configured 2s (so the timeout fires, rather than there being
    /// a spare connection).
    #[test]
    fn reader_checkout_fails_fast_when_pool_is_saturated() {
        use std::time::Instant;

        let tmp = TempDir::new().unwrap();
        let g = GraphView::open(&tmp.path().join("g.sqlite")).unwrap();

        // Hold every connection the pool can hand out. `min_idle ==
        // max_size` means the pool is fully provisioned, so this checks
        // out the entire capacity and leaves zero free for the next
        // caller -- the same dead-end a backlog of reindex-contended
        // reads hits.
        let capacity = g.readers.max_size() as usize;
        let held: Vec<ReaderConn> = (0..capacity)
            .map(|_| g.reader().expect("seed checkout"))
            .collect();
        assert_eq!(held.len(), capacity, "pool should hand out its full size");

        let start = Instant::now();
        let result = g.reader();
        let elapsed = start.elapsed();

        assert!(
            result.is_err(),
            "a saturated-pool checkout must error, not return a phantom connection",
        );
        // The whole point: nowhere near r2d2's 30s default. Generous
        // upper bound (configured 2s + slack) keeps the test stable on
        // a loaded CI box while still failing loudly if the timeout
        // silently reverts to the default.
        assert!(
            elapsed < Duration::from_secs(10),
            "checkout took {elapsed:?}; expected ~{READER_CHECKOUT_TIMEOUT:?}, \
             NOT the r2d2 30s default: connection_timeout was not applied",
        );
        // And it actually waited for the bound rather than erroring
        // instantly, proving the timeout (not some other failure) is
        // what fired. Small floor under the 2s config to tolerate timer
        // granularity.
        assert!(
            elapsed >= Duration::from_millis(1500),
            "checkout returned in {elapsed:?}, faster than the {READER_CHECKOUT_TIMEOUT:?} \
             bound: the timeout did not gate the wait",
        );

        drop(held);
        // Once a connection frees up, checkout succeeds again.
        g.reader().expect("checkout after release");
    }

    #[test]
    fn replace_all_clears_then_inserts_in_one_tx() {
        let tmp = TempDir::new().unwrap();
        let g = GraphView::open(&tmp.path().join("g.sqlite")).unwrap();
        // Pre-populate so we can verify clear-and-replace semantics.
        g.replace_file(FileRecord {
            rel: "old.md",
            title: Some("Old"),
            mtime: Some(1),
            size: None,
            node_kind: NodeKind::File,
            outgoing: &[],
            headings: &[],
            emails: None,
            aliases: None,
        })
        .unwrap();
        assert_eq!(
            count(&g, "SELECT COUNT(*) FROM nodes WHERE rel_path='old.md'"),
            1
        );
        let edges = vec![Edge {
            src: "a.md".into(),
            dst: "b.md".into(),
            kind: EdgeKind::Link,
            anchor: None,
        }];
        let headings = vec![markdown::Heading {
            ord: 0,
            line: 0,
            level: 1,
            text: "Hello".into(),
        }];
        let entries = vec![
            FileGraph {
                rel: "a.md",
                title: Some("Alpha"),
                mtime: Some(10),
                size: None,
                node_kind: NodeKind::File,
                edges: &edges,
                headings: &headings,
                emails: None,
                aliases: None,
            },
            FileGraph {
                rel: "b.md",
                title: None,
                mtime: Some(20),
                size: None,
                node_kind: NodeKind::File,
                edges: &[],
                headings: &[],
                emails: None,
                aliases: Some("bee bumble"),
            },
        ];
        g.replace_all(&entries).unwrap();
        // The rebuild keeps every node column the incremental writers keep,
        // aliases included, so @@alias resolution survives it.
        assert_eq!(
            count(
                &g,
                "SELECT COUNT(*) FROM nodes WHERE rel_path='b.md' AND aliases='bee bumble'"
            ),
            1
        );
        // Old entry is gone, new ones present.
        assert_eq!(count(&g, "SELECT COUNT(*) FROM nodes"), 2);
        assert_eq!(
            count(&g, "SELECT COUNT(*) FROM nodes WHERE rel_path='old.md'"),
            0
        );
        assert_eq!(count(&g, "SELECT COUNT(*) FROM edges"), 1);
        assert_eq!(count(&g, "SELECT COUNT(*) FROM headings"), 1);
    }

    #[test]
    fn replace_then_forget_round_trips() {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("graph.sqlite");
        let g = GraphView::open(&db).unwrap();
        g.replace_file(FileRecord {
            rel: "notes/a.md",
            title: Some("Hello"),
            mtime: Some(1000),
            size: None,
            node_kind: NodeKind::File,
            outgoing: &[],
            headings: &[],
            emails: None,
            aliases: None,
        })
        .unwrap();
        assert_eq!(
            count(
                &g,
                "SELECT COUNT(*) FROM nodes WHERE rel_path = 'notes/a.md'"
            ),
            1
        );
        g.forget_file("notes/a.md").unwrap();
        assert_eq!(
            count(
                &g,
                "SELECT COUNT(*) FROM nodes WHERE rel_path = 'notes/a.md'"
            ),
            0
        );
    }

    #[test]
    fn replace_file_keeps_two_anchors_to_the_same_target() {
        // A file that links the same target via two different anchors must keep
        // both edges, so the primary key includes the anchor.
        let tmp = TempDir::new().unwrap();
        let g = GraphView::open(&tmp.path().join("g.sqlite")).unwrap();
        let link = |anchor: &str| Edge {
            src: "notes/a.md".to_string(),
            dst: "notes/b.md".to_string(),
            kind: EdgeKind::Link,
            anchor: Some(anchor.to_string()),
        };
        g.replace_file(FileRecord {
            rel: "notes/a.md",
            title: None,
            mtime: Some(1),
            size: None,
            node_kind: NodeKind::File,
            outgoing: &[link("section-one"), link("section-two")],
            headings: &[],
            emails: None,
            aliases: None,
        })
        .unwrap();

        let mut anchors: Vec<Option<String>> = g
            .neighbors("notes/a.md")
            .unwrap()
            .into_iter()
            .filter(|e| e.dst == "notes/b.md")
            .map(|e| e.anchor)
            .collect();
        anchors.sort();
        assert_eq!(
            anchors,
            vec![
                Some("section-one".to_string()),
                Some("section-two".to_string())
            ],
            "both anchors to the same target must survive the PK dedup"
        );
    }

    #[test]
    fn replace_file_no_anchor_edge_reads_back_as_none() {
        // The NOT NULL '' sentinel must surface as anchor: None so the
        // Edge contract ("Some iff a real anchor") holds for callers.
        let tmp = TempDir::new().unwrap();
        let g = GraphView::open(&tmp.path().join("g.sqlite")).unwrap();
        g.replace_file(FileRecord {
            rel: "notes/a.md",
            title: None,
            mtime: Some(1),
            size: None,
            node_kind: NodeKind::File,
            outgoing: &[Edge {
                src: "notes/a.md".to_string(),
                dst: "notes/b.md".to_string(),
                kind: EdgeKind::Link,
                anchor: None,
            }],
            headings: &[],
            emails: None,
            aliases: None,
        })
        .unwrap();
        let edges = g.neighbors("notes/a.md").unwrap();
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].anchor, None);
    }

    fn populate(g: &GraphView, files: &[(&str, Option<&str>, Option<i64>)]) {
        for (rel, title, mtime) in files {
            g.replace_file(FileRecord {
                rel,
                title: *title,
                mtime: *mtime,
                size: None,
                node_kind: NodeKind::File,
                outgoing: &[],
                headings: &[],
                emails: None,
                aliases: None,
            })
            .unwrap();
        }
    }

    #[test]
    fn node_kind_returns_indexed_kind_or_none() {
        let tmp = TempDir::new().unwrap();
        let g = GraphView::open(&tmp.path().join("g.sqlite")).unwrap();
        g.replace_file(FileRecord {
            rel: "Contacts/Alice.md",
            title: Some("Alice Anderson"),
            mtime: Some(1),
            size: None,
            node_kind: NodeKind::Contact,
            outgoing: &[],
            headings: &[],
            emails: Some("alice@example.com"),
            aliases: None,
        })
        .unwrap();
        g.replace_file(FileRecord {
            rel: "recipes/pasta.md",
            title: Some("Pasta"),
            mtime: Some(2),
            size: None,
            node_kind: NodeKind::File,
            outgoing: &[],
            headings: &[],
            emails: None,
            aliases: None,
        })
        .unwrap();
        assert_eq!(
            g.node_kind("Contacts/Alice.md").unwrap(),
            Some(NodeKind::Contact)
        );
        assert_eq!(
            g.node_kind("recipes/pasta.md").unwrap(),
            Some(NodeKind::File)
        );
        // Unknown path: None so the caller can decide what to do
        // (resolve_link uses unwrap_or_default to fall back to File).
        assert_eq!(g.node_kind("does/not/exist.md").unwrap(), None);
    }

    /// `NodeKind` serializes lowercase on the wire so the JSON value
    /// matches the SQL `nodes.kind` column and consumers don't have
    /// to switch on rust enum names.
    #[test]
    fn node_kind_serializes_lowercase() {
        let file = serde_json::to_string(&NodeKind::File).unwrap();
        let contact = serde_json::to_string(&NodeKind::Contact).unwrap();
        assert_eq!(file, "\"file\"");
        assert_eq!(contact, "\"contact\"");
    }

    #[test]
    fn contacts_filtered_pushes_query_and_limit_into_sql() {
        let tmp = TempDir::new().unwrap();
        let g = GraphView::open(&tmp.path().join("g.sqlite")).unwrap();
        // Mix of contact and file nodes; filter must skip files even
        // when their title/basename matches.
        g.replace_file(FileRecord {
            rel: "Contacts/Alice.md",
            title: Some("Alice Anderson"),
            mtime: Some(1),
            size: None,
            node_kind: NodeKind::Contact,
            outgoing: &[],
            headings: &[],
            emails: Some("alice@example.com alice.work@example.com"),
            aliases: None,
        })
        .unwrap();
        g.replace_file(FileRecord {
            rel: "Contacts/Bob.md",
            title: Some("Bob Brown"),
            mtime: Some(2),
            size: None,
            node_kind: NodeKind::Contact,
            outgoing: &[],
            headings: &[],
            emails: Some("bob@example.org"),
            aliases: None,
        })
        .unwrap();
        g.replace_file(FileRecord {
            rel: "Contacts/Charlie.md",
            title: Some("Charlie Cohen"),
            mtime: Some(3),
            size: None,
            node_kind: NodeKind::Contact,
            outgoing: &[],
            headings: &[],
            emails: None,
            aliases: None,
        })
        .unwrap();
        g.replace_file(FileRecord {
            rel: "notes/alice-mentioned.md",
            title: Some("Alice Mentioned"),
            mtime: Some(4),
            size: None,
            node_kind: NodeKind::File,
            outgoing: &[],
            headings: &[],
            emails: None,
            aliases: None,
        })
        .unwrap();

        // Case-insensitive contains on title.
        let hits = g.contacts_filtered(Some("ali"), 10).unwrap();
        let paths: Vec<_> = hits.iter().map(|c| c.rel_path.as_str()).collect();
        assert_eq!(paths, vec!["Contacts/Alice.md"]);

        // Case-insensitive contains on basename.
        let hits = g.contacts_filtered(Some("BOB"), 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].rel_path, "Contacts/Bob.md");

        // Empty / None matches all contacts in display-name order,
        // capped by limit.
        let hits = g.contacts_filtered(None, 2).unwrap();
        let paths: Vec<_> = hits.iter().map(|c| c.rel_path.as_str()).collect();
        assert_eq!(paths, vec!["Contacts/Alice.md", "Contacts/Bob.md"]);

        // Empty-string query is treated as None.
        let hits = g.contacts_filtered(Some("   "), 10).unwrap();
        assert_eq!(hits.len(), 3);

        // Email-substring match: typed local part finds the contact
        // whose stored emails column contains it.
        let hits = g.contacts_filtered(Some("bob@example"), 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].rel_path, "Contacts/Bob.md");
        assert_eq!(hits[0].emails, vec!["bob@example.org"]);

        // Email-domain match: typed domain fragment finds every
        // contact with that domain.
        let hits = g.contacts_filtered(Some("example.com"), 10).unwrap();
        let paths: Vec<_> = hits.iter().map(|c| c.rel_path.as_str()).collect();
        assert_eq!(paths, vec!["Contacts/Alice.md"]);

        // Surfaced emails are split back into a vec for picker
        // rendering.
        let alice = hits.into_iter().next().unwrap();
        assert_eq!(
            alice.emails,
            vec!["alice@example.com", "alice.work@example.com"]
        );
    }

    #[test]
    fn contacts_filtered_escapes_like_wildcards() {
        let tmp = TempDir::new().unwrap();
        let g = GraphView::open(&tmp.path().join("g.sqlite")).unwrap();
        g.replace_file(FileRecord {
            rel: "Contacts/100off.md",
            title: Some("100% Off"),
            mtime: Some(1),
            size: None,
            node_kind: NodeKind::Contact,
            outgoing: &[],
            headings: &[],
            emails: None,
            aliases: None,
        })
        .unwrap();
        g.replace_file(FileRecord {
            rel: "Contacts/Bob.md",
            title: Some("Bob"),
            mtime: Some(2),
            size: None,
            node_kind: NodeKind::Contact,
            outgoing: &[],
            headings: &[],
            emails: None,
            aliases: None,
        })
        .unwrap();
        // A bare `%` would be a SQL LIKE wildcard matching everything.
        // After escaping it must match only the literal "%".
        let hits = g.contacts_filtered(Some("%"), 10).unwrap();
        let paths: Vec<_> = hits.iter().map(|c| c.rel_path.as_str()).collect();
        assert_eq!(paths, vec!["Contacts/100off.md"]);
    }

    #[test]
    fn link_targets_ranks_prefix_above_substring() {
        let tmp = TempDir::new().unwrap();
        let g = GraphView::open(&tmp.path().join("g.sqlite")).unwrap();
        populate(
            &g,
            &[
                ("recipes/carbonara.md", Some("Carbonara"), Some(2000)),
                ("notes/oscarboxing.md", Some("Oscar Boxing"), Some(3000)),
                ("notes/title-only.md", Some("Carbon dating"), Some(4000)),
            ],
        );
        let hits = g.link_targets("carb", 10).unwrap();
        let names: Vec<_> = hits.iter().map(|h| h.path.as_str()).collect();
        // rank-1 (basename starts with "carb") must come before
        // rank-2 (basename contains "carb") which comes before
        // rank-3 (title contains "carb").
        assert_eq!(
            names,
            vec![
                "recipes/carbonara.md",
                "notes/oscarboxing.md",
                "notes/title-only.md",
            ]
        );
    }

    #[test]
    fn link_targets_empty_query_returns_recent() {
        let tmp = TempDir::new().unwrap();
        let g = GraphView::open(&tmp.path().join("g.sqlite")).unwrap();
        populate(
            &g,
            &[
                ("a.md", None, Some(1000)),
                ("b.md", None, Some(3000)),
                ("c.md", None, Some(2000)),
            ],
        );
        let hits = g.link_targets("", 10).unwrap();
        let names: Vec<_> = hits.iter().map(|h| h.path.as_str()).collect();
        assert_eq!(names, vec!["b.md", "c.md", "a.md"]);
    }

    #[test]
    fn link_targets_finds_headings() {
        let tmp = TempDir::new().unwrap();
        let g = GraphView::open(&tmp.path().join("g.sqlite")).unwrap();
        let headings = vec![
            markdown::Heading {
                ord: 0,
                line: 0,
                level: 1,
                text: "Pasta night".into(),
            },
            markdown::Heading {
                ord: 1,
                line: 5,
                level: 2,
                text: "Carbonara variant".into(),
            },
        ];
        g.replace_file(FileRecord {
            rel: "notes/2026-05-06.md",
            title: Some("Pasta night"),
            mtime: Some(1),
            size: None,
            node_kind: NodeKind::File,
            outgoing: &[],
            headings: &headings,
            emails: None,
            aliases: None,
        })
        .unwrap();
        let hits = g.link_targets("variant", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, LinkTargetKind::Heading);
        assert_eq!(hits[0].heading.as_deref(), Some("Carbonara variant"));
        // Anchor is the slug of the heading text.
        assert_eq!(hits[0].anchor.as_deref(), Some("carbonara-variant"));
        assert_eq!(hits[0].level, Some(2));
    }

    #[test]
    fn link_targets_is_ascii_case_insensitive() {
        let tmp = TempDir::new().unwrap();
        let g = GraphView::open(&tmp.path().join("g.sqlite")).unwrap();
        populate(&g, &[("Recipes/Carbonara.md", Some("Carbonara"), Some(1))]);
        let hits = g.link_targets("CARB", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "Recipes/Carbonara.md");
    }

    #[test]
    fn link_targets_escapes_like_wildcards() {
        let tmp = TempDir::new().unwrap();
        let g = GraphView::open(&tmp.path().join("g.sqlite")).unwrap();
        populate(
            &g,
            &[("100off.md", None, Some(2)), ("100%off.md", None, Some(1))],
        );
        // A bare "%" in the query must match literally, not act as
        // a SQL wildcard. Only "100%off.md" should match.
        let hits = g.link_targets("%", 10).unwrap();
        let names: Vec<_> = hits.iter().map(|h| h.path.as_str()).collect();
        assert_eq!(names, vec!["100%off.md"]);
    }

    #[test]
    fn link_targets_caps_heading_results_at_half_limit() {
        let tmp = TempDir::new().unwrap();
        let g = GraphView::open(&tmp.path().join("g.sqlite")).unwrap();
        let mut hs = Vec::new();
        for i in 0..20 {
            hs.push(markdown::Heading {
                ord: i,
                line: i,
                level: 2,
                text: format!("note-{i}"),
            });
        }
        g.replace_file(FileRecord {
            rel: "toc-heavy.md",
            title: None,
            mtime: Some(1),
            size: None,
            node_kind: NodeKind::File,
            outgoing: &[],
            headings: &hs,
            emails: None,
            aliases: None,
        })
        .unwrap();
        let hits = g.link_targets("note", 10).unwrap();
        // Cap at limit/2 = 5 heading hits, regardless of how many
        // headings actually match.
        let heading_hits = hits
            .iter()
            .filter(|h| h.kind == LinkTargetKind::Heading)
            .count();
        assert_eq!(heading_hits, 5);
    }

    #[test]
    fn migration_v2_idempotent_when_columns_already_present() {
        // Simulates a crash that landed the ALTER TABLE statements
        // but not the basename backfill. user_version is still 1, the
        // columns are present and basename is NULL. The next open must
        // not error on re-ALTER and must complete the backfill.
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("g.sqlite");
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch(
                r#"
                CREATE TABLE nodes (
                    rel_path TEXT PRIMARY KEY,
                    kind     TEXT NOT NULL,
                    mtime    INTEGER,
                    title    TEXT,
                    basename TEXT
                );
                CREATE TABLE edges (
                    src    TEXT NOT NULL,
                    dst    TEXT NOT NULL,
                    kind   TEXT NOT NULL,
                    anchor TEXT,
                    PRIMARY KEY (src, dst, kind)
                );
                CREATE TABLE headings (
                    rel_path TEXT NOT NULL,
                    level    INTEGER NOT NULL,
                    text     TEXT NOT NULL,
                    anchor   TEXT NOT NULL,
                    ord      INTEGER NOT NULL,
                    PRIMARY KEY (rel_path, ord)
                );
                INSERT INTO nodes(rel_path, kind, mtime, title, basename)
                VALUES ('half/done.md', 'file', 5, NULL, NULL);
                PRAGMA user_version = 1;
                "#,
            )
            .unwrap();
        }
        let g = GraphView::open(&db).unwrap();
        let conn = g.reader().unwrap();
        let bn: Option<String> = conn
            .query_row(
                "SELECT basename FROM nodes WHERE rel_path='half/done.md'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(bn.as_deref(), Some("done.md"));
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 8);
    }

    #[test]
    fn migration_v2_backfills_basename_for_existing_nodes() {
        // Open at v1, insert a row by hand (simulating an old DB),
        // then re-open: migration must populate basename without
        // touching title (which we don't have at migration time).
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("g.sqlite");
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch(
                r#"
                CREATE TABLE nodes (
                    rel_path TEXT PRIMARY KEY,
                    kind     TEXT NOT NULL,
                    mtime    INTEGER
                );
                CREATE TABLE edges (
                    src    TEXT NOT NULL,
                    dst    TEXT NOT NULL,
                    kind   TEXT NOT NULL,
                    anchor TEXT,
                    PRIMARY KEY (src, dst, kind)
                );
                CREATE TABLE headings (
                    rel_path TEXT NOT NULL,
                    level    INTEGER NOT NULL,
                    text     TEXT NOT NULL,
                    anchor   TEXT NOT NULL,
                    ord      INTEGER NOT NULL,
                    PRIMARY KEY (rel_path, ord)
                );
                INSERT INTO nodes(rel_path, kind, mtime)
                VALUES ('legacy/note.md', 'file', 1000);
                PRAGMA user_version = 1;
                "#,
            )
            .unwrap();
        }
        let g = GraphView::open(&db).unwrap();
        let conn = g.reader().unwrap();
        let bn: Option<String> = conn
            .query_row(
                "SELECT basename FROM nodes WHERE rel_path='legacy/note.md'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(bn.as_deref(), Some("note.md"));
        let title: Option<String> = conn
            .query_row(
                "SELECT title FROM nodes WHERE rel_path='legacy/note.md'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            title.is_none(),
            "title backfill needs file content; stays NULL"
        );
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 8);
    }

    /// Stages a few files into the staging tables, verifies the
    /// cursor advances, swaps, and verifies the live tables reflect
    /// the staged data and staging is empty.
    #[test]
    fn staging_cursor_swap_round_trip() {
        let tmp = TempDir::new().unwrap();
        let g = GraphView::open(&tmp.path().join("g.sqlite")).unwrap();
        assert!(g.staging_cursor().unwrap().is_none());

        // `stage_file` overrides the edge's `src` with the
        // FileGraph's rel, so the field's value here is filled in
        // for API completeness only.
        let edges_b = vec![Edge {
            src: "ignored".to_string(),
            dst: "a".to_string(),
            kind: EdgeKind::Link,
            anchor: None,
        }];
        for (rel, edges) in [
            ("a.md", &[][..]),
            ("b.md", edges_b.as_slice()),
            ("c.md", &[][..]),
        ] {
            let fg = FileGraph {
                rel,
                title: None,
                mtime: Some(1),
                size: None,
                node_kind: NodeKind::File,
                edges,
                headings: &[],
                emails: None,
                aliases: None,
            };
            g.stage_file(&fg).unwrap();
        }
        assert_eq!(g.staging_cursor().unwrap().as_deref(), Some("c.md"));

        g.swap_staging().unwrap();
        assert!(g.staging_cursor().unwrap().is_none());
        let mut files = g.files().unwrap();
        files.sort();
        assert_eq!(files, vec!["a.md", "b.md", "c.md"]);
        // Edge survived the swap.
        let backlinks = g.backlinks("a").unwrap();
        assert!(backlinks.iter().any(|e| e.src == "b.md"));
    }

    /// Stages files, runs sanitize_staging with a smaller live set,
    /// verifies the missing files are purged out of staging before
    /// the next swap.
    #[test]
    fn sanitize_staging_drops_rows_not_in_live_set() {
        let tmp = TempDir::new().unwrap();
        let g = GraphView::open(&tmp.path().join("g.sqlite")).unwrap();
        for rel in ["a.md", "b.md", "c.md"] {
            let fg = FileGraph {
                rel,
                title: None,
                mtime: Some(1),
                size: None,
                node_kind: NodeKind::File,
                edges: &[],
                headings: &[],
                emails: None,
                aliases: None,
            };
            g.stage_file(&fg).unwrap();
        }
        let live: std::collections::HashSet<String> = ["a.md".to_string(), "c.md".to_string()]
            .into_iter()
            .collect();
        let purged = g.sanitize_staging(&live).unwrap();
        assert_eq!(purged, 1);
        g.swap_staging().unwrap();
        let mut files = g.files().unwrap();
        files.sort();
        assert_eq!(files, vec!["a.md", "c.md"]);
    }

    /// A swap is atomic against readers: while staging holds the
    /// new shape, the live tables still serve the previous one.
    /// After swap, the live tables serve the new shape and staging
    /// is empty.
    #[test]
    fn swap_staging_atomically_replaces_live_state() {
        let tmp = TempDir::new().unwrap();
        let g = GraphView::open(&tmp.path().join("g.sqlite")).unwrap();
        // Seed live with a single file via the existing replace_file.
        g.replace_file(FileRecord {
            rel: "old.md",
            title: Some("Old"),
            mtime: Some(1),
            size: None,
            node_kind: NodeKind::File,
            outgoing: &[],
            headings: &[],
            emails: None,
            aliases: None,
        })
        .unwrap();
        // Stage a different file. While we haven't swapped yet,
        // the live state still surfaces only the original entry.
        let fg = FileGraph {
            rel: "new.md",
            title: None,
            mtime: Some(2),
            size: None,
            node_kind: NodeKind::File,
            edges: &[],
            headings: &[],
            emails: None,
            aliases: None,
        };
        g.stage_file(&fg).unwrap();
        assert_eq!(g.files().unwrap(), vec!["old.md".to_string()]);
        // After swap, only the staged file remains.
        g.swap_staging().unwrap();
        assert_eq!(g.files().unwrap(), vec!["new.md".to_string()]);
        // Staging is empty after the swap.
        assert!(g.staging_cursor().unwrap().is_none());
    }
}
