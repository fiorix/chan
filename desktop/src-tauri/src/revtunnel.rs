//! Desktop side of `cs tunnel`: the reverse-tunnel trigger command.
//!
//! A devserver terminal's `cs tunnel` pushes a `tunnel_open` window_command to
//! the terminal's OWN window over the tenant `/ws`; the SPA forwards the
//! payload here. The payload describes the server-minted tunnel id, protocol,
//! bind address, ports, and half-close support but carries no independently
//! usable capability. The devserver to answer is resolved from the invoking
//! window's own connection record (its `lib-*` label), never from the payload:
//! a page can only ask its own devserver for what that devserver could already
//! ask itself.
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
//!
//! Either shape's sockets take the route the feeds take, the process's
//! WireGuard decision, so a tunnel also reaches its devserver wherever that
//! feed does: a gateway's tenant name that only the fabric's proxy can carry
//! needs no DNS on this machine for a tunnel either.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use chan_revtunnel::client::{ClientConfig, ConnectFuture, Transport, TunnelHandle};
use chan_revtunnel::{Proto, TunnelOpen, TunnelSpec};
use tauri::State;
use tokio_tungstenite::tungstenite::http::Uri;

use crate::devserver::DevserverConn;
use crate::wireguard::WsRoute;
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

/// The route of every tunnel socket, control and data: the dial the
/// process's WireGuard fabric decides, as the window feeds take it. A host
/// that is not loopback is reached by a CONNECT through the fabric's proxy,
/// which carries a gateway's names into their tunnel with no lookup on this
/// machine; a loopback host, or a process with no fabric, is dialed directly.
/// The decision is read at each dial. A CONNECT the proxy refuses fails that
/// socket: a host the fabric routes is never dialed around it.
struct FabricTransport {
    route: Box<RouteOf>,
}

/// Where a WebSocket dial of a URL goes, the question
/// [`crate::wireguard::ws_route`] answers for the process.
type RouteOf = dyn Fn(&Uri) -> Option<WsRoute> + Send + Sync;

impl FabricTransport {
    fn of_process() -> Arc<dyn Transport> {
        Arc::new(Self {
            route: Box::new(crate::wireguard::ws_route),
        })
    }
}

impl Transport for FabricTransport {
    fn connect<'a>(&'a self, uri: &'a Uri) -> ConnectFuture<'a> {
        Box::pin(async move {
            match (self.route)(uri) {
                None => Ok(None),
                Some(route) => {
                    crate::wireguard::connect_through(route.proxy, &route.host, route.port)
                        .await
                        .map(Some)
                }
            }
        })
    }
}

/// Dial target and credentials for a directly attached devserver: the tunnel
/// endpoint the desktop already dials for everything else, authenticated by
/// the devserver-level bearer.
fn raw_client_config(
    conn: &DevserverConn,
    tunnel_id: String,
    spec: TunnelSpec,
    half_close: bool,
) -> ClientConfig {
    ClientConfig {
        base_ws_url: format!("ws://{}:{}", conn.host, conn.port),
        bearer: Some(conn.token.clone()),
        cookie: None,
        origin: None,
        tunnel_id,
        spec,
        half_close,
        // A `ws://` origin runs no TLS.
        connector: None,
        transport: Some(FabricTransport::of_process()),
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
    half_close: bool,
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
        half_close,
        // The gateway is verified as the window feed verifies it, over the
        // route the window feed takes to it.
        connector: Some(crate::tls::ws_connector()?),
        transport: Some(FabricTransport::of_process()),
    })
}

/// Resolve the dial target and credentials for whichever way this devserver is
/// attached.
async fn client_config(
    conn: &DevserverConn,
    tunnel_id: String,
    spec: TunnelSpec,
    half_close: bool,
) -> Result<ClientConfig, String> {
    if conn.gateway.is_none() {
        return Ok(raw_client_config(conn, tunnel_id, spec, half_close));
    }
    // TODO: a gateway browser session expires absolutely (an hour at most) and
    // can be revoked, and the proxy force-closes the WebSocket bridges on
    // either, so a long-lived gateway tunnel dies mid-flight with live
    // connections on it. The fix is a devserver-side grace window that holds
    // the registration open while the desktop redials it by tunnel id.
    let cookie_header = crate::devserver::gateway_cookie_header(conn).await?;
    gateway_client_config(conn, cookie_header, tunnel_id, spec, half_close)
}

