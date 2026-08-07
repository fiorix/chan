//! Boot configuration + launch handle for a served library/workspace.
//!
//! `ServeConfig` is the bundle a binary hands the host/route layer at boot;
//! `ServeHandle` is what's resolved once the listener binds (addr, prefix,
//! token) for the launch banner / browser handoff. `sanitize_prefix`
//! canonicalizes an untrusted URL path prefix. `chan-server` re-exports all
//! three.

use std::net::SocketAddr;
use std::time::Duration;

use chan_workspace::SearchAggression;

/// Configuration the binary hands the server at boot. Kept terse on
/// purpose; expand only when a route demands it.
#[derive(Debug, Clone)]
pub struct ServeConfig {
    pub addr: SocketAddr,
    /// When true, the server skips the bearer-token gate. For
    /// tests and local dev only. Loopback bind is the only check
    /// left; do not flip this in production.
    pub no_token: bool,
    /// URL path prefix all routes are served under. Canonical form:
    /// empty (no prefix) or `/seg[/seg...]` (leading slash, no
    /// trailing). Use `sanitize_prefix` to canonicalize untrusted
    /// input.
    pub prefix: String,
    /// Idle-shutdown window. When set, the server triggers a
    /// graceful shutdown if no HTTP request or WebSocket frame is
    /// observed inside the window. Intended for systemd
    /// socket-activated deployments where many idle instances
    /// stack on one host. `None` keeps the server resident
    /// indefinitely (today's default).
    pub idle_timeout: Option<Duration>,
    /// Open the launch URL in the user's default browser after the
    /// listener binds. Set by the CLI for the default `chan open`
    /// flow; suppressed for tunnel mode (no local URL to open).
    pub open_browser: bool,
    /// Optional one-shot override for the search indexer's resource
    /// profile. When absent, the persisted server config decides.
    pub search_aggression: Option<SearchAggression>,
    /// Mirror of the CLI `-v/--verbose` flag. When true, the cold-start
    /// stderr indexing progress carries per-stage detail
    /// (current file / labels); when false it stays a throttled
    /// one-liner. Off for tunnel/desktop-spawned runs.
    pub verbose: bool,
    /// Tell the SPA shell to grey out the Settings entry point so a
    /// non-owner viewer can't open the settings panel. Surfaced to
    /// the frontend as `<meta name="chan-settings-disabled">`, and
    /// mirrored on `AppState::settings_disabled` so the
    /// `tunnel_guard::settings_guard` middleware can refuse the
    /// matching write routes server-side. Set by `--no-settings` for
    /// kiosk / shared-workstation deployments where the operator at the
    /// keyboard is not the workspace owner. The default leaves it false.
    pub settings_disabled: bool,
}

/// Resolved at boot for the launch banner / browser handoff.
#[derive(Debug, Clone)]
pub struct ServeHandle {
    pub addr: SocketAddr,
    /// Canonical prefix (matches `ServeConfig::prefix`).
    pub prefix: String,
    pub token: Option<String>,
}

impl ServeHandle {
    pub fn launch_url(&self) -> String {
        let path = if self.prefix.is_empty() {
            "/".to_string()
        } else {
            format!("{}/index.html", self.prefix)
        };
        match &self.token {
            Some(t) => format!("http://{}{}?t={}", self.addr, path, t),
            None => format!("http://{}{}", self.addr, path),
        }
    }
}

/// Canonicalize a user-supplied URL path prefix.
///
/// Returns `Ok("")` for the empty / "no prefix" case, or
/// `Ok("/seg[/seg...]")` for a non-empty prefix with leading slash
/// and no trailing slash. Each segment must match `[A-Za-z0-9-]+`.
///
/// Strict on purpose: the whole point is that a reverse proxy in
/// front of `chan open` can pin the location to a simple, unambiguous
/// path. Anything that needs URL encoding, `..` traversal, or
/// non-ASCII gets rejected up front.
pub fn sanitize_prefix(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    // Strip leading and trailing slashes; collapse internal `//` runs
    // implicitly via the segment split that drops empty pieces.
    let core = trimmed.trim_matches('/');
    if core.is_empty() {
        return Ok(String::new());
    }
    let mut out = String::with_capacity(core.len() + 1);
    for segment in core.split('/') {
        if segment.is_empty() {
            // From a `//` run inside the prefix: collapse silently.
            continue;
        }
        if !segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(format!(
                "invalid prefix segment {segment:?}: only [A-Za-z0-9-] allowed"
            ));
        }
        out.push('/');
        out.push_str(segment);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::sanitize_prefix as n;
    use super::ServeHandle;

    #[test]
    fn launch_url_uses_index_for_prefixed_serves() {
        let handle = ServeHandle {
            addr: "127.0.0.1:1234".parse().unwrap(),
            prefix: "/workspace-abcd".to_string(),
            token: Some("token".to_string()),
        };
        assert_eq!(
            handle.launch_url(),
            "http://127.0.0.1:1234/workspace-abcd/index.html?t=token"
        );
    }

    #[test]
    fn launch_url_preserves_root_for_unprefixed_serves() {
        let handle = ServeHandle {
            addr: "127.0.0.1:1234".parse().unwrap(),
            prefix: String::new(),
            token: Some("token".to_string()),
        };
        assert_eq!(handle.launch_url(), "http://127.0.0.1:1234/?t=token");
    }

    #[test]
    fn empty_inputs_canonicalize_to_empty() {
        assert_eq!(n("").unwrap(), "");
        assert_eq!(n("   ").unwrap(), "");
        assert_eq!(n("/").unwrap(), "");
        assert_eq!(n("///").unwrap(), "");
    }

    #[test]
    fn canonicalizes_slashes_and_whitespace() {
        assert_eq!(n("foo").unwrap(), "/foo");
        assert_eq!(n("/foo").unwrap(), "/foo");
        assert_eq!(n("/foo/").unwrap(), "/foo");
        assert_eq!(n("foo/").unwrap(), "/foo");
        assert_eq!(n("/foo/bar").unwrap(), "/foo/bar");
        assert_eq!(n("//foo//bar//").unwrap(), "/foo/bar");
        assert_eq!(n("  /foo/  ").unwrap(), "/foo");
    }

    #[test]
    fn allowed_chars() {
        assert_eq!(n("/abc-123").unwrap(), "/abc-123");
        assert_eq!(n("/A-B/c-D").unwrap(), "/A-B/c-D");
    }

    #[test]
    fn rejects_bad_segments() {
        for bad in ["/foo/../bar", "/foo bar", "/foo%20", "/föö", "/a/b!"] {
            assert!(n(bad).is_err(), "expected error for {bad:?}");
        }
    }
}
