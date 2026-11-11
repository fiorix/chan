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

/// The longest picked file name a status carries, in characters. The page
/// polls the status, so the name in it is bounded whatever the filesystem
/// allowed. File names are commonly limited to 255 bytes or UTF-16 units,
/// which is never more than 255 characters, so an ordinary name is not cut.
const PICKED_NAME_MAX_CHARS: usize = 255;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndpointKind {
    Download,
    Upload,
}

/// What the page is told of an upload's selection: the first file's base name
/// and how many files were picked. It names the transfer's row from the two,
/// the name for one file and the count for several, so the payload does not
/// grow with the selection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PickedFiles {
    name: String,
    count: u64,
}

#[derive(Debug)]
pub struct TransferProgress {
    loaded: AtomicU64,
    total: AtomicU64,
    cancelled: AtomicBool,
    cancel_notify: Notify,
    picked: OnceLock<PickedFiles>,
}

impl TransferProgress {
    fn new(total: Option<u64>) -> Self {
        Self {
            loaded: AtomicU64::new(0),
            total: AtomicU64::new(total.unwrap_or(UNKNOWN_TOTAL)),
            cancelled: AtomicBool::new(false),
            cancel_notify: Notify::new(),
            picked: OnceLock::new(),
        }
    }

    pub fn set_total(&self, total: Option<u64>) {
        self.total
            .store(total.unwrap_or(UNKNOWN_TOTAL), Ordering::Relaxed);
    }

    /// Record an upload's selection for the status. `first_name` is the first
    /// file's base name and never a path: the chosen paths stay in this
    /// process. A selection is recorded once; a later call changes nothing.
    pub fn set_picked(&self, first_name: &str, count: usize) {
        let _ = self.picked.set(PickedFiles {
            name: first_name.chars().take(PICKED_NAME_MAX_CHARS).collect(),
            count: count as u64,
        });
    }

