//! Persisted bearer token + axum middleware that gates `/api/*` and `/ws`.
//!
//! Token persistence lives at `<paths.tokens>/token` (mode 0600 on Unix)
//! so a `cargo build && chan serve` cycle does not invalidate the
//! browser's cached sessionStorage token. Atomic write goes through
//! chan-workspace's `fs_ops::atomic_write` so the parent-dir fsync invariant
//! matches the rest of the app.
//!
//! Devserver tunnel requests carry `TunnelOrigin`; the gateway is the trust
//! boundary in that path, so the local bearer gate admits those requests after
//! the proxy has authenticated them.

use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use chan_workspace::paths::WorkspacePaths;
use rand::RngCore;

use crate::signal::now_unix_secs;
use crate::state::AppState;

const TOKEN_LEN: usize = 32;
const TOKEN_ALPHABET: &[u8] = b"abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

pub fn random_token() -> String {
    let mut bytes = [0u8; TOKEN_LEN];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|b| TOKEN_ALPHABET[(*b as usize) % TOKEN_ALPHABET.len()] as char)
        .collect()
}

/// Load the persisted server token, generating one on first run.
/// Lives at `<paths.tokens>/token` (mode 0600 on Unix). The token
/// survives a binary rebuild so the browser's cached sessionStorage
/// token stays valid across `cargo build && chan serve` cycles.
pub fn load_or_create_token(paths: &WorkspacePaths) -> std::io::Result<String> {
    ensure_tokens_dir(&paths.tokens)?;
    let token_path = paths.tokens.join("token");
    if let Ok(s) = std::fs::read_to_string(&token_path) {
        let s = s.trim();
        if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Ok(s.to_owned());
        }
    }
    let token = random_token();
    write_token_atomic(&token_path, &token)?;
    Ok(token)
}

/// Make sure `<state>/tokens/<workspace-key>/` is a directory we can write
/// inside. Self-heals one specific corruption case: a regular file
/// sitting at that path (typically left by manual fiddling) makes
/// `create_dir_all` fail with `AlreadyExists` and would otherwise
/// abort the whole serve. We remove the stray file and retry. Any
/// other condition (symlink, real permission problem on the dir) is
/// propagated unchanged.
fn ensure_tokens_dir(dir: &Path) -> std::io::Result<()> {
    match std::fs::create_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let meta = std::fs::symlink_metadata(dir)?;
            let ft = meta.file_type();
            if ft.is_file() {
                std::fs::remove_file(dir)?;
                std::fs::create_dir_all(dir)
            } else {
                Err(e)
            }
        }
        Err(e) => Err(e),
    }
}

