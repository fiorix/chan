//! Shared state and request validation for desktop-native transfers.
//!
//! The webview supplies only an opaque transfer id and a same-origin API URL.
//! Rust re-validates that URL against the invoking webview, borrows its cookie
//! jar for gateway authentication, and exposes progress through a polled,
//! process-local registry. Polling is deliberately capped by the SPA at 10 Hz.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use reqwest::header::{HeaderMap, HeaderValue, COOKIE, ORIGIN};
use serde::Serialize;
use tauri::WebviewWindow;
use tokio::sync::Notify;
use url::Url;

const UNKNOWN_TOTAL: u64 = u64::MAX;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndpointKind {
    Download,
    Upload,
}

#[derive(Debug)]
pub struct TransferProgress {
    loaded: AtomicU64,
    total: AtomicU64,
    cancelled: AtomicBool,
    cancel_notify: Notify,
}

impl TransferProgress {
    fn new(total: Option<u64>) -> Self {
        Self {
            loaded: AtomicU64::new(0),
            total: AtomicU64::new(total.unwrap_or(UNKNOWN_TOTAL)),
            cancelled: AtomicBool::new(false),
            cancel_notify: Notify::new(),
        }
    }

    pub fn set_total(&self, total: Option<u64>) {
        self.total
            .store(total.unwrap_or(UNKNOWN_TOTAL), Ordering::Relaxed);
    }

    pub fn add_loaded(&self, bytes: u64) {
        self.loaded.fetch_add(bytes, Ordering::Relaxed);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    pub async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        self.cancel_notify.notified().await;
    }

    #[cfg(test)]
    pub fn new_for_test(total: Option<u64>) -> Self {
        Self::new(total)
    }

    #[cfg(test)]
    pub fn cancel_for_test(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }
}

fn registry() -> &'static Mutex<HashMap<String, Arc<TransferProgress>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<TransferProgress>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

pub struct TransferRegistration {
    id: String,
    pub progress: Arc<TransferProgress>,
}

impl TransferRegistration {
    pub fn new(id: String, total: Option<u64>) -> Result<Self, String> {
        validate_transfer_id(&id)?;
        let progress = Arc::new(TransferProgress::new(total));
        let mut transfers = registry()
            .lock()
            .map_err(|_| "native transfer registry poisoned".to_string())?;
        if transfers.contains_key(&id) {
            return Err("native transfer id is already active".into());
        }
        transfers.insert(id.clone(), Arc::clone(&progress));
        Ok(Self { id, progress })
    }
}

impl Drop for TransferRegistration {
    fn drop(&mut self) {
        if let Ok(mut transfers) = registry().lock() {
            transfers.remove(&self.id);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct NativeTransferStatus {
    loaded: u64,
    total: Option<u64>,
}

#[tauri::command]
pub fn native_transfer_status(transfer_id: String) -> Option<NativeTransferStatus> {
    let transfers = registry().lock().ok()?;
    let progress = transfers.get(&transfer_id)?;
    let total = progress.total.load(Ordering::Relaxed);
    Some(NativeTransferStatus {
        loaded: progress.loaded.load(Ordering::Relaxed),
        total: (total != UNKNOWN_TOTAL).then_some(total),
    })
}

#[tauri::command]
pub fn cancel_native_transfer(transfer_id: String) -> bool {
    let Ok(transfers) = registry().lock() else {
        return false;
    };
    let Some(progress) = transfers.get(&transfer_id) else {
        return false;
    };
    progress.cancelled.store(true, Ordering::Relaxed);
    progress.cancel_notify.notify_one();
    true
}

fn validate_transfer_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 96
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid native transfer id".into());
    }
    Ok(())
}

pub fn validated_endpoint(
    current: &Url,
    requested: &str,
    kind: EndpointKind,
) -> Result<Url, String> {
    let endpoint =
        Url::parse(requested).map_err(|error| format!("invalid transfer URL: {error}"))?;
    if !matches!(endpoint.scheme(), "http" | "https")
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.fragment().is_some()
    {
        return Err("native transfer URL must be an http(s) API URL".into());
    }
    if endpoint.origin() != current.origin() {
        return Err("native transfer URL changed origin".into());
    }
    let current_path = current.path().trim_end_matches('/');
    let prefix = current_path
        .strip_suffix("/index.html")
        .unwrap_or(current_path);
    let path = endpoint
        .path()
        .strip_prefix(prefix)
        .ok_or_else(|| "native transfer URL changed workspace prefix".to_string())?;
    let expected = match kind {
        EndpointKind::Download => {
            path.strip_prefix("/api/files/")
                .is_some_and(|file_path| !file_path.is_empty())
                && endpoint
                    .query_pairs()
                    .any(|(key, value)| key == "download" && matches!(value.as_ref(), "1" | "true"))
        }
        EndpointKind::Upload => path == "/api/files/upload",
    };
    if !expected {
        return Err("native transfer URL is not the expected file API route".into());
    }
    Ok(endpoint)
}

pub fn endpoint_for_window(
    window: &WebviewWindow,
    requested: &str,
    kind: EndpointKind,
) -> Result<Url, String> {
    let current = window
        .url()
        .map_err(|error| format!("reading invoking webview URL: {error}"))?;
    validated_endpoint(&current, requested, kind)
}

pub fn request_headers(
    window: &WebviewWindow,
    endpoint: &Url,
    unsafe_method: bool,
) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        ORIGIN,
        HeaderValue::from_str(&endpoint.origin().ascii_serialization())
            .map_err(|error| format!("invalid transfer origin header: {error}"))?,
    );
    let cookies = window
        .cookies_for_url(endpoint.clone())
        .map_err(|error| format!("reading webview authentication cookies: {error}"))?;
    if !cookies.is_empty() {
        let value = cookies
            .iter()
            .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
            .collect::<Vec<_>>()
            .join("; ");
        headers.insert(
            COOKIE,
            HeaderValue::from_str(&value)
                .map_err(|error| format!("invalid transfer cookie header: {error}"))?,
        );
    }
    if unsafe_method {
        if let Some(csrf) = cookies
            .iter()
            .find(|cookie| cookie.name() == "__Host-devserver_csrf")
        {
            headers.insert(
                "x-chan-csrf",
                HeaderValue::from_str(csrf.value())
                    .map_err(|error| format!("invalid gateway CSRF cookie: {error}"))?,
            );
        }
    }
    Ok(headers)
}

