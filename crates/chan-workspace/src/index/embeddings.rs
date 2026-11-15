// candle-backed embedder. candle is a pure-Rust transformer
// runtime, so the embedder ships no native runtime of its own: no
// prebuilt download at build time, no shared library next to the
// binary at runtime, and no rpath / install_name_tool
// post-processing.
//
// Backends (CPU is the default; GPU is opt-in via CHAN_ENABLE_GPU=1):
//   - macOS: candle's Metal backend (objc2-metal -> Metal.framework).
//     Linked when the `metal` feature is on, which the chan binary
//     forwards automatically on macOS targets, but only selected at
//     runtime when CHAN_ENABLE_GPU=1.
//   - Linux + `--features cuda`: candle's CUDA backend (cudarc),
//     likewise selected only under CHAN_ENABLE_GPU=1.
//   - everything else: CPU.
//
// CPU is the default because the Metal path hangs in
// `[_MTLCommandBuffer waitUntilCompleted]` on at least one machine;
// see `select_device`; the GPU-embed investigation is in git history.
// `CHAN_ENABLE_GPU=1` opts back into the accelerator at runtime
// without rebuilding.
//
// Models we accept are listed in `MODELS`. Unknown ids are rejected
// at open time so the user gets a clear error instead of a panic
// deep inside candle. The embedding dimension is read from the
// model's own `config.json::hidden_size` so adding a new BGE
// variant only means adding one row.
//
// On-disk layout: the downloader writes the Hub-compatible model cache under
// `<cache_dir>/models--<org>--<name>/snapshots/<rev>/`. We resolve
// `config.json`, `tokenizer.json`, and `model.safetensors` from
// there. The cache is per-machine (immutable model files,
// identical across workspaces).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use candle_core::{Device, IndexOp, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::bert::{BertModel, Config, DTYPE};
use thiserror::Error;
use tokenizers::{PaddingParams, PaddingStrategy, Tokenizer, TruncationParams, TruncationStrategy};

use super::config;

mod download;

#[derive(Debug, Error)]
pub enum EmbedError {
    #[error("unknown embedding model: {0}")]
    UnknownModel(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("candle: {0}")]
    Candle(String),
    #[error("tokenizer: {0}")]
    Tokenizer(String),
    #[error("hf-hub: {0}")]
    HfHub(String),
    /// The model server's certificate failed the shared trust decision.
    #[error("hf-hub: {0} (certificate verification failed)")]
    Certificate(String),
    /// A proxy env var (`HTTP(S)_PROXY`/`ALL_PROXY`) is set to a value the model
    /// downloader's HTTP client (ureq) cannot use, so a download would run
    /// without the proxy and fail in a constrained env. Surfaced with the
    /// offending var + value instead of the opaque transport error.
    #[error(
        "proxy env var {var} = {value:?} is not usable by the model downloader \
         (only http:// and socks proxies are supported; an https://-scheme proxy \
         or a malformed value is rejected). Set an http:// proxy URL for the model host."
    )]
    ProxyConfig { var: String, value: String },
    #[error("config decode: {0}")]
    Config(String),
    #[error("operation cancelled")]
    Cancelled,
    /// Model not present on disk and the binary wasn't
    /// built with `--features embed-model`. Surfaces to the CLI / API
    /// layer so the user sees "model not downloaded;
    /// run `chan workspace index download-model` or enable in Settings"
    /// instead of a silent model download.
    #[error(
        "embedding model '{model_id}' not downloaded; expected at {expected_dir:?}. \
         Run `chan workspace index download-model` or rebuild with `--features embed-model`."
    )]
    ModelNotDownloaded {
        model_id: String,
        expected_dir: PathBuf,
    },
}

fn candle_err(error: candle_core::Error) -> EmbedError {
    // Candle's contextual wrappers do not expose their inner error through
    // Error::source. Preserve I/O before corruption recovery classifies it.
    let mut cause = &error;
    loop {
        match cause {
            candle_core::Error::Io(io) => {
                return EmbedError::Io(std::io::Error::new(io.kind(), error));
            }
            candle_core::Error::WithPath { inner, .. }
            | candle_core::Error::Context { inner, .. }
            | candle_core::Error::WithBacktrace { inner, .. } => cause = inner,
            _ => return EmbedError::Candle(error.to_string()),
        }
    }
}
fn tok_err<E: std::fmt::Display>(e: E) -> EmbedError {
    EmbedError::Tokenizer(e.to_string())
}

