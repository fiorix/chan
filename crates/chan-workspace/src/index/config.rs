// Persisted config for the search index. Lives at
// `<index_dir>/config.toml` (per-workspace global cache; see
// `crate::paths::workspace_paths`) and stores the embedding model id,
// the chunking strategy, and a schema version that triggers a full
// rebuild when bumped.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::error::ChanError;

/// Default embedding model. Small (~130 MB), English-only, fast.
pub const DEFAULT_MODEL: &str = "BAAI/bge-small-en-v1.5";

/// Curated embedding model exposed to the CLI and Settings UI.
/// The embedder accepts exactly this list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct EmbeddingModelInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub dim: u32,
    pub size_label: &'static str,
    pub note: &'static str,
    #[serde(rename = "default")]
    pub is_default: bool,
}

const EMBEDDING_MODELS: &[EmbeddingModelInfo] = &[
    EmbeddingModelInfo {
        id: DEFAULT_MODEL,
        label: "BGE Small EN v1.5",
        dim: 384,
        size_label: "~130 MB",
        note: "Small English model; fastest curated option.",
        is_default: true,
    },
    EmbeddingModelInfo {
        id: "BAAI/bge-base-en-v1.5",
        label: "BGE Base EN v1.5",
        dim: 768,
        size_label: "~440 MB",
        note: "Medium English model with higher recall than small.",
        is_default: false,
    },
    EmbeddingModelInfo {
        id: "BAAI/bge-large-en-v1.5",
        label: "BGE Large EN v1.5",
        dim: 1024,
        size_label: "~1.3 GB",
        note: "Large English model; highest-capacity English option.",
        is_default: false,
    },
    EmbeddingModelInfo {
        id: "BAAI/bge-m3",
        label: "BGE M3",
        dim: 1024,
        size_label: "~2.3 GB",
        note: "Multilingual BGE model for mixed-language workspaces.",
        is_default: false,
    },
];

pub fn embedding_models() -> &'static [EmbeddingModelInfo] {
    EMBEDDING_MODELS
}

pub fn embedding_model(id: &str) -> Option<&'static EmbeddingModelInfo> {
    EMBEDDING_MODELS.iter().find(|model| model.id == id)
}

/// Current on-disk schema version. Bumping this forces a rebuild on
/// next index open; the indexer compares against the value loaded
/// from disk and clears `bm25/` + `embeddings/` on mismatch.
///
/// v1: per-heading chunking with hybrid (BM25 + dense) retrieval,
///     replacing the old per-file BM25 schema.
/// v2: candle-backed embedder replaces fastembed/ort. Vector tensors
///     are byte-compatible (same f32 layout, same BGE checkpoints)
///     but small numerical drift between ONNX and the pure-Rust
///     transformer kernel can shift cosine scores by epsilon, so
///     wipe and re-embed on first open after upgrade.
/// v3: indexer widened from `.md`-only to every `FileClass::EditableText`
///     extension (today: `.md` + `.txt`). Existing indices were
///     `.md`-only and would miss `.txt` content; a wipe-and-rebuild
///     populates them.
pub const SCHEMA_VERSION: u32 = 3;

/// How a markdown file is split into indexable units.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Chunking {
    /// One chunk per ATX heading section. Files without headings
    /// fall back to a single whole-doc chunk.
    #[default]
    Headings,
    /// One chunk per file, no splitting.
    WholeDoc,
    /// Fixed-window chunks of N characters with no overlap.
    Fixed { chars: usize },
}

/// On-disk shape of `<index_dir>/config.toml`.
///
/// `model` is the user-configured target: the model the indexer
/// should use for new embeddings. `vectors_model` and `vectors_dim`
/// describe what produced the vectors *currently on disk*. The two
/// can diverge when the user changes the target model (via
/// `Index::set_model` or by hand-editing this file) but the vector
/// store hasn't been rebuilt yet. `Index::open` detects that
/// divergence and wipes `embeddings/` so the next reindex repopulates
/// the store against the new model.
///
/// Keeping the "what's on disk" stamp separate from "what's
/// configured" closes a silent-corruption window: just trusting
/// `model` would let a config edit produce a vector store mixing
/// outputs from two different models, or feeding query vectors of
/// one dim against doc vectors of another.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexConfig {
    pub schema_version: u32,
    pub model: String,
    #[serde(default)]
    pub chunking: Chunking,
    /// Model id that produced the vectors currently on disk. `None`
    /// means the vector store is empty (post-wipe, fresh install,
    /// or never-embedded). On `Index::open`, a mismatch against
    /// `model` triggers an embedding-only wipe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vectors_model: Option<String>,
    /// Dim of the vectors currently on disk. Stamped alongside
    /// `vectors_model` at the end of every embed pass. Used by
    /// `build_all` as a defensive cross-check against the live
    /// embedder's `dim()` before writing more shards.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vectors_dim: Option<u32>,
    /// Per-workspace directory BLOCKLIST additions.
    /// Directory basenames excluded from THIS workspace's index + graph walk,
    /// ON TOP of the global machine-wide baseline (`Registry::
    /// index_excluded_dirs`). The effective walk filter is
    /// union(global defaults, these). Empty by default (`#[serde(default)]`),
    /// so a new or legacy workspace adds nothing of its own. Matched as exact
    /// basenames at any depth, case-insensitive (same semantics as the global
    /// list). Managed via `GET`/`PUT /api/index/excluded-dirs`.
    #[serde(default)]
    pub excluded_dirs: Vec<String>,
}

