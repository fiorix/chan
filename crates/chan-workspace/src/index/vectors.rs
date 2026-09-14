// Persistent vector store. v1 layout: one bincode-serialized file
// per source file under the per-workspace index dir's `embeddings/`
// subdirectory (resolved by `crate::paths::workspace_paths`). Filename is
// `sha256(rel_path)[..16]` to avoid path-character escaping on
// disk (Windows in particular).
//
// At open time we slurp every per-file bin into one in-memory `Vec`
// for brute-force cosine search. For ≤10k chunks (~15 MB at dim 384)
// this is sub-millisecond. The HNSW upgrade lives behind the same
// `VectorStore::search` signature, so the swap is local later.
//
// Vectors are stored normalized; BGE models already return
// normalized vectors, so cosine == dot product and we skip the
// re-normalize at write time.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use super::chunking::Chunk;

/// Storage-format version inside the per-file bin. v2 added
/// `body_hash` so `Index::build_all` can skip re-embedding files
/// whose chunks already match the shard on disk. v1 shards lack
/// the hash; `load_all` discards them so the next build re-embeds
/// (one-time cost on upgrade).
const FORMAT_VERSION: u32 = 2;

/// One embedded chunk in storage.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddedChunk {
    pub chunk_id: String,
    pub heading: String,
    pub body: String,
    pub start_line: u64,
    pub end_line: u64,
    pub depth: u8,
    pub vector: Vec<f32>,
}

/// File-level wrapper, written to disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct FileEmbeddings {
    version: u32,
    rel_path: String,
    model: String,
    dim: usize,
    /// sha256 of the canonical (chunk_id, body) sequence; the
    /// "embed signature" `Index::build_all` consults to decide
    /// whether the on-disk shard is still current for this file's
    /// chunks. Stable across runs: identical chunks (which is what
    /// the chunker produces for identical source text under the
    /// same `Chunking` strategy) hash to the same value.
    body_hash: [u8; 32],
    chunks: Vec<EmbeddedChunk>,
}

/// In-memory shard metadata. We keep more than just `chunks` so
/// `shard_signature` can answer "is this file already embedded
/// for the current model?" without re-reading disk.
#[derive(Debug, Clone)]
struct ShardMeta {
    model: String,
    body_hash: [u8; 32],
    chunks: Vec<EmbeddedChunk>,
}

/// One semantic-search result. Field set matches `bm25::Hit` so the
/// fusion step can blend the two without translation.
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
pub enum VectorError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("encode: {0}")]
    Encode(String),
    #[error("decode {path}: {source}")]
    Decode {
        path: PathBuf,
        #[source]
        source: bincode::error::DecodeError,
    },
    #[error("dim mismatch (expected {expected}, got {got}) for {path}")]
    DimMismatch {
        path: String,
        expected: usize,
        got: usize,
    },
}

/// In-memory + on-disk vector store, keyed by source path.
pub struct VectorStore {
    embeddings_dir: PathBuf,
    /// rel_path -> shard metadata. Mutated incrementally on every
    /// `replace_file` / `delete_file` so search and the build-all
    /// skip check see the same view as disk without re-reading every
    /// shard. BTreeMap (over HashMap) keeps search-result ordering
    /// deterministic when scores tie.
    entries: std::sync::RwLock<BTreeMap<String, ShardMeta>>,
}

impl std::fmt::Debug for VectorStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VectorStore").finish()
    }
}

impl VectorStore {
    /// Open the vector store under `index_dir`. We manage its
    /// `embeddings/` subdirectory.
    pub fn open(index_dir: &Path) -> Result<Self, VectorError> {
        let embeddings_dir = embeddings_dir(index_dir);
        std::fs::create_dir_all(&embeddings_dir)?;
        let entries = load_all(&embeddings_dir)?;
        Ok(Self {
            embeddings_dir,
            entries: std::sync::RwLock::new(entries),
        })
    }