/// The proxy env vars the ureq client consults, in its precedence order
/// (`ureq::Proxy::try_from_system`): the first that parses to a usable proxy
/// wins. Mirrored here so a download failure can point at a set-but-unusable
/// proxy var.
const PROXY_VARS: [&str; 6] = [
    "ALL_PROXY",
    "all_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
];

/// Whether ureq's `Proxy::new` would accept this value: a bare `host[:port]`
/// (treated as http) or an `http`/`socks{,4,4a,5}` scheme. An `https`-scheme
/// proxy or any other scheme is rejected -- the gap behind a silent
/// constrained-env download failure.
fn proxy_value_usable(value: &str) -> bool {
    match value.split_once("://") {
        Some((scheme, rest)) => {
            !rest.is_empty() && matches!(scheme, "http" | "socks" | "socks4" | "socks4a" | "socks5")
        }
        None => !value.is_empty(),
    }
}

/// The first set-but-unusable proxy var, or `None` when no proxy var is set or at
/// least one set var IS usable (ureq falls through to it, like `try_from_system`).
fn proxy_env_issue() -> Option<(String, String)> {
    proxy_issue_from(|var| std::env::var(var).ok())
}

fn proxy_issue_from(lookup: impl Fn(&str) -> Option<String>) -> Option<(String, String)> {
    let mut first_unusable = None;
    for var in PROXY_VARS {
        let Some(value) = lookup(var) else { continue };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if proxy_value_usable(value) {
            return None;
        }
        first_unusable.get_or_insert_with(|| (var.to_string(), value.to_string()));
    }
    first_unusable
}

/// Maximum input length in tokens. BGE family is 512.
const MAX_SEQ_LEN: usize = 512;

/// Per-forward-pass batch cap. The indexer hands us thousands of
/// chunks at a time (cross-file batching for throughput); running
/// them as one tensor would allocate
/// `[N, 512, hidden] * num_layers * activations` on the device, which
/// exhausts GPU memory and stalls Metal indefinitely on large workspaces.
/// 32 keeps activation memory under ~25 MB per layer for bge-small
/// while still amortizing kernel-launch overhead. Tune up cautiously
/// on machines with more VRAM.
const INFER_BATCH: usize = 32;

/// Loaded transformer + tokenizer. The Mutex wraps both because
/// `BertModel::forward` and tokenization are `&self` but we want
/// to keep the call site cheap; the rest of the codebase expects
/// `&Embedder` access. Contention is light: query embeds are tiny
/// and the indexer batches.
pub struct Embedder {
    model_id: String,
    inner: Mutex<Inner>,
    dim: usize,
}

struct Inner {
    model: BertModel,
    tokenizer: Tokenizer,
    device: Device,
}

impl std::fmt::Debug for Embedder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Embedder")
            .field("model_id", &self.model_id)
            .field("dim", &self.dim)
            .finish()
    }
}

impl Embedder {
    /// Open `model_id` (e.g. `BAAI/bge-small-en-v1.5`). Pulls
    /// `config.json` + `tokenizer.json` + `model.safetensors` from
    /// HuggingFace into `cache_dir` on first use; subsequent opens
    /// are local and fast.
    ///
    /// Decoding, loading or probing a corrupt cached model removes its
    /// per-model cache and retries once. Download and filesystem failures
    /// preserve the cache so resumable bytes and concurrent download locks
    /// remain intact. The probe also detects weights that load but fail
    /// during inference. A second failure surfaces to the caller.
    pub fn open(model_id: &str, cache_dir: &Path) -> Result<Self, EmbedError> {
        let client = download::Client::new(cache_dir)?;
        Self::open_with_client(model_id, cache_dir, &client)
    }

    fn open_with_client(
        model_id: &str,
        cache_dir: &Path,
        client: &download::Client,
    ) -> Result<Self, EmbedError> {
        match Self::open_once(model_id, cache_dir, client).and_then(|e| e.probe().map(|_| e)) {
            Ok(e) => Ok(e),
            Err(
                first_err @ (EmbedError::Config(_)
                | EmbedError::Tokenizer(_)
                | EmbedError::Candle(_)),
            ) => {
                tracing::warn!(
                    model = model_id,
                    error = %first_err,
                    "embedder open/probe failed; wiping model cache and retrying",
                );
                wipe_model_cache(model_id, cache_dir)?;
                let e = Self::open_once(model_id, cache_dir, client)?;
                e.probe()?;
                Ok(e)
            }
            Err(error) => Err(error),
        }
    }

