//! Desktop side of `cs tunnel`: the reverse-tunnel trigger command.
//!
//! A devserver terminal's `cs tunnel` pushes a `tunnel_open` window_command to
//! the terminal's OWN window over the tenant `/ws`; the SPA forwards the
//! payload here. The payload names only the tunnel and its ports. The
//! devserver to answer is resolved from the invoking window's own connection
//! record (its `lib-*` label), never from the payload: a page can only ask its
//! own devserver for what that devserver could already ask itself.
//!
//! The listener, the control WebSocket back to the devserver, and the
//! per-connection bridges all live in `chan_revtunnel::client`; this module
//! only resolves the connection, hands over the credentials, and tracks the
//! resulting handle.
//!
//! Both attach shapes are served. A directly attached devserver is dialed at
//! its own `ws://host:port` with its bearer; a gateway-attached one is dialed
//! at its pinned proxy origin with the browser session cookie and the exact
//! external `Origin`, which is what the window feed's socket already carries,
//! so a tunnel socket is accepted wherever that feed is.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use chan_revtunnel::client::{ClientConfig, TunnelHandle};
use chan_revtunnel::{Proto, TunnelOpen, TunnelSpec};
use tauri::State;

use crate::devserver::DevserverConn;
use crate::AppState;

/// Live tunnel listeners keyed by tunnel id, so a later teardown path can
/// `remove` + `stop` one. Entries whose tunnel ended on its own (the devserver
/// sent Close, or its socket dropped) stay in the map as inert handles until
/// the process exits: `TunnelHandle::wait` consumes the handle, so an end
/// cannot be observed while the map still owns it for stopping. One inert
/// entry per `cs tunnel` invocation is a bounded cost; a stop on one is a
/// no-op send.
fn live_tunnels() -> &'static Mutex<HashMap<String, TunnelHandle>> {
    static TUNNELS: OnceLock<Mutex<HashMap<String, TunnelHandle>>> = OnceLock::new();
    TUNNELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Validate the trigger payload into the spec the client binds. UDP parses on
/// the wire but no end implements datagram relay, so it is refused here with
/// the reason instead of silently behaving like TCP.
fn spec_from_payload(payload: &TunnelOpen) -> Result<TunnelSpec, String> {
    if payload.proto == Proto::Udp {
        return Err("udp tunnels are not implemented yet; only tcp is supported".to_string());
    }
    let bind_addr = payload
        .bind_addr
        .parse()
        .map_err(|e| format!("invalid bind address {:?}: {e}", payload.bind_addr))?;
    Ok(TunnelSpec {
        proto: payload.proto,
        bind_addr,
        desktop_port: payload.desktop_port,
        devserver_port: payload.devserver_port,
    })
}

/// The connection record backing a window, from its `lib-*` label. This is the
/// security property of the whole design: the dial target and credentials come
/// from the desktop's own state for the invoking window, so a forged payload
/// can never point the desktop at another devserver.
fn conn_for_window(state: &AppState, label: &str) -> Result<DevserverConn, String> {
    let id = crate::devserver_id_for_window_label(&state.devserver_feed, label)
        .ok_or_else(|| "this window is not backed by a devserver".to_string())?;
    state
        .devservers
        .get(&id)
        .ok_or_else(|| "the devserver behind this window is not connected".to_string())
}

/// Dial target and credentials for a directly attached devserver: the tunnel
/// endpoint the desktop already dials for everything else, authenticated by
/// the devserver-level bearer.
fn raw_client_config(conn: &DevserverConn, tunnel_id: String, spec: TunnelSpec) -> ClientConfig {
    ClientConfig {
        base_ws_url: format!("ws://{}:{}", conn.host, conn.port),
        bearer: Some(conn.token.clone()),
        cookie: None,
        origin: None,
        tunnel_id,
        spec,
    }
}

/// Dial target and credentials for a gateway-attached devserver, built from
/// the same three pieces the window feed's socket uses. The cookie header is
/// passed in because minting it is async, which keeps this a pure mapping the
/// tests can pin.
fn gateway_client_config(
    conn: &DevserverConn,
    cookie_header: String,
    tunnel_id: String,
    spec: TunnelSpec,
) -> Result<ClientConfig, String> {
    Ok(ClientConfig {
        // Each socket appends its own path and query, so the base is the
        // pinned proxy origin and nothing else.
        base_ws_url: crate::devserver::gateway_ws_url(conn, "")?,
        // The gateway hop authenticates the browser session; the
        // devserver-level bearer is not part of it and never leaves the
        // machine's own connection record.
        bearer: None,
        cookie: Some(cookie_header),
        origin: Some(crate::window_watcher_wiring::gateway_ws_origin(conn)?.to_string()),
        tunnel_id,
        spec,
    })
}

