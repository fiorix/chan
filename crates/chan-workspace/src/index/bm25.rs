// BM25 side of the search index, backed by tantivy. Owns the
// `bm25/` subdirectory under the per-workspace index dir (resolved
// by `crate::paths::workspace_paths`).
//
// Each indexed unit is one chunk (see `index::chunking`). We delete
// by `path` so re-indexing a file is "remove all its chunks, then
// add the new ones" without tracking individual chunk ids.
//
// The body field is STORED so snippet generation is self-contained
// (no second read of the source file at query time). Index size
// roughly doubles vs not storing; for personal-notes corpora that's
// still tiny (~MBs).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tantivy::collector::TopDocs;
use tantivy::indexer::IndexWriterOptions;
use tantivy::query::{BooleanQuery, Occur, Query, QueryParser, RegexQuery};
use tantivy::schema::{
    Field, IndexRecordOption, Schema, SchemaBuilder, Value, FAST, INDEXED, STORED, STRING, TEXT,
};
use tantivy::snippet::SnippetGenerator;
use tantivy::{
    doc, DocSet, Index, IndexReader, IndexWriter, ReloadPolicy, TantivyDocument, Term, TERMINATED,
};
use thiserror::Error;

use super::chunking::{self, Chunk};
use super::config::Chunking;

/// Memory budget per writer batch. tantivy's recommendation is
/// 50 MB minimum; our corpora are small so this is more than enough.
const WRITER_BUDGET: usize = 50_000_000;
const TANTIVY_MIN_MEMORY_PER_THREAD: usize = 15_000_000;
const TANTIVY_MAX_AUTO_THREADS: usize = 8;

/// One search hit. Field naming matches the API response shape so
/// the server layer can serialize these directly.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Hit {
    pub path: String,
    pub chunk_id: String,
    pub heading: String,
    pub start_line: u64,
    pub snippet: String,
    pub score: f32,
}