impl Default for IndexConfig {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            model: DEFAULT_MODEL.to_owned(),
            chunking: Chunking::default(),
            vectors_model: None,
            vectors_dim: None,
            // Per-workspace blocklist additions: none by default; the global
            // baseline alone applies until the user adds workspace-specific
            // dirs via the CRUD route.
            excluded_dirs: Vec::new(),
        }
    }
}

// `toml::de::Error` and `toml::ser::Error` are intentionally
// boxed here. Both carry inline message buffers + span info that
// push their stack size on the Windows target past clippy's
// `result-large-err` 128-byte threshold; boxing brings the
// `ConfigError` variant down to a single pointer so every
// `Result<_, ConfigError>` return site stays under the lint.
// Linux + macOS don't trip the lint (different stack alignment
// and intrinsic type sizes there), but the boxing also reduces
// the size of the Ok variant's stack slot on every platform.
#[derive(Debug, Error)]
pub enum ConfigError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("decode {path}: {source}")]
    Decode {
        path: PathBuf,
        #[source]
        source: Box<toml::de::Error>,
    },
    #[error(transparent)]
    Encode(Box<toml::ser::Error>),
    #[error(transparent)]
    Chan(#[from] ChanError),
}

// Manual `From` for the encoder side: `#[from]` on a `Box<_>`
// field would generate `From<Box<toml::ser::Error>>`, which
// breaks `?` at the `toml::to_string_pretty(...)` call site.
// Wrap the bare error in a `Box` at the boundary so `?`
// continues to compile unchanged.
impl From<toml::ser::Error> for ConfigError {
    fn from(e: toml::ser::Error) -> Self {
        Self::Encode(Box::new(e))
    }
}

/// Path to the index config inside `index_dir`.
pub fn config_path(index_dir: &Path) -> PathBuf {
    index_dir.join("config.toml")
}

/// Load the config, falling back to defaults if the file is absent.
/// A malformed file is an error; we don't silently overwrite a
/// user's edit.
pub fn load(index_dir: &Path) -> Result<IndexConfig, ConfigError> {
    let path = config_path(index_dir);
    if !path.exists() {
        return Ok(IndexConfig::default());
    }
    let raw = std::fs::read_to_string(&path)?;
    toml::from_str(&raw).map_err(|source| ConfigError::Decode {
        path,
        source: Box::new(source),
    })
}

/// Persist the config. Creates the parent directory if needed.
pub fn save(index_dir: &Path, cfg: &IndexConfig) -> Result<(), ConfigError> {
    let path = config_path(index_dir);
    let body = toml::to_string_pretty(cfg)?;
    crate::fs_ops::atomic_write(&path, body.as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn load_returns_default_when_absent() {
        let tmp = TempDir::new().unwrap();
        let cfg = load(tmp.path()).unwrap();
        assert_eq!(cfg.model, DEFAULT_MODEL);
        assert_eq!(cfg.schema_version, SCHEMA_VERSION);
        assert!(matches!(cfg.chunking, Chunking::Headings));
    }

    #[test]
    fn save_then_load_roundtrips() {
        let tmp = TempDir::new().unwrap();
        let cfg = IndexConfig {
            model: "BAAI/bge-m3".to_owned(),
            chunking: Chunking::Fixed { chars: 512 },
            ..IndexConfig::default()
        };
        save(tmp.path(), &cfg).unwrap();
        let loaded = load(tmp.path()).unwrap();
        assert_eq!(loaded.model, "BAAI/bge-m3");
        assert!(matches!(loaded.chunking, Chunking::Fixed { chars: 512 }));
    }

    #[test]
    fn model_registry_contains_curated_models_and_marks_default() {
        let models = embedding_models();
        let ids: Vec<&str> = models.iter().map(|model| model.id).collect();
        assert_eq!(
            ids,
            vec![
                "BAAI/bge-small-en-v1.5",
                "BAAI/bge-base-en-v1.5",
                "BAAI/bge-large-en-v1.5",
                "BAAI/bge-m3",
            ]
        );
        assert_eq!(
            models.iter().filter(|model| model.is_default).count(),
            1,
            "exactly one embedding model must be marked default",
        );
        let default = embedding_model(DEFAULT_MODEL).unwrap();
        assert_eq!(default.dim, 384);
        assert!(default.is_default);
        assert!(embedding_model("not-a-model").is_none());
    }

    #[test]
    fn load_works_while_workspace_lock_is_held() {
        // `chan workspace index status` reads IndexConfig without
        // opening a Workspace (so no writer lock acquired), which means
        // a running `chan serve` against the workspace no longer blocks
        // the CLI. Pin the invariant: `config::load` doesn't touch
        // any lock file and returns successfully even while another
        // holder (simulating the chan serve process) has acquired
        // the per-workspace writer flock.
        use crate::lock::WorkspaceLock;
        let tmp = TempDir::new().unwrap();
        let index_dir = tmp.path().join("index");
        let lock_dir = tmp.path().join("lock");
        std::fs::create_dir_all(&index_dir).unwrap();
        let on_disk = IndexConfig {
            model: "BAAI/bge-m3".to_owned(),
            ..IndexConfig::default()
        };
        save(&index_dir, &on_disk).unwrap();
        let _holder = WorkspaceLock::acquire(&lock_dir, tmp.path()).unwrap();
        let loaded = load(&index_dir).unwrap();
        assert_eq!(loaded.model, "BAAI/bge-m3");
    }

    #[test]
    fn malformed_is_error() {
        let tmp = TempDir::new().unwrap();
        let path = config_path(tmp.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "this is not toml = =").unwrap();
        let err = load(tmp.path()).unwrap_err();
        assert!(matches!(err, ConfigError::Decode { .. }));
    }
}