/// The effective transfer ceiling. It has exactly one owner, the server that
/// reports it, and this process keeps no constant, default, or fallback of its
/// own: a second copy of the policy is a second policy, and they drift.
///
/// [`TransferCap::Unknown`] is a real state and is NOT a synonym for
/// unlimited. It means this process could not learn the ceiling, either
/// because the server does not report one or because reading it failed. The
/// defined response is to enforce nothing client-side and leave the refusal to
/// the server, which enforces on the route regardless of what any client
/// believes. An unreadable ceiling therefore costs the client-side fail-fast
/// and nothing else: the refusal still happens, later and from the server.
///
/// Deliberately no `Default` impl: there is no defensible default to derive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferCap {
    Known(u64),
    Unknown,
}

impl TransferCap {
    /// Interpret what the server reported. `None` is the absent field.
    pub fn from_reported(reported: Option<u64>) -> Self {
        match reported {
            Some(max) => Self::Known(max),
            None => Self::Unknown,
        }
    }

    /// Refuse `bytes` against a known ceiling. Used both as the preflight,
    /// before a byte is written or sent, and as the streaming backstop against
    /// the running total, because a declared length is a claim and the bytes
    /// that actually arrive are the fact.
    pub fn check(&self, bytes: u64) -> Result<(), String> {
        match self {
            Self::Known(max) if bytes > *max => Err(format!(
                "transfer of {bytes} bytes exceeds the server's effective limit of {max} bytes"
            )),
            _ => Ok(()),
        }
    }
}

/// The tenant's `/api/config` URL, derived from an ALREADY-VALIDATED transfer
/// endpoint so it inherits that same-origin and workspace-prefix check instead
/// of trusting a second URL from the page. The loopback surface authenticates
/// on the `t` query parameter, so that one pair is carried over and every
/// other query parameter is dropped.
pub fn config_url_for_transfer(endpoint: &Url) -> Result<Url, String> {
    let path = endpoint.path();
    let at = path
        .rfind("/api/files")
        .ok_or_else(|| "transfer endpoint is not a file API URL".to_string())?;
    let token = endpoint
        .query_pairs()
        .find(|(key, _)| key == "t")
        .map(|(_, value)| value.into_owned());
    let mut config = endpoint.clone();
    config.set_path(&format!("{}/api/config", &path[..at]));
    config.set_query(None);
    if let Some(token) = token {
        config.query_pairs_mut().append_pair("t", &token);
    }
    Ok(config)
}

/// Read the effective ceiling from the server that owns it, over the same
/// validated origin and credentials the transfer itself uses.
///
/// Every failure path answers [`TransferCap::Unknown`] rather than a number.
/// A transport error, a non-success status, an undecodable body, and an absent
/// field are all the same thing from here: this process does not know the
/// policy, so it does not get to invent one.
pub async fn fetch_transfer_cap(
    client: &reqwest::Client,
    endpoint: &Url,
    headers: HeaderMap,
) -> TransferCap {
    let Ok(url) = config_url_for_transfer(endpoint) else {
        return TransferCap::Unknown;
    };
    let Ok(response) = client.get(url).headers(headers).send().await else {
        return TransferCap::Unknown;
    };
    if !response.status().is_success() {
        return TransferCap::Unknown;
    }
    let Ok(body) = response.json::<serde_json::Value>().await else {
        return TransferCap::Unknown;
    };
    TransferCap::from_reported(
        body.pointer("/preferences/transfer_max_bytes")
            .and_then(serde_json::Value::as_u64),
    )
}