#[derive(Debug, Error)]
pub enum Bm25Error {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    OpenDir(#[from] tantivy::directory::error::OpenDirectoryError),
    #[error(transparent)]
    Tantivy(#[from] tantivy::TantivyError),
    #[error("query parse: {0}")]
    QueryParse(#[from] tantivy::query::QueryParserError),
}

/// Field handles, kept together so we don't pluck them out of the
/// schema on every operation.
struct Fields {
    path: Field,
    chunk_id: Field,
    heading: Field,
    body: Field,
    start_line: Field,
    depth: Field,
}

/// BM25 index. Holds an open writer (single-thread per tantivy
/// contract; Mutex-wrapped so the rest of the codebase can share a
/// `&Bm25Index`) and a shareable reader.
pub struct Bm25Index {
    index: Index,
    writer: Mutex<IndexWriter>,
    reader: IndexReader,
    fields: Fields,
}

impl std::fmt::Debug for Bm25Index {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Bm25Index").finish()
    }
}

impl Bm25Index {
    /// Open the BM25 index under `index_dir`, creating it on first
    /// use. We manage its `bm25/` subdir.
    pub fn open(index_dir: &Path) -> Result<Self, Bm25Error> {
        let dir = bm25_dir(index_dir);
        std::fs::create_dir_all(&dir)?;
        let schema = build_schema();
        let fields = pluck_fields(&schema);
        // tantivy's open_or_create errors if the dir was used with a
        // different schema. We don't migrate yet (schema_version
        // bump => full rebuild); the caller (index::Index) is
        // responsible for clearing the dir before bumps.
        let index = Index::open_or_create(tantivy::directory::MmapDirectory::open(&dir)?, schema)?;
        let writer_budget = crate::fd_budget::tantivy_writer_budget(default_writer_threads());
        let writer_options = IndexWriterOptions::builder()
            .num_worker_threads(writer_budget.worker_threads)
            .num_merge_threads(writer_budget.merge_threads)
            .memory_budget_per_thread(WRITER_BUDGET / writer_budget.worker_threads)
            .build();
        let writer = index.writer_with_options(writer_options)?;
        // Manual reload, not OnCommit*: `commit` below reloads the
        // reader synchronously itself, so tantivy's commit watcher is
        // redundant -- and on a long-lived multi-workspace process (the
        // devserver) every OnCommit reader spins up a `MmapDirectory`
        // file_watcher holding an inotify fd, which accumulates across
        // mount/unmount churn until the process hits EMFILE. Manual keeps
        // search-after-commit correct with no background watcher.
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()?;
        Ok(Self {
            index,
            writer: Mutex::new(writer),
            reader,
            fields,
        })
    }

    /// Erase every document for `rel_path`. Idempotent.
    pub fn delete_file(&self, rel_path: &str) -> Result<(), Bm25Error> {
        let writer = self.writer.lock().unwrap();
        writer.delete_term(Term::from_field_text(self.fields.path, rel_path));
        Ok(())
    }

    /// Re-index a single file. Deletes its previous chunks and writes
    /// new ones according to `chunking`. Caller commits.
    pub fn index_file(
        &self,
        rel_path: &str,
        content: &str,
        chunking: &Chunking,
    ) -> Result<usize, Bm25Error> {
        let chunks = chunking::chunk(content, chunking);
        self.index_chunks(rel_path, &chunks)
    }

    /// Same as `index_file` but takes pre-computed chunks. Used by
    /// `Index::build_all`'s parallel walker so chunking can happen
    /// off the writer thread, avoiding the per-file double parse
    /// the previous `index_file`-only path was paying. Empty chunk
    /// slice still drops any prior documents for `rel_path` so a
    /// file that became empty is removed from the index.
    pub fn index_chunks(&self, rel_path: &str, chunks: &[Chunk]) -> Result<usize, Bm25Error> {
        self.delete_file(rel_path)?;
        if chunks.is_empty() {
            return Ok(0);
        }
        let writer = self.writer.lock().unwrap();
        for c in chunks {
            self.add_chunk(&writer, rel_path, c)?;
        }
        Ok(chunks.len())
    }

    fn add_chunk(&self, writer: &IndexWriter, rel_path: &str, c: &Chunk) -> Result<(), Bm25Error> {
        writer.add_document(doc!(
            self.fields.path => rel_path,
            self.fields.chunk_id => c.id.as_str(),
            self.fields.heading => c.heading.as_str(),
            self.fields.body => c.body.as_str(),
            self.fields.start_line => c.start_line as u64,
            self.fields.depth => u64::from(c.depth),
        ))?;
        Ok(())
    }

    /// Flush pending writes. Call after a batch of `index_file` /
    /// `delete_file`. Synchronously reloads the reader so subsequent
    /// `search` calls see the new data; tantivy's default reload
    /// policy is async, which is wrong for our caller's expectations.
    pub fn commit(&self) -> Result<(), Bm25Error> {
        let mut writer = self.writer.lock().unwrap();
        writer.commit()?;
        self.reader.reload()?;
        Ok(())
    }

    /// Search `body` + `heading` with BM25 ranking. Returns up to
    /// `limit` hits.
    ///
    /// Plain alphanumeric typeahead queries get prefix-matched so
    /// typed `beet` finds stored `beetroot`. Tantivy 0.24's
    /// `QueryParser` does NOT expand `term*` itself, so for a query
    /// where every whitespace-separated token is bare alphanumerics
    /// we build a `BooleanQuery` of `RegexQuery::from_pattern("tok.*")`
    /// over `body` and `heading` directly, ANDed across tokens.
    /// Queries that contain any tantivy operator (`+ - " * ? ~ :`)
    /// fall through to `QueryParser::parse_query` so power-user
    /// searches (phrases, fielded queries, fuzzy) keep their
    /// semantics. Empty queries return no hits.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<Hit>, Bm25Error> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let searcher = self.reader.searcher();
        let parser =
            QueryParser::for_index(&self.index, vec![self.fields.body, self.fields.heading]);
        let prefix_query = self.try_build_prefix_query(q)?;
        // Search query uses the prefix path when applicable so
        // typed `beet` matches stored `beetroot`. Snippet uses the
        // QueryParser parse for whole-token highlights.
        let search_query: Box<dyn Query> = match &prefix_query {
            Some(pq) => pq.box_clone(),
            None => parser.parse_query(q)?,
        };
        let snippet_query: Box<dyn Query> =
            parser
                .parse_query(q)
                .unwrap_or_else(|_| match &prefix_query {
                    Some(pq) => pq.box_clone(),
                    None => unreachable!("query trimmed empty handled above"),
                });
        let top = searcher.search(&*search_query, &TopDocs::with_limit(limit))?;
        let snippet_gen = SnippetGenerator::create(&searcher, &*snippet_query, self.fields.body)?;
        // Lowercase prefixes pulled out of the user's query for the
        // manual fallback highlighter below. Empty when we routed
        // through the QueryParser path (operators / phrases). Use the
        // same subtokens we matched on so a mention/path query bolds
        // the indexed words (handle, file, md) rather than the raw
        // unmatchable token (@@handle, file.md).
        let prefix_terms: Vec<String> = if prefix_query.is_some() {
            query_subtokens(q)
        } else {
            Vec::new()
        };
        let mut hits = Vec::with_capacity(top.len());
        for (score, doc_addr) in top {
            let doc: TantivyDocument = searcher.doc(doc_addr)?;
            let body_text = get_text(&doc, self.fields.body);
            let term_snippet = snippet_gen.snippet_from_doc(&doc);
            let snippet = if !term_snippet.is_empty() {
                term_snippet.to_html()
            } else if !prefix_terms.is_empty() {
                // SnippetGenerator returns empty when the
                // QueryParser-parsed terms aren't found as exact
                // tokens (the common case for typed-prefix
                // queries: typing `lem` while the index has
                // `lemon`). Fall back to a manual
                // case-insensitive prefix highlighter that
                // surrounds matched substrings with the same
                // `<b>...</b>` markup. Picks an excerpt centered
                // on the first match so the user sees relevant
                // context.
                manual_prefix_snippet(&body_text, &prefix_terms)
            } else {
                String::new()
            };
            hits.push(Hit {
                path: get_text(&doc, self.fields.path),
                chunk_id: get_text(&doc, self.fields.chunk_id),
                heading: get_text(&doc, self.fields.heading),
                start_line: get_u64(&doc, self.fields.start_line),
                snippet,
                score,
            });
        }
        Ok(hits)
    }

    /// Total indexed-document count. Used by the status endpoint.
    pub fn doc_count(&self) -> u64 {
        self.reader.searcher().num_docs()
    }

    /// Snapshot of every distinct live `path` value currently committed
    /// to the index, sorted ascending. Walks each segment's path term
    /// dictionary and verifies terms against live postings on segments
    /// that contain deletions. This avoids scanning stored documents.
    ///
    /// Used by `Index::build_all` to compute the set of paths that
    /// were indexed by a prior build but are no longer on disk, so
    /// the stale docs can be deleted in the same commit as the new
    /// build. Without this cleanup, renaming or deleting a file
    /// between two reindex runs leaks the old `path` field into
    /// BM25 forever, and the user sees ghost hits pointing at
    /// files that no longer exist.
    pub fn known_paths(&self) -> Result<Vec<String>, Bm25Error> {
        use std::collections::BTreeSet;
        let searcher = self.reader.searcher();
        let mut paths: BTreeSet<String> = BTreeSet::new();
        for segment in searcher.segment_readers() {
            let inv = segment.inverted_index(self.fields.path)?;
            let mut stream = inv.terms().stream()?;
            while let Some((term_bytes, term_info)) = stream.next() {
                let has_live_posting = match segment.alive_bitset() {
                    None => true,
                    Some(alive) => {
                        let mut postings =
                            inv.read_postings_from_terminfo(term_info, IndexRecordOption::Basic)?;
                        let mut doc = postings.doc();
                        while doc != TERMINATED && !alive.is_alive(doc) {
                            doc = postings.advance();
                        }
                        doc != TERMINATED
                    }
                };
                if !has_live_posting {
                    continue;
                }
                if let Ok(path) = std::str::from_utf8(term_bytes) {
                    paths.insert(path.to_string());
                }
            }
        }
        Ok(paths.into_iter().collect())
    }

    /// If `q` is one or more bare whitespace-separated tokens (no
    /// tantivy operators), construct a prefix-match query that
    /// finds documents where every token appears as a prefix of
    /// some indexed term in either `body` or `heading`. Returns
    /// `None` for queries that should pass through to the default
    /// QueryParser (quoted phrases, fielded queries, etc).
    ///
    /// Implementation: per-token `BooleanQuery::Should` over
    /// `RegexQuery::from_pattern("<tok>.*", body|heading)`, then
    /// `BooleanQuery::Must` across tokens for AND semantics. The
    /// BM25 scorer underneath ranks the matched docs as usual.
    fn try_build_prefix_query(&self, q: &str) -> Result<Option<Box<dyn Query>>, Bm25Error> {
        let tokens: Vec<&str> = q.split_whitespace().collect();
        if tokens.is_empty() {
            return Ok(None);
        }
        if tokens.iter().any(|t| has_operator(t)) {
            return Ok(None);
        }
        // Split each whitespace token into the alphanumeric subtokens
        // the default tokenizer produced from the indexed text, so a
        // mention (@@handle), a path (a/b/c), or a filename (file.md)
        // matches the stripped index terms (handle / a,b,c / file,md)
        // instead of building a literal-punctuation regex that can
        // never match a stored term. A bare word yields exactly one
        // subtoken, leaving ordinary queries unchanged.
        let subtokens = query_subtokens(q);
        if subtokens.is_empty() {
            // An all-punctuation query (e.g. "@@") has nothing to
            // prefix-match; let the QueryParser path handle it.
            return Ok(None);
        }
        let mut top: Vec<(Occur, Box<dyn Query>)> = Vec::with_capacity(subtokens.len());
        for sub in &subtokens {
            // Escape regex metachars defensively; subtokens are
            // alphanumeric by construction, so this is a no-op today.
            let pattern = format!("{}.*", regex_escape(sub));
            let mut field_clauses: Vec<(Occur, Box<dyn Query>)> = Vec::with_capacity(2);
            for &field in &[self.fields.body, self.fields.heading] {
                let rq = RegexQuery::from_pattern(&pattern, field)?;
                field_clauses.push((Occur::Should, Box::new(rq)));
            }
            top.push((Occur::Must, Box::new(BooleanQuery::new(field_clauses))));
        }
        Ok(Some(Box::new(BooleanQuery::new(top))))
    }
}

fn default_writer_threads() -> usize {
    let mut threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2)
        .min(TANTIVY_MAX_AUTO_THREADS);
    if WRITER_BUDGET / threads < TANTIVY_MIN_MEMORY_PER_THREAD {
        threads = (WRITER_BUDGET / TANTIVY_MIN_MEMORY_PER_THREAD).max(1);
    }
    threads
}

