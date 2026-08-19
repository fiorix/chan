//! Runtime-minted IPC grants for authenticated gateway devserver windows.
//!
//! A grant is minted only after the gateway entry endpoint authorizes one
//! explicit roster target. Its `remote.urls` contains that response's validated
//! canonical exact origin, never a discovery-apex wildcard. Official and
//! self-hosted gateways use the same path.
//!
//! Rules the mint must never break, each pinned by a test below:
//!
//! - NO scoped permissions: runtime scope ids collide with build-time ids.
//! - NO deny entries: deny entries are ORIGIN-BLIND in tauri's
//!   `resolve_access` (the origin-match result of a denied command is
//!   discarded), so any deny entry would kill the command on EVERY origin.
//! - Once per exact origin and process: re-adding a capability ACCUMULATES duplicate
//!   resolved-command entries (no dedup on the identifier); duplicates are
//!   harmless to resolution but grow the authority without bound. There is
//!   no remove_capability: a removed gateway's grant persists until the
//!   app restarts. Revocation therefore closes managed windows immediately but
//!   a hard ACL purge requires quitting Chan Desktop.
//! - The minted JSON must parse and every permission must resolve:
//!   `add_capability`'s string form PANICS on malformed JSON
//!   (`RuntimeCapability::build` expect) and on permissions missing from
//!   the build-time ACL manifests (`Resolved::resolve` unwrap), aborting
//!   the app. [`mint_exact_origin_grant`] parses as a guard before handing the
//!   string over, and the pins keep the resolution path green.
//!
//! The tests drive the production `on_message` dispatch through the mock
//! runtime against the app's real generated ACL context: IPC access is
//! resolved against the shared `RuntimeAuthority` on every invoke, never
//! snapshotted per window, so a `lib-*` window that is ALREADY OPEN when
//! the capability is added gains the grant on its next invoke. What unit
//! tests cannot prove on a headless host - a real OS webview delivering an
//! invoke from a remote https page - is covered by the desktop hand-smoke;
//! native-shell smoke covers the real WebView delivery path.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use tauri::utils::acl::capability::CapabilityFile;
use tauri::Manager;