    /// Cold-path bring-up: fetch model files and load them with candle.
    /// Pulled out of `open` so the wipe-and-retry path can call it
    /// twice without duplicating the body. Callers should prefer
    /// `Embedder::open`, which adds the corruption recovery.
    fn open_once(
        model_id: &str,
        cache_dir: &Path,
        client: &download::Client,
    ) -> Result<Self, EmbedError> {
        let _ = lookup_model(model_id)?;
        std::fs::create_dir_all(cache_dir)?;

        // Cache lookup precedes client initialization, so an already downloaded
        // model opens without network access or a new trust-store read.
        let config_path = client.get(model_id, "config.json")?;
        let tokenizer_path = client.get(model_id, "tokenizer.json")?;
        let weights_path = client.get(model_id, "model.safetensors")?;

        let config_raw = std::fs::read(&config_path)?;
        let config: Config =
            serde_json::from_slice(&config_raw).map_err(|e| EmbedError::Config(e.to_string()))?;
        let dim = config.hidden_size;

        if std::fs::metadata(&weights_path)?.len() == 0 {
            return Err(EmbedError::Candle("model weights file is empty".to_owned()));
        }
        let device = select_device();
        // Safe: safetensors files are mmap-friendly; candle reads
        // them read-only and doesn't mutate the backing pages.
        let vb = unsafe {
            VarBuilder::from_mmaped_safetensors(&[weights_path], DTYPE, &device)
                .map_err(candle_err)?
        };
        let model = BertModel::load(vb, &config).map_err(candle_err)?;

        let tokenizer_bytes = std::fs::read(&tokenizer_path)?;
        let mut tokenizer = Tokenizer::from_bytes(&tokenizer_bytes).map_err(tok_err)?;
        // Pad to the longest in the batch (BERT requires uniform
        // length per batch). Truncate to the model's max position
        // embedding window to match HF's default policy.
        let pad_id = tokenizer.get_padding().map(|p| p.pad_id).unwrap_or(0);
        tokenizer
            .with_padding(Some(PaddingParams {
                strategy: PaddingStrategy::BatchLongest,
                pad_id,
                pad_type_id: 0,
                pad_token: "[PAD]".to_string(),
                ..Default::default()
            }))
            .with_truncation(Some(TruncationParams {
                max_length: MAX_SEQ_LEN.min(config.max_position_embeddings),
                strategy: TruncationStrategy::LongestFirst,
                ..Default::default()
            }))
            .map_err(tok_err)?;

        Ok(Self {
            model_id: model_id.to_owned(),
            inner: Mutex::new(Inner {
                model,
                tokenizer,
                device,
            }),
            dim,
        })
    }

    pub fn model_id(&self) -> &str {
        &self.model_id
    }

    /// Embedding dimension. Useful so callers can sanity-check
    /// stored vectors before searching.
    pub fn dim(&self) -> usize {
        self.dim
    }

    /// Embed a batch of documents. Internally splits into
    /// `INFER_BATCH`-sized forward passes so the caller can hand us
    /// thousands of chunks at a time without blowing GPU memory.
    /// Caller may pass a cancel flag; checked between sub-batches
    /// so a `chan workspace index` Ctrl+C interrupts within ~one forward pass
    /// instead of waiting for the next file boundary.
    pub fn embed_documents<S: AsRef<str> + Send + Sync>(
        &self,
        docs: &[S],
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        self.embed_documents_cancelable(docs, None)
    }

    /// Cancellable variant. Returns `Cancelled` between sub-batches
    /// when `cancel` is set. The plain `embed_documents` is a thin
    /// wrapper that passes `None`.
    pub fn embed_documents_cancelable<S: AsRef<str> + Send + Sync>(
        &self,
        docs: &[S],
        cancel: Option<&std::sync::atomic::AtomicBool>,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        if docs.is_empty() {
            return Ok(Vec::new());
        }
        let texts: Vec<&str> = docs.iter().map(|s| s.as_ref()).collect();
        let mut guard = self.inner.lock().unwrap();
        let mut out: Vec<Vec<f32>> = Vec::with_capacity(texts.len());
        for slice in texts.chunks(INFER_BATCH) {
            if let Some(c) = cancel {
                if c.load(std::sync::atomic::Ordering::Relaxed) {
                    return Err(EmbedError::Cancelled);
                }
            }
            let rows = embed_with(&mut guard, slice)?;
            out.extend(rows);
        }
        Ok(out)
    }