/// Whether `tok` should bypass the prefix-match path and route
/// through tantivy's default QueryParser. Tokens with any operator
/// (`+ - " * ? ~ : ( )`) keep their power-user semantics; tokens
/// with a hyphen anywhere are also routed through the parser
/// because tantivy's default tokenizer splits on `-` and our
/// RegexQuery would not match "unique-token" against the indexed
/// terms `unique` and `token` separately.
fn has_operator(tok: &str) -> bool {
    tok.bytes().any(|b| {
        matches!(
            b,
            b':' | b'*' | b'?' | b'~' | b'+' | b'"' | b'(' | b')' | b'-'
        )
    })
}

/// Build a snippet for a body whose match is a prefix of an
/// indexed token (the path tantivy's term-based SnippetGenerator
/// does not cover). Walks `body` once with case-insensitive
/// substring search per prefix, wraps every match in
/// `<b>...</b>`, and excerpts ~200 chars centered on the first
/// hit so the user sees relevant context. Returns an empty
/// string when no prefix is found.
fn manual_prefix_snippet(body: &str, prefixes: &[String]) -> String {
    if prefixes.is_empty() || body.is_empty() {
        return String::new();
    }
    let lc = body.to_lowercase();
    // First-match position (byte offset in `lc`/`body`; ASCII
    // prefixes only; non-ASCII case folding is approximate but
    // good enough for English typeahead).
    let first_idx = prefixes.iter().filter_map(|p| lc.find(p.as_str())).min();
    let first_idx = match first_idx {
        Some(i) => i,
        None => return String::new(),
    };
    // Excerpt window: ~200 chars wide, anchored on the first
    // match. Skip past the previous word boundary so the snippet
    // starts cleanly.
    const WINDOW: usize = 200;
    let half = WINDOW / 2;
    let start = first_idx.saturating_sub(half);
    let start = nudge_to_char_boundary(body, start, false);
    let end = (first_idx + half).min(body.len());
    let end = nudge_to_char_boundary(body, end, true);
    let mut excerpt = String::with_capacity(WINDOW + 32);
    if start > 0 {
        excerpt.push('…');
    }
    let segment = &body[start..end];
    let lc_segment = &lc[start..end];
    // Multi-prefix highlight: scan once, at each position pick
    // the longest matching prefix and wrap it.
    let mut cursor = 0usize;
    while cursor < segment.len() {
        // Find the next prefix match starting at or after cursor.
        let next = prefixes
            .iter()
            .filter_map(|p| {
                let needle = p.as_str();
                lc_segment[cursor..]
                    .find(needle)
                    .map(|rel| (cursor + rel, needle.len()))
            })
            .min_by_key(|&(idx, _)| idx);
        match next {
            Some((idx, len)) => {
                excerpt.push_str(&segment[cursor..idx]);
                excerpt.push_str("<b>");
                excerpt.push_str(&segment[idx..idx + len]);
                excerpt.push_str("</b>");
                cursor = idx + len;
            }
            None => {
                excerpt.push_str(&segment[cursor..]);
                break;
            }
        }
    }
    if end < body.len() {
        excerpt.push('…');
    }
    excerpt
}

