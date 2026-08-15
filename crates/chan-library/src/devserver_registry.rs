//! The launcher's devserver registry boundary.
//!
//! The launcher lists and mutates the user's configured devservers, but the
//! devserver set lives in chan-desktop's config (`desktop/src-tauri/src/config.rs`),
//! which sits ABOVE chan-server in the dependency graph and is invisible from
//! here. Mirroring the [`WorkspaceOverlay`](crate::WorkspaceOverlay) inversion,
//! [`WorkspaceHost`](crate::WorkspaceHost) holds an optional
//! `Arc<dyn DevserverRegistry>` the embedder installs; the launcher routes read
//! it at request time. chan-desktop implements the trait over its config vec;
//! the headless devserver and plain `chan open` install none, so the accessor
//! returns `None` and the routes serve an empty list and 404 mutation.
//!
//! The trait lives in chan-library because `WorkspaceHost` -- which holds the
//! handle -- is a chan-library type, and the crate dependency only flows
//! chan-server -> chan-library, not the reverse. chan-server re-exports these so
//! its routes name them as `chan_server::Devserver*`.
//!
//! Errors are plain `String`s: the only consumer is the route layer, which turns
//! them straight into HTTP bodies, so threading a rich error enum across the
//! chan-library / chan-server / chan-desktop boundary buys nothing.

use serde::{Deserialize, Serialize};

/// A devserver's live connection state, as the launcher renders it. Replaces a
/// bare `connected` bool so the launcher can show a connect spinner
/// (`connecting`) and clear it the instant the tunnel drops (`disconnected`),
/// driving the UI off real state rather than an optimistic timer. Volatile
/// runtime state populated by chan-desktop from its connection map; a
/// headless/registry-less surface tracks no connections and reports
/// `disconnected`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum DevserverStatus {
    /// No live connection: registered but offline, or the tunnel/control script
    /// dropped. The launcher shows Connect, no spinner, Edit enabled.
    #[default]
    Disconnected,
    /// A connect is in flight (dial / tunnel handshake not yet complete). The
    /// launcher shows a spinner and disables Connect/Disconnect.
    Connecting,
    /// The desktop holds a live connection. The launcher shows Disconnect and
    /// gates Edit read-only.
    Connected,
    /// The connection record still exists, but this devserver's window/color
    /// feed sockets are down (N consecutive reconnect failures) -- the half-open
    /// zombie a laptop sleep leaves behind, where the 5s workspace poll's fresh
    /// dials still succeed so `Connected` would lie. The launcher maps this to
    /// the connection-lost (red) dot; the desktop clears it on feed recovery.
    Unreachable,
}