    /// Single-query embedding. Same path as documents (BGE family
    /// doesn't need a query-specific prefix for retrieval).
    pub fn embed_query(&self, q: &str) -> Result<Vec<f32>, EmbedError> {
        let mut v = self.embed_documents(&[q])?;
        Ok(v.pop().unwrap_or_default())
    }

    /// Single tokenize + forward pass over an empty string. Used by
    /// `open` to catch a model that loaded but can't actually run
    /// (truncated safetensors, mismatched config). The string is
    /// non-empty inside the tokenizer because BERT prepends the CLS
    /// token, so we still exercise the full code path.
    fn probe(&self) -> Result<(), EmbedError> {
        self.embed_documents(&[""])?;
        Ok(())
    }
}

/// Remove a corrupt model's cache directory so its files can be downloaded
/// again. A directory that is already absent needs no cleanup.
fn wipe_model_cache(model_id: &str, cache_dir: &Path) -> Result<(), EmbedError> {
    let dir = cache_dir.join(format!("models--{}", model_id.replace('/', "--")));
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    Ok(())
}

fn embed_with(inner: &mut Inner, texts: &[&str]) -> Result<Vec<Vec<f32>>, EmbedError> {
    let encodings = inner
        .tokenizer
        .encode_batch(texts.to_vec(), true)
        .map_err(tok_err)?;

    let device = &inner.device;
    let mut id_rows: Vec<Tensor> = Vec::with_capacity(encodings.len());
    let mut mask_rows: Vec<Tensor> = Vec::with_capacity(encodings.len());
    for enc in &encodings {
        let ids: Vec<u32> = enc.get_ids().to_vec();
        let mask: Vec<u32> = enc.get_attention_mask().to_vec();
        id_rows.push(Tensor::new(ids.as_slice(), device).map_err(candle_err)?);
        mask_rows.push(Tensor::new(mask.as_slice(), device).map_err(candle_err)?);
    }
    let token_ids = Tensor::stack(&id_rows, 0).map_err(candle_err)?;
    let attention_mask = Tensor::stack(&mask_rows, 0).map_err(candle_err)?;
    let token_type_ids = token_ids.zeros_like().map_err(candle_err)?;

    // [batch, seq_len, hidden] last hidden state.
    let hidden = inner
        .model
        .forward(&token_ids, &token_type_ids, Some(&attention_mask))
        .map_err(candle_err)?;
    // BGE family is CLS-pooled per the HF model card. Take the
    // first token of every row, then L2-normalize so cosine becomes
    // a dot product downstream.
    let pooled = hidden.i((.., 0)).map_err(candle_err)?;
    let normed = l2_normalize(&pooled)?;

    let rows: Vec<Vec<f32>> = normed.to_vec2::<f32>().map_err(candle_err)?;
    Ok(rows)
}

fn l2_normalize(t: &Tensor) -> Result<Tensor, EmbedError> {
    let squared = t.sqr().map_err(candle_err)?;
    let sums = squared.sum_keepdim(1).map_err(candle_err)?;
    let norms = sums.sqrt().map_err(candle_err)?;
    t.broadcast_div(&norms).map_err(candle_err)
}

/// Pick the best available accelerator. CPU is the default; GPU is
/// opt-in via `CHAN_ENABLE_GPU=1`. When opted in, macOS uses Metal,
/// Linux + `cuda` feature uses CUDA, everything else is CPU.
///
/// WHY default to CPU: the candle Metal backend hangs indefinitely
/// in `[_MTLCommandBuffer waitUntilCompleted]` on at least one Apple
/// Silicon machine during BGE indexing, wedging `chan serve` with no
/// progress and no error. Until that command-buffer usage is fixed
/// (proper future work: a forward-pass timeout with CPU fallback, or
/// correcting how we submit/await the Metal command buffer), the GPU
/// path must not be reachable out of the box. The code path is kept
/// intact behind the opt-in so machines with a working Metal/CUDA
/// stack can still use it for benchmarking.
///
/// Pure policy: should the accelerator (Metal/CUDA) be attempted?
/// Split out from `select_device` so the env-var contract is unit
/// testable without touching real device init or process-global env.
fn want_gpu(enable_gpu: bool) -> bool {
    enable_gpu
}