/// Move `idx` to the nearest UTF-8 char boundary so a slice with
/// `body[start..end]` doesn't panic on multibyte text. `forward`
/// chooses which side to drift toward; we use it to expand the
/// window slightly rather than truncating the match.
fn nudge_to_char_boundary(s: &str, idx: usize, forward: bool) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    let mut i = idx;
    while i > 0 && i < s.len() && !s.is_char_boundary(i) {
        if forward {
            i += 1;
        } else {
            i -= 1;
        }
    }
    i
}

/// Escape regex metacharacters so a literal token can be embedded
/// in a regex pattern. Tantivy's RegexQuery uses Rust's `regex`
/// syntax; only a handful of metas need escaping for our use.
fn regex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '.' | '+' | '*' | '?' | '(' | ')' | '|' | '[' | ']' | '{' | '}' | '^' | '$' | '\\' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

/// Split a query into the lowercased alphanumeric subtokens that
/// tantivy's default tokenizer would have produced from the indexed
/// text. Splitting on every non-alphanumeric boundary mirrors how the
/// body/heading fields were tokenized, so a mention (`@@handle`), a
/// path (`a/b/c`), or a filename (`file.md`) lines up with the stored
/// terms instead of carrying punctuation a prefix regex could never
/// match. A bare word yields a single subtoken (ordinary queries are
/// untouched); an all-punctuation query yields none.
fn query_subtokens(q: &str) -> Vec<String> {
    q.split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase)
        .collect()
}