/// One configured devserver, as the launcher lists it. The token is WRITE-ONLY:
/// accepted on add/update, never serialized back -- [`has_token`](Self::has_token)
/// reports its presence instead.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DevserverEntry {
    /// Stable registry id used for row actions and the connection-state map.
    pub id: String,
    /// Full configured endpoint URL, including scheme. Raw local devservers use
    /// `http://host:port`; gateway devservers use the public identity origin.
    #[serde(default)]
    pub url: String,
    /// The devserver host the desktop dials: hostname or IP, no scheme or port
    /// (`box.example.com`). The desktop forms the dial / tenant URL from `host` +
    /// `port` (`http://{host}:{port}{prefix}...`).
    pub host: String,
    /// The devserver port the desktop dials.
    pub port: u16,
    /// Optional user label for the launcher section header; empty means derive
    /// the label from the URL host.
    pub label: String,
    /// Optional connect script (e.g. an `ssh -L` tunnel) the desktop runs before
    /// the dial.
    pub script: String,
    /// Whether a bearer token is stored for this devserver. The value itself is
    /// never echoed back over the wire.
    pub has_token: bool,
    /// Auto-hide the connect CONTROL terminal once the devserver connects: when
    /// set, the desktop's connect flow buries the control-terminal window on
    /// success instead of leaving it open. Set from the add/edit dialog.
    /// `#[serde(default)]`: a row without the field reads `false`.
    #[serde(default)]
    pub auto_hide_control: bool,
    /// The library id this devserver is assigned once known, joining its window
    /// rows in the feed to the user's name for it. `None` before the devserver's
    /// first connect, when no library id exists yet.
    pub library_id: Option<String>,
    /// This devserver's live connection state. Volatile runtime state populated
    /// by chan-desktop from its connection map; `disconnected` on a
    /// headless/registry-less surface that tracks no connections. The launcher
    /// reads it to show Connect vs Disconnect, drive the connect spinner, and
    /// gate Edit read-only while connected/connecting. `#[serde(default)]`: a
    /// row without the field reads `disconnected`.
    #[serde(default)]
    pub status: DevserverStatus,
    /// Whether a browser sign-in is holding this row. Sign-in waits are
    /// gateway-level (a gateway's `pending_signin` rides its own entry), so
    /// devserver rows always report `false` today; the key stays on the
    /// wire so the launcher parses it unconditionally. `#[serde(default)]`:
    /// a row without the field reads `false`.
    #[serde(default)]
    pub pending_signin: bool,
    /// The devserver host's OS family (`macos | windows | linux | other`),
    /// learned from its `DevserverInfo` self-report at connect and cached in the
    /// live feed (survives disconnect). Empty before the first connect or from a
    /// devserver too old to report it; the launcher shows no icon then. A
    /// non-empty unrecognized value shows the neutral monitor mark.
    /// `#[serde(default)]`: a row without the field reads empty.
    #[serde(default)]
    pub os: String,
    /// Best-effort human OS string for the launcher tooltip (e.g. a linux
    /// `/etc/os-release` `PRETTY_NAME`); serialized as `null` when unknown
    /// (uniform with `library_id`, so the launcher wire always carries the key).
    #[serde(default)]
    pub pretty_name: Option<String>,
    /// The id of the gateway this row was synthesized from (`gw-<8hex>`), or
    /// `None` for a plain configured row. The launcher gates row editing off
    /// this: synthesized rows come and go with the gateway's roster and carry
    /// no local config to edit. `#[serde(default)]`: a row without the field
    /// reads `None`; the key always serializes (no skip), so the TypeScript
    /// mirror never needs optional-key handling.
    #[serde(default)]
    pub gateway_id: Option<String>,
    /// The owning gateway's public identity origin for the launcher's
    /// "via <gateway>" note; empty for plain rows. `#[serde(default)]`: a row
    /// without the field reads empty.
    #[serde(default)]
    pub gateway_url: String,
    /// Whether this row is a devserver SHARED with the user (roster role is
    /// not `owner`) rather than one the user owns; always `false` for plain
    /// rows. `#[serde(default)]`: a row without the field reads `false`.
    #[serde(default)]
    pub shared: bool,
    /// Whether this shared gateway row still needs explicit consent before the
    /// desktop grants its exact web origin native IPC. Always `false` for plain
    /// and owned rows. `#[serde(default)]` keeps older producers readable while
    /// the key always serializes for the launcher's required wire mirror.
    #[serde(default)]
    pub native_trust_required: bool,
}

/// The add/update payload. `host` + `port` are required; the rest are optional.
/// `token` is write-only -- `Some` sets/replaces it; `None` on an update keeps
/// the stored one unless `clear_token` is true. (No `color`: a devserver's
/// pane-highlight colour is set from the focus-border menu and persisted per
/// chan-library, not via this dialog.)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct DevserverInput {
    /// Full endpoint URL. When empty, consumers may derive it from `host` +
    /// `port` for the raw local-devserver path.
    #[serde(default)]
    pub url: Option<String>,
    /// The devserver host (hostname or IP, no scheme or port). Required; the
    /// registry validates it is non-empty.
    pub host: String,
    /// The devserver port. Required.
    pub port: u16,
    /// Optional user label; `None`/empty derives from the host.
    #[serde(default)]
    pub label: Option<String>,
    /// Optional connect script.
    #[serde(default)]
    pub script: Option<String>,
    /// Optional bearer token (write-only). `None` on update keeps the stored one.
    #[serde(default)]
    pub token: Option<String>,
    /// Clear the stored bearer token on update. Ignored on add and overridden by
    /// a non-empty `token`, so pasting a replacement URL wins over the checkbox.
    #[serde(default)]
    pub clear_token: bool,
    /// Auto-hide the connect control terminal on a successful connect (the
    /// dialog's checkbox). `#[serde(default)]`: an absent field reads `false`.
    #[serde(default)]
    pub auto_hide_control: bool,
}

