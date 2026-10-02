use std::net::SocketAddr;

use anyhow::{Context, Result};

use crate::registry::library;
use crate::DEFAULT_PORT;

/// Devserver twin of [`devserver_port_collision_hint`]: an actionable message
/// for the devserver's own listener failing to bind with `AddrInUse` (the only
/// fallible bind that escapes `run_devserver`; the discovery-socket bind is
/// non-fatal). Unlike the serve-path hint this fires for ANY port and names
/// it, so a deliberate squatter against an explicit `--port` reads as a
/// collision in the journal instead of a generic anyhow chain. `None` for
/// every other error, which keeps its context unchanged.
fn devserver_bind_collision_hint(addr: SocketAddr, err: &anyhow::Error) -> Option<String> {
    let io_err = err.root_cause().downcast_ref::<std::io::Error>()?;
    if io_err.kind() != std::io::ErrorKind::AddrInUse {
        return None;
    }
    let squatter = if addr.port() == DEFAULT_PORT {
        "most likely another `chan devserver` or a standalone `chan serve` \
         server (both default to it)"
    } else {
        "another process owns it"
    };
    Some(format!(
        "chan devserver: could not bind {addr}: the port is already in use -- \
         {squatter}. Stop the other process or re-run with a different \
         `--port` (a listening tunnel-mode devserver defaults to an \
         OS-assigned free port)."
    ))
}

/// Warn when a devserver bind exposes a non-loopback interface: there is no TLS,
/// only the persisted bearer-token gate.
pub(super) fn warn_non_loopback_bind(addr: SocketAddr) {
    if !addr.ip().is_loopback() {
        eprintln!(
            "WARNING: binding to {} exposes the devserver on a non-loopback \
             interface. There is no TLS and only a bearer-token gate; reach a \
             remote devserver over `ssh -L` instead of binding it publicly.",
            addr.ip()
        );
    }
}

/// Build the foreground tunnel config from `--tunnel-token`, warning when the
/// secret arrived on the command line (visible in `ps`) rather than via
/// `CHAN_TUNNEL_TOKEN`. Only the foreground / `chan` paths reach this; the
/// systemd/launchd refusal lives at the call site. These backends persist no
/// unit to reuse an endpoint from, so a token with no `--tunnel-url` /
/// `CHAN_TUNNEL_URL` is an error here -- the same refusal the supervised path
/// only reaches once the installed unit has come up empty too.
pub(super) fn build_devserver_tunnel(
    tunnel_token: Option<String>,
    tunnel_url: Option<String>,
    tunnel_devserver_name: Option<&str>,
) -> Result<Option<chan_server::DevserverTunnel>> {
    let Some(token) = tunnel_token else {
        return Ok(None);
    };
    // clap does not expose the arg source, so compare to the env directly.
    if std::env::var("CHAN_TUNNEL_TOKEN").ok().as_deref() != Some(token.as_str()) {
        eprintln!(
            "WARNING: --tunnel-token is visible in `ps` output. \
             Prefer CHAN_TUNNEL_TOKEN env var instead."
        );
    }
    let tunnel_url = tunnel_url.context(MISSING_TUNNEL_URL)?;
    Ok(Some(chan_server::DevserverTunnel {
        tunnel_url,
        token,
        name: resolve_tunnel_devserver_name(tunnel_devserver_name),
    }))
}

/// The refusal when tunnel mode is asked for with no endpoint to dial. Shared
/// so the unsupervised backends and the supervised one (which reaches it only
/// after the installed unit yields no endpoint either) read identically.
pub(super) const MISSING_TUNNEL_URL: &str =
    "chan devserver: tunnel mode requires --tunnel-url or CHAN_TUNNEL_URL";

/// Hidden daemon child tunnel config. The token is never accepted as an argv
/// field here; the parent passes it through CHAN_TUNNEL_TOKEN only. The name
/// is not a secret and rides argv (`--tunnel-devserver-name`).
pub(crate) fn build_devserver_tunnel_from_env(
    tunnel_url: Option<String>,
    tunnel_devserver_name: Option<String>,
) -> Result<Option<chan_server::DevserverTunnel>> {
    let Some(token) = std::env::var("CHAN_TUNNEL_TOKEN")
        .ok()
        .filter(|token| !token.is_empty())
    else {
        return Ok(None);
    };
    let tunnel_url = tunnel_url
        .filter(|url| !url.trim().is_empty())
        .context("CHAN_TUNNEL_URL or --tunnel-url is required with CHAN_TUNNEL_TOKEN")?;
    Ok(Some(chan_server::DevserverTunnel {
        tunnel_url,
        token,
        name: resolve_tunnel_devserver_name(tunnel_devserver_name.as_deref()),
    }))
}