    /// The selection `set_picked` recorded, or none before it ran.
    pub fn picked(&self) -> Option<PickedFiles> {
        self.picked.get().cloned()
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
    /// An upload's selection, from the moment the upload records it. The
    /// payload has no such field before that, or for a download.
    #[serde(skip_serializing_if = "Option::is_none")]
    picked: Option<PickedFiles>,
}

#[tauri::command]
pub fn native_transfer_status(transfer_id: String) -> Option<NativeTransferStatus> {
    let transfers = registry().lock().ok()?;
    let progress = transfers.get(&transfer_id)?;
    let total = progress.total.load(Ordering::Relaxed);
    Some(NativeTransferStatus {
        loaded: progress.loaded.load(Ordering::Relaxed),
        total: (total != UNKNOWN_TOTAL).then_some(total),
        picked: progress.picked(),
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

/// A same-origin file API URL and the workspace prefix checked against its window.
pub struct ValidatedEndpoint {
    url: Url,
    workspace_prefix: String,
}

impl ValidatedEndpoint {
    pub fn url(&self) -> &Url {
        &self.url
    }
}

pub fn validated_endpoint(
    current: &Url,
    requested: &str,
    kind: EndpointKind,
) -> Result<ValidatedEndpoint, String> {
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
            path.strip_prefix("/api/fs/")
                .is_some_and(|file_path| !file_path.is_empty())
                && endpoint
                    .query_pairs()
                    .any(|(key, value)| key == "download" && matches!(value.as_ref(), "1" | "true"))
        }
        EndpointKind::Upload => matches!(path, "/api/fs/upload"),
    };
    if !expected {
        return Err("native transfer URL is not the expected file API route".into());
    }
    Ok(ValidatedEndpoint {
        url: endpoint,
        workspace_prefix: prefix.to_string(),
    })
}

pub fn endpoint_for_window(
    window: &WebviewWindow,
    requested: &str,
    kind: EndpointKind,
) -> Result<ValidatedEndpoint, String> {
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
/// the server.
///
/// What that fallback is worth depends on the direction and the tenant, and
/// this process cannot tell them apart: both tenants serve `/api/fs/...`,
/// so the URL does not say which will answer. An upload is refused by the
/// server on either tenant, and a terminal download is refused by the ceiling
/// on its route, so for those the unreadable ceiling costs the client-side
/// fail-fast and nothing else. A workspace download is bounded by no server
/// ceiling, so there the check in [`crate::download`] is the only cap in the
/// path and [`TransferCap::Unknown`] removes it rather than deferring it.
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
pub fn config_url_for_transfer(endpoint: &ValidatedEndpoint) -> Url {
    let token = endpoint
        .url
        .query_pairs()
        .find(|(key, _)| key == "t")
        .map(|(_, value)| value.into_owned());
    let mut config = endpoint.url.clone();
    config.set_path(&format!("{}/api/config", endpoint.workspace_prefix));
    config.set_query(None);
    if let Some(token) = token {
        config.query_pairs_mut().append_pair("t", &token);
    }
    config
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
    endpoint: &ValidatedEndpoint,
    headers: HeaderMap,
) -> TransferCap {
    let url = config_url_for_transfer(endpoint);
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
    crate::wireguard::client_builder()
        .and_then(|builder| {
            builder
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|error| error.to_string())
        })
        .map_err(|error| format!("building native transfer client: {error}"))
}

/// A transfer request's error as the page may show and keep it: what failed,
/// down to the cause the system gave, without the request URL. The page builds
/// that URL, and on the loopback surface it carries the tenant's bearer token
/// in its `t` query, while reqwest's own Display names the URL and stops
/// before the cause.
pub fn reason_without_url(error: reqwest::Error) -> String {
    let error = error.without_url();
    let mut reason = error.to_string();
    let mut cause = std::error::Error::source(&error);
    while let Some(next) = cause {
        reason.push_str(": ");
        reason.push_str(&next.to_string());
        cause = next.source();
    }
    reason
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A send that fails, here to a port nothing listens on, is reported by
    /// what failed and why, and neither the URL nor the token the page put in
    /// its query reaches the reason.
    #[tokio::test]
    async fn a_failed_send_names_its_cause_and_not_the_url_or_its_token() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let url = format!("http://127.0.0.1:{port}/api/files/upload?t=secret-token");
        let error = http_client()
            .unwrap()
            .post(&url)
            .send()
            .await
            .expect_err("nothing listens on the port");
        assert!(error.is_connect(), "{error:?}");
        let reason = reason_without_url(error);
        for leaked in ["secret-token", "t=", "/api/files/upload", url.as_str()] {
            assert!(!reason.contains(leaked), "{leaked:?} in {reason:?}");
        }
        assert!(
            reason.to_lowercase().contains("refused"),
            "the reason says the connection was refused: {reason:?}"
        );
    }

    #[test]
    fn transfer_endpoints_are_same_origin_and_exact_route_shapes() {
        let current = Url::parse("https://alice.example/prefix/?w=1").unwrap();
        assert!(validated_endpoint(
            &current,
            "https://alice.example/prefix/api/fs/a.md?download=1&t=x",
            EndpointKind::Download,
        )
        .is_ok());
        assert!(validated_endpoint(
            &current,
            "https://alice.example/prefix/api/fs/upload?t=x",
            EndpointKind::Upload,
        )
        .is_ok());
        // The former `/api/files` compatibility alias must stay refused.
        assert!(validated_endpoint(
            &current,
            "https://alice.example/prefix/api/files/a.md?download=1&t=x",
            EndpointKind::Download,
        )
        .is_err());
        assert!(validated_endpoint(
            &current,
            "https://alice.example/prefix/api/files/upload?t=x",
            EndpointKind::Upload,
        )
        .is_err());
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
        let current = Url::parse("https://alice.example/prefix/").unwrap();
        let endpoint = validated_endpoint(
            &current,
            "https://alice.example/prefix/api/fs/a.md?download=1&t=secret",
            EndpointKind::Download,
        )
        .unwrap();
        let config = config_url_for_transfer(&endpoint);
        assert_eq!(
            config.as_str(),
            "https://alice.example/prefix/api/config?t=secret"
        );

        let upload = validated_endpoint(
            &Url::parse("http://127.0.0.1:4090/").unwrap(),
            "http://127.0.0.1:4090/api/fs/upload?t=tok",
            EndpointKind::Upload,
        )
        .unwrap();
        assert_eq!(
            config_url_for_transfer(&upload).as_str(),
            "http://127.0.0.1:4090/api/config?t=tok"
        );

        // No token to carry means no query at all, not an empty one.
        let bare = validated_endpoint(
            &current,
            "https://alice.example/prefix/api/fs/a.md?download=1",
            EndpointKind::Download,
        )
        .unwrap();
        assert_eq!(
            config_url_for_transfer(&bare).as_str(),
            "https://alice.example/prefix/api/config"
        );

        // The former `/api/files` compatibility alias must stay refused.
        assert!(validated_endpoint(
            &current,
            "https://alice.example/prefix/api/files/a.md?download=1",
            EndpointKind::Download,
        )
        .is_err());

        assert!(validated_endpoint(
            &current,
            "https://alice.example/nope",
            EndpointKind::Download
        )
        .is_err());
    }

    #[test]
    fn native_transfer_cap_config_url_ignores_file_api_segments() {
        let cases = [
            (
                "https://alice.example/prefix/",
                "https://alice.example/prefix/api/fs/docs/api/fs/notes.md?download=1&t=secret&extra=1",
                "https://alice.example/prefix/api/config?t=secret",
            ),
            (
                "http://127.0.0.1:4090/",
                "http://127.0.0.1:4090/api/fs/mirror/api/fstab?download=1&t=tok",
                "http://127.0.0.1:4090/api/config?t=tok",
            ),
            (
                "https://alice.example/api/fs/index.html?w=1",
                "https://alice.example/api/fs/api/fs/a.md?download=true&t=a%26b&extra=1",
                "https://alice.example/api/fs/api/config?t=a%26b",
            ),
        ];
        let mut failures = Vec::new();
        for (current, requested, expected) in cases {
            let endpoint = validated_endpoint(
                &Url::parse(current).unwrap(),
                requested,
                EndpointKind::Download,
            )
            .unwrap();
            let actual = config_url_for_transfer(&endpoint);
            if actual.as_str() != expected {
                failures.push(format!("{requested}: expected {expected}, got {actual}"));
            }
        }
        assert!(failures.is_empty(), "wrong config URLs: {failures:?}");
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

    /// The status as the page reads it over IPC.
    fn status_payload(id: &str) -> serde_json::Value {
        serde_json::to_value(native_transfer_status(id.into()).expect("a live transfer")).unwrap()
    }

    /// The page names an upload's row from the status, so the status says
    /// nothing of a selection until the upload records one, and from then on
    /// carries the first file's name and the count.
    #[test]
    fn transfer_status_names_a_selection_only_once_it_is_recorded() {
        let registration = TransferRegistration::new("native-picked".into(), None).unwrap();
        assert_eq!(
            status_payload("native-picked"),
            serde_json::json!({ "loaded": 0, "total": null }),
            "nothing is picked yet, so the payload has no selection at all"
        );

        registration.progress.set_picked("report.pdf", 3);
        assert_eq!(
            status_payload("native-picked"),
            serde_json::json!({
                "loaded": 0,
                "total": null,
                "picked": { "name": "report.pdf", "count": 3 },
            }),
        );

        // The selection is the picker's one answer, so it is not replaced.
        registration.progress.set_picked("other.bin", 1);
        assert_eq!(
            status_payload("native-picked")["picked"],
            serde_json::json!({ "name": "report.pdf", "count": 3 }),
        );
    }

    /// The boundary of the name a status carries: a name of exactly the
    /// limit is whole, one character over is cut, and the cut falls between
    /// characters. The count is one number however many files were picked,
    /// so a poll's payload stays small for any selection.
    #[test]
    fn transfer_status_bounds_the_picked_name_and_carries_one_count() {
        let exact = "x".repeat(PICKED_NAME_MAX_CHARS);
        let registration = TransferRegistration::new("native-picked-exact".into(), None).unwrap();
        registration.progress.set_picked(&exact, 1);
        assert_eq!(
            status_payload("native-picked-exact")["picked"]["name"],
            serde_json::json!(exact),
            "a name at the limit is not cut"
        );

        // A two-byte character, so a cut counted in bytes would split one.
        let over = "\u{e9}".repeat(PICKED_NAME_MAX_CHARS + 1);
        let registration = TransferRegistration::new("native-picked-over".into(), None).unwrap();
        registration.progress.set_picked(&over, 250_000);
        let payload = status_payload("native-picked-over");
        assert_eq!(
            payload["picked"]["name"],
            serde_json::json!("\u{e9}".repeat(PICKED_NAME_MAX_CHARS)),
            "one character over the limit is cut to the limit"
        );
        assert_eq!(payload["picked"]["count"], serde_json::json!(250_000));
        let sent = serde_json::to_string(&payload).unwrap().len();
        assert!(
            sent <= PICKED_NAME_MAX_CHARS * 4 + 128,
            "a poll of a large selection stays small: {sent} bytes"
        );
    }
}