/// The launcher's devserver CRUD, inverted so chan-library (and chan-server's
/// routes) reach the desktop config without depending on it. The embedder
/// (chan-desktop) implements it over its persisted `Devserver` vec, persisting on
/// mutate; the headless surfaces install none.
///
/// "Not found" is signalled out-of-band (`Ok(None)` / `Ok(false)`) so the route
/// layer maps it to 404, reserving `Err` for real failures (a bad URL the
/// registry rejects, a persist error).
pub trait DevserverRegistry: Send + Sync {
    /// Every configured devserver, tokens elided. Infallible (mirrors the window
    /// feed): a backing-store read error surfaces as an empty list, not a 500.
    fn list(&self) -> Vec<DevserverEntry>;
    /// Add a devserver, returning the stored row with its assigned id.
    fn add(&self, input: DevserverInput) -> Result<DevserverEntry, String>;
    /// Edit a devserver in place; a blank `token` keeps the stored one unless
    /// `clear_token` is true. Returns the updated row, or `Ok(None)` when no
    /// devserver has `id`.
    fn update(&self, id: &str, input: DevserverInput) -> Result<Option<DevserverEntry>, String>;
    /// Remove a devserver; `Ok(false)` when no devserver has `id`.
    fn remove(&self, id: &str) -> Result<bool, String>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_serde_lowercase_with_unreachable_and_default() {
        // Contract E: the new variant rides the lowercase wire `"unreachable"`,
        // round-tripping both ways.
        assert_eq!(
            serde_json::to_string(&DevserverStatus::Unreachable).unwrap(),
            "\"unreachable\""
        );
        assert_eq!(
            serde_json::from_str::<DevserverStatus>("\"unreachable\"").unwrap(),
            DevserverStatus::Unreachable
        );
        // The default stays Disconnected, so a devserver row without a `status`
        // field (an older desktop's config) deserializes as disconnected.
        assert_eq!(DevserverStatus::default(), DevserverStatus::Disconnected);
        // The pre-existing variants keep their wire spelling unchanged.
        assert_eq!(
            serde_json::to_string(&DevserverStatus::Connected).unwrap(),
            "\"connected\""
        );
    }

    #[test]
    fn gateway_fields_default_and_always_serialize() {
        // A row serialized before the gateway fields existed deserializes
        // with their defaults, so older desktop configs and older wire
        // producers keep parsing.
        let legacy = "{\"id\":\"ds1\",\"url\":\"http://box:8787\",\"host\":\"box\",\
                      \"port\":8787,\"label\":\"\",\"script\":\"\",\"has_token\":false,\
                      \"library_id\":null}";
        let entry: DevserverEntry = serde_json::from_str(legacy).unwrap();
        assert_eq!(entry.gateway_id, None);
        assert_eq!(entry.gateway_url, "");
        assert!(!entry.shared);
        assert!(!entry.native_trust_required);
        // And the keys always ride the wire (no skip_serializing_if), so the
        // launcher's TypeScript mirror reads them unconditionally.
        let wire = serde_json::to_value(&entry).unwrap();
        let obj = wire.as_object().unwrap();
        assert_eq!(obj.get("gateway_id"), Some(&serde_json::Value::Null));
        assert_eq!(obj.get("gateway_url"), Some(&serde_json::json!("")));
        assert_eq!(obj.get("shared"), Some(&serde_json::json!(false)));
        assert_eq!(
            obj.get("native_trust_required"),
            Some(&serde_json::json!(false))
        );
    }
}