/// Open the reverse tunnel a devserver's `cs tunnel` asked for. `open` dials the control socket before it binds, so a bind failure is reported to the devserver itself and the error return here only feeds the SPA's console/status surface.
///
/// The embedded host refuses local `cs tunnel` requests before broadcasting a trigger. `conn_for_window` also refuses any trigger that reaches a local window, because that window has no devserver connection to answer.
///
/// A refusal before the control dial cannot be reported: an unresolvable window names no devserver to tell, and a gateway session that will not mint is the credential the report would need. A devserver request refused here therefore leaves the blocked `cs tunnel` to its ready timeout. The spec refusals below are reachable only from a client other than `cs`, which refuses an unsupported protocol and a malformed spec at its own edge.
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
    let cfg = client_config(&conn, payload.tunnel_id.clone(), spec, payload.half_close).await?;
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
                // completes; dropping the handle requests shutdown but does not wait for it.
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
            half_close: true,
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
        let cfg = raw_client_config(&raw_conn(), "tun-test".into(), spec(), true);
        assert_eq!(
            control_url(&cfg),
            "ws://127.0.0.1:8787/api/library/tunnel/control?tunnel=tun-test"
        );
        assert_eq!(cfg.bearer.as_deref(), Some("devserver-token"));
        assert_eq!(cfg.cookie, None);
        assert_eq!(cfg.origin, None);
        assert!(cfg.half_close);
        assert!(cfg.connector.is_none(), "a ws:// dial runs no TLS");
        assert!(cfg.transport.is_some(), "the fabric decides the route");
    }

    #[test]
    fn a_gateway_devserver_is_dialed_at_its_pinned_proxy_origin_over_wss() {
        let conn = gateway_conn("https://alice--0123456789ab.p1.proxy.chan.app");
        let cfg = gateway_client_config(
            &conn,
            "__Host-devserver_gate=g".into(),
            "t-1".into(),
            spec(),
            true,
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
        assert!(cfg.half_close);
        // The gateway is verified with the shared trust decision, not
        // tokio-tungstenite's bundled roots.
        assert!(matches!(
            cfg.connector,
            Some(tokio_tungstenite::Connector::Rustls(_))
        ));
        // The route is the fabric's, a decision apart from that trust.
        assert!(cfg.transport.is_some(), "the fabric decides the route");
    }

    #[test]
    fn a_loopback_gateway_keeps_its_scheme_and_port() {
        let conn = gateway_conn("http://alice--0123456789ab.p1.localtest.me:8080");
        let cfg = gateway_client_config(
            &conn,
            "__Host-devserver_gate=g".into(),
            "t-1".into(),
            spec(),
            true,
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

    /// A gateway-attached native tunnel presents the cached session that the
    /// gateway's desktop entry route minted for this connection's PAT. The
    /// session publisher also installs the same cookie values in the webview
    /// store, so a main-frame script at the tenant origin can present that
    /// admitted owner-desktop session too. The leg gate refuses a grantee's
    /// desktop session and the owner's browser session. A refreshed desktop
    /// session comes from the same entry route.
    #[tokio::test]
    async fn a_gateway_tunnel_presents_the_session_the_desktop_entry_route_minted() {
        use axum::http::{HeaderMap, StatusCode};
        use std::sync::atomic::{AtomicUsize, Ordering};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let identity_origin = format!("http://127.0.0.1:{port}");
        let proxy_origin = format!("http://alice--aaaaaaaaaaaa.p1.localtest.me:{port}");
        let owner_user_id = uuid::Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap();
        let mints = Arc::new(AtomicUsize::new(0));
        let entry_bearers = Arc::new(Mutex::new(Vec::<String>::new()));
        let exchanged = Arc::new(Mutex::new(Vec::<String>::new()));
        let app = axum::Router::new()
            .route(
                "/desktop/v1/devserver/entry",
                axum::routing::post({
                    let mints = Arc::clone(&mints);
                    let entry_bearers = Arc::clone(&entry_bearers);
                    let proxy_origin = proxy_origin.clone();
                    move |headers: HeaderMap| {
                        let mint = mints.fetch_add(1, Ordering::SeqCst);
                        entry_bearers.lock().unwrap().push(
                            headers
                                .get("authorization")
                                .map(|value| value.to_str().unwrap().to_string())
                                .unwrap_or_default(),
                        );
                        let proxy_origin = proxy_origin.clone();
                        async move {
                            axum::Json(serde_json::json!({
                                "owner_user_id": owner_user_id,
                                "username": "alice",
                                "devserver_id": "a".repeat(64),
                                "proxy_origin": proxy_origin,
                                "entry_exchange_url": format!("{proxy_origin}/_chan/entry"),
                                "entry_credential": format!("desktop-entry-credential-{mint}"),
                            }))
                        }
                    }
                }),
            )
            .route(
                "/_chan/entry",
                axum::routing::post({
                    let exchanged = Arc::clone(&exchanged);
                    move |body: axum::body::Bytes| {
                        let credential = url::form_urlencoded::parse(&body)
                            .find(|(name, _)| name == "credential")
                            .map(|(_, value)| value.into_owned())
                            .unwrap_or_default();
                        exchanged.lock().unwrap().push(credential.clone());
                        async move {
                            axum::response::Response::builder()
                                .status(StatusCode::SEE_OTHER)
                                .header("location", "/")
                                .header(
                                    "set-cookie",
                                    format!("__Host-devserver_gate=gate-for-{credential}; Path=/; HttpOnly; Max-Age=3600"),
                                )
                                .header(
                                    "set-cookie",
                                    format!("__Host-devserver_csrf=csrf-for-{credential}; Path=/; Max-Age=3600"),
                                )
                                .body(axum::body::Body::empty())
                                .unwrap()
                        }
                    }
                }),
            );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let discovery = crate::devserver::GatewayDiscovery {
            kind: "chan-gateway".into(),
            api_version: 1,
            identity_origin: identity_origin.clone(),
            desktop_authorize_url: format!("{identity_origin}/desktop/authorize"),
            desktop_entry_url: format!("{identity_origin}/desktop/v1/devserver/entry"),
            devserver_proxy_origin: format!("http://localtest.me:{port}"),
            devserver_proxy_host_depth: 2,
            roster_url: None,
            wireguard: None,
        };
        let gateway = crate::devserver::gateway_conn(
            &discovery,
            "desktop-pat".into(),
            Some(crate::devserver::GatewayEntryTarget {
                owner_user_id,
                owner: "alice".into(),
                devserver_id: "a".repeat(64),
            }),
        )
        .await
        .expect("desktop entry and exchange");
        let conn = DevserverConn {
            host: "alice--aaaaaaaaaaaa.p1.localtest.me".into(),
            port,
            token: "devserver-token".into(),
            name: "alice".into(),
            gateway: Some(Box::new(gateway)),
        };

        let cfg = client_config(&conn, "tun-1".into(), spec(), true)
            .await
            .unwrap();
        let first = "__Host-devserver_gate=gate-for-desktop-entry-credential-0; \
                     __Host-devserver_csrf=csrf-for-desktop-entry-credential-0";
        assert_eq!(cfg.cookie.as_deref(), Some(first));
        assert_eq!(cfg.bearer, None);

        crate::devserver::refresh_gateway_session_if_current(&conn, first)
            .await
            .expect("refresh through the desktop entry route");
        let cfg = client_config(&conn, "tun-1".into(), spec(), true)
            .await
            .unwrap();
        assert_eq!(
            cfg.cookie.as_deref(),
            Some(
                "__Host-devserver_gate=gate-for-desktop-entry-credential-1; \
                 __Host-devserver_csrf=csrf-for-desktop-entry-credential-1"
            )
        );

        assert_eq!(
            *entry_bearers.lock().unwrap(),
            vec!["Bearer desktop-pat".to_string(); 2],
            "every session the legs present was minted by the desktop entry route"
        );
        assert_eq!(
            *exchanged.lock().unwrap(),
            vec![
                "desktop-entry-credential-0".to_string(),
                "desktop-entry-credential-1".to_string()
            ]
        );
        server.abort();
    }

    /// What one upgrade to the tenant fixture carried.
    #[derive(Debug, Clone, PartialEq, Eq)]
    struct Upgrade {
        /// The request target: path and query.
        target: String,
        host: Option<String>,
        cookie: Option<String>,
        origin: Option<String>,
        authorization: Option<String>,
    }

    /// A devserver stand-in on loopback: it records every upgrade, hands the
    /// control socket's text frames to the test, and answers each data
    /// socket's binary frames with `re:` and the bytes.
    struct Tenant {
        addr: std::net::SocketAddr,
        upgrades: Arc<Mutex<Vec<Upgrade>>>,
        control: tokio::sync::mpsc::Receiver<String>,
    }

    impl Tenant {
        async fn start() -> Self {
            use futures::{SinkExt, StreamExt};
            use tokio_tungstenite::tungstenite::handshake::server::Request;
            use tokio_tungstenite::tungstenite::Message;

            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let upgrades = Arc::new(Mutex::new(Vec::new()));
            let (control_tx, control) = tokio::sync::mpsc::channel(8);
            let seen = Arc::clone(&upgrades);
            tokio::spawn(async move {
                while let Ok((sock, _)) = listener.accept().await {
                    let seen = Arc::clone(&seen);
                    let control_tx = control_tx.clone();
                    tokio::spawn(async move {
                        let mut upgrade = None;
                        let accepted = tokio_tungstenite::accept_hdr_async(
                            sock,
                            #[allow(clippy::result_large_err)]
                            |request: &Request, response| {
                                let header = |name: &str| {
                                    request
                                        .headers()
                                        .get(name)
                                        .map(|value| value.to_str().unwrap().to_string())
                                };
                                upgrade = Some(Upgrade {
                                    target: request
                                        .uri()
                                        .path_and_query()
                                        .map(|target| target.to_string())
                                        .unwrap_or_default(),
                                    host: header("host"),
                                    cookie: header("cookie"),
                                    origin: header("origin"),
                                    authorization: header("authorization"),
                                });
                                Ok(response)
                            },
                        )
                        .await;
                        let (Ok(mut ws), Some(upgrade)) = (accepted, upgrade) else {
                            return;
                        };
                        let is_control = upgrade.target.starts_with(CONTROL_PATH);
                        seen.lock().unwrap().push(upgrade);
                        while let Some(Ok(frame)) = ws.next().await {
                            let open = match frame {
                                Message::Text(text) if is_control => {
                                    let _ = control_tx.send(text.to_string()).await;
                                    true
                                }
                                Message::Binary(bytes) => {
                                    let answer = [b"re:".as_slice(), &bytes].concat();
                                    ws.send(Message::binary(answer)).await.is_ok()
                                }
                                Message::Close(_) => false,
                                _ => true,
                            };
                            if !open {
                                break;
                            }
                        }
                    });
                }
            });
            Self {
                addr,
                upgrades,
                control,
            }
        }

        fn upgrades(&self) -> Vec<Upgrade> {
            self.upgrades.lock().unwrap().clone()
        }

        async fn ready(&mut self) -> chan_revtunnel::ControlFrame {
            let text = within("the ready frame", self.control.recv())
                .await
                .expect("the control socket reached the tenant");
            serde_json::from_str(&text).expect("a control frame")
        }
    }

    /// A CONNECT proxy standing where the fabric's stands. It records each
    /// request line and, when it carries, answers 200 and splices the stream
    /// to `upstream` whatever authority was named, as the fabric's proxy
    /// carries a mapped name into its tunnel; otherwise it answers 403.
    struct FabricProxy {
        addr: std::net::SocketAddr,
        connects: Arc<Mutex<Vec<String>>>,
    }

    impl FabricProxy {
        async fn start(upstream: std::net::SocketAddr, carries: bool) -> Self {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};

            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let connects = Arc::new(Mutex::new(Vec::new()));
            let seen = Arc::clone(&connects);
            tokio::spawn(async move {
                while let Ok((mut client, _)) = listener.accept().await {
                    let seen = Arc::clone(&seen);
                    tokio::spawn(async move {
                        let mut head = Vec::new();
                        while !head.ends_with(b"\r\n\r\n") {
                            let Ok(byte) = client.read_u8().await else {
                                return;
                            };
                            head.push(byte);
                        }
                        let head = String::from_utf8_lossy(&head);
                        seen.lock()
                            .unwrap()
                            .push(head.lines().next().unwrap_or("").to_string());
                        if !carries {
                            let _ = client
                                .write_all(
                                    b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\
                                      Connection: close\r\n\r\n",
                                )
                                .await;
                            return;
                        }
                        if client
                            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                            .await
                            .is_err()
                        {
                            return;
                        }
                        let Ok(mut upstream) = tokio::net::TcpStream::connect(upstream).await
                        else {
                            return;
                        };
                        let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
                    });
                }
            });
            Self { addr, connects }
        }

        fn connects(&self) -> Vec<String> {
            self.connects.lock().unwrap().clone()
        }

        /// The fabric's routing decision for a process whose proxy is this
        /// one: the host classification the window feeds dial by.
        fn transport(&self) -> Arc<dyn Transport> {
            let proxy = self.addr;
            Arc::new(FabricTransport {
                route: Box::new(move |uri| crate::wireguard::ws_route_with(Some(proxy), uri)),
            })
        }
    }

    async fn within<T>(what: &str, future: impl std::future::Future<Output = T>) -> T {
        tokio::time::timeout(std::time::Duration::from_secs(10), future)
            .await
            .unwrap_or_else(|_| panic!("{what} did not finish"))
    }

    /// One caller's round trip through a tunnel's listener.
    async fn round_trip(bound: std::net::SocketAddr, bytes: &[u8]) -> tokio::net::TcpStream {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let mut caller = within(
            "the caller's connect",
            tokio::net::TcpStream::connect(bound),
        )
        .await
        .expect("the tunnel's listener accepts");
        caller.write_all(bytes).await.unwrap();
        let answer = [b"re:".as_slice(), bytes].concat();
        let mut back = vec![0u8; answer.len()];
        within("the tenant's answer", caller.read_exact(&mut back))
            .await
            .expect("the answer crosses the data socket");
        assert_eq!(back, answer);
        caller
    }

    /// The spec of a tunnel on a listener port the OS picks.
    fn any_port_spec() -> TunnelSpec {
        TunnelSpec {
            desktop_port: 0,
            ..spec()
        }
    }

    /// A tenant name no resolver answers (RFC 6761 reserves `.invalid`), on a
    /// port nothing here listens on: the tenant is reached through the proxy
    /// or not at all.
    const TENANT_AUTHORITY: &str = "alice--0123456789ab.p1.proxy.chan.invalid:8080";

    #[tokio::test]
    async fn a_gateway_tunnel_reaches_a_tenant_only_the_fabric_proxy_can_name() {
        let mut tenant = Tenant::start().await;
        let proxy = FabricProxy::start(tenant.addr, true).await;
        let conn = gateway_conn(&format!("http://{TENANT_AUTHORITY}"));
        let mut cfg = gateway_client_config(
            &conn,
            "__Host-devserver_gate=g".into(),
            "t-1".into(),
            any_port_spec(),
            true,
        )
        .unwrap();
        cfg.transport = Some(proxy.transport());

        let handle = within("the tunnel's open", chan_revtunnel::client::open(cfg))
            .await
            .expect("the control socket goes through the proxy");
        assert_eq!(
            tenant.ready().await,
            chan_revtunnel::ControlFrame::Ready {
                bound: handle.bound.to_string()
            }
        );
        // Two forwarded connections, the first still open while the second
        // is served.
        let first = round_trip(handle.bound, b"one").await;
        let second = round_trip(handle.bound, b"two").await;

        // The control socket and each data socket asked the proxy for the
        // tenant's own authority.
        assert_eq!(
            proxy.connects(),
            vec![format!("CONNECT {TENANT_AUTHORITY} HTTP/1.1"); 3]
        );
        // Inside the route every upgrade is the one a direct dial sends: the
        // tenant's host, the session cookie and the external origin.
        let upgrade = |target: &str| Upgrade {
            target: target.to_string(),
            host: Some(TENANT_AUTHORITY.to_string()),
            cookie: Some("__Host-devserver_gate=g".into()),
            origin: Some(format!("http://{TENANT_AUTHORITY}")),
            authorization: None,
        };
        assert_eq!(
            tenant.upgrades(),
            [
                upgrade("/api/library/tunnel/control?tunnel=t-1"),
                upgrade("/api/library/tunnel/conn?tunnel=t-1&conn=c0&half_close=true"),
                upgrade("/api/library/tunnel/conn?tunnel=t-1&conn=c1&half_close=true"),
            ]
        );
        drop((first, second));
        handle.stop();
        within("the tunnel's end", handle.wait()).await;
    }

    #[tokio::test]
    async fn a_tunnel_the_fabric_proxy_refuses_does_not_open() {
        let tenant = Tenant::start().await;
        let proxy = FabricProxy::start(tenant.addr, false).await;
        let conn = gateway_conn(&format!("http://{TENANT_AUTHORITY}"));
        let mut cfg = gateway_client_config(
            &conn,
            "__Host-devserver_gate=g".into(),
            "t-1".into(),
            any_port_spec(),
            true,
        )
        .unwrap();
        cfg.transport = Some(proxy.transport());

        let err = within("the tunnel's open", chan_revtunnel::client::open(cfg))
            .await
            .unwrap_err();
        assert!(err.contains("connect tunnel control socket"), "{err}");
        assert!(err.contains("403"), "the proxy's refusal is named: {err}");
        assert_eq!(
            proxy.connects(),
            [format!("CONNECT {TENANT_AUTHORITY} HTTP/1.1")]
        );
        assert_eq!(tenant.upgrades(), []);
    }

    #[tokio::test]
    async fn a_loopback_devserver_is_dialed_without_the_fabric_proxy() {
        // A devserver on this machine must not depend on the proxy being up:
        // with a fabric in the process its tunnel sockets still dial it
        // directly, under its own bearer.
        let mut tenant = Tenant::start().await;
        let proxy = FabricProxy::start(tenant.addr, false).await;
        let conn = DevserverConn {
            port: tenant.addr.port(),
            ..raw_conn()
        };
        let mut cfg = raw_client_config(&conn, "t-1".into(), any_port_spec(), true);
        cfg.transport = Some(proxy.transport());

        let handle = within("the tunnel's open", chan_revtunnel::client::open(cfg))
            .await
            .expect("a loopback devserver is dialed directly");
        assert!(matches!(
            tenant.ready().await,
            chan_revtunnel::ControlFrame::Ready { .. }
        ));
        let _caller = round_trip(handle.bound, b"local").await;
        assert_eq!(proxy.connects(), Vec::<String>::new());
        let upgrades = tenant.upgrades();
        assert_eq!(upgrades.len(), 2);
        for upgrade in upgrades {
            assert_eq!(upgrade.host, Some(tenant.addr.to_string()));
            assert_eq!(
                upgrade.authorization.as_deref(),
                Some("Bearer devserver-token")
            );
        }
    }

    #[tokio::test]
    async fn a_direct_devserver_needs_no_gateway_session() {
        // The attach shape decides the credentials: this path must not reach
        // for a gateway session (there is none to mint, and the call is I/O).
        let cfg = client_config(&raw_conn(), "tun-test".into(), spec(), true)
            .await
            .unwrap();
        assert_eq!(cfg.base_ws_url, "ws://127.0.0.1:8787");
        assert!(cfg.cookie.is_none() && cfg.origin.is_none());
    }
}