/// Resolve the dial target and credentials for whichever way this devserver is
/// attached.
async fn client_config(
    conn: &DevserverConn,
    tunnel_id: String,
    spec: TunnelSpec,
) -> Result<ClientConfig, String> {
    if conn.gateway.is_none() {
        return Ok(raw_client_config(conn, tunnel_id, spec));
    }
    // TODO: a gateway browser session expires absolutely (an hour at most) and
    // can be revoked, and the proxy force-closes the WebSocket bridges on
    // either, so a long-lived gateway tunnel dies mid-flight with live
    // connections on it. The fix is a devserver-side grace window that holds
    // the registration open while the desktop redials it by tunnel id.
    let cookie_header = crate::devserver::gateway_cookie_header(conn).await?;
    gateway_client_config(conn, cookie_header, tunnel_id, spec)
}

/// Open the reverse tunnel a devserver's `cs tunnel` asked for. `open` dials
/// the control socket before it binds, so a bind failure is reported to the
/// devserver itself and the error return here only feeds the SPA's
/// console/status surface.
///
/// A refusal reached before that dial cannot be reported, and for the two that
/// matter it never could be: an unresolvable window names no devserver to tell,
/// and a gateway session that will not mint is the very credential the telling
/// would need. Both leave the blocked `cs tunnel` to its ready timeout. The
/// spec refusals below are reachable only from a client other than `cs`, which
/// refuses an unsupported protocol and a malformed spec at its own edge.
#[tauri::command]
pub async fn open_reverse_tunnel(
    state: State<'_, Arc<AppState>>,
    window: tauri::WebviewWindow,
    payload: TunnelOpen,
) -> Result<(), String> {
    let spec = spec_from_payload(&payload)?;
    let conn = conn_for_window(&state, window.label())?;
    if !spec.is_loopback_bind() {
        // Parsing keeps a non-loopback bind valid on purpose; the edge warns.
        tracing::warn!(tunnel = %payload.tunnel_id, %spec, "reverse tunnel binds beyond loopback");
    }
    let cfg = client_config(&conn, payload.tunnel_id.clone(), spec).await?;
    match chan_revtunnel::client::open(cfg).await {
        Ok(handle) => {
            tracing::info!(tunnel = %payload.tunnel_id, bound = %handle.bound, "reverse tunnel listening");
            if let Some(previous) = live_tunnels()
                .lock()
                .unwrap()
                .insert(payload.tunnel_id.clone(), handle)
            {
                // A replayed trigger for the same id: the newer listener wins.
                // Stop the older one and hold its handle until the wind-down
                // completes (dropping a still-running handle is not a stop).
                previous.stop();
                tauri::async_runtime::spawn(async move { previous.wait().await });
            }
            Ok(())
        }
        Err(e) => {
            tracing::warn!(tunnel = %payload.tunnel_id, error = %e, "reverse tunnel failed to open");
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chan_revtunnel::wire::{CONTROL_PATH, TUNNEL_PARAM};
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    fn payload(proto: Proto, bind_addr: &str) -> TunnelOpen {
        TunnelOpen {
            tunnel_id: "tun-test".into(),
            proto,
            bind_addr: bind_addr.into(),
            desktop_port: 8080,
            devserver_port: 3000,
        }
    }

    #[test]
    fn udp_is_refused_with_the_reason() {
        let err = spec_from_payload(&payload(Proto::Udp, "127.0.0.1")).unwrap_err();
        assert!(err.contains("not implemented"), "unexpected error: {err}");
    }

    #[test]
    fn the_payload_maps_into_the_spec_verbatim() {
        let spec = spec_from_payload(&payload(Proto::Tcp, "127.0.0.1")).unwrap();
        assert_eq!(spec.bind_addr, IpAddr::V4(Ipv4Addr::LOCALHOST));
        assert_eq!(spec.desktop_port, 8080);
        assert_eq!(spec.devserver_port, 3000);
        assert!(spec.is_loopback_bind());

        let spec = spec_from_payload(&payload(Proto::Tcp, "::1")).unwrap();
        assert_eq!(spec.bind_addr, IpAddr::V6(Ipv6Addr::LOCALHOST));
    }

    #[test]
    fn a_malformed_bind_address_is_named() {
        let err = spec_from_payload(&payload(Proto::Tcp, "nope")).unwrap_err();
        assert!(err.contains("\"nope\""), "unexpected error: {err}");
    }

    fn spec() -> TunnelSpec {
        spec_from_payload(&payload(Proto::Tcp, "127.0.0.1")).unwrap()
    }

    fn raw_conn() -> DevserverConn {
        DevserverConn {
            host: "127.0.0.1".into(),
            port: 8787,
            token: "devserver-token".into(),
            name: "dev".into(),
            gateway: None,
        }
    }

    fn gateway_conn(proxy_origin: &str) -> DevserverConn {
        let parsed = url::Url::parse(proxy_origin).unwrap();
        DevserverConn {
            host: parsed.host_str().unwrap().into(),
            port: parsed.port_or_known_default().unwrap(),
            token: String::new(),
            name: "alice".into(),
            gateway: Some(Box::new(crate::devserver::GatewayConn::new(
                "https://gw.chan.app".into(),
                "https://gw.chan.app/desktop/v1/devserver/entry".into(),
                proxy_origin.into(),
                "pat".into(),
            ))),
        }
    }

    /// The URL `chan_revtunnel::client` dials for the control socket, composed
    /// the way the client composes it.
    fn control_url(cfg: &ClientConfig) -> String {
        format!(
            "{}{CONTROL_PATH}?{TUNNEL_PARAM}={}",
            cfg.base_ws_url.trim_end_matches('/'),
            cfg.tunnel_id
        )
    }

    #[test]
    fn a_direct_devserver_is_dialed_at_its_own_authority_with_its_bearer() {
        let cfg = raw_client_config(&raw_conn(), "tun-test".into(), spec());
        assert_eq!(
            control_url(&cfg),
            "ws://127.0.0.1:8787/api/library/tunnel/control?tunnel=tun-test"
        );
        assert_eq!(cfg.bearer.as_deref(), Some("devserver-token"));
        assert_eq!(cfg.cookie, None);
        assert_eq!(cfg.origin, None);
    }

    #[test]
    fn a_gateway_devserver_is_dialed_at_its_pinned_proxy_origin_over_wss() {
        let conn = gateway_conn("https://alice--0123456789ab.p1.proxy.chan.app");
        let cfg = gateway_client_config(
            &conn,
            "__Host-devserver_gate=g".into(),
            "t-1".into(),
            spec(),
        )
        .unwrap();
        assert_eq!(
            control_url(&cfg),
            "wss://alice--0123456789ab.p1.proxy.chan.app\
             /api/library/tunnel/control?tunnel=t-1"
        );
        assert_eq!(cfg.cookie.as_deref(), Some("__Host-devserver_gate=g"));
        // The Origin is the external https origin, never the wss dial URL:
        // the gateway rejects a cookie-authenticated upgrade carrying
        // anything else.
        assert_eq!(
            cfg.origin.as_deref(),
            Some("https://alice--0123456789ab.p1.proxy.chan.app")
        );
        // The devserver-level bearer stays on the machine's own connection
        // record: the gateway hop authenticates the browser session.
        assert_eq!(cfg.bearer, None);
    }

    #[test]
    fn a_loopback_gateway_keeps_its_scheme_and_port() {
        let conn = gateway_conn("http://alice--0123456789ab.p1.localtest.me:8080");
        let cfg = gateway_client_config(
            &conn,
            "__Host-devserver_gate=g".into(),
            "t-1".into(),
            spec(),
        )
        .unwrap();
        assert_eq!(
            control_url(&cfg),
            "ws://alice--0123456789ab.p1.localtest.me:8080\
             /api/library/tunnel/control?tunnel=t-1"
        );
        assert_eq!(
            cfg.origin.as_deref(),
            Some("http://alice--0123456789ab.p1.localtest.me:8080")
        );
    }

    #[tokio::test]
    async fn a_direct_devserver_needs_no_gateway_session() {
        // The attach shape decides the credentials: this path must not reach
        // for a gateway session (there is none to mint, and the call is I/O).
        let cfg = client_config(&raw_conn(), "tun-test".into(), spec())
            .await
            .unwrap();
        assert_eq!(cfg.base_ws_url, "ws://127.0.0.1:8787");
        assert!(cfg.cookie.is_none() && cfg.origin.is_none());
    }
}