    /// Replace the stored chunks for `rel_path` with `embedded`.
    /// Persists, then mutates the in-memory snapshot in place. Pass
    /// an empty slice to delete the file from the store entirely.
    ///
    /// `body_hash` is derived from the chunk bodies and stamped on
    /// the shard so the build-all skip check can compare against the
    /// hash of a fresh re-chunk and re-use the existing embeddings
    /// when they match.
    pub fn replace_file(
        &self,
        rel_path: &str,
        model: &str,
        dim: usize,
        embedded: Vec<EmbeddedChunk>,
    ) -> Result<(), VectorError> {
        let path = file_for(&self.embeddings_dir, rel_path);
        if embedded.is_empty() {
            // No chunks => no file. (Files made up entirely of
            // whitespace / fenced code only would land here.)
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
            self.entries.write().unwrap().remove(rel_path);
            return Ok(());
        }
        // Sanity: every vector matches `dim`.
        for c in &embedded {
            if c.vector.len() != dim {
                return Err(VectorError::DimMismatch {
                    path: rel_path.to_owned(),
                    expected: dim,
                    got: c.vector.len(),
                });
            }
        }
        let body_hash = body_hash_of_embedded(&embedded);
        let payload = FileEmbeddings {
            version: FORMAT_VERSION,
            rel_path: rel_path.to_owned(),
            model: model.to_owned(),
            dim,
            body_hash,
            chunks: embedded,
        };
        let bytes = bincode::serde::encode_to_vec(&payload, bincode::config::standard())
            .map_err(|e| VectorError::Encode(e.to_string()))?;
        crate::fs_ops::atomic_write(&path, &bytes)
            .map_err(|e| VectorError::Io(std::io::Error::other(e.to_string())))?;
        // On-disk write succeeded; mirror it in memory.
        self.entries.write().unwrap().insert(
            rel_path.to_owned(),
            ShardMeta {
                model: payload.model,
                body_hash: payload.body_hash,
                chunks: payload.chunks,
            },
        );
        Ok(())
    }

    /// `(model, body_hash)` for the file's on-disk shard, or `None`
    /// when no shard is loaded. `Index::build_all` calls this before
    /// queuing a file for embedding: if the tuple matches what a
    /// fresh re-chunk would stamp, the existing vectors are still
    /// current and the file can skip the embed phase entirely. The
    /// shard's vectors stay on disk; the next BM25 commit still runs.
    pub fn shard_signature(&self, rel_path: &str) -> Option<(String, [u8; 32])> {
        self.entries
            .read()
            .unwrap()
            .get(rel_path)
            .map(|m| (m.model.clone(), m.body_hash))
    }

    pub fn delete_file(&self, rel_path: &str) -> Result<(), VectorError> {
        let path = file_for(&self.embeddings_dir, rel_path);
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        self.entries.write().unwrap().remove(rel_path);
        Ok(())
    }

    /// Reclaim shards whose sources were absent from a complete walk. The
    /// disk pass uses hashed filenames so undecodable shards are included.
    pub(super) fn prune_orphans(&self, visited: &HashSet<&str>) -> Result<(), VectorError> {
        for rel in self.known_paths() {
            if !visited.contains(rel.as_str()) {
                if let Err(error) = self.delete_file(&rel) {
                    tracing::warn!(%rel, ?error, "vector shard cleanup failed");
                }
            }
        }
        let keep: HashSet<PathBuf> = visited
            .iter()
            .map(|rel| file_for(&self.embeddings_dir, rel))
            .collect();
        for entry in std::fs::read_dir(&self.embeddings_dir)? {
            let path = entry?.path();
            if path.extension().and_then(|s| s.to_str()) == Some("bin") && !keep.contains(&path) {
                if let Err(error) = std::fs::remove_file(&path) {
                    if error.kind() != std::io::ErrorKind::NotFound {
                        tracing::warn!(?path, ?error, "vector shard cleanup failed");
                    }
                }
            }
        }
        Ok(())
    }

    /// Snapshot of every rel_path currently held in memory. Used by
    /// reconciliation passes (e.g. build_all) that need to compute
    /// the set of orphan shards without round-tripping disk.
    pub fn known_paths(&self) -> Vec<String> {
        self.entries.read().unwrap().keys().cloned().collect()
    }

    /// Brute-force cosine top-k. `query_vec` is assumed normalized
    /// (which BGE outputs are). For non-normalized future models
    /// we'd need to L2-normalize on either side.
    pub fn search(&self, query_vec: &[f32], limit: usize) -> Vec<Hit> {
        if query_vec.is_empty() || limit == 0 {
            return Vec::new();
        }
        let entries = self.entries.read().unwrap();
        let mut scored: Vec<(f32, &str, &EmbeddedChunk)> = entries
            .iter()
            .flat_map(|(rel, meta)| {
                meta.chunks
                    .iter()
                    .filter(|c| c.vector.len() == query_vec.len())
                    .map(move |c| (dot(query_vec, &c.vector), rel.as_str(), c))
            })
            .collect();
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(limit);
        scored
            .into_iter()
            .map(|(score, rel, c)| Hit {
                path: rel.to_owned(),
                chunk_id: c.chunk_id.clone(),
                heading: c.heading.clone(),
                start_line: c.start_line,
                snippet: snippet_of(&c.body),
                score,
            })
            .collect()
    }