/// Canonicalize and validate the one exact origin a runtime capability may
/// carry. The entry validator already enforces the gateway namespace; this
/// guard keeps accidental wildcard/path/query inputs away from `add_capability`.
pub fn exact_origin_remote_urls(exact_origin: &str) -> Result<Vec<String>, String> {
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

/// Every app command the minted gateway grant carries, in the module that
/// owns the grant so the advertisement cannot drift from the authority: the
/// ACL parity tests in serve.rs assert this list equals the grant recomputed
/// from the capability sources. It is what a gateway-served `lib-*` window on
/// a minted exact origin may invoke; a loopback window's effective grant
/// differs at the edges (no `gateway_csrf_token`, and `read_dropped_paths`
/// only where local-drop applies), which cannot mislead because a locally
/// served page never skews from its host.
///
/// `native_vocabulary` is itself a member: an app old enough to lack an
/// advertised command is also old enough to lack this query, so a page that
/// cannot ask falls back to interpreting the refusal, and a page that can
/// ask may trust absence from this list as a version statement.
pub const GATEWAY_WINDOW_COMMANDS: &[&str] = &[
    "abandon_devserver_for_window",
    "append_generated_download",
    "begin_generated_download",
    "cancel_generated_download",
    "cancel_native_transfer",
    "create_library_window",
    "download_file_native",
    "finish_generated_download",
    "focus_library_window",
    "gateway_csrf_token",
    "hide_window_from_close_confirm",
    "native_transfer_status",
    "native_vocabulary",
    "open_devtools",
    "open_new_window",
    "open_reverse_tunnel",
    "platform_os",
    "probe_url",
    "read_clipboard_html",
    "read_clipboard_image",
    "read_clipboard_text",
    "reconnect_devserver_for_window",
    "reload_window",
    "request_app_quit",
    "request_close_window",
    "upload_files_native",
    "write_clipboard_html",
    "write_clipboard_image",
    "write_clipboard_text",
    "zoom_in",
    "zoom_out",
    "zoom_reset",
];

/// The capability JSON minted for one authenticated exact origin: the existing
/// devserver native vocabulary, `lib-*` windows only, and one `remote.urls`
/// entry.
/// No scoped permissions, no deny entries (see the module doc for why
/// both rules are absolute).
pub fn exact_origin_capability_json(exact_origin: &str) -> Result<String, String> {
    let remote_urls = exact_origin_remote_urls(exact_origin)?;
    Ok(serde_json::json!({
        "identifier": "gateway-window",
        "description": "authenticated exact-origin grant for a gateway-served lib window",
        "remote": { "urls": remote_urls },
        "windows": ["lib-*"],
        "permissions": [
            "workspace-window",
            "allow-gateway-csrf-token",
            "allow-download-file-native",
            "allow-upload-files-native",
            "allow-native-transfer-status",
            "allow-cancel-native-transfer",
            "allow-begin-generated-download",
            "allow-append-generated-download",
            "allow-finish-generated-download",
            "allow-cancel-generated-download",
            "core:webview:allow-set-webview-zoom",
            "core:window:allow-set-fullscreen",
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

/// Grant `lib-*` windows on `exact_origin` their native IPC vocabulary once per
/// process. Already-open windows on the origin gain the grant on their next
/// invoke; revocation prevents managed reopening but cannot remove this Tauri
/// authority entry until process exit.
pub fn mint_exact_origin_grant<R: tauri::Runtime>(
    manager: &impl Manager<R>,
    exact_origin: &str,
) -> Result<bool, String> {
    let urls = exact_origin_remote_urls(exact_origin)?;
    // Poison-tolerant: an unwind inside add_capability (its panic paths
    // are pinned unreachable for our JSON, but pins are not proofs) must
    // not wedge every later mint into a panic on this lock; recovering a
    // possibly-stale set risks at most one duplicate re-mint, which
    // resolution tolerates.
    let mut minted = minted_origins().lock().unwrap_or_else(|e| e.into_inner());
    if minted.contains(&urls[0]) {
        tracing::debug!(
            exact_origin = %urls[0],
            "gateway-window capability already minted for this origin"
        );
        return Ok(false);
    }
    let json = exact_origin_capability_json(&urls[0])?;
    // Parse first: the string form of add_capability ABORTS on malformed
    // JSON, so guard with the fallible parse before handing the string
    // over (the unresolvable-permission abort stays covered by the pins).
    json.parse::<CapabilityFile>()
        .map_err(|e| format!("minted capability does not parse: {e}"))?;
    manager
        .add_capability(json)
        .map_err(|e| format!("adding gateway capability: {e}"))?;
    let origin = urls.into_iter().next().expect("urls is non-empty");
    // The ACL refuses gateway_csrf_token before any handler runs, so no
    // desktop-side code sees a refusal and nothing else records which origin
    // actually carries the grant. Pair this line with the SPA's refusal log
    // (origin + window label) to tell an origin that was never minted from one
    // minted for a different origin than the window presents.
    tracing::info!(
        exact_origin = %origin,
        "minted the gateway-window capability for lib-* windows on this origin"
    );
    minted.insert(origin);
    Ok(true)
}

/// Test-only read on the process-global mint set: roster-side tests prove
/// a parsed roster origin never reaches the mint (the entry flow is the
/// only mint path).
#[cfg(test)]
pub(crate) fn is_minted(exact_origin: &str) -> bool {
    minted_origins()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(exact_origin)
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::panic::{catch_unwind, AssertUnwindSafe};

    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    /// Stub for the `platform_os` app command (granted to `lib-*` windows
    /// via the `workspace-window` permission set), so an allowed invoke
    /// has a handler to reach and returns a recognizable body.
    #[tauri::command]
    fn platform_os() -> &'static str {
        "stub-os"
    }

    /// Stub for the `open_reverse_tunnel` app command (also granted through
    /// the `workspace-window` set): the `cs tunnel` trigger must reach
    /// devserver-served `lib-*` windows, so the scope test pins the minted
    /// grant carrying it.
    #[tauri::command]
    fn open_reverse_tunnel() -> &'static str {
        "stub-tunnel"
    }

    /// Stub for the gateway-only CSRF mirror command. Unlike the broader
    /// workspace-window set, its permission is carried directly by the minted
    /// exact-origin capability.
    #[tauri::command]
    fn gateway_csrf_token() -> &'static str {
        "stub-csrf"
    }

    /// Stubs for the command deck's library-window commands. Their permissions
    /// sit in the `workspace-window` SET rather than in this capability's own
    /// permission list, so these pins are what prove a gateway-served `lib-*`
    /// window really reaches them through the set the minted capability carries.
    #[tauri::command]
    fn create_library_window() -> &'static str {
        "stub-create"
    }

    #[tauri::command]
    fn focus_library_window() -> &'static str {
        "stub-focus"
    }

    /// Stub for `read_dropped_paths` - the one command a loopback
    /// workspace window holds that `lib-*` windows never get, on any
    /// origin. Registered so the out-of-set denial pin cannot pass
    /// vacuously: if a capability ever leaked this command to lib
    /// windows, the invoke would reach this handler and return Ok,
    /// failing the pin (an unregistered command is rejected with the same
    /// Err shape as an ACL denial).
    #[tauri::command]
    fn read_dropped_paths() -> &'static str {
        "leaked"
    }

    /// A mock-runtime app built from the REAL generated context: the
    /// actual ACL manifests and static capabilities of chan-desktop, no
    /// display server required.
    fn mock_desktop_app() -> tauri::App<tauri::test::MockRuntime> {
        mock_builder()
            .invoke_handler(tauri::generate_handler![
                platform_os,
                gateway_csrf_token,
                read_dropped_paths,
                open_reverse_tunnel,
                create_library_window,
                focus_library_window
            ])
            .build(crate::app_context())
            .expect("mock app builds from the real context")
    }

    fn lib_window(
        app: &tauri::App<tauri::test::MockRuntime>,
        label: &str,
        url: &str,
    ) -> tauri::WebviewWindow<tauri::test::MockRuntime> {
        WebviewWindowBuilder::new(app, label, WebviewUrl::External(url.parse().unwrap()))
            .build()
            .expect("mock webview window")
    }

    /// Drives `Webview::on_message` with `cmd` as if a page at `url` sent
    /// it: the same per-invoke path (origin derivation + live authority
    /// lookup) production IPC takes.
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

    const EXACT_ORIGIN: &str = "https://alice--0a1b2c3d4e5f.p1.proxy.chan.app";
    const GATEWAY_PAGE: &str = "https://alice--0a1b2c3d4e5f.p1.proxy.chan.app/";
    /// The label the window watcher actually builds: `native_label` is
    /// `{library_id}::{window_id}`, never a flat `lib-x`.
    const WATCHED_LABEL: &str = "lib-0a1b2c3d4e5f::w-7";
    /// The page a watched gateway window actually loads: `gateway_url` joins
    /// the pinned proxy origin to `window_entry_path`, so the document sits
    /// under a tenant prefix, never at the origin root.
    const WATCHED_PAGE: &str =
        "https://alice--0a1b2c3d4e5f.p1.proxy.chan.app/api/notes-1a2b3c/index.html";
    const SIBLING_PAGE: &str = "https://bob--1a2b3c4d5e6f.p1.proxy.chan.app/";
    const PROXY_APEX_PAGE: &str = "https://p1.proxy.chan.app/";
    const WRONG_PORT_PAGE: &str = "https://alice--0a1b2c3d4e5f.p1.proxy.chan.app:444/";
    const OTHER_REMOTE_PAGE: &str = "https://ws1.unrelated.example/";

    fn production_json() -> String {
        exact_origin_capability_json(EXACT_ORIGIN).unwrap()
    }

    #[test]
    fn remote_urls_are_one_canonical_exact_origin() {
        assert_eq!(
            exact_origin_remote_urls(EXACT_ORIGIN).unwrap(),
            vec![EXACT_ORIGIN.to_string()]
        );
        assert_eq!(
            exact_origin_remote_urls("https://alice--0a1b2c3d4e5f.p1.proxy.chan.app:443").unwrap(),
            vec![EXACT_ORIGIN.to_string()],
            "effective default ports canonicalize"
        );
        for invalid in [
            "ftp://x",
            "not a url",
            "https://*.p1.proxy.chan.app",
            "https://user@alice--0a1b2c3d4e5f.p1.proxy.chan.app",
            "https://alice--0a1b2c3d4e5f.p1.proxy.chan.app/path",
            "https://alice--0a1b2c3d4e5f.p1.proxy.chan.app/?q=1",
            "https://alice--0a1b2c3d4e5f.p1.proxy.chan.app/#fragment",
        ] {
            assert!(exact_origin_remote_urls(invalid).is_err(), "{invalid}");
        }
    }

    /// The core pin: a foreign-origin invoke is denied before the mint,
    /// the SAME already-open window is allowed right after it, and a
    /// window created after the mint is covered too. Consumes the
    /// PRODUCTION mint path end to end. This test is the sole
    /// mint_exact_origin_grant caller for EXACT_ORIGIN: the once-guard
    /// is process-global, so a second caller would read Ok(false)
    /// depending on test order.
    #[test]
    fn runtime_grant_reaches_already_open_and_later_windows() {
        let app = mock_desktop_app();

        let open_before_mint = lib_window(&app, "lib-before", GATEWAY_PAGE);
        assert!(
            invoke_from(&open_before_mint, GATEWAY_PAGE, "platform_os").is_err(),
            "foreign origin must be denied before the mint"
        );

        assert_eq!(
            mint_exact_origin_grant(&app, EXACT_ORIGIN),
            Ok(true),
            "first mint for the origin installs the capability"
        );

        assert_eq!(
            invoke_from(&open_before_mint, GATEWAY_PAGE, "platform_os"),
            Ok("stub-os".into()),
            "an already-open window gains the grant on its next invoke"
        );
        assert_eq!(
            invoke_from(&open_before_mint, GATEWAY_PAGE, "gateway_csrf_token"),
            Ok("stub-csrf".into()),
            "the gateway-only token command rides the minted exact-origin grant"
        );

        let opened_after_mint = lib_window(&app, "lib-after", GATEWAY_PAGE);
        assert_eq!(
            invoke_from(&opened_after_mint, GATEWAY_PAGE, "platform_os"),
            Ok("stub-os".into()),
            "windows created after the mint are covered"
        );

        // The once-per-(origin, run) guard: a reconnect does not
        // accumulate duplicate grants.
        assert_eq!(mint_exact_origin_grant(&app, EXACT_ORIGIN), Ok(false));
    }

    /// The grant must not leak: wrong origin, wrong window label, or a
    /// command outside the granted set all stay denied after the mint.
    #[test]
    fn runtime_grant_stays_scoped() {
        let app = mock_desktop_app();
        app.add_capability(production_json())
            .expect("add_capability returned Ok");

        let lib = lib_window(&app, "lib-scoped", GATEWAY_PAGE);
        for denied in [
            SIBLING_PAGE,
            PROXY_APEX_PAGE,
            WRONG_PORT_PAGE,
            OTHER_REMOTE_PAGE,
        ] {
            assert!(
                invoke_from(&lib, denied, "platform_os").is_err(),
                "origin {denied} must stay outside the exact grant"
            );
            assert!(
                invoke_from(&lib, denied, "gateway_csrf_token").is_err(),
                "origin {denied} must not read the gateway CSRF token"
            );
            for command in ["create_library_window", "focus_library_window"] {
                assert!(
                    invoke_from(&lib, denied, command).is_err(),
                    "origin {denied} must not open or raise a native library window"
                );
            }
        }
        assert!(
            invoke_from(&lib, GATEWAY_PAGE, "read_dropped_paths").is_err(),
            "commands outside the granted set stay denied"
        );
        assert_eq!(
            invoke_from(&lib, GATEWAY_PAGE, "open_reverse_tunnel"),
            Ok("stub-tunnel".into()),
            "the cs tunnel trigger is part of the minted lib-window vocabulary"
        );
        assert_eq!(
            invoke_from(&lib, GATEWAY_PAGE, "create_library_window"),
            Ok("stub-create".into()),
            "a gateway lib window mints its own library's windows natively"
        );
        assert_eq!(
            invoke_from(&lib, GATEWAY_PAGE, "focus_library_window"),
            Ok("stub-focus".into()),
            "a gateway lib window raises its own library's windows natively"
        );

        let non_lib = lib_window(&app, "settings-scoped", GATEWAY_PAGE);
        assert!(
            invoke_from(&non_lib, GATEWAY_PAGE, "platform_os").is_err(),
            "window labels outside lib-* stay denied"
        );
        assert!(
            invoke_from(&non_lib, GATEWAY_PAGE, "gateway_csrf_token").is_err(),
            "window labels outside lib-* cannot read the gateway CSRF token"
        );
    }

    /// The shapes production presents, which no other pin here uses: every
    /// window above is labelled flat (`lib-scoped`) and every page is the
    /// origin root, while a watcher-opened gateway window is
    /// `{library_id}::{window_id}` on a tenant path. A grant that resolved
    /// only for a flat label, or only at `/`, would pass every other pin in
    /// this module and still refuse the window an owner actually gets.
    #[test]
    fn runtime_grant_covers_the_label_and_page_the_watcher_builds() {
        let app = mock_desktop_app();
        app.add_capability(production_json())
            .expect("add_capability returned Ok");

        let watched = lib_window(&app, WATCHED_LABEL, WATCHED_PAGE);
        assert_eq!(
            invoke_from(&watched, WATCHED_PAGE, "create_library_window"),
            Ok("stub-create".into()),
            "the command deck's mint must resolve for the real label and tenant path"
        );
        assert_eq!(
            invoke_from(&watched, WATCHED_PAGE, "focus_library_window"),
            Ok("stub-focus".into()),
            "raising a sibling window must resolve for the real label and tenant path"
        );
        assert_eq!(
            invoke_from(&watched, WATCHED_PAGE, "gateway_csrf_token"),
            Ok("stub-csrf".into()),
            "the CSRF mirror must resolve for the real label and tenant path"
        );

        // Non-vacuity: the scoping still holds at these shapes, so a pass
        // above cannot come from a grant that stopped discriminating.
        assert!(
            invoke_from(&watched, SIBLING_PAGE, "create_library_window").is_err(),
            "another tenant's page must stay outside the grant"
        );
        assert!(
            invoke_from(&watched, WATCHED_PAGE, "read_dropped_paths").is_err(),
            "commands outside the granted set stay denied at these shapes"
        );
        let foreign = lib_window(&app, "outbound-3", WATCHED_PAGE);
        assert!(
            invoke_from(&foreign, WATCHED_PAGE, "create_library_window").is_err(),
            "a URL attachment on the same origin is not a library window"
        );
    }

    /// The ordering the grant depends on and nothing else enforces. A
    /// `lib-*` window reaches its native vocabulary only if the capability
    /// for its origin was already added, and the ACL refuses before any
    /// desktop code runs, so a mint that moved after the window could open
    /// would surface as an unexplained per-command refusal on the page with
    /// nothing logged on this side. Pinned against the source because the
    /// invariant is the ORDER of three statements, which no unit test on the
    /// mint itself can observe.
    #[test]
    fn the_rostered_connect_mints_before_a_window_can_exist() {
        const MAIN_RS: &str = include_str!("main.rs");
        // Both needles are the DEFINITION form, at line start with its open
        // paren, and both must be proven present. The bare name also appears
        // in string literals in this file's own tests, so a looser needle
        // bounds the slice on a test rather than on the function, and a
        // `split(..).next()` end would widen it to the rest of the file: under
        // either, the mint could be found somewhere else entirely while the
        // rostered connect had lost it, and this pin would still pass.
        let after = MAIN_RS
            .split("\nasync fn connect_rostered_devserver(")
            .nth(1)
            .expect("connect_rostered_devserver is defined");
        let end = after
            .find("\nasync fn connect_devserver_impl_inner(")
            .expect("the rostered connect precedes the raw inner, which bounds this slice");
        let connect = &after[..end];

        let mint = connect
            .find("mint_exact_origin_grant")
            .expect("the rostered connect mints the exact-origin grant");
        let install = connect
            .find("install_gateway_webview_session")
            .expect("the rostered connect installs the WebView session");
        let watcher = connect
            .find("spawn_devserver_window_watcher")
            .expect("the rostered connect spawns the window watcher");
        assert!(
            mint < install && mint < watcher,
            "the grant must be in place before any window can be built on the origin"
        );

        let statement = &connect[mint..][..connect[mint..]
            .find(';')
            .expect("the mint is a single statement")];
        assert!(
            statement.contains("proxy_origin"),
            "the mint must use the connection's pinned origin, the same value navigation builds from"
        );
        assert!(
            statement.contains('?'),
            "a failed mint must abort the connect rather than leave an ungranted window"
        );
    }

    /// Both add_capability panic paths, pinned unreachable for the JSON
    /// the mint produces: it parses as a CapabilityFile and every named
    /// permission resolves against the app's build-time manifests.
    #[test]
    fn minted_capability_parses_and_resolves() {
        let json = production_json();
        json.parse::<CapabilityFile>()
            .expect("minted JSON parses as a capability");

        // A clean return proves resolution: an unresolvable set panics
        // inside add_capability before an Err is ever reachable.
        let app = mock_desktop_app();
        app.add_capability(json)
            .expect("add_capability returned Ok");
    }

    /// Re-adding the same capability accumulates duplicate grants rather
    /// than erroring or replacing: resolution still allows the command,
    /// which is why mint_exact_origin_grant keeps its once-per-origin guard
    /// guard rather than re-issuing on every connect.
    #[test]
    fn re_minting_accumulates_without_breaking_resolution() {
        let app = mock_desktop_app();
        let json = production_json();
        app.add_capability(json.clone())
            .expect("add_capability returned Ok");
        app.add_capability(json).expect("re-add returned Ok");
        let webview = lib_window(&app, "lib-remint", GATEWAY_PAGE);
        assert_eq!(
            invoke_from(&webview, GATEWAY_PAGE, "platform_os"),
            Ok("stub-os".into())
        );
    }

    /// The hazard the pins above guard: malformed JSON and unknown
    /// permissions don't error, they PANIC (and abort the app outside
    /// catch_unwind). Documents why the minted shape must stay pinned.
    #[test]
    fn malformed_or_unresolvable_capability_panics() {
        let app = mock_desktop_app();
        assert!(
            catch_unwind(AssertUnwindSafe(|| app.add_capability("{not json"))).is_err(),
            "malformed JSON panics"
        );
        drop(app);

        let app = mock_desktop_app();
        let unresolvable = serde_json::json!({
            "identifier": "gateway-window-bad",
            "description": "",
            "remote": { "urls": ["https://*.proxy.gw-test.example"] },
            "windows": ["lib-*"],
            "permissions": ["no-such-permission"],
        })
        .to_string();
        assert!(
            catch_unwind(AssertUnwindSafe(|| app.add_capability(unresolvable))).is_err(),
            "unknown permission panics"
        );
    }
}