/// Gateway bound on a devserver's roster label
/// (`gateway/crates/profile/src/http.rs`, `create_devserver`): 64 bytes.
/// The CLI caps the announced name to the same bound so the gateway
/// never has to reject it.
const TUNNEL_DEVSERVER_NAME_MAX_BYTES: usize = 64;

/// Normalize an explicit `--tunnel-devserver-name`: map control
/// characters to spaces, collapse whitespace runs, trim, and cap at
/// the gateway's 64-byte label bound (truncating on a char boundary).
/// Control characters never reach the wire or the systemd unit from
/// here: an interior newline would inject unit directives into
/// `Environment=` and an ANSI escape would corrupt whatever renders
/// the name. A blank value (after mapping) reads as absent so the
/// hostname default applies.
pub(super) fn normalize_tunnel_devserver_name(raw: &str) -> Option<String> {
    let mapped: String = raw
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let collapsed = mapped.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    Some(truncate_on_char_boundary(&collapsed, TUNNEL_DEVSERVER_NAME_MAX_BYTES).to_string())
}

/// The display name a tunnel registration announces for the gateway
/// roster: the explicit `--tunnel-devserver-name` when given, else this
/// box's hostname (via [`devserver_host_label`]). Never empty.
fn resolve_tunnel_devserver_name(explicit: Option<&str>) -> String {
    explicit
        .and_then(normalize_tunnel_devserver_name)
        .unwrap_or_else(|| {
            normalize_tunnel_devserver_name(&devserver_host_label())
                .expect("devserver_host_label never yields a blank label")
        })
}

