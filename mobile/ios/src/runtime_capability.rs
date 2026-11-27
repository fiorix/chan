//! Runtime-minted IPC grants for authenticated gateway devserver origins on iOS.
//!
//! A grant is minted only after the gateway entry endpoint authorizes one
//! explicit roster target. Its `remote.urls` contains that response's validated
//! canonical exact origin, never a discovery-apex wildcard. Official and
//! self-hosted gateways use the same path.
//!
//! Rules the mint must never break, each pinned by a test below:
//!
//! - NO scoped permissions: runtime scope ids collide with build-time ids.
//! - NO deny entries: deny entries are origin-blind in Tauri's `resolve_access`
//!   (the origin-match result of a denied command is discarded), so any deny
//!   entry would kill the command on every origin.
//! - Once per exact origin and process: re-adding a capability accumulates
//!   duplicate resolved-command entries; duplicates are harmless to resolution
//!   but grow the authority without bound. There is no `remove_capability`, so
//!   a removed gateway's runtime ACL entry persists until the app restarts while
//!   `gateway_csrf_token` independently checks live connection state.
//! - The minted JSON must parse and every permission must resolve:
//!   `add_capability`'s string form panics on malformed JSON and on permissions
//!   missing from the build-time ACL manifests. [`mint_exact_origin_grant`]
//!   parses as a guard before handing the string over, and the tests pin
//!   resolution against the real `tauri::generate_context!()`.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use tauri::utils::acl::capability::CapabilityFile;
use tauri::Manager;

/// Canonicalize and validate the one exact origin a runtime capability may
/// carry. The entry validator already enforces the gateway namespace; this
/// guard keeps accidental wildcard, path, query, or userinfo inputs away from
/// `add_capability`.
pub(crate) fn exact_origin_remote_urls(exact_origin: &str) -> Result<Vec<String>, String> {
    let parsed = url::Url::parse(exact_origin).map_err(|e| format!("invalid exact origin: {e}"))?;
    let scheme = parsed.scheme();
    if !matches!(scheme, "http" | "https") {
        return Err(format!("exact origin {exact_origin:?} must be http(s)"));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| format!("exact origin {exact_origin:?} has no host"))?;
    if host.contains('*')
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(format!(
            "exact origin {exact_origin:?} must contain only scheme, host, and port"
        ));
    }
    Ok(vec![parsed.origin().ascii_serialization()])
}

/// Every app command the minted gateway grant carries on `"main"`.
/// `native_vocabulary` returns this list so a remotely served page knows what
/// this build provides before invoking a command.
pub(crate) const GATEWAY_WINDOW_COMMANDS: &[&str] = &[
    "abandon_devserver_for_window",
    "create_library_window",
    "focus_library_window",
    "gateway_csrf_token",
    "mobile_back_to_computers",
    "native_vocabulary",
    "open_new_window",
    "reconnect_devserver_for_window",
    "set_terminal_background_opacity",
    "show_computers_for_window",
    "terminal_background_opacity",
    "toggle_launcher_panel",
];

/// The capability JSON minted for one authenticated exact origin on the single
/// iOS webview (`"main"`). No scoped permissions and no deny entries.
pub(crate) fn exact_origin_capability_json(exact_origin: &str) -> Result<String, String> {
    let remote_urls = exact_origin_remote_urls(exact_origin)?;
    Ok(serde_json::json!({
        "identifier": "gateway-window",
        "description": "authenticated exact-origin grant for the main webview on a gateway tenant",
        "remote": { "urls": remote_urls },
        "windows": ["main"],
        "permissions": [
            "allow-abandon-devserver-for-window",
            "allow-create-library-window",
            "allow-focus-library-window",
            "allow-gateway-csrf-token",
            "allow-mobile-back-to-computers",
            "allow-native-vocabulary",
            "allow-open-new-window",
            "allow-reconnect-devserver-for-window",
            "allow-set-terminal-background-opacity",
            "allow-show-computers-for-window",
            "allow-terminal-background-opacity",
            "allow-toggle-launcher-panel",
            "core:event:allow-listen",
            "core:event:allow-unlisten",
            "opener:default",
            "opener:allow-open-url",
        ],
    })
    .to_string())
}

fn minted_origins() -> &'static Mutex<HashSet<String>> {
    static MINTED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    MINTED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Grant `"main"` on `exact_origin` its native IPC vocabulary once per process.