    /// Total stored chunks. For the API status endpoint.
    pub fn chunk_count(&self) -> usize {
        self.entries
            .read()
            .unwrap()
            .values()
            .map(|m| m.chunks.len())
            .sum()
    }
}

/// Body-hash for a `Chunk` sequence as it would be embedded. The
/// shard's `body_hash` is the same function applied to the
/// `EmbeddedChunk`s (which share the `(chunk_id, body)` projection).
/// `Index::build_all` re-chunks the source and calls this to decide
/// whether the existing shard is still current.
///
/// Hash domain is `chunk_id || 0x00 || body || 0x00` per chunk,
/// concatenated in order. The trailing 0x00 separator stops a
/// "longer body with empty next chunk" forging the same digest as
/// "shorter body + non-empty next chunk".
pub fn body_hash_of_chunks(chunks: &[Chunk]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for c in chunks {
        hasher.update(c.id.as_bytes());
        hasher.update([0u8]);
        hasher.update(c.body.as_bytes());
        hasher.update([0u8]);
    }
    hasher.finalize().into()
}

fn body_hash_of_embedded(chunks: &[EmbeddedChunk]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for c in chunks {
        hasher.update(c.chunk_id.as_bytes());
        hasher.update([0u8]);
        hasher.update(c.body.as_bytes());
        hasher.update([0u8]);
    }
    hasher.finalize().into()
}

/// Build an `EmbeddedChunk` list from a `Chunk` list + a parallel
/// vector slice. The slices must align 1:1; caller is responsible.
pub fn pair(chunks: &[Chunk], vectors: Vec<Vec<f32>>) -> Vec<EmbeddedChunk> {
    assert_eq!(chunks.len(), vectors.len(), "chunks and vectors must align");
    chunks
        .iter()
        .zip(vectors)
        .map(|(c, v)| EmbeddedChunk {
            chunk_id: c.id.clone(),
            heading: c.heading.clone(),
            body: c.body.clone(),
            start_line: c.start_line as u64,
            end_line: c.end_line as u64,
            depth: c.depth,
            vector: v,
        })
        .collect()
}

fn embeddings_dir(index_dir: &Path) -> PathBuf {
    index_dir.join("embeddings")
}

fn file_for(dir: &Path, rel_path: &str) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(rel_path.as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest.iter().take(16).map(|b| format!("{b:02x}")).collect();
    dir.join(format!("{hex}.bin"))
}

fn load_all(dir: &Path) -> Result<BTreeMap<String, ShardMeta>, VectorError> {
    let mut out: BTreeMap<String, ShardMeta> = BTreeMap::new();
    let read_dir = match std::fs::read_dir(dir) {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e.into()),
    };
    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("bin") {
            continue;
        }
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(?path, ?e, "skipping corrupt vector file");
                continue;
            }
        };
        let (decoded, _): (FileEmbeddings, _) =
            match bincode::serde::decode_from_slice(&bytes, bincode::config::standard()) {
                Ok(v) => v,
                Err(source) => {
                    tracing::warn!(?path, ?source, "skipping undecodable vector file");
                    continue;
                }
            };
        if decoded.version != FORMAT_VERSION {
            // v1 shards predate `body_hash` so there's no way to
            // verify them against current chunks; skip and let
            // build_all re-embed. On-disk file remains until the
            // next replace_file for that rel_path overwrites it.
            tracing::warn!(
                ?path,
                got = decoded.version,
                want = FORMAT_VERSION,
                "skipping vector file with stale format"
            );
            continue;
        }
        // Two shards mapping to the same rel_path would be a hash
        // collision in `file_for` (sha256[..16]). Keep the last
        // wins; on-disk, replace_file overwrites by hash so this
        // is purely defensive.
        out.insert(
            decoded.rel_path,
            ShardMeta {
                model: decoded.model,
                body_hash: decoded.body_hash,
                chunks: decoded.chunks,
            },
        );
    }
    Ok(out)
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

