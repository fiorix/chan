//! The launcher's gateway registry boundary.
//!
//! The launcher lists and mutates the user's configured gateways, but the
//! gateway set lives in chan-desktop's config (`desktop/src-tauri/src/config.rs`),
//! which sits ABOVE chan-server in the dependency graph and is invisible from
//! here. Mirroring the [`DevserverRegistry`](crate::DevserverRegistry)
//! inversion, [`WorkspaceHost`](crate::WorkspaceHost) holds an optional
//! `Arc<dyn GatewayRegistry>` the embedder installs; the launcher routes read
//! it at request time. chan-desktop implements the trait over its config vec;
//! the headless devserver and plain `chan open` install none, so the accessor
//! returns `None` and the routes serve an empty list and 404 mutation.
//!
//! Connect/disconnect are NOT registry methods: like devserver connect, they
//! operate the desktop's live connection state and ride the desktop window-ops
//! bridge, answering the plain-text NO_DESKTOP 409 on bridge-less surfaces.
//!
//! The launcher SPA's TypeScript (`web/packages/launcher/src/api/library.ts`)
//! mirrors these serde shapes exactly; a field change here must flow to that
//! mirror in the same round of edits.
//!
//! Errors are plain `String`s: the only consumer is the route layer, which
//! turns them straight into HTTP bodies, so threading a rich error enum across
//! the chan-library / chan-server / chan-desktop boundary buys nothing.

use serde::{Deserialize, Serialize};

/// A gateway's live connection state, as the launcher renders it. Volatile
/// runtime state populated by chan-desktop from its gateway manager; a
/// headless/registry-less surface tracks no connections and reports
/// `disconnected`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum GatewayStatus {
    /// No live connection: configured but not connected. The launcher shows
    /// Connect on the badge.
    #[default]
    Disconnected,
    /// A connect is in flight (discovery / sign-in / first roster fetch not
    /// yet complete). The launcher shows a spinner and disables the buttons.
    Connecting,
    /// The desktop holds a live roster poll for this gateway. The launcher
    /// shows Disconnect.
    Connected,
    /// The desktop keeps retrying but the gateway has failed N consecutive
    /// roster polls; the last-known devserver rows stay served. The launcher
    /// maps this to the connection-lost (red) dot.
    Unreachable,
}

/// One configured gateway, as the launcher lists it. Every key is always
/// present on the wire (`last_error` serializes as `null` when clear), so the
/// TypeScript mirror never needs optional-key handling.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GatewayEntry {
    /// Stable registry id (`gw-<8hex>`, desktop-minted) used for row actions
    /// and as the gateway segment of synthesized devserver row ids.
    pub id: String,
    /// The gateway's public identity origin as the user entered it
    /// (e.g. `https://gw.chan.app`).
    pub url: String,
    /// Optional user label for the badge; empty means derive the label from
    /// the URL host.
    pub label: String,
    /// Persisted connect intent: the desktop auto-connects enabled gateways
    /// at startup. Connect persists `true`, disconnect persists `false`.
    pub enabled: bool,
    /// This gateway's live connection state. Volatile runtime state populated
    /// by chan-desktop; `disconnected` on a headless/registry-less surface.
    #[serde(default)]
    pub status: GatewayStatus,
    /// A sign-in for this gateway is waiting on the user's browser: the
    /// desktop opened the identity page and holds the connect until the deep
    /// link returns, the wait times out, or the user re-clicks Connect. The
    /// launcher renders a waiting spinner off this. Volatile runtime state;
    /// always `false` on a headless/registry-less surface.
    #[serde(default)]
    pub pending_signin: bool,
    /// How many devserver rows this gateway's roster currently contributes to
    /// the launcher list (owned + shared). Zero while disconnected.
    #[serde(default)]
    pub devserver_count: usize,
    /// The last connect/poll failure, human-readable, for the badge tooltip;
    /// `null` when the gateway is healthy or has never been dialed.
    #[serde(default)]
    pub last_error: Option<String>,
}