/// An already-open `"main"` webview gains the grant on its next invoke.
pub(crate) fn mint_exact_origin_grant<R: tauri::Runtime>(
    manager: &impl Manager<R>,
    exact_origin: &str,
) -> Result<bool, String> {
    let urls = exact_origin_remote_urls(exact_origin)?;
    // Poison-tolerant: an unwind inside add_capability must not wedge every
    // later mint into a panic on this lock; recovering a possibly-stale set
    // risks at most one duplicate re-mint, which resolution tolerates.
    let mut minted = minted_origins().lock().unwrap_or_else(|e| e.into_inner());
    if minted.contains(&urls[0]) {
        tracing::debug!(
            exact_origin = %urls[0],
            "gateway-window capability already minted for this origin"
        );
        return Ok(false);
    }
    let json = exact_origin_capability_json(&urls[0])?;
    // Parse first: the string form of add_capability panics on malformed JSON,
    // so guard with the fallible parse before handing the string over.
    json.parse::<CapabilityFile>()
        .map_err(|e| format!("minted capability does not parse: {e}"))?;
    manager
        .add_capability(json)
        .map_err(|e| format!("adding gateway capability: {e}"))?;
    let origin = urls.into_iter().next().expect("urls is non-empty");
    tracing::info!(
        exact_origin = %origin,
        "minted the gateway-window capability for main on this origin"
    );
    minted.insert(origin);
    Ok(true)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    const EXACT_ORIGIN: &str = "https://alice--0a1b2c3d4e5f.p1.proxy.chan.app";
    const GATEWAY_PAGE: &str =
        "https://alice--0a1b2c3d4e5f.p1.proxy.chan.app/api/notes-1a2b3c/index.html";
    const SIBLING_PAGE: &str = "https://bob--1a2b3c4d5e6f.p1.proxy.chan.app/";
    const LOOPBACK_PAGE: &str = "http://127.0.0.1:8471/";

    #[tauri::command]
    fn mobile_back_to_computers() -> &'static str {
        "stub-back"
    }

    #[tauri::command]
    fn gateway_csrf_token() -> &'static str {
        "stub-csrf"
    }

    #[tauri::command]
    fn terminal_background_opacity() -> &'static str {
        "stub-opacity"
    }

    #[tauri::command]
    fn set_terminal_background_opacity() -> &'static str {
        "stub-set-opacity"
    }

    #[tauri::command]
    fn native_vocabulary() -> &'static str {
        "stub-vocab"
    }

    #[tauri::command]
    fn focus_library_window() -> &'static str {
        "stub-focus"
    }

    #[tauri::command]
    fn create_library_window() -> &'static str {
        "stub-create"
    }

    #[tauri::command]
    fn open_new_window() -> &'static str {
        "stub-new-window"
    }

    #[tauri::command]
    fn toggle_launcher_panel() -> &'static str {
        "stub-toggle"
    }

    #[tauri::command]
    fn show_computers_for_window() -> &'static str {
        "stub-computers"
    }

    #[tauri::command]
    fn reconnect_devserver_for_window() -> &'static str {
        "stub-reconnect"
    }

    #[tauri::command]
    fn abandon_devserver_for_window() -> &'static str {
        "stub-abandon"
    }

    #[tauri::command]
    fn mobile_deliver_pending_show_card() -> &'static str {
        "stub-deliver-card"
    }

    pub(crate) fn mock_app_with_context_and_handler<F>(
        handler: F,
    ) -> tauri::App<tauri::test::MockRuntime>
    where
        F: Fn(tauri::ipc::Invoke<tauri::test::MockRuntime>) -> bool + Send + Sync + 'static,
    {
        mock_builder()
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_opener::init())
            .invoke_handler(handler)
            .build(tauri::generate_context!())
            .expect("mock app builds from the real chan-ios context")
    }

    pub(crate) fn mock_app_with_context() -> tauri::App<tauri::test::MockRuntime> {
        mock_app_with_context_and_handler(|_| false)
    }

    fn mock_ios_app() -> tauri::App<tauri::test::MockRuntime> {
        mock_app_with_context_and_handler(tauri::generate_handler![
            mobile_back_to_computers,
            gateway_csrf_token,
            terminal_background_opacity,
            set_terminal_background_opacity,
            native_vocabulary,
            focus_library_window,
            create_library_window,
            open_new_window,
            toggle_launcher_panel,
            show_computers_for_window,
            reconnect_devserver_for_window,
            abandon_devserver_for_window,
            mobile_deliver_pending_show_card,
        ])
    }

    fn window_at(
        app: &tauri::App<tauri::test::MockRuntime>,
        label: &str,
        url: &str,
    ) -> tauri::WebviewWindow<tauri::test::MockRuntime> {
        WebviewWindowBuilder::new(app, label, WebviewUrl::External(url.parse().unwrap()))
            .build()
            .expect("mock webview window")
    }

    fn invoke_from(
        webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
        url: &str,
        cmd: &str,
    ) -> Result<String, serde_json::Value> {
        get_ipc_response(
            webview,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: url.parse().unwrap(),
                body: InvokeBody::default(),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize::<String>().expect("string response"))
    }

    #[test]
    fn remote_urls_reject_wildcards_paths_queries_and_userinfo() {
        assert_eq!(
            exact_origin_remote_urls(EXACT_ORIGIN).unwrap(),
            vec![EXACT_ORIGIN.to_string()]
        );
        assert_eq!(
            exact_origin_remote_urls("https://alice--0a1b2c3d4e5f.p1.proxy.chan.app:443").unwrap(),
            vec![EXACT_ORIGIN.to_string()],
            "effective default ports canonicalize"
        );
        assert_eq!(
            exact_origin_remote_urls("http://127.0.0.1:7002").unwrap(),
            vec!["http://127.0.0.1:7002".to_string()],
        );
        for invalid in [
            "ftp://alice--0a1b2c3d4e5f.p1.proxy.chan.app",
            "not a url",
            "https://*.p1.proxy.chan.app",
            "https://user@alice--0a1b2c3d4e5f.p1.proxy.chan.app",
            "https://user:pass@alice--0a1b2c3d4e5f.p1.proxy.chan.app",
            "https://alice--0a1b2c3d4e5f.p1.proxy.chan.app/path",
            "https://alice--0a1b2c3d4e5f.p1.proxy.chan.app/?q=1",
            "https://alice--0a1b2c3d4e5f.p1.proxy.chan.app/#fragment",
        ] {
            assert!(
                exact_origin_remote_urls(invalid).is_err(),
                "{invalid} must be rejected"
            );
        }
    }

    #[test]
    fn exact_origin_capability_json_parses_and_targets_main() {
        let json = exact_origin_capability_json(EXACT_ORIGIN).unwrap();
        json.parse::<CapabilityFile>()
            .expect("minted JSON parses as a CapabilityFile");

        let parsed: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        assert_eq!(parsed["windows"], serde_json::json!(["main"]));
        assert_eq!(parsed["remote"]["urls"], serde_json::json!([EXACT_ORIGIN]),);
        let perms = parsed["permissions"].as_array().expect("permissions array");
        let names: Vec<&str> = perms
            .iter()
            .map(|entry| entry.as_str().expect("unscoped string permission"))
            .collect();
        assert_eq!(
            names,
            vec![
                "allow-abandon-devserver-for-window",
                "allow-create-library-window",
                "allow-focus-library-window",
                "allow-gateway-csrf-token",
                "allow-mobile-back-to-computers",
                "allow-native-vocabulary",
                "allow-open-new-window",
                "allow-reconnect-devserver-for-window",
                "allow-set-terminal-background-opacity",
                "allow-show-computers-for-window",
                "allow-terminal-background-opacity",
                "allow-toggle-launcher-panel",
                "core:event:allow-listen",
                "core:event:allow-unlisten",
                "opener:default",
                "opener:allow-open-url",
            ]
        );
    }

    #[test]
    fn gateway_window_commands_match_exact_origin_grant_app_toml_and_invoke_handler() {
        let json = exact_origin_capability_json(EXACT_ORIGIN).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        let mut granted_cmds: Vec<String> = parsed["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .filter_map(|perm| perm.strip_prefix("allow-"))
            .map(|cmd| cmd.replace('-', "_"))
            .collect();
        granted_cmds.sort();

        let mut advertised: Vec<String> = GATEWAY_WINDOW_COMMANDS
            .iter()
            .map(|c| (*c).to_string())
            .collect();
        advertised.sort();
        assert_eq!(granted_cmds, advertised);

        let app_toml: toml::Value =
            toml::from_str(include_str!("../permissions/app.toml")).expect("valid app.toml");
        let perms = app_toml["permission"].as_array().expect("permission array");
        let mut allowed_in_toml = HashSet::new();
        for perm in perms {
            if let Some(cmds) = perm
                .get("commands")
                .and_then(|c| c.get("allow"))
                .and_then(|a| a.as_array())
            {
                for cmd in cmds {
                    allowed_in_toml.insert(cmd.as_str().unwrap().to_string());
                }
            }
        }
        for cmd in GATEWAY_WINDOW_COMMANDS
            .iter()
            .copied()
            .chain(std::iter::once("mobile_deliver_pending_show_card"))
        {
            assert!(
                allowed_in_toml.contains(cmd),
                "{cmd} missing from permissions/app.toml"
            );
        }

        let lib_rs = include_str!("lib.rs");
        let handler = lib_rs
            .split_once("pub(crate) fn app_invoke_handler(")
            .expect("app_invoke_handler exists")
            .1
            .split_once("\n}\n")
            .expect("app_invoke_handler ends")
            .0;
        for cmd in GATEWAY_WINDOW_COMMANDS
            .iter()
            .copied()
            .chain(std::iter::once("mobile_deliver_pending_show_card"))
        {
            assert!(
                handler.contains(cmd),
                "{cmd} missing from app_invoke_handler()"
            );
        }
    }

    #[test]
    fn mint_exact_origin_grant_resolves_deduplicates_and_enforces_acl() {
        let app = mock_ios_app();
        let main = window_at(&app, "main", LOOPBACK_PAGE);
        let other = window_at(&app, "other", GATEWAY_PAGE);

        // Static ios.json allows loopback launcher commands on main, including
        // toggle_launcher_panel, native_vocabulary, and card delivery, while
        // keeping remote-only and gateway CSRF commands off loopback.
        for allowed in [
            "mobile_back_to_computers",
            "terminal_background_opacity",
            "set_terminal_background_opacity",
            "toggle_launcher_panel",
            "native_vocabulary",
            "mobile_deliver_pending_show_card",
        ] {
            assert!(
                invoke_from(&main, LOOPBACK_PAGE, allowed).is_ok(),
                "loopback origin must permit {allowed}"
            );
        }
        for denied in [
            "gateway_csrf_token",
            "focus_library_window",
            "create_library_window",
            "open_new_window",
            "show_computers_for_window",
            "reconnect_devserver_for_window",
            "abandon_devserver_for_window",
        ] {
            assert!(
                invoke_from(&main, LOOPBACK_PAGE, denied).is_err(),
                "loopback origin must not hold {denied}"
            );
        }

        // Before minting, main on the gateway origin is denied all IPC commands.
        for cmd in GATEWAY_WINDOW_COMMANDS {
            assert!(
                invoke_from(&main, GATEWAY_PAGE, cmd).is_err(),
                "unminted remote origin must deny {cmd}"
            );
        }

        assert_eq!(
            mint_exact_origin_grant(&app, EXACT_ORIGIN),
            Ok(true),
            "first mint installs the exact-origin capability"
        );
        assert_eq!(
            mint_exact_origin_grant(&app, EXACT_ORIGIN),
            Ok(false),
            "repeat mint for the same canonical origin deduplicates"
        );
        assert_eq!(
            mint_exact_origin_grant(&app, "https://alice--0a1b2c3d4e5f.p1.proxy.chan.app:443"),
            Ok(false),
            "canonicalized equivalent origin also deduplicates"
        );

        // Already-open main gains every GATEWAY_WINDOW_COMMANDS entry on the
        // minted exact origin, while loopback-only card delivery stays denied.
        for cmd in GATEWAY_WINDOW_COMMANDS {
            assert!(
                invoke_from(&main, GATEWAY_PAGE, cmd).is_ok(),
                "minted exact origin must permit {cmd}"
            );
        }
        assert!(
            invoke_from(&main, GATEWAY_PAGE, "mobile_deliver_pending_show_card").is_err(),
            "remote origin must never hold loopback-only card delivery"
        );

        // Sibling origin and non-main labels stay denied for every command.
        for cmd in GATEWAY_WINDOW_COMMANDS {
            assert!(
                invoke_from(&main, SIBLING_PAGE, cmd).is_err(),
                "sibling gateway tenant origin must stay denied for {cmd}"
            );
            assert!(
                invoke_from(&other, GATEWAY_PAGE, cmd).is_err(),
                "non-main window label must stay denied for {cmd}"
            );
        }
    }
}