fn select_device() -> Device {
    let enable_gpu = std::env::var_os("CHAN_ENABLE_GPU").is_some();
    if !want_gpu(enable_gpu) {
        tracing::info!(
            "embedder: using CPU (GPU is opt-in; set CHAN_ENABLE_GPU=1 to enable Metal/CUDA)"
        );
        return Device::Cpu;
    }
    #[cfg(all(target_os = "macos", feature = "metal"))]
    {
        match Device::new_metal(0) {
            Ok(d) => {
                tracing::info!("embedder: Metal backend enabled via CHAN_ENABLE_GPU");
                return d;
            }
            Err(e) => {
                tracing::warn!("embedder: Metal init failed ({e}); falling back to CPU");
            }
        }
    }
    #[cfg(all(target_os = "linux", feature = "cuda"))]
    {
        match Device::new_cuda(0) {
            Ok(d) => {
                tracing::info!("embedder: CUDA backend enabled via CHAN_ENABLE_GPU");
                return d;
            }
            Err(e) => {
                tracing::warn!("embedder: CUDA init failed ({e}); falling back to CPU");
            }
        }
    }
    Device::Cpu
}

fn lookup_model(id: &str) -> Result<usize, EmbedError> {
    config::embedding_model(id)
        .map(|model| model.dim as usize)
        .ok_or_else(|| EmbedError::UnknownModel(id.to_owned()))
}

/// Per-machine model cache. macOS: `~/Library/Caches/chan/models`;
/// Linux: `$XDG_CACHE_HOME/chan/models`; Windows:
/// `%LOCALAPPDATA%/chan/models`. Falls back to the system temp dir
/// if `dirs::cache_dir()` is unavailable; the downloader repopulates that
/// directory whenever its cached model files are absent.
pub fn global_models_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("chan")
        .join("models")
}

/// Translate a HuggingFace model id (`"<org>/<name>"`) into the
/// directory name hf-hub uses inside its cache root: `models--`
/// prefix, slashes replaced with `--`. Mirrors hf-hub's own scheme
/// (`hf_hub::cache::Cache::repo_path`) so the seeder, the runtime
/// resolver, and `Embedder::open`'s cache lookup all agree on where
/// a downloaded model lives.
pub fn repo_dir_name(model_id: &str) -> String {
    format!("models--{}", model_id.replace('/', "--"))
}

/// True when `repo_dir` holds a usable copy of `model_id`'s files:
/// `refs/main` present, plus at least one `snapshots/<hash>/`
/// directory containing `config.json`, `tokenizer.json`, and
/// `model.safetensors`. Anything weaker (stray lockfile, half-
/// downloaded snapshot, blobs-only state from an aborted model
/// download) fails the check.
fn model_files_present(repo_dir: &Path) -> bool {
    if !repo_dir.join("refs").join("main").is_file() {
        return false;
    }
    let snapshots = repo_dir.join("snapshots");
    let Ok(it) = std::fs::read_dir(&snapshots) else {
        return false;
    };
    for entry in it.flatten() {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if !ft.is_dir() {
            continue;
        }
        let dir = entry.path();
        if dir.join("config.json").is_file()
            && dir.join("tokenizer.json").is_file()
            && dir.join("model.safetensors").is_file()
        {
            return true;
        }
    }
    false
}

/// Runtime resolver for the embedding model. Indexes by
/// model name (not a hardcoded path) so a multi-model picker
/// can swap the active model without changing this function.
///
/// Returns the repo directory under `global_models_dir()` when the
/// model is laid out and ready (matches the same predicate
/// `embed_seed.rs::default_model_present` uses on the seed path --
/// either source can populate the cache). Returns
/// `EmbedError::ModelNotDownloaded` otherwise; callers propagate it
/// to the API / CLI surface so the user sees "model not downloaded;
/// run `chan workspace index download-model` or rebuild with `--features
/// embed-model`".
///
/// Rejects unknown model ids first (mirrors `Embedder::open_once`'s
/// `lookup_model` gate) so the error path stays consistent
/// regardless of cache state.
pub fn resolve_model(model_id: &str) -> Result<PathBuf, EmbedError> {
    resolve_model_in(model_id, &global_models_dir())
}