pub fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("building native transfer client: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transfer_endpoints_are_same_origin_and_exact_route_shapes() {
        let current = Url::parse("https://alice.example/prefix/?w=1").unwrap();
        assert!(validated_endpoint(
            &current,
            "https://alice.example/prefix/api/files/a.md?download=1&t=x",
            EndpointKind::Download,
        )
        .is_ok());
        assert!(validated_endpoint(
            &current,
            "https://alice.example/prefix/api/files/upload?t=x",
            EndpointKind::Upload,
        )
        .is_ok());
        for invalid in [
            "https://bob.example/prefix/api/files/a.md?download=1",
            "https://alice.example/prefix/api/files/a.md",
            "https://alice.example/other/api/files/a.md?download=1",
            "https://alice.example/prefix/api/files/upload/extra",
            "file:///tmp/a",
        ] {
            assert!(
                validated_endpoint(&current, invalid, EndpointKind::Download).is_err(),
                "{invalid}"
            );
        }
    }

    /// The boundary itself: exact size passes, one byte over is refused. The
    /// message names both numbers so a refusal is diagnosable without a log.
    #[test]
    fn native_transfer_cap_allows_exact_and_refuses_one_byte_over() {
        let cap = TransferCap::from_reported(Some(1024));
        assert!(cap.check(0).is_ok());
        assert!(cap.check(1023).is_ok());
        assert!(cap.check(1024).is_ok(), "the cap is inclusive");

        let refused = cap.check(1025).expect_err("one byte over must refuse");
        assert!(refused.contains("1025"), "{refused}");
        assert!(refused.contains("1024"), "{refused}");
    }

    /// The trap this item exists to prevent. An absent field is UNKNOWN, and
    /// unknown must not become a number: no default, no fallback ceiling, no
    /// re-derived policy. It also must not silently become unlimited by
    /// accident, so this pins the reasoning as well as the behaviour: the
    /// desktop enforces nothing it cannot read, and the server still does.
    #[test]
    fn native_transfer_cap_absent_field_is_unknown_and_invents_no_default() {
        let cap = TransferCap::from_reported(None);
        assert_eq!(cap, TransferCap::Unknown);

        // Nothing is refused client-side, because there is no known ceiling to
        // refuse against. This is the pre-guard behaviour, not a decision that
        // transfers are unlimited; the route enforces regardless.
        assert!(cap.check(0).is_ok());
        assert!(cap.check(u64::MAX).is_ok());

        // A reported zero is a known ceiling of zero, NOT the absent case.
        // Conflating them is how "absent" turns into a default.
        let zero = TransferCap::from_reported(Some(0));
        assert_eq!(zero, TransferCap::Known(0));
        assert!(zero.check(0).is_ok());
        assert!(zero.check(1).is_err());
    }

    /// The config URL inherits the transfer endpoint's origin and workspace
    /// prefix rather than being a second URL to trust, and carries only the
    /// bearer query the loopback surface authenticates on.
    #[test]
    fn native_transfer_cap_config_url_derives_from_the_validated_endpoint() {
        let endpoint =
            Url::parse("https://alice.example/prefix/api/files/a.md?download=1&t=secret").unwrap();
        let config = config_url_for_transfer(&endpoint).unwrap();
        assert_eq!(
            config.as_str(),
            "https://alice.example/prefix/api/config?t=secret"
        );

        let upload = Url::parse("http://127.0.0.1:4090/api/files/upload?t=tok").unwrap();
        assert_eq!(
            config_url_for_transfer(&upload).unwrap().as_str(),
            "http://127.0.0.1:4090/api/config?t=tok"
        );

        // No token to carry means no query at all, not an empty one.
        let bare = Url::parse("https://alice.example/prefix/api/files/a.md?download=1").unwrap();
        assert_eq!(
            config_url_for_transfer(&bare).unwrap().as_str(),
            "https://alice.example/prefix/api/config"
        );

        assert!(
            config_url_for_transfer(&Url::parse("https://alice.example/nope").unwrap()).is_err()
        );
    }

    #[test]
    fn transfer_registry_tracks_progress_and_cancellation() {
        let registration = TransferRegistration::new("native-test".into(), Some(100)).unwrap();
        registration.progress.add_loaded(25);
        assert_eq!(
            native_transfer_status("native-test".into()).unwrap().loaded,
            25
        );
        assert!(cancel_native_transfer("native-test".into()));
        assert!(registration.progress.is_cancelled());
        drop(registration);
        assert!(native_transfer_status("native-test".into()).is_none());
    }
}