fn snippet_of(body: &str) -> String {
    // Cheap snippet for v1: first ~200 chars on a single line. The
    // tantivy SnippetGenerator only works against tokenized fields
    // and there's no equivalent for vector hits since we don't have
    // a query *string* to highlight against, only a query *vector*.
    let flat: String = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let max = 200;
    if flat.chars().count() <= max {
        flat
    } else {
        let mut iter = flat.chars();
        let head: String = (&mut iter).take(max).collect();
        format!("{head}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fresh() -> (TempDir, VectorStore) {
        let tmp = TempDir::new().unwrap();
        let s = VectorStore::open(tmp.path()).unwrap();
        (tmp, s)
    }

    fn make_chunk(id: &str, vec: Vec<f32>) -> EmbeddedChunk {
        EmbeddedChunk {
            chunk_id: id.to_owned(),
            heading: format!("h-{id}"),
            body: format!("body for {id}"),
            start_line: 0,
            end_line: 1,
            depth: 1,
            vector: vec,
        }
    }

    #[test]
    fn corrupt_shard_preserves_healthy_vectors_and_can_be_replaced() {
        let (tmp, store) = fresh();
        for rel in ["bad.md", "healthy.md"] {
            store
                .replace_file(rel, "model", 2, vec![make_chunk(rel, vec![1.0, 0.0])])
                .unwrap();
        }
        let bad = file_for(&embeddings_dir(tmp.path()), "bad.md");
        std::fs::write(&bad, b"garbage").unwrap();
        drop(store);
        let store = VectorStore::open(tmp.path()).unwrap();
        assert_eq!(store.known_paths(), ["healthy.md"]);
        assert_eq!(store.search(&[1.0, 0.0], 10)[0].path, "healthy.md");
        store
            .replace_file(
                "bad.md",
                "model",
                2,
                vec![make_chunk("fixed", vec![1.0, 0.0])],
            )
            .unwrap();
        drop(store);
        assert_eq!(
            VectorStore::open(tmp.path()).unwrap().known_paths(),
            ["bad.md", "healthy.md"]
        );
    }

    #[test]
    fn empty_store_returns_no_hits() {
        let (_tmp, s) = fresh();
        assert!(s.search(&[1.0, 0.0, 0.0], 5).is_empty());
        assert_eq!(s.chunk_count(), 0);
    }

    #[test]
    fn replace_then_search_orders_by_cosine() {
        let (_tmp, s) = fresh();
        s.replace_file(
            "a.md",
            "model",
            3,
            vec![
                make_chunk("a1", vec![1.0, 0.0, 0.0]),
                make_chunk("a2", vec![0.0, 1.0, 0.0]),
            ],
        )
        .unwrap();
        s.replace_file(
            "b.md",
            "model",
            3,
            vec![make_chunk("b1", vec![0.7, 0.7, 0.0])],
        )
        .unwrap();
        let hits = s.search(&[1.0, 0.0, 0.0], 5);
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].path, "a.md");
        assert_eq!(hits[0].chunk_id, "a1");
        assert!(hits[0].score > hits[1].score);
    }

    #[test]
    fn replace_with_empty_deletes() {
        let (_tmp, s) = fresh();
        s.replace_file("a.md", "m", 2, vec![make_chunk("a1", vec![1.0, 0.0])])
            .unwrap();
        assert_eq!(s.chunk_count(), 1);
        s.replace_file("a.md", "m", 2, vec![]).unwrap();
        assert_eq!(s.chunk_count(), 0);
    }

    #[test]
    fn delete_file_removes_entries() {
        let (_tmp, s) = fresh();
        s.replace_file("a.md", "m", 2, vec![make_chunk("a1", vec![1.0, 0.0])])
            .unwrap();
        s.delete_file("a.md").unwrap();
        assert_eq!(s.chunk_count(), 0);
    }

    #[test]
    fn dim_mismatch_is_error() {
        let (_tmp, s) = fresh();
        let err = s
            .replace_file("a.md", "m", 4, vec![make_chunk("a1", vec![1.0, 0.0])])
            .unwrap_err();
        assert!(matches!(err, VectorError::DimMismatch { .. }));
    }

    #[test]
    fn reload_persists() {
        let tmp = TempDir::new().unwrap();
        {
            let s = VectorStore::open(tmp.path()).unwrap();
            s.replace_file("a.md", "m", 2, vec![make_chunk("a1", vec![1.0, 0.0])])
                .unwrap();
        }
        let s = VectorStore::open(tmp.path()).unwrap();
        assert_eq!(s.chunk_count(), 1);
    }
}