pub fn model_downloaded(model_id: &str) -> Result<bool, EmbedError> {
    model_downloaded_in(model_id, &global_models_dir())
}

/// Resolve against an explicit cache root: the machine cache for `resolve_model`,
/// or the directory a workspace or index retains.
pub(crate) fn resolve_model_in(model_id: &str, cache_dir: &Path) -> Result<PathBuf, EmbedError> {
    let _ = lookup_model(model_id)?;
    let repo_dir = cache_dir.join(repo_dir_name(model_id));
    if model_files_present(&repo_dir) {
        Ok(repo_dir)
    } else {
        Err(EmbedError::ModelNotDownloaded {
            model_id: model_id.to_owned(),
            expected_dir: repo_dir,
        })
    }
}

fn model_downloaded_in(model_id: &str, cache_dir: &Path) -> Result<bool, EmbedError> {
    let _ = lookup_model(model_id)?;
    let repo_dir = cache_dir.join(repo_dir_name(model_id));
    Ok(model_files_present(&repo_dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_weights_are_classified_before_mapping() {
        let cache = tempfile::tempdir().unwrap();
        crate::index::test_support::seed_embedding_model(cache.path());
        let weights = cache
            .path()
            .join(repo_dir_name(crate::DEFAULT_MODEL))
            .join("snapshots/test-model/model.safetensors");
        std::fs::write(weights, []).unwrap();
        let client = download::Client::new(cache.path()).unwrap();
        let error = Embedder::open_once(crate::DEFAULT_MODEL, cache.path(), &client)
            .expect_err("empty weights must fail before an OS-specific mmap attempt");
        assert!(
            matches!(&error, EmbedError::Candle(message) if message == "model weights file is empty"),
            "empty weights need a platform-independent corruption error: {error}"
        );
    }

    #[test]
    fn candle_filesystem_errors_preserve_kind_and_context() {
        let io = || {
            candle_core::Error::Io(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "model read denied",
            ))
        };
        let backtrace = |inner| candle_core::Error::WithBacktrace {
            inner: Box::new(inner),
            backtrace: Box::new(std::backtrace::Backtrace::disabled()),
        };
        for error in [
            io(),
            io().with_path("model.safetensors"),
            io().context("mapping model weights"),
            backtrace(io()),
            backtrace(io().with_path("model.safetensors")).context("loading model"),
        ] {
            let message = error.to_string();
            let mapped = candle_err(error);
            let EmbedError::Io(error) = mapped else {
                panic!("filesystem failures must remain non-retryable I/O: {mapped}");
            };
            assert_eq!(
                error.kind(),
                std::io::ErrorKind::PermissionDenied,
                "filesystem error kind must survive Candle context wrappers"
            );
            assert_eq!(
                error.to_string(),
                message,
                "retain the full model read context"
            );
        }

        let decode = candle_core::Error::Msg("invalid model weights".to_owned())
            .with_path("model.safetensors")
            .context("loading model");
        let expected = decode.to_string();
        assert!(
            matches!(candle_err(decode), EmbedError::Candle(message) if message == expected),
            "model decoding failures remain retryable with their full context"
        );
    }

    #[test]
    fn unknown_model_is_error() {
        let err = lookup_model("not-a-model").unwrap_err();
        assert!(matches!(err, EmbedError::UnknownModel(_)));
    }

    #[test]
    fn proxy_value_usable_accepts_http_and_socks_only() {
        assert!(proxy_value_usable("http://proxy:8080"));
        assert!(proxy_value_usable("socks5://proxy:1080"));
        assert!(proxy_value_usable("socks://proxy:1080"));
        // A bare host[:port] is treated as http by ureq.
        assert!(proxy_value_usable("proxy.example:8080"));
        // The known gaps: an https-scheme proxy and any other scheme.
        assert!(!proxy_value_usable("https://proxy:8080"));
        assert!(!proxy_value_usable("ftp://x"));
        assert!(!proxy_value_usable(""));
    }

    #[test]
    fn proxy_issue_falls_through_to_a_usable_var() {
        use std::collections::HashMap;
        let look =
            |m: HashMap<&'static str, &'static str>| move |v: &str| m.get(v).map(|s| s.to_string());
        // No proxy set -> no issue.
        assert_eq!(proxy_issue_from(look(HashMap::new())), None);
        // A usable proxy -> no issue.
        assert_eq!(
            proxy_issue_from(look(HashMap::from([("HTTP_PROXY", "http://p:8080")]))),
            None
        );
        // Only an https-scheme proxy -> flagged with the offending var + value.
        assert_eq!(
            proxy_issue_from(look(HashMap::from([("HTTPS_PROXY", "https://p:8080")]))),
            Some(("HTTPS_PROXY".to_string(), "https://p:8080".to_string()))
        );
        // An unusable ALL_PROXY but a usable HTTP_PROXY -> ureq uses the latter,
        // so no issue (mirrors try_from_system's fall-through precedence).
        assert_eq!(
            proxy_issue_from(look(HashMap::from([
                ("ALL_PROXY", "https://bad"),
                ("HTTP_PROXY", "http://good:8080"),
            ]))),
            None
        );
    }

    #[test]
    fn gpu_is_opt_in() {
        // Default (neither var): CPU, because the Metal path hangs in
        // [_MTLCommandBuffer waitUntilCompleted] out of the box.
        assert!(!want_gpu(false));
        // Opt-in: attempt the accelerator.
        assert!(want_gpu(true));
    }

    #[test]
    fn known_models_resolve() {
        assert!(lookup_model("BAAI/bge-small-en-v1.5").is_ok());
        assert!(lookup_model("BAAI/bge-m3").is_ok());
    }

    #[test]
    fn model_downloaded_flag_uses_cache_layout() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!model_downloaded_in("BAAI/bge-small-en-v1.5", tmp.path()).unwrap());

        let repo = tmp.path().join(repo_dir_name("BAAI/bge-small-en-v1.5"));
        seeded_repo(&repo);
        assert!(model_downloaded_in("BAAI/bge-small-en-v1.5", tmp.path()).unwrap());

        let err = model_downloaded_in("not-a-model", tmp.path()).unwrap_err();
        assert!(matches!(err, EmbedError::UnknownModel(_)));
    }

    fn seeded_repo(repo: &Path) {
        std::fs::create_dir_all(repo.join("refs")).unwrap();
        std::fs::write(repo.join("refs").join("main"), b"deadbeef").unwrap();
        let snap = repo.join("snapshots").join("deadbeef");
        std::fs::create_dir_all(&snap).unwrap();
        std::fs::write(snap.join("config.json"), b"{}").unwrap();
        std::fs::write(snap.join("tokenizer.json"), b"{}").unwrap();
        std::fs::write(snap.join("model.safetensors"), b"weights").unwrap();
    }

    #[test]
    fn repo_dir_name_matches_hf_hub_layout() {
        assert_eq!(
            repo_dir_name("BAAI/bge-small-en-v1.5"),
            "models--BAAI--bge-small-en-v1.5"
        );
        assert_eq!(repo_dir_name("BAAI/bge-m3"), "models--BAAI--bge-m3");
    }

    #[test]
    fn resolve_model_returns_path_when_files_present() {
        // Pin the happy path. When refs/main + a
        // complete snapshot trio are present, the resolver returns
        // the repo dir; callers proceed to `Embedder::open` against
        // the cached files without an hf-hub network round-trip.
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join(repo_dir_name("BAAI/bge-small-en-v1.5"));
        seeded_repo(&repo);
        let resolved = resolve_model_in("BAAI/bge-small-en-v1.5", tmp.path()).unwrap();
        assert_eq!(resolved, repo);
    }

    #[test]
    fn resolve_model_errors_when_dir_empty() {
        // Default-build runtime path: feature `embed-model` off + no
        // prior download → resolver surfaces
        // ModelNotDownloaded with the expected path. The CLI / API
        // layer turns this into the "run `chan workspace index download-model`"
        // hint instead of triggering an hf-hub network fetch.
        let tmp = tempfile::tempdir().unwrap();
        let err = resolve_model_in("BAAI/bge-small-en-v1.5", tmp.path()).unwrap_err();
        match err {
            EmbedError::ModelNotDownloaded {
                model_id,
                expected_dir,
            } => {
                assert_eq!(model_id, "BAAI/bge-small-en-v1.5");
                assert_eq!(
                    expected_dir,
                    tmp.path().join("models--BAAI--bge-small-en-v1.5")
                );
            }
            other => panic!("expected ModelNotDownloaded, got {other:?}"),
        }
    }

    #[test]
    fn resolve_model_errors_when_snapshot_incomplete() {
        // Half-downloaded state: refs/main present, but the
        // snapshot is missing one of the trio. Rejecting this is
        // load-bearing -- a hf-hub download interrupted mid-flight
        // can leave the dir in this shape, and we don't want the
        // embedder to open a partial model and crash mid-forward-
        // pass. ModelNotDownloaded is the right signal: the caller
        // re-runs the download.
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join(repo_dir_name("BAAI/bge-small-en-v1.5"));
        seeded_repo(&repo);
        std::fs::remove_file(
            repo.join("snapshots")
                .join("deadbeef")
                .join("tokenizer.json"),
        )
        .unwrap();
        let err = resolve_model_in("BAAI/bge-small-en-v1.5", tmp.path()).unwrap_err();
        assert!(matches!(err, EmbedError::ModelNotDownloaded { .. }));
    }

    #[test]
    fn resolve_model_rejects_unknown_id_before_filesystem_check() {
        // Even if the unknown id had a plausibly-laid-out dir on
        // disk, the resolver rejects it up front. Keeps the error
        // path consistent with `Embedder::open_once`'s gate.
        let tmp = tempfile::tempdir().unwrap();
        let err = resolve_model_in("not-a-model", tmp.path()).unwrap_err();
        assert!(matches!(err, EmbedError::UnknownModel(_)));
    }

    #[test]
    fn wipe_model_cache_removes_org_name_dir() {
        // The cache writer and wipe-and-retry path share this repository
        // naming convention, so recovery must remove the same directory.
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("models--BAAI--bge-small-en-v1.5");
        std::fs::create_dir_all(dir.join("snapshots/rev/blobs")).unwrap();
        std::fs::write(dir.join("snapshots/rev/blobs/junk"), b"partial").unwrap();
        wipe_model_cache("BAAI/bge-small-en-v1.5", tmp.path()).unwrap();
        assert!(
            !dir.exists(),
            "wipe_model_cache should have removed {}",
            dir.display(),
        );
        // Repeat call is a no-op (idempotent).
        wipe_model_cache("BAAI/bge-small-en-v1.5", tmp.path()).unwrap();
    }

    /// Gated on CHAN_RUN_MODEL_TESTS=1 so CI doesn't pull 130 MB
    /// every run. Locally: `CHAN_RUN_MODEL_TESTS=1 cargo test`.
    fn run_model_tests() -> bool {
        std::env::var_os("CHAN_RUN_MODEL_TESTS").is_some()
    }

    #[test]
    fn outputs_are_unit_vectors() {
        if !run_model_tests() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let e = Embedder::open("BAAI/bge-small-en-v1.5", tmp.path()).unwrap();
        let v = e
            .embed_documents(&["hello world", "another sentence"])
            .unwrap();
        for row in &v {
            let n: f32 = row.iter().map(|x| x * x).sum::<f32>().sqrt();
            assert!((n - 1.0).abs() < 1e-4, "row not unit-norm: {n}");
        }
    }

    #[test]
    fn batched_equals_per_row() {
        if !run_model_tests() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let e = Embedder::open("BAAI/bge-small-en-v1.5", tmp.path()).unwrap();
        let texts = ["alpha", "beta", "gamma"];
        let batched = e.embed_documents(&texts).unwrap();
        for (i, t) in texts.iter().enumerate() {
            let single = e.embed_query(t).unwrap();
            let dot: f32 = batched[i].iter().zip(&single).map(|(a, b)| a * b).sum();
            assert!(
                dot > 0.999,
                "batched vs single mismatch for {t:?}: cos={dot}"
            );
        }
    }

    #[test]
    fn deterministic() {
        if !run_model_tests() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let e = Embedder::open("BAAI/bge-small-en-v1.5", tmp.path()).unwrap();
        let a = e.embed_query("the quick brown fox").unwrap();
        let b = e.embed_query("the quick brown fox").unwrap();
        assert_eq!(a, b);
    }
}