/// The add/update payload. `url` is required on add; on update the URL is
/// the gateway's identity and stays immutable (changing the origin is a
/// remove + re-add), so the registry only checks it against the stored row.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct GatewayInput {
    /// The gateway's public identity origin, scheme included. The registry
    /// validates and normalizes it on add; on update it must match the
    /// stored origin (empty means keep).
    pub url: String,
    /// Optional user label; `None`/empty derives from the URL host.
    #[serde(default)]
    pub label: Option<String>,
}

/// The launcher's gateway CRUD, inverted so chan-library (and chan-server's
/// routes) reach the desktop config without depending on it. The embedder
/// (chan-desktop) implements it over its persisted `Gateway` vec, persisting
/// on mutate; the headless surfaces install none.
///
/// "Not found" is signalled out-of-band (`Ok(false)`) so the route layer maps
/// it to 404, reserving `Err` for real failures (a bad URL the registry
/// rejects, a persist error).
pub trait GatewayRegistry: Send + Sync {
    /// Every configured gateway. Infallible (mirrors the devserver list): a
    /// backing-store read error surfaces as an empty list, not a 500.
    fn list(&self) -> Vec<GatewayEntry>;
    /// Add a gateway, returning the stored row with its assigned id. Adding
    /// never probes the URL; a wrong one surfaces on first connect.
    fn add(&self, input: GatewayInput) -> Result<GatewayEntry, String>;
    /// Rename a gateway in place: `label` is full-replace (`None`/empty
    /// clears, deriving the badge from the URL host). The URL is the
    /// gateway's identity and stays immutable: a non-empty `url` naming a
    /// different origin is rejected (remove + re-add is the origin-change
    /// path). Returns the updated row, or `Ok(None)` when no gateway has
    /// `id`.
    fn update(&self, id: &str, input: GatewayInput) -> Result<Option<GatewayEntry>, String>;
    /// Remove a gateway; `Ok(false)` when no gateway has `id`. Removal
    /// cascades on the desktop side (live connections torn down, roster rows
    /// dropped); the stored keyring PAT is kept for a later re-add.
    fn remove(&self, id: &str) -> Result<bool, String>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_wire_shape_is_pinned() {
        // The launcher's TypeScript mirror parses exactly this shape; every
        // key is present, `last_error` rides as null when clear.
        let entry = GatewayEntry {
            id: "gw-1a2b3c4d".into(),
            url: "https://gw.chan.app".into(),
            label: String::new(),
            enabled: true,
            status: GatewayStatus::Disconnected,
            pending_signin: false,
            devserver_count: 3,
            last_error: None,
        };
        assert_eq!(
            serde_json::to_string(&entry).unwrap(),
            "{\"id\":\"gw-1a2b3c4d\",\"url\":\"https://gw.chan.app\",\"label\":\"\",\
             \"enabled\":true,\"status\":\"disconnected\",\"pending_signin\":false,\
             \"devserver_count\":3,\"last_error\":null}"
        );
        // And the shape round-trips.
        let back: GatewayEntry =
            serde_json::from_str(&serde_json::to_string(&entry).unwrap()).unwrap();
        assert_eq!(back, entry);
    }

    #[test]
    fn status_serde_lowercase_with_default() {
        assert_eq!(
            serde_json::to_string(&GatewayStatus::Unreachable).unwrap(),
            "\"unreachable\""
        );
        assert_eq!(
            serde_json::from_str::<GatewayStatus>("\"connecting\"").unwrap(),
            GatewayStatus::Connecting
        );
        assert_eq!(GatewayStatus::default(), GatewayStatus::Disconnected);
    }

    #[test]
    fn input_label_is_optional() {
        // The launcher's add form posts url-only when the label is untouched.
        let input: GatewayInput =
            serde_json::from_str("{\"url\":\"https://gw.chan.app\"}").unwrap();
        assert_eq!(input.url, "https://gw.chan.app");
        assert_eq!(input.label, None);
        // An explicit empty label stays distinguishable from an absent one.
        let input: GatewayInput =
            serde_json::from_str("{\"url\":\"https://gw.chan.app\",\"label\":\"\"}").unwrap();
        assert_eq!(input.label, Some(String::new()));
    }
}