fn bm25_dir(index_dir: &Path) -> PathBuf {
    index_dir.join("bm25")
}

fn build_schema() -> Schema {
    let mut sb = SchemaBuilder::default();
    // STRING (single-token, exact-match) is what we need for delete-
    // by-path. INDEXED gives us the term lookup; STORED so we can
    // return it in hits; FAST in case we want to facet by file later.
    sb.add_text_field("path", STRING | STORED | FAST);
    sb.add_text_field("chunk_id", STRING | STORED);
    sb.add_text_field("heading", TEXT | STORED);
    sb.add_text_field("body", TEXT | STORED);
    sb.add_u64_field("start_line", INDEXED | STORED);
    sb.add_u64_field("depth", INDEXED | STORED);
    sb.build()
}

fn pluck_fields(schema: &Schema) -> Fields {
    Fields {
        path: schema.get_field("path").unwrap(),
        chunk_id: schema.get_field("chunk_id").unwrap(),
        heading: schema.get_field("heading").unwrap(),
        body: schema.get_field("body").unwrap(),
        start_line: schema.get_field("start_line").unwrap(),
        depth: schema.get_field("depth").unwrap(),
    }
}

fn get_text(doc: &TantivyDocument, field: Field) -> String {
    doc.get_first(field)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_owned()
}