/// Write the token via chan-workspace's atomic_write helper (tmpfile +
/// fsync of file AND parent dir + rename). Sets 0600 permissions on
/// Unix to keep the secret out of `ls -l` snooping.
fn write_token_atomic(token_path: &Path, token: &str) -> std::io::Result<()> {
    chan_workspace::fs_ops::atomic_write(token_path, token.as_bytes())
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(token_path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Reject requests that don't carry the right token.
///
/// Auth scope: only `/api/*` and `/ws` routes are gated. Static
/// assets stay open: the browser issues those via `<script src>` /
/// `<link href>` before our JS runs and they can't carry the token.
/// The data plane is what needs protecting.
pub async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    req: Request<Body>,
    next: Next,
) -> Response {
    // The activity bump lives here so it only fires on requests we
    // actually serve: a brute-forcing client with bad tokens keeps
    // hitting the 401 path below and won't pin the idle timer open.
    let bump = || {
        state
            .last_activity
            .store(now_unix_secs(), Ordering::Relaxed)
    };
    let Some(expected) = state.token.as_deref() else {
        bump();
        return next.run(req).await;
    };
    let path = req.uri().path();
    if !(path.starts_with("/api") || path == "/ws") {
        bump();
        return next.run(req).await;
    }
    if req.extensions().get::<crate::TunnelOrigin>().is_some() {
        bump();
        return next.run(req).await;
    }
    if extract_token(req.uri().query(), req.headers()) == Some(expected) {
        bump();
        return next.run(req).await;
    }
    (StatusCode::UNAUTHORIZED, "missing or invalid token").into_response()
}

pub fn extract_token<'a>(query: Option<&'a str>, headers: &'a HeaderMap) -> Option<&'a str> {
    if let Some(q) = query {
        for pair in q.split('&') {
            if let Some(rest) = pair.strip_prefix("t=") {
                return Some(rest);
            }
        }
    }
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_token_is_alphanumeric_and_long() {
        let t = random_token();
        assert_eq!(t.len(), TOKEN_LEN);
        assert!(t.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn extract_token_query_param() {
        let h = HeaderMap::new();
        assert_eq!(
            extract_token(Some("foo=bar&t=secret&x=y"), &h),
            Some("secret")
        );
    }

    #[test]
    fn extract_token_authorization_header() {
        let mut h = HeaderMap::new();
        h.insert(header::AUTHORIZATION, "Bearer secret".parse().unwrap());
        assert_eq!(extract_token(None, &h), Some("secret"));
    }

    #[test]
    fn extract_token_missing() {
        let h = HeaderMap::new();
        assert_eq!(extract_token(None, &h), None);
    }

    /// Regression: some on-disk state has `<state>/tokens/<key>` as a
    /// regular file (32-byte token blob) instead of a directory.
    /// `create_dir_all` cannot turn a file into a directory, so `chan
    /// open` would die with `io: File exists (os error 17)`.
    /// `ensure_tokens_dir` must self-heal: drop the stray file, make
    /// the directory, and let the regular write path produce a fresh
    /// token underneath.
    #[test]
    fn ensure_tokens_dir_self_heals_stale_file_at_tokens_path() {
        let tmp = tempfile::TempDir::new().unwrap();
        let tokens = tmp.path().join("tokens").join("deadbeef0000cafe");
        // Pre-populate the schema-violating state: parent dir exists,
        // and the per-key slot is a regular file.
        std::fs::create_dir_all(tokens.parent().unwrap()).unwrap();
        std::fs::write(&tokens, b"WTMYtxvSqLsPsRpVBihjKJaUHWsnL7F9").unwrap();
        assert!(tokens.is_file());

        ensure_tokens_dir(&tokens).expect("self-heal");
        assert!(
            tokens.is_dir(),
            "stray file should have been replaced by a dir"
        );

        // Follow-through: the real call site writes a `token` file
        // inside, which the next boot reads back unchanged.
        let token_path = tokens.join("token");
        write_token_atomic(&token_path, "abcdef").unwrap();
        assert_eq!(std::fs::read_to_string(&token_path).unwrap(), "abcdef");
    }

    /// Sanity: the happy path stays happy. `ensure_tokens_dir` on a
    /// pristine layout is a plain `create_dir_all`.
    #[test]
    fn ensure_tokens_dir_creates_missing_dir() {
        let tmp = tempfile::TempDir::new().unwrap();
        let tokens = tmp.path().join("tokens").join("aaaaaaaaaaaaaaaa");
        ensure_tokens_dir(&tokens).unwrap();
        assert!(tokens.is_dir());
    }

    /// And idempotence: a second call on an existing directory must
    /// succeed without touching the contents.
    #[test]
    fn ensure_tokens_dir_idempotent_on_existing_dir() {
        let tmp = tempfile::TempDir::new().unwrap();
        let tokens = tmp.path().join("tokens").join("bbbbbbbbbbbbbbbb");
        std::fs::create_dir_all(&tokens).unwrap();
        std::fs::write(tokens.join("token"), b"existing").unwrap();
        ensure_tokens_dir(&tokens).unwrap();
        assert_eq!(
            std::fs::read_to_string(tokens.join("token")).unwrap(),
            "existing"
        );
    }
}
