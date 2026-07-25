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