fn get_u64(doc: &TantivyDocument, field: Field) -> u64 {
    doc.get_first(field).and_then(|v| v.as_u64()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fresh() -> (TempDir, Bm25Index) {
        let tmp = TempDir::new().unwrap();
        let idx = Bm25Index::open(tmp.path()).unwrap();
        (tmp, idx)
    }

    #[test]
    fn empty_index_returns_no_hits() {
        let (_tmp, idx) = fresh();
        let hits = idx.search("anything", 10).unwrap();
        assert!(hits.is_empty());
        assert_eq!(idx.doc_count(), 0);
    }

    #[test]
    fn index_then_search() {
        let (_tmp, idx) = fresh();
        let body =
            "# notes\n\nThis page talks about apples and bananas.\n\n## fruit\nMore on apples.\n";
        idx.index_file("notes.md", body, &Chunking::Headings)
            .unwrap();
        idx.commit().unwrap();
        let hits = idx.search("apples", 10).unwrap();
        assert!(!hits.is_empty());
        assert!(hits.iter().all(|h| h.path == "notes.md"));
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn re_index_replaces_old_chunks() {
        let (_tmp, idx) = fresh();
        idx.index_file("a.md", "# old\nfoo bar\n", &Chunking::Headings)
            .unwrap();
        idx.commit().unwrap();
        assert!(!idx.search("foo", 10).unwrap().is_empty());

        idx.index_file("a.md", "# new\nbaz qux\n", &Chunking::Headings)
            .unwrap();
        idx.commit().unwrap();
        assert!(idx.search("foo", 10).unwrap().is_empty());
        assert!(!idx.search("baz", 10).unwrap().is_empty());
    }

    #[test]
    fn delete_file_removes_chunks() {
        let (_tmp, idx) = fresh();
        idx.index_file("a.md", "# h\nunique-term\n", &Chunking::Headings)
            .unwrap();
        idx.commit().unwrap();
        idx.delete_file("a.md").unwrap();
        idx.commit().unwrap();
        assert!(idx.search("unique-term", 10).unwrap().is_empty());
    }

    #[test]
    fn known_paths_excludes_deleted_path_from_live_segment() {
        let (_tmp, idx) = fresh();
        {
            let writer = idx.writer.lock().unwrap();
            writer.set_merge_policy(Box::new(tantivy::merge_policy::NoMergePolicy));
        }
        idx.index_file("old.md", "staletombstone", &Chunking::WholeDoc)
            .unwrap();
        idx.index_file("keep.md", "livekeeper", &Chunking::WholeDoc)
            .unwrap();
        idx.commit().unwrap();
        assert_eq!(idx.search("staletombstone", 10).unwrap()[0].path, "old.md");
        assert_eq!(idx.search("livekeeper", 10).unwrap()[0].path, "keep.md");

        let segment_ids = idx.index.searchable_segment_ids().unwrap();
        idx.writer
            .lock()
            .unwrap()
            .merge(&segment_ids)
            .wait()
            .unwrap();
        idx.reader.reload().unwrap();

        idx.delete_file("old.md").unwrap();
        idx.commit().unwrap();

        let searcher = idx.reader.searcher();
        assert_eq!(searcher.segment_readers().len(), 1);
        let segment = &searcher.segment_readers()[0];
        assert_eq!(segment.num_docs(), 1);
        assert_eq!(segment.num_deleted_docs(), 1);
        assert_eq!(idx.known_paths().unwrap(), vec!["keep.md"]);
        assert!(idx.search("staletombstone", 10).unwrap().is_empty());
        assert_eq!(idx.search("livekeeper", 10).unwrap()[0].path, "keep.md");
    }

    #[test]
    fn snippet_highlights_match() {
        let (_tmp, idx) = fresh();
        idx.index_file(
            "a.md",
            "# top\nThe quick brown fox jumps over the lazy dog.\n",
            &Chunking::Headings,
        )
        .unwrap();
        idx.commit().unwrap();
        let hits = idx.search("fox", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("<b>fox</b>"));
    }

    #[test]
    fn prefix_matches_partial_word() {
        // Typing "beet" should surface a doc containing only
        // "beetroot". This is the common typeahead case for the
        // Cmd+K palette.
        let (_tmp, idx) = fresh();
        idx.index_file(
            "recipes/beetroot.md",
            "# Beetroot\nRoasted beetroot recipe.\n",
            &Chunking::Headings,
        )
        .unwrap();
        idx.commit().unwrap();
        // Full token still works.
        assert_eq!(idx.search("beetroot", 10).unwrap().len(), 1);
        // Bare prefix typed in the palette: matches via the
        // RegexQuery path that try_build_prefix_query constructs.
        let hits = idx.search("beet", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "recipes/beetroot.md");
    }

    #[test]
    fn query_subtokens_splits_on_punctuation() {
        assert_eq!(query_subtokens("@@Alice"), vec!["alice".to_string()]);
        assert_eq!(
            query_subtokens("a/b/c"),
            vec!["a".to_string(), "b".to_string(), "c".to_string()]
        );
        assert_eq!(
            query_subtokens("file.md"),
            vec!["file".to_string(), "md".to_string()]
        );
        // A bare word and a plain multi-word query are untouched.
        assert_eq!(query_subtokens("plain"), vec!["plain".to_string()]);
        assert_eq!(
            query_subtokens("two words"),
            vec!["two".to_string(), "words".to_string()]
        );
        // All-punctuation yields nothing.
        assert!(query_subtokens("@@").is_empty());
    }

    #[test]
    fn mention_query_matches_handle_word() {
        // BM25 strips the leading @@, so a query typed as "@@Alice"
        // must still find the note mentioning @@Alice (indexed as the
        // bare term "alice"). Before the subtoken split this returned
        // nothing because the regex carried the literal @@.
        let (_tmp, idx) = fresh();
        idx.index_file(
            "team/roster.md",
            "# Roster\nThe coordinator is @@Alice and the host is @@Bob.\n",
            &Chunking::Headings,
        )
        .unwrap();
        // Distractor doc: must not contain the searched term.
        idx.index_file(
            "team/process.md",
            "# Process\nThe coordinator runs the planning meeting.\n",
            &Chunking::Headings,
        )
        .unwrap();
        idx.commit().unwrap();
        let hits = idx.search("@@Alice", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "team/roster.md");
    }

    #[test]
    fn path_query_ands_all_segments() {
        // A slash path (no hyphen, so it stays on the prefix path)
        // ANDs its segments: the note naming the file is found, the
        // note missing a segment is not.
        let (_tmp, idx) = fresh();
        idx.index_file(
            "docs/paths.md",
            "# Paths\nThe handler lives in src/routes/search.rs today.\n",
            &Chunking::Headings,
        )
        .unwrap();
        idx.index_file(
            "docs/other.md",
            "# Other\nThis note mentions routes and a search box.\n",
            &Chunking::Headings,
        )
        .unwrap();
        idx.commit().unwrap();
        let hits = idx.search("src/routes/search.rs", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "docs/paths.md");
    }

    #[test]
    fn filename_query_matches_stem_and_extension() {
        let (_tmp, idx) = fresh();
        idx.index_file(
            "docs/files.md",
            "# Files\nEvery team dir carries a bootstrap.md file.\n",
            &Chunking::Headings,
        )
        .unwrap();
        idx.commit().unwrap();
        let hits = idx.search("bootstrap.md", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "docs/files.md");
    }

    #[test]
    fn quoted_phrase_falls_back_to_query_parser() {
        // A quoted phrase contains the `"` operator, so we route
        // it through tantivy's QueryParser as an exact phrase
        // query rather than the prefix path. "beet root" doesn't
        // match "beetroot soup" (no whitespace between beet and
        // root in the indexed body).
        let (_tmp, idx) = fresh();
        idx.index_file("a.md", "# h\nbeetroot soup\n", &Chunking::Headings)
            .unwrap();
        idx.commit().unwrap();
        let phrase_hits = idx.search(r#""beet root""#, 10).unwrap();
        assert!(phrase_hits.is_empty(), "phrase should not match");
    }

    #[test]
    fn empty_query_returns_no_hits() {
        let (_tmp, idx) = fresh();
        idx.index_file("a.md", "# h\nfoo\n", &Chunking::Headings)
            .unwrap();
        idx.commit().unwrap();
        assert!(idx.search("", 10).unwrap().is_empty());
        assert!(idx.search("   ", 10).unwrap().is_empty());
    }

    #[test]
    fn prefix_match_carries_a_snippet() {
        // Regression: typing "lem" used to return hits with empty
        // snippet bodies (tantivy's term-based SnippetGenerator
        // can't highlight a prefix that isn't a real indexed
        // token). The manual prefix highlighter in
        // `manual_prefix_snippet` must produce a `<b>...</b>`
        // wrapped excerpt.
        let (_tmp, idx) = fresh();
        idx.index_file(
            "a.md",
            "# h\n## Ingredients\n- 1 lemon\n- 1 garlic\n",
            &Chunking::Headings,
        )
        .unwrap();
        idx.commit().unwrap();
        let hits = idx.search("lem", 10).unwrap();
        assert!(!hits.is_empty());
        let h = hits
            .iter()
            .find(|h| h.chunk_id != "h-0")
            .unwrap_or(&hits[0]);
        assert!(
            h.snippet.contains("<b>lem"),
            "expected highlighted prefix in {:?}",
            h.snippet
        );
    }

    #[test]
    fn multi_token_prefix_match_anded() {
        // "be ro" should match "beetroot recipe" since both
        // tokens have prefix matches in the doc.
        let (_tmp, idx) = fresh();
        idx.index_file("a.md", "# h\nbeetroot recipe\n", &Chunking::Headings)
            .unwrap();
        idx.index_file("b.md", "# h\nbananas\n", &Chunking::Headings)
            .unwrap();
        idx.commit().unwrap();
        let hits = idx.search("be re", 10).unwrap();
        let paths: Vec<_> = hits.iter().map(|h| h.path.as_str()).collect();
        assert!(paths.contains(&"a.md"));
        assert!(!paths.contains(&"b.md"));
    }
}