/// The longest prefix of `s` that fits in `max` bytes without splitting
/// a UTF-8 code point.
fn truncate_on_char_boundary(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Whether the foreground devserver binds a local TCP listener. Non-tunnel always
/// binds. Tunnel mode defaults to no-bind (the gateway is the surface) EXCEPT
/// under systemd notify, where the loopback management API is needed so
/// `chan devserver stop` / `restart --force` can drain the terminals
/// explicitly (restart itself needs no call: the fd store preserves PTYs).
/// `CHAN_DEVSERVER_LISTEN`
/// forces either way. Tunnel-off + LISTEN=0 leaves nothing reachable (no local
/// listener, no tunnel -- only the `chan serve` discovery socket), so it is a
/// hard error rather than a silently-unreachable devserver.
pub(super) fn resolve_devserver_listen(
    tunnel_mode: bool,
    under_systemd_notify: bool,
    listen_override: Option<bool>,
) -> Result<bool> {
    let listen = listen_override.unwrap_or(!tunnel_mode || under_systemd_notify);
    if !listen && !tunnel_mode {
        anyhow::bail!(
            "chan devserver: CHAN_DEVSERVER_LISTEN=0 with no tunnel leaves nothing reachable \
             (no local listener and no tunnel). Set CHAN_TUNNEL_TOKEN to publish through the \
             gateway, or unset CHAN_DEVSERVER_LISTEN to bind the local listener."
        );
    }
    Ok(listen)
}

/// Read `CHAN_DEVSERVER_LISTEN` as a tri-state: unset or empty ⇒ `None` (use the
/// tunnel-mode default), `"0"` ⇒ `Some(false)`, any other non-empty value ⇒
/// `Some(true)` (mirrors `CHAN_NO_DESKTOP_HANDOFF`'s truthiness).
pub(super) fn devserver_listen_override() -> Option<bool> {
    std::env::var("CHAN_DEVSERVER_LISTEN")
        .ok()
        .and_then(|v| parse_listen_override(&v))
}

/// Pure parse for [`devserver_listen_override`] so the tri-state is unit-tested
/// without touching the process environment.
fn parse_listen_override(raw: &str) -> Option<bool> {
    if raw.is_empty() {
        None
    } else {
        Some(raw != "0")
    }
}

/// The port a fresh foreground devserver binds. An explicit `--port` always
/// wins, tunnel mode included. A LISTENING tunnel-mode devserver defaults to
/// `0` (the OS assigns a free port): its listener is management-only plumbing
/// behind the gateway -- nothing depends on the number, the bound port is
/// read back from `local_addr()` and persisted -- while a fixed 8787 default
/// collides with whatever else owns that port, and the systemd unit path
/// restarts into the same collision forever. Everything else keeps
/// [`DEFAULT_PORT`], whose equality with `chan serve`'s default powers the
/// serve-path collision hint.
pub(super) fn resolve_devserver_port(
    explicit: Option<u16>,
    tunnel_mode: bool,
    listen: bool,
) -> u16 {
    match explicit {
        Some(port) => port,
        None if tunnel_mode && listen => 0,
        None => DEFAULT_PORT,
    }
}

/// Run the devserver in the foreground. The no-supervisor default and the
/// systemd unit's `ExecStart` / launchd agent's `ProgramArguments` all land
/// here. `tunnel` carries the gateway registration when `--tunnel-token` is
/// set; the supervised backends never pass it (tunnel mode is foreground-only).
pub(crate) async fn run_devserver_foreground(
    addr: SocketAddr,
    tunnel: Option<chan_server::DevserverTunnel>,
    listen: bool,
) -> Result<()> {
    let lib = library()?;
    let result = chan_server::run_devserver(
        lib,
        chan_server::DevserverConfig {
            addr,
            host_label: devserver_host_label(),
            tunnel,
            listen,
        },
    )
    .await;
    // A bind collision gets the actionable hint (mirrors `cmd_serve`); under
    // systemd it lands in the journal as the loud failure line.
    if let Err(err) = &result {
        if let Some(hint) = devserver_bind_collision_hint(addr, err) {
            return Err(anyhow::anyhow!(hint));
        }
    }
    result.context("running devserver")
}

/// Human label for the box, shown in the management API. Falls back to a
/// generic label when the hostname is empty.
fn devserver_host_label() -> String {
    let host = gethostname::gethostname().to_string_lossy().into_owned();
    if host.trim().is_empty() {
        "devserver".to_string()
    } else {
        host
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devserver_bind_collision_hint_names_any_port() {
        use std::io::{Error as IoError, ErrorKind};
        let bind_err = |kind: ErrorKind, addr: &str| {
            anyhow::Error::from(IoError::from(kind)).context(format!("binding devserver on {addr}"))
        };

        // An explicit non-default port gets the hint too (a squatter against
        // `--port 9000` must fail loud with the port named), reading the
        // AddrInUse through the anyhow context chain the bind site adds.
        let addr: SocketAddr = "127.0.0.1:9000".parse().unwrap();
        let hint = devserver_bind_collision_hint(addr, &bind_err(ErrorKind::AddrInUse, "9000"))
            .expect("hint");
        assert!(hint.contains("127.0.0.1:9000"), "{hint}");
        assert!(hint.contains("--port"), "{hint}");

        // The shared default names its likely squatters.
        let addr: SocketAddr = format!("127.0.0.1:{DEFAULT_PORT}").parse().unwrap();
        let hint = devserver_bind_collision_hint(addr, &bind_err(ErrorKind::AddrInUse, "8787"))
            .expect("hint");
        assert!(hint.contains("chan devserver"), "{hint}");
        assert!(hint.contains("chan serve"), "{hint}");

        // Any other failure keeps its generic context.
        assert!(devserver_bind_collision_hint(
            addr,
            &bind_err(ErrorKind::PermissionDenied, "8787")
        )
        .is_none());
        assert!(devserver_bind_collision_hint(addr, &anyhow::anyhow!("not io")).is_none());
    }

    /// The `listen` resolution matrix: tunnel mode flips the default to no-bind
    /// UNLESS running under systemd notify; `CHAN_DEVSERVER_LISTEN` overrides;
    /// tunnel-off + LISTEN=0 is the unreachable-devserver hard error.
    #[test]
    fn devserver_listen_matrix() {
        // Tunnel off: default binds; explicit 1 binds; explicit 0 errors
        // (nothing reachable). systemd notify makes no difference off-tunnel.
        assert!(resolve_devserver_listen(false, false, None).unwrap());
        assert!(resolve_devserver_listen(false, true, None).unwrap());
        assert!(resolve_devserver_listen(false, false, Some(true)).unwrap());
        assert!(resolve_devserver_listen(false, false, Some(false)).is_err());
        // Tunnel on, NOT under systemd: default does NOT bind locally; explicit 0
        // also doesn't; explicit 1 binds the local listener alongside the tunnel.
        assert!(!resolve_devserver_listen(true, false, None).unwrap());
        assert!(!resolve_devserver_listen(true, false, Some(false)).unwrap());
        assert!(resolve_devserver_listen(true, false, Some(true)).unwrap());
        // Tunnel on, UNDER systemd notify: default binds the loopback management
        // API so the `stop` / `--force` terminal drain can reach it; explicit
        // 0 still opts out.
        assert!(resolve_devserver_listen(true, true, None).unwrap());
        assert!(!resolve_devserver_listen(true, true, Some(false)).unwrap());
    }

    /// `CHAN_DEVSERVER_LISTEN` is a tri-state: unset/empty ⇒ default, `"0"` ⇒
    /// off, any other non-empty value ⇒ on.
    #[test]
    fn devserver_listen_override_parse() {
        assert_eq!(parse_listen_override(""), None);
        assert_eq!(parse_listen_override("0"), Some(false));
        assert_eq!(parse_listen_override("1"), Some(true));
        // Any non-empty, non-"0" value is truthy (mirrors CHAN_NO_DESKTOP_HANDOFF).
        assert_eq!(parse_listen_override("yes"), Some(true));
    }

    /// The port default matrix: an explicit `--port` always wins; a LISTENING
    /// tunnel-mode devserver defaults to 0 (OS-assigned, so systemd restarts
    /// never collide on a fixed port); everything else keeps the shared 8787.
    #[test]
    fn devserver_port_defaults_by_mode() {
        // Explicit wins everywhere, tunnel mode included.
        assert_eq!(resolve_devserver_port(Some(9000), true, true), 9000);
        assert_eq!(resolve_devserver_port(Some(9000), false, true), 9000);
        assert_eq!(resolve_devserver_port(Some(DEFAULT_PORT), true, true), 8787);
        // Tunnel + listen (systemd notify / CHAN_DEVSERVER_LISTEN=1): the OS
        // assigns the port.
        assert_eq!(resolve_devserver_port(None, true, true), 0);
        // Tunnel without a listener: nothing binds; the addr keeps the shared
        // default for the discovery/window-record report.
        assert_eq!(resolve_devserver_port(None, true, false), DEFAULT_PORT);
        // Non-tunnel keeps the shared default the `chan serve` handoff and the
        // serve-path collision hint rely on.
        assert_eq!(resolve_devserver_port(None, false, true), DEFAULT_PORT);
    }

    #[test]
    fn unsupervised_tunnel_still_demands_an_endpoint_up_front() {
        // Making the endpoint requirement lazy must not make it optional. The
        // foreground and `chan` backends persist no unit to recover one from,
        // so for them the refusal fires exactly where it always did.
        let Err(error) = build_devserver_tunnel(Some("chan_pat_a".into()), None, None) else {
            panic!("a token with no endpoint must fail on the unsupervised path");
        };
        assert_eq!(error.to_string(), MISSING_TUNNEL_URL);
        // No token is not tunnel mode, endpoint or not.
        assert!(build_devserver_tunnel(None, None, None).unwrap().is_none());
        assert!(
            build_devserver_tunnel(None, Some("https://cli.test".into()), None)
                .unwrap()
                .is_none()
        );
        // Token plus endpoint resolves to a tunnel.
        let tunnel = build_devserver_tunnel(
            Some("chan_pat_a".into()),
            Some("https://cli.test".into()),
            Some("office box"),
        )
        .unwrap()
        .unwrap();
        assert_eq!(tunnel.tunnel_url, "https://cli.test");
        assert_eq!(tunnel.token, "chan_pat_a");
        assert_eq!(tunnel.name, "office box");
    }

    #[test]
    fn tunnel_devserver_name_resolves_explicit_then_hostname() {
        // Explicit wins and is trimmed; blank/whitespace falls back to the
        // hostname default, which is never empty.
        assert_eq!(
            resolve_tunnel_devserver_name(Some("  office box  ")),
            "office box"
        );
        let host_default = resolve_tunnel_devserver_name(None);
        assert!(!host_default.is_empty());
        assert_eq!(resolve_tunnel_devserver_name(Some("   ")), host_default);
    }

    #[test]
    fn tunnel_devserver_name_maps_control_chars_to_spaces() {
        // Interior control characters (newline would inject systemd
        // unit directives, ESC would corrupt renderers) become spaces,
        // and whitespace runs collapse.
        assert_eq!(
            resolve_tunnel_devserver_name(Some("office\nbox")),
            "office box"
        );
        assert_eq!(
            resolve_tunnel_devserver_name(Some("office\r\n\tbox")),
            "office box"
        );
        assert_eq!(
            resolve_tunnel_devserver_name(Some("a\u{1b}b")),
            "a b",
            "ANSI escape byte maps to a space"
        );
        // All-control input reads as blank: hostname default applies.
        let host_default = resolve_tunnel_devserver_name(None);
        assert_eq!(resolve_tunnel_devserver_name(Some("\n\t\r")), host_default);
        // Percent is not a control character; it survives untouched
        // (the systemd unit write site escapes it, not this layer).
        assert_eq!(resolve_tunnel_devserver_name(Some("box 50%")), "box 50%");
    }

    #[test]
    fn tunnel_devserver_name_caps_at_64_bytes_on_char_boundary() {
        let long = "x".repeat(80);
        assert_eq!(resolve_tunnel_devserver_name(Some(&long)), "x".repeat(64));
        // A multi-byte char straddling the cap is dropped whole, never split.
        let mut tricky = "x".repeat(63);
        tricky.push('é'); // 2 bytes: 63 + 2 > 64
        let resolved = resolve_tunnel_devserver_name(Some(&tricky));
        assert_eq!(resolved, "x".repeat(63));
    }
}
