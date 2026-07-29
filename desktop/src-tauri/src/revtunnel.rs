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

/// Open the reverse tunnel a devserver's `cs tunnel` asked for. `open` reports
/// a bind failure to the devserver itself over the control socket, so the
/// error return here only feeds the SPA's console/status surface; resolution
/// failures never reach the devserver and surface as its ready timeout.
#[tauri::command]
pub async fn open_reverse_tunnel(
    state: State<'_, Arc<AppState>>,
    window: tauri::WebviewWindow,
    payload: TunnelOpen,
) -> Result<(), String> {
    let spec = spec_from_payload(&payload)?;
    let conn = conn_for_window(&state, window.label())?;
    if conn.gateway.is_some() {
        return Err("cs tunnel is not supported on gateway-attached devservers yet".to_string());
    }
    if !spec.is_loopback_bind() {
        // Parsing keeps a non-loopback bind valid on purpose; the edge warns.
        tracing::warn!(tunnel = %payload.tunnel_id, %spec, "reverse tunnel binds beyond loopback");
    }
    let cfg = ClientConfig {
        base_ws_url: format!("ws://{}:{}", conn.host, conn.port),
        bearer: Some(conn.token.clone()),
        // Raw attach only: the gateway path (cookie + origin) is refused above.
        cookie: None,
        origin: None,
        tunnel_id: payload.tunnel_id.clone(),
        spec,
    };
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
}
