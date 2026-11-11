//! The WireGuard fabric: in-process tunnels to the gateways configured with
//! a wg-quick file or enrolled parameters, and the loopback CONNECT proxy
//! every outbound leg reaches those gateways through.
//!
//! The proxy is bound at start, before any HTTP client or webview exists,
//! whether or not a gateway carries a file, and lives for the process. The
//! three legs to a gateway, the HTTP clients, the window feed's WebSocket
//! and the webviews, all know how to dial through an HTTP proxy, so one
//! proxy puts them inside the tunnels with no interface, route or privilege
//! on the host. Its address is the one thing decided once per process,
//! because the webview proxy is: WebView2 takes it as a browser argument
//! shared by every webview of the process, so the launcher and every window
//! carry the same value. What the proxy routes is not decided at start: the
//! tunnels are a live registry behind it, keyed by gateway id. A row's source
//! is adopted when it is set or changed through the Gateways form, when the
//! row connects, and at start for every enabled row. An enrolled row holds
//! one tunnel per ingress, with its own host map; a manual file stays one
//! tunnel. A cleared source, a removed row and a user disconnect retire
//! every tunnel of that row. A file that cannot be read or a
//! tunnel that cannot start disables that row alone, with the reader's
//! message, until its next adopt; a proxy that cannot bind disables every
//! WireGuard row with that reason, and the app runs without a proxy.
//!
//! The proxy routes by destination: an address inside a tunnel's AllowedIPs
//! goes through that tunnel, anything else is connected directly. The
//! loopback destinations of the Rust legs (the embedded server, a devserver
//! on this machine) never enter the proxy at all, so they do not depend on
//! it being up; the webviews on Linux have no such exception, so there every
//! local window reaches the embedded server through the proxy's plain HTTP
//! forwarding, with or without a gateway.

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use chan_wireguard::{ConnectProxy, HostRoute, ProxyRoute, Tunnel};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::http::Uri;
use url::Url;

use crate::config::{Gateway, WireguardEnrollment};

/// The destinations the HTTP clients dial without the proxy: the proxy
/// would only pass them through, and the embedded server and a devserver on
/// this machine must not depend on it being up.
const DIRECT_HOSTS: &str = "127.0.0.0/8,::1,localhost";

/// A CONNECT exchange, connect included, is bounded so a proxy that stops
/// answering fails the feed round instead of holding it.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// A CONNECT response head longer than this without its blank line is a
/// broken proxy; the bound keeps the byte-wise read from growing forever.
const MAX_RESPONSE_HEAD: usize = 16 * 1024;

/// The process's proxy and the tunnels it routes, one row per gateway that
/// was adopted. Dropping it ends the proxy and every tunnel and connection
/// through it, so it lives in [`AppState`](crate::AppState) for the
/// process.
pub struct WireguardFabric {
    proxy: Proxy,
    /// The runtime every tunnel's driver runs on, whichever thread adopts.
    runtime: tokio::runtime::Handle,
    /// One row per adopted gateway. Adopt and retire hold it from the check
    /// to the swap, so concurrent adopts never race on an ingress.
    rows: Mutex<HashMap<String, GatewayRow>>,
    /// Gateways keep their place; each row follows its ingress list order.
    next_route_order: AtomicU64,
    #[cfg(test)]
    refused_starts: Mutex<std::collections::HashSet<String>>,
}

enum Proxy {
    Bound {
        proxy: ConnectProxy,
        url: Url,
    },
    /// The bind failed: no row can be reached, and this is why.
    Unavailable(String),
}

/// One gateway's routes in discovery order. Only public parameters are
/// retained for comparison; each tunnel owns its private configuration.
struct GatewayRow {
    route_order: u64,
    enrollment: Option<(WireguardEnrollment, String)>,
    ingresses: Vec<(String, Row)>,
}

/// One manual tunnel or enrolled ingress.
#[derive(Clone)]
enum Row {
    /// The tunnel runs from `path` (a client file or enrolled key file).
    Running {
        path: PathBuf,
        tunnel: Tunnel,
        hosts: Vec<HostRoute>,
        endpoint: String,
        started: Instant,
        #[cfg(test)]
        test_status: Option<chan_wireguard::Status>,
    },
    /// The source at `path` was refused, for `reason`; nothing runs.
    Refused { path: PathBuf, reason: String },
}

impl WireguardFabric {
    /// Adopt a hand-written file or every peer of an enrolled row.
    /// Enrolled configurations are built in memory from the one key file.
    pub fn adopt_gateway(&self, gateway: &Gateway) -> Option<Result<String, String>> {
        if gateway.wireguard.is_some() && gateway.wireguard_enrollment.is_some() {
            self.retire(&gateway.id);
            return Some(self.adopt_with(
                &gateway.id,
                gateway.wireguard_source().expect("both sources are present"),
                Vec::new(),
                || Err("WireGuard: a gateway cannot name both a manual file and enrolled parameters".into()),
            ));
        }
        // Re-enrollment is the only way to use a regenerated key. Blocking
        // discovery on the obsolete enrollment would block that sign-in.
        // An already-running tunnel keeps its old key until it is replaced.
        if gateway.wireguard_enrollment.is_some()
            && gateway.wireguard_public_key.is_some()
            && gateway.wireguard_public_key != gateway.wireguard_enrolled_key
        {
            let mut rows = self.rows.lock().unwrap();
            if let Some(row) = rows.get_mut(&gateway.id) {
                row.ingresses
                    .retain(|(_, ingress)| matches!(ingress, Row::Running { .. }));
                if row.ingresses.is_empty() {
                    rows.remove(&gateway.id);
                }
            }
            return None;
        }
        let source = gateway.wireguard_source()?;
        if let Some(enrollment) = &gateway.wireguard_enrollment {
            Some(self.adopt_enrolled(gateway, enrollment))
        } else {
            Some(self.adopt(&gateway.id, source, gateway.host_routes()))
        }
    }

    fn adopt_enrolled(
        &self,
        gateway: &Gateway,
        enrollment: &WireguardEnrollment,
    ) -> Result<String, String> {
        if let Proxy::Unavailable(reason) = &self.proxy {
            return Err(reason.clone());
        }
        let mut rows = self.rows.lock().unwrap();
        let key = gateway.wireguard_enrolled_key.clone().unwrap_or_default();
        let previous = rows.get(&gateway.id);
        if let Some(row) = previous {
            if row
                .enrollment
                .as_ref()
                .is_some_and(|(parameters, enrolled_key)| {
                    parameters == enrollment && enrolled_key == &key
                })
                && row
                    .ingresses
                    .iter()
                    .all(|(_, ingress)| matches!(ingress, Row::Running { .. }))
            {
                return row.answer();
            }
        }
        let configs = if key.is_empty() {
            Err("WireGuard: enrollment has no enrolled key".to_string())
        } else {
            enrollment.configs(&key)
        };
        let same_client =
            previous
                .and_then(|r| r.enrollment.as_ref())
                .is_some_and(|(old, old_key)| {
                    old_key == &key
                        && old.key_file == enrollment.key_file
                        && old.addresses == enrollment.addresses
                        && old.allowed_ips == enrollment.allowed_ips
                        && old.persistent_keepalive == enrollment.persistent_keepalive
                });
        let ingresses = match configs {
            Ok(configs) => enrollment
                .ingresses
                .iter()
                .zip(configs)
                .map(|(ingress, config)| {
                    let id = format!("{}/{}", gateway.id, ingress.id);
                    let retained = previous.filter(|_| same_client).and_then(|row| {
                        let (old, _) = row.enrollment.as_ref()?;
                        if !old.ingresses.contains(ingress) {
                            return None;
                        }
                        row.ingresses.iter().find(|(held, state)| {
                            held == &id && matches!(state, Row::Running { .. })
                        })
                    });
                    let state = if let Some((_, state)) = retained {
                        state.clone()
                    } else {
                        let _runtime = self.runtime.enter();
                        let hosts = ingress
                            .hosts
                            .iter()
                            .map(|host| HostRoute {
                                name: host.name.clone(),
                                addresses: host.addresses.clone(),
                            })
                            .collect();
                        #[cfg(test)]
                        if self.refused_starts.lock().unwrap().contains(&id) {
                            return (
                                id,
                                Row::Refused {
                                    path: enrollment.key_file.clone(),
                                    reason: "WireGuard: injected socket refusal".into(),
                                },
                            );
                        }
                        Row::from_started(&enrollment.key_file, hosts, start_config(&id, config))
                    };
                    (id, state)
                })
                .collect(),
            Err(reason) => vec![(
                gateway.id.clone(),
                Row::Refused {
                    path: enrollment.key_file.clone(),
                    reason,
                },
            )],
        };
        let row = GatewayRow {
            route_order: previous
                .map(|row| row.route_order)
                .unwrap_or_else(|| self.next_route_order.fetch_add(1, Ordering::Relaxed)),
            enrollment: Some((enrollment.clone(), key)),
            ingresses,
        };
        self.install_row(&mut rows, &gateway.id, row)
    }

    /// The proxy as the legs name it, `http://127.0.0.1:<port>`; `None`
    /// when it could not bind.
    pub fn proxy_url(&self) -> Option<&Url> {
        match &self.proxy {
            Proxy::Bound { url, .. } => Some(url),
            Proxy::Unavailable(_) => None,
        }
    }

    /// How many tunnels run.
    pub fn tunnels(&self) -> usize {
        self.rows
            .lock()
            .unwrap()
            .values()
            .flat_map(|row| &row.ingresses)
            .filter(|(_, row)| matches!(row, Row::Running { .. }))
            .count()
    }

    /// Start `gateway_id`'s tunnel from the wg-quick file at `conf` and
    /// route it in the running proxy, with `hosts` as the names it carries
    /// without a lookup on the host (empty to route by AllowedIPs alone).
    ///
    /// Synchronous, and callable from any thread: the tunnel's driver is
    /// spawned on the fabric's runtime. The new route is in the proxy
    /// before the row's previous tunnel, if any, is dropped, so the next
    /// connection already goes through the new one while the connections
    /// the old one carries end with it. Answers the tunnel's status for the
    /// launcher, `connecting` until a handshake completes.
    ///
    /// A row already running from `conf` is left as it is and answers its
    /// live status, whatever `hosts` says, so a save that leaves the path
    /// alone never restarts a tunnel; a caller that rewrote the file in
    /// place, or changed the host map, calls [`retire`](Self::retire)
    /// first. A file the reader refuses, a tunnel that does not start or a
    /// host map the proxy refuses answers `Err` with a `WireGuard: ...`
    /// sentence that names the path, the line and the key and never a
    /// value; that row's route and any tunnel it ran are dropped and the
    /// refusal is kept, so [`failure`](Self::failure) reads it while the
    /// row still names `conf`. With no proxy every adopt answers the bind
    /// failure and nothing starts.
    pub fn adopt(
        &self,
        gateway_id: &str,
        conf: &Path,
        hosts: Vec<HostRoute>,
    ) -> Result<String, String> {
        self.adopt_with(gateway_id, conf, hosts, || start_tunnel(gateway_id, conf))
    }

    fn adopt_with(
        &self,
        gateway_id: &str,
        conf: &Path,
        hosts: Vec<HostRoute>,
        start: impl FnOnce() -> Result<(Tunnel, String), String>,
    ) -> Result<String, String> {
        if let Proxy::Unavailable(reason) = &self.proxy {
            return Err(reason.clone());
        }
        let mut rows = self.rows.lock().unwrap();
        if let Some(row) = rows.get(gateway_id) {
            if row.enrollment.is_none()
                && matches!(row.ingresses.first(), Some((_, Row::Running { path, .. })) if path == conf)
            {
                return row.answer();
            }
        }
        let started = {
            let _runtime = self.runtime.enter();
            start()
        };
        let route_order = rows
            .get(gateway_id)
            .map(|row| row.route_order)
            .unwrap_or_else(|| self.next_route_order.fetch_add(1, Ordering::Relaxed));
        let row = GatewayRow {
            route_order,
            enrollment: None,
            ingresses: vec![(
                gateway_id.to_owned(),
                Row::from_started(conf, hosts, started),
            )],
        };
        self.install_row(&mut rows, gateway_id, row)
    }

    fn install_row(
        &self,
        rows: &mut HashMap<String, GatewayRow>,
        gateway_id: &str,
        row: GatewayRow,
    ) -> Result<String, String> {
        let path = row.ingresses[0].1.path().to_owned();
        let previous = rows.insert(gateway_id.to_owned(), row);
        if let Err(error) = self.publish_routes(rows) {
            let reason = format!("WireGuard: {}: {error}", path.display());
            tracing::warn!(gateway = %gateway_id, %error, "gateway WireGuard host map refused");
            rows.get_mut(gateway_id).expect("inserted row").ingresses =
                vec![(gateway_id.to_owned(), Row::Refused { path, reason })];
            self.publish_routes(rows)
                .expect("remaining routes were validated at their adoption");
        }
        for (id, row) in &rows[gateway_id].ingresses {
            if let Row::Running {
                path,
                endpoint,
                started,
                ..
            } = row
            {
                let retained = previous.as_ref().is_some_and(|old| old.ingresses.iter().any(|(held, row)| {
                    held == id && matches!(row, Row::Running { started: before, .. } if before == started)
                }));
                if !retained {
                    tracing::info!(gateway = %gateway_id, ingress = %id, file = %path.display(), %endpoint, "gateway WireGuard tunnel started");
                }
            }
        }
        // Retained handles survive a table swap; removed tunnels end only
        // after the proxy routes the complete replacement.
        drop(previous);
        rows[gateway_id].answer()
    }

    fn publish_routes(&self, rows: &HashMap<String, GatewayRow>) -> io::Result<()> {
        let Proxy::Bound { proxy, .. } = &self.proxy else {
            return Ok(());
        };
        let mut ordered: Vec<_> = rows.values().collect();
        ordered.sort_by_key(|row| row.route_order);
        let routes = ordered
            .into_iter()
            .flat_map(|row| &row.ingresses)
            .filter_map(|(id, row)| match row {
                Row::Running { tunnel, hosts, .. } => Some((
                    id.clone(),
                    ProxyRoute {
                        tunnel: tunnel.clone(),
                        hosts: hosts.clone(),
                    },
                )),
                Row::Refused { .. } => None,
            })
            .collect();
        proxy.replace_routes(routes)
    }

    /// Drop `gateway_id`'s routes and row: its tunnels end, and so does
    /// every connection through them. `false` when the fabric held nothing
    /// for the row.
    pub fn retire(&self, gateway_id: &str) -> bool {
        let mut rows = self.rows.lock().unwrap();
        let row = rows.remove(gateway_id);
        self.publish_routes(&rows)
            .expect("retiring only removes validated routes");
        drop(rows);
        if let Some(row) = &row {
            for (id, ingress) in &row.ingresses {
                if let Row::Running { path, .. } = ingress {
                    tracing::info!(gateway = %gateway_id, ingress = %id, file = %path.display(), "gateway WireGuard tunnel retired");
                }
            }
        }
        row.is_some()
    }

    /// The worst running ingress's status, with discovery order breaking
    /// ties; refusals are reported separately by `failure`. A stored path
    /// different from the running source reads no status until adopted.
    pub fn status(&self, gateway_id: &str, configured: Option<&Path>) -> Option<String> {
        let rows = self.rows.lock().unwrap();
        rows.get(gateway_id)?.status(configured)
    }

    /// A matched route's missing-session reason. Host maps take precedence
    /// over resolved addresses, as they do in the proxy. The outer option
    /// says a route matched; its inner value is absent when that route is
    /// live, so a later dark route cannot explain a live destination.
    pub(crate) fn reason_for_destination(
        &self,
        host: &str,
        addresses: &[IpAddr],
    ) -> Option<Option<String>> {
        let rows = self.rows.lock().unwrap();
        let ordered = || {
            rows.values().flat_map(|gateway| {
                gateway
                    .ingresses
                    .iter()
                    .enumerate()
                    .map(move |(index, (_, row))| ((gateway.route_order, index), row))
            })
        };
        let mapped = ordered().filter(|(_, row)| matches!(row, Row::Running { hosts, .. } if hosts.iter().any(|route| host_route_matches(&route.name, host))))
            .min_by_key(|(order, _)| *order).map(|(_, row)| row);
        let row = mapped.or_else(|| addresses.iter().find_map(|ip| {
            ordered().filter(|(_, row)| matches!(row, Row::Running { tunnel, .. } if tunnel.allowed_ips().iter().any(|cidr| cidr.contains(*ip))))
                .min_by_key(|(order, _)| *order).map(|(_, row)| row)
        }))?;
        match row {
            row @ Row::Running {
                path,
                endpoint,
                started,
                ..
            } => Some(missing_handshake_reason(
                row.tunnel_status()?,
                endpoint,
                path,
                started.elapsed(),
            )),
            Row::Refused { .. } => None,
        }
    }

    /// Why discovery through this gateway's running tunnel lacks a session.
    /// An enrolled ingress explains only names its host map carries.
    pub fn discovery_failure(
        &self,
        gateway_id: &str,
        configured: Option<&Path>,
        host: Option<&str>,
    ) -> Option<String> {
        let rows = self.rows.lock().unwrap();
        let row = rows.get(gateway_id)?;
        let ingress = if row.enrollment.is_some() {
            let host = host?;
            &row.ingresses.iter().find(|(_, ingress)| matches!(ingress,
                Row::Running { hosts, .. } if hosts.iter().any(|route| host_route_matches(&route.name, host))
            ))?.1
        } else {
            &row.ingresses.first()?.1
        };
        match ingress {
            Row::Running {
                path,
                endpoint,
                started,
                ..
            } if Some(path.as_path()) == configured => missing_handshake_reason(
                ingress.tunnel_status()?,
                endpoint,
                path,
                started.elapsed(),
            ),
            _ => None,
        }
    }

    /// The first ingress refusal, in discovery order, while the configured
    /// source is the adopted one.
    pub fn failure(&self, gateway_id: &str, configured: Option<&Path>) -> Option<String> {
        self.rows
            .lock()
            .unwrap()
            .get(gateway_id)?
            .failure(configured)
    }

    /// Why a row naming `configured` cannot be reached: its file's
    /// refusal, or, for any row with a file, the proxy's bind failure.
    pub fn connect_refusal(&self, gateway_id: &str, configured: Option<&Path>) -> Option<String> {
        if let Some(reason) = self.failure(gateway_id, configured) {
            return Some(reason);
        }
        match &self.proxy {
            Proxy::Unavailable(reason) if configured.is_some() => Some(reason.clone()),
            _ => None,
        }
    }

    #[cfg(test)]
    pub(crate) fn refuse_start(&self, id: &str) {
        self.refused_starts.lock().unwrap().insert(id.into());
    }

    #[cfg(test)]
    pub(crate) fn ingress_starts(&self, gateway_id: &str) -> Vec<(String, Instant)> {
        self.rows
            .lock()
            .unwrap()
            .get(gateway_id)
            .into_iter()
            .flat_map(|row| &row.ingresses)
            .filter_map(|(id, row)| match row {
                Row::Running { started, .. } => Some((id.clone(), *started)),
                Row::Refused { .. } => None,
            })
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn set_test_status(&self, gateway_id: &str, status: chan_wireguard::Status) {
        let mut rows = self.rows.lock().unwrap();
        let Some((_, Row::Running { test_status, .. })) = rows
            .get_mut(gateway_id)
            .and_then(|row| row.ingresses.first_mut())
        else {
            panic!("test gateway has no running tunnel");
        };
        *test_status = Some(status);
    }
}

impl GatewayRow {
    fn failure(&self, configured: Option<&Path>) -> Option<String> {
        self.ingresses.iter().find_map(|(id, row)| match row {
            Row::Refused { path, reason } if Some(path.as_path()) == configured => {
                Some(if self.ingresses.len() > 1 {
                    format!("{id}: {reason}")
                } else {
                    reason.clone()
                })
            }
            _ => None,
        })
    }

    fn status(&self, configured: Option<&Path>) -> Option<String> {
        let mut worst = None;
        for (_, row) in &self.ingresses {
            if Some(row.path()) != configured {
                continue;
            }
            let Some(status) = row.tunnel_status() else {
                continue;
            };
            let rank = match status.handshake {
                chan_wireguard::HandshakeState::Lost(_) => 4,
                chan_wireguard::HandshakeState::Never if status.resolution_error.is_some() => 3,
                chan_wireguard::HandshakeState::Never => 2,
                chan_wireguard::HandshakeState::Live(_) if status.resolution_error.is_some() => 1,
                chan_wireguard::HandshakeState::Live(_) => 0,
            };
            if worst.as_ref().is_none_or(|(held, _)| rank > *held) {
                worst = Some((rank, status));
            }
        }
        worst.map(|(_, status)| describe(status))
    }

    fn answer(&self) -> Result<String, String> {
        let path = Some(self.ingresses[0].1.path());
        self.status(path).ok_or_else(|| {
            self.failure(path)
                .expect("a nonempty row without running tunnels has a refusal")
        })
    }
}

impl Row {
    fn from_started(
        path: &Path,
        hosts: Vec<HostRoute>,
        started: Result<(Tunnel, String), String>,
    ) -> Self {
        match started {
            Ok((tunnel, endpoint)) => Self::Running {
                path: path.to_owned(),
                tunnel,
                hosts,
                endpoint,
                started: Instant::now(),
                #[cfg(test)]
                test_status: None,
            },
            Err(reason) => Self::Refused {
                path: path.to_owned(),
                reason,
            },
        }
    }

    fn path(&self) -> &Path {
        match self {
            Self::Running { path, .. } | Self::Refused { path, .. } => path,
        }
    }

    fn tunnel_status(&self) -> Option<chan_wireguard::Status> {
        #[cfg(test)]
        if let Row::Running {
            test_status: Some(status),
            ..
        } = self
        {
            return Some(status.clone());
        }
        match self {
            Row::Running { tunnel, .. } => Some(tunnel.status()),
            Row::Refused { .. } => None,
        }
    }
}

impl std::fmt::Debug for WireguardFabric {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Counts and paths only: a row's reason is the reader's sentence,
        // and nothing here prints what a file holds.
        let tunnels = self.tunnels();
        let paths: HashMap<String, String> = self
            .rows
            .lock()
            .unwrap()
            .iter()
            .map(|(id, row)| (id.clone(), row.ingresses[0].1.path().display().to_string()))
            .collect();
        let mut out = f.debug_struct("WireguardFabric");
        match &self.proxy {
            Proxy::Bound { proxy, .. } => out.field("proxy", proxy),
            Proxy::Unavailable(_) => out.field("proxy", &"unavailable"),
        };
        out.field("tunnels", &tunnels)
            .field("rows", &paths)
            .finish()
    }
}

/// Read `conf` and start its tunnel, logging a refusal as it happens. Must
/// run inside the runtime the tunnel lives on.
fn start_tunnel(gateway_id: &str, conf: &Path) -> Result<(Tunnel, String), String> {
    let config = chan_wireguard::config::read_file(conf).map_err(|e| {
        tracing::warn!(gateway = %gateway_id, error = %e, "gateway WireGuard file refused");
        format!("WireGuard: {e}")
    })?;
    start_config(gateway_id, config)
}

fn start_config(
    gateway_id: &str,
    config: chan_wireguard::config::Config,
) -> Result<(Tunnel, String), String> {
    let endpoint = config.peer.endpoint.to_string();
    match Tunnel::start(config) {
        Ok(tunnel) => Ok((tunnel, endpoint)),
        Err(e) => {
            tracing::warn!(gateway = %gateway_id, %endpoint, error = %e, "gateway WireGuard tunnel failed to start");
            Err(format!("WireGuard: starting the tunnel to {endpoint}: {e}"))
        }
    }
}

/// The launcher's words for a tunnel's state. A tunnel keeps handshaking
/// with the endpoint it knows while lookups of the name fail, so a live
/// session reads as up with the failure beside it. A failed lookup is
/// retried; a timed-out one is not until its OS call returns.
fn describe(status: chan_wireguard::Status) -> String {
    let failure = status.resolution_error.map(|error| {
        if status.resolution_stalled {
            format!("{error}; stalled, waiting for the system resolver")
        } else {
            format!("{error}, retrying")
        }
    });
    match (status.handshake, failure) {
        (chan_wireguard::HandshakeState::Never, None) => "connecting".to_string(),
        (chan_wireguard::HandshakeState::Never, Some(failure)) => failure,
        (chan_wireguard::HandshakeState::Live(_), None) => "up".to_string(),
        (chan_wireguard::HandshakeState::Live(_), Some(failure)) => format!("up; {failure}"),
        (chan_wireguard::HandshakeState::Lost(age), None) => {
            format!("lost; no handshake for {}", format_age(age))
        }
        (chan_wireguard::HandshakeState::Lost(age), Some(failure)) => {
            format!("lost; no handshake for {}; {failure}", format_age(age))
        }
    }
}

fn format_age(age: Duration) -> String {
    let seconds = age.as_secs();
    if seconds < 60 {
        format!("{seconds} s")
    } else if seconds < 3600 {
        format!("{} min", seconds / 60)
    } else {
        let hours = seconds / 3600;
        let minutes = (seconds % 3600) / 60;
        if minutes == 0 {
            format!("{hours} h")
        } else {
            format!("{hours} h {minutes} min")
        }
    }
}

/// Match the proxy's exact and wildcard host routes without a host
/// lookup. The wildcard needs at least one label before its suffix.
fn host_route_matches(route: &str, host: &str) -> bool {
    match route.strip_prefix("*.") {
        Some(suffix) => {
            let Some(head) = host.len().checked_sub(suffix.len() + 1) else {
                return false;
            };
            head > 0
                && host.as_bytes()[head] == b'.'
                && host[head + 1..].eq_ignore_ascii_case(suffix)
        }
        None => host.eq_ignore_ascii_case(route),
    }
}

fn missing_handshake_reason(
    status: chan_wireguard::Status,
    endpoint: &str,
    file: &Path,
    since_start: Duration,
) -> Option<String> {
    match status.handshake {
        chan_wireguard::HandshakeState::Live(_) => None,
        chan_wireguard::HandshakeState::Never if status.endpoint.is_none() => {
            Some(describe(status))
        }
        _ if status.endpoint.is_none() && status.resolution_error.is_some() => {
            Some(describe(status))
        }
        chan_wireguard::HandshakeState::Never => Some(format!(
            "no WireGuard handshake with the peer at {endpoint} since the tunnel started {} ago; check PublicKey in {} and that the peer lists this client's key",
            format_age(since_start),
            file.display()
        )),
        chan_wireguard::HandshakeState::Lost(age) => Some(format!(
            "no WireGuard handshake with the peer at {endpoint} for {}; the tunnel had a session and lost it",
            format_age(age)
        )),
    }
}

/// Bind the proxy on loopback, then adopt every enabled gateway's manual
/// file or enrolled ingresses, each with its host map. Never waits for an
/// endpoint lookup or a handshake. A source that cannot be read or a tunnel that cannot start
/// fails that row alone; a proxy that cannot bind fails every row, since
/// nothing can reach a tunnel without it. Must run on the tokio runtime
/// the tunnels live on for the process.
pub async fn start(gateways: &[Gateway]) -> WireguardFabric {
    start_with_bind(
        gateways,
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
    )
    .await
}

async fn start_with_bind(gateways: &[Gateway], bind: SocketAddr) -> WireguardFabric {
    let proxy = match ConnectProxy::bind_routed(Vec::new(), bind).await {
        Ok(proxy) => {
            let url = Url::parse(&format!("http://{}", proxy.local_addr()))
                .expect("a loopback socket address is a URL authority");
            tracing::info!(proxy = %proxy.local_addr(), tunnels = 0, "gateway WireGuard proxy listening");
            Proxy::Bound { proxy, url }
        }
        Err(e) => {
            tracing::error!(error = %e, "gateway WireGuard proxy failed to bind; WireGuard gateways are disabled");
            Proxy::Unavailable(format!("WireGuard: starting the proxy: {e}"))
        }
    };
    let fabric = WireguardFabric {
        proxy,
        runtime: tokio::runtime::Handle::current(),
        rows: Mutex::new(HashMap::new()),
        next_route_order: AtomicU64::new(0),
        #[cfg(test)]
        refused_starts: Mutex::new(Default::default()),
    };
    for gateway in gateways.iter().filter(|g| g.enabled) {
        // A refusal is logged and kept on the row by adopt itself.
        let _ = fabric.adopt_gateway(gateway);
    }
    fabric
}

/// The process's proxy, as the legs consume it.
struct ProxyDecision {
    url: Url,
    addr: SocketAddr,
    proxy: reqwest::Proxy,
}

/// Decided once per process. A reader before the decision pins its absence,
/// so a decision made after a client was built fails rather than leaving
/// that client on the wrong path.
static PROXY: OnceLock<Option<ProxyDecision>> = OnceLock::new();

/// Record the process's proxy, `None` for no fabric, before any HTTP client
/// or webview is built. Fails when the decision was already made, by a
/// previous call or by a client built before it.
pub fn install_proxy(url: Option<Url>) -> Result<(), String> {
    let decision = match url {
        None => None,
        Some(url) => {
            let addr = proxy_socket_addr(&url)?;
            let proxy = reqwest::Proxy::all(url.clone())
                .map_err(|e| format!("{url} is not a proxy URL the HTTP client accepts: {e}"))?
                .no_proxy(reqwest::NoProxy::from_string(DIRECT_HOSTS));
            Some(ProxyDecision { url, addr, proxy })
        }
    };
    PROXY.set(decision).map_err(|_| {
        "the WireGuard proxy was decided twice, or after an HTTP client was built".to_string()
    })
}

fn proxy_socket_addr(url: &Url) -> Result<SocketAddr, String> {
    let host = url
        .host_str()
        .ok_or_else(|| format!("{url} has no host"))?
        .trim_matches(|c| c == '[' || c == ']');
    let ip: IpAddr = host
        .parse()
        .map_err(|_| format!("{url} must name the proxy by address"))?;
    let port = url.port().ok_or_else(|| format!("{url} has no port"))?;
    Ok(SocketAddr::new(ip, port))
}

fn decision() -> Option<&'static ProxyDecision> {
    PROXY.get_or_init(|| None).as_ref()
}

/// The builder every HTTP client of the desktop starts from: verifying
/// servers with chan-tls's trust decision, and through the proxy when the
/// process has one, with loopback destinations direct, or the plain builder
/// otherwise. Fails only when that trust decision cannot be built.
pub fn client_builder() -> Result<reqwest::ClientBuilder, String> {
    let proxy = decision().map(|d| &d.proxy);
    let tls = chan_tls::client_config().map_err(|e| e.to_string())?;
    Ok(client_builder_with(proxy, tls))
}

fn client_builder_with(
    proxy: Option<&reqwest::Proxy>,
    tls: chan_tls::rustls::ClientConfig,
) -> reqwest::ClientBuilder {
    let builder = reqwest::Client::builder().use_preconfigured_tls(crate::tls::http1(tls));
    match proxy {
        Some(proxy) => builder.proxy(proxy.clone()),
        None => builder,
    }
}

/// Where a WebSocket upgrade to `uri` dials: the proxy, with the authority
/// to CONNECT, or `None` for a direct dial when the process has no proxy or
/// the host is a loopback one.
pub fn ws_route(uri: &Uri) -> Option<WsRoute> {
    ws_route_with(decision().map(|d| d.addr), uri)
}

/// A WebSocket dial through the proxy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WsRoute {
    pub proxy: SocketAddr,
    pub host: String,
    pub port: u16,
}

fn ws_route_with(proxy: Option<SocketAddr>, uri: &Uri) -> Option<WsRoute> {
    let proxy = proxy?;
    let host = uri
        .host()?
        .trim_matches(|c| c == '[' || c == ']')
        .to_string();
    if is_direct_host(&host) {
        return None;
    }
    let port = uri.port_u16().unwrap_or(match uri.scheme_str() {
        Some("wss") | Some("https") => 443,
        _ => 80,
    });
    Some(WsRoute { proxy, host, port })
}

/// Loopback literals and `localhost`, the hosts [`DIRECT_HOSTS`] names.
fn is_direct_host(host: &str) -> bool {
    match host.parse::<IpAddr>() {
        Ok(ip) => ip.is_loopback(),
        Err(_) => host.eq_ignore_ascii_case("localhost"),
    }
}

/// Open a TCP connection to `host:port` through the CONNECT proxy at
/// `proxy`: send the request, read the response head byte by byte to its
/// blank line so nothing of what follows is consumed, require a 200, and
/// hand back the stream for the TLS and WebSocket handshakes to run over.
pub async fn connect_through(proxy: SocketAddr, host: &str, port: u16) -> io::Result<TcpStream> {
    tokio::time::timeout(
        CONNECT_TIMEOUT,
        connect_through_unbounded(proxy, host, port),
    )
    .await
    .map_err(|_| {
        io::Error::new(
            io::ErrorKind::TimedOut,
            format!("CONNECT {host}:{port} through the WireGuard proxy timed out"),
        )
    })?
}

async fn connect_through_unbounded(
    proxy: SocketAddr,
    host: &str,
    port: u16,
) -> io::Result<TcpStream> {
    let mut stream = TcpStream::connect(proxy).await?;
    // The feed's frames are small and waited on; a delayed segment is a
    // round trip added to each.
    stream.set_nodelay(true)?;
    // An IPv6 literal needs its brackets back in the authority.
    let authority = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let request = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n");
    stream.write_all(request.as_bytes()).await?;
    let mut head = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    loop {
        if stream.read(&mut byte).await? == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                format!("the WireGuard proxy closed during CONNECT {authority}"),
            ));
        }
        head.push(byte[0]);
        if head.ends_with(b"\r\n\r\n") {
            break;
        }
        if head.len() >= MAX_RESPONSE_HEAD {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("the WireGuard proxy's CONNECT {authority} response head never ended"),
            ));
        }
    }
    let status = connect_status(&head).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("the WireGuard proxy answered CONNECT {authority} with no HTTP status line"),
        )
    })?;
    if status != 200 {
        return Err(io::Error::new(
            io::ErrorKind::ConnectionRefused,
            format!("the WireGuard proxy answered {status} to CONNECT {authority}"),
        ));
    }
    Ok(stream)
}

/// The status code of a response head, `HTTP/1.x NNN ...`.
fn connect_status(head: &[u8]) -> Option<u16> {
    let line_end = head.windows(2).position(|pair| pair == b"\r\n")?;
    let line = std::str::from_utf8(&head[..line_end]).ok()?;
    let mut parts = line.splitn(3, ' ');
    let version = parts.next()?;
    if !version.starts_with("HTTP/1.") {
        return None;
    }
    parts.next()?.parse().ok()
}

/// The proxy URL for a window's webview builder: the process's proxy when
/// there is one. WebView2 takes it as a browser argument, WebKitGTK sets it
/// on the shared web context, and WKWebView sets it on the webview's data
/// store, whose Network.framework symbols exist from macOS 14, the bundle's
/// minimum system version. On Linux it also carries the local windows,
/// through the proxy's plain HTTP forwarding.
pub fn webview_proxy_url() -> Option<Url> {
    decision().map(|d| d.url.clone())
}

/// The same proxy for the launcher's wry builder, which takes it as a
/// host and port rather than a URL.
pub fn launcher_proxy_config() -> Option<wry::ProxyConfig> {
    decision().map(|d| {
        wry::ProxyConfig::Http(wry::ProxyEndpoint {
            host: d.addr.ip().to_string(),
            port: d.addr.port().to_string(),
        })
    })
}

/// Put the process's proxy on a window's webview builder, when there is one.
pub fn with_webview_proxy<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: tauri::WebviewWindowBuilder<'a, R, M>,
) -> tauri::WebviewWindowBuilder<'a, R, M> {
    match webview_proxy_url() {
        Some(url) => builder.proxy_url(url),
        None => builder,
    }
}

/// The same for the launcher's wry builder.
pub fn with_launcher_proxy(builder: wry::WebViewBuilder<'_>) -> wry::WebViewBuilder<'_> {
    match launcher_proxy_config() {
        Some(config) => builder.with_proxy_config(config),
        None => builder,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use base64::Engine;
    use chan_wireguard::x25519::{PublicKey, StaticSecret};
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;

    const WAIT: Duration = Duration::from_secs(10);

    fn secret() -> StaticSecret {
        let mut bytes = [0u8; 32];
        getrandom::getrandom(&mut bytes).unwrap();
        StaticSecret::from(bytes)
    }

    fn base64_of(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    /// Write `text` to `dir/name`, owner-only as the reader requires.
    fn owner_only(dir: &Path, name: &str, text: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, text).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        path
    }

    /// The far side of one gateway's tunnel: a tunnel on a loopback socket
    /// at `peer_addr`, and the wg-quick file the fabric reads for the
    /// client side at `client_addr`, written under `dir` as `name`. The
    /// peer learns the client's endpoint from its first authenticated
    /// initiation, so its own configured endpoint is a port nothing
    /// answers on.
    pub(crate) struct Peer {
        pub(crate) tunnel: Tunnel,
        pub(crate) conf: PathBuf,
        pub(crate) private_key: String,
    }

    pub(crate) async fn peer(dir: &Path, name: &str, client_addr: &str, peer_addr: &str) -> Peer {
        peer_with_key(dir, name, client_addr, peer_addr, &secret()).await
    }

    async fn peer_with_key(
        dir: &Path,
        name: &str,
        client_addr: &str,
        peer_addr: &str,
        client: &StaticSecret,
    ) -> Peer {
        let server = secret();
        let udp = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let at = udp.local_addr().unwrap();
        let nowhere: SocketAddr = "127.0.0.1:9".parse().unwrap();
        let server_config = chan_wireguard::config::Config::parse(&format!(
            "[Interface]\nPrivateKey = {}\nAddress = {peer_addr}/32\n[Peer]\nPublicKey = {}\nEndpoint = {nowhere}\nAllowedIPs = {client_addr}/32\n",
            base64_of(&server.to_bytes()),
            base64_of(PublicKey::from(client).as_bytes()),
        ))
        .unwrap();
        let tunnel = Tunnel::start_on(server_config, udp, nowhere).unwrap();
        let private_key = base64_of(&client.to_bytes());
        let conf = owner_only(
            dir,
            name,
            &format!(
                "[Interface]\nPrivateKey = {private_key}\nAddress = {client_addr}/32\n[Peer]\nPublicKey = {}\nEndpoint = {at}\nAllowedIPs = {peer_addr}/32\n",
                base64_of(PublicKey::from(&server).as_bytes()),
            ),
        );
        Peer {
            tunnel,
            conf,
            private_key,
        }
    }

    fn gateway(id: &str, wireguard: Option<&Path>) -> Gateway {
        Gateway {
            id: id.into(),
            url: format!("https://{id}.test"),
            label: String::new(),
            enabled: true,
            added_at: 0,
            native_trust: vec![],
            wireguard: wireguard.map(Path::to_path_buf),
            wireguard_public_key: None,
            wireguard_enrolled_key: None,
            wireguard_enrollment: None,
            wireguard_hosts: Vec::new(),
        }
    }

    impl WireguardFabric {
        fn proxy_addr(&self) -> SocketAddr {
            proxy_socket_addr(self.proxy_url().expect("a bound proxy")).unwrap()
        }

        fn routes(&self) -> usize {
            match &self.proxy {
                Proxy::Bound { proxy, .. } => proxy.routes(),
                Proxy::Unavailable(_) => 0,
            }
        }

        /// A handle of the row's running tunnel, held apart from the
        /// fabric's own.
        fn tunnel(&self, gateway_id: &str) -> Option<Tunnel> {
            match &self
                .rows
                .lock()
                .unwrap()
                .get(gateway_id)?
                .ingresses
                .first()?
                .1
            {
                Row::Running { tunnel, .. } => Some(tunnel.clone()),
                Row::Refused { .. } => None,
            }
        }
    }

    /// CONNECT `target` through the fabric's proxy: the proxy's status,
    /// and the stream when it answered 200.
    async fn connect_via(fabric: &WireguardFabric, target: SocketAddr) -> (u16, TcpStream) {
        connect_authority(fabric, &target.to_string()).await
    }

    /// CONNECT `target`, an address or a name with its port, through the
    /// fabric's proxy.
    async fn connect_authority(fabric: &WireguardFabric, target: &str) -> (u16, TcpStream) {
        let mut stream = TcpStream::connect(fabric.proxy_addr()).await.unwrap();
        stream
            .write_all(format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            let n = tokio::time::timeout(WAIT, stream.read(&mut byte))
                .await
                .expect("the proxy answers")
                .unwrap();
            assert_ne!(n, 0, "the proxy closed before a response head");
            head.push(byte[0]);
        }
        (connect_status(&head).unwrap(), stream)
    }

    /// A CONNECT through the fabric to `peer`'s listener on `port` is
    /// answered 200 and lands there from `client_addr`, and bytes cross.
    async fn carried(
        fabric: &WireguardFabric,
        listener: &mut chan_wireguard::Listener,
        client_addr: &str,
        peer_addr: &str,
    ) {
        let target = SocketAddr::new(peer_addr.parse().unwrap(), listener.port());
        let (status, mut client) = connect_via(fabric, target).await;
        assert_eq!(status, 200, "CONNECT {target}");
        let mut server = tokio::time::timeout(WAIT, listener.accept())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            server.peer_addr().ip(),
            client_addr.parse::<IpAddr>().unwrap()
        );
        client.write_all(b"ping").await.unwrap();
        let mut buf = [0u8; 4];
        tokio::time::timeout(WAIT, server.read_exact(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&buf, b"ping");
    }

    #[tokio::test]
    async fn startup_binds_proxy_without_polling_endpoint_resolution() {
        use std::future::Future;
        use std::task::Poll;

        let dir = tempfile::tempdir().unwrap();
        let path = owner_only(
            dir.path(),
            "gateway.conf",
            "[Interface]\nPrivateKey = yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=\nAddress = 10.7.0.1/32\n[Peer]\nPublicKey = xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=\nEndpoint = pending.test:51820\nAllowedIPs = 10.7.0.0/24\n",
        );
        let gateways = [gateway("pending", Some(&path))];
        let starting = start(&gateways);
        tokio::pin!(starting);
        let fabric = std::future::poll_fn(|cx| match starting.as_mut().poll(cx) {
            Poll::Ready(value) => Poll::Ready(value),
            Poll::Pending => panic!("startup waited before binding the proxy"),
        })
        .await;
        assert_eq!(
            fabric.status("pending", Some(&path)).as_deref(),
            Some("connecting")
        );
        assert_eq!(fabric.connect_refusal("pending", Some(&path)), None);
        assert_eq!(fabric.tunnels(), 1);
        // This current-thread runtime has not yielded to a driver task. No
        // lookup can complete, but the listener already accepts connections.
        let connection = std::net::TcpStream::connect(fabric.proxy_addr()).unwrap();
        drop(connection);
        drop(fabric);
    }

    #[tokio::test]
    async fn start_binds_the_proxy_with_no_gateway() {
        let fabric = start(&[]).await;
        assert!(fabric.proxy_url().is_some());
        assert_eq!(fabric.tunnels(), 0);
        assert_eq!(fabric.routes(), 0);
        // The proxy itself answers: a request in origin form is one to the
        // proxy and is refused as malformed.
        let mut stream = TcpStream::connect(fabric.proxy_addr()).await.unwrap();
        stream
            .write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(WAIT, stream.read_to_end(&mut response))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(connect_status(&response), Some(400), "{response:?}");
    }

    /// A CONNECT through the fabric to `name` on `peer`'s listener port is
    /// answered 200 and lands on the listener from `client_addr`. Every
    /// name these tests use ends in `.invalid`, which never resolves, so a
    /// carried name went by the host map.
    pub(crate) async fn carried_by_name(
        fabric: &WireguardFabric,
        listener: &mut chan_wireguard::Listener,
        client_addr: &str,
        name: &str,
    ) {
        let target = format!("{name}:{}", listener.port());
        let (status, mut client) = connect_authority(fabric, &target).await;
        assert_eq!(status, 200, "CONNECT {target}");
        let mut server = tokio::time::timeout(WAIT, listener.accept())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            server.peer_addr().ip(),
            client_addr.parse::<IpAddr>().unwrap()
        );
        client.write_all(b"ping").await.unwrap();
        let mut buf = [0u8; 4];
        tokio::time::timeout(WAIT, server.read_exact(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&buf, b"ping");
    }

    fn host(name: &str, address: &str) -> crate::config::WireguardHost {
        crate::config::WireguardHost {
            name: name.into(),
            addresses: vec![address.parse().unwrap()],
        }
    }

    pub(crate) async fn enrolled_peers(dir: &Path, id: &str) -> (Gateway, Vec<Peer>) {
        use crate::wireguard_keys::{EnrollmentIngress, EnrollmentParams};
        let client = secret();
        let public = base64_of(PublicKey::from(&client).as_bytes());
        let key = owner_only(dir, &format!("{id}.key"), &base64_of(&client.to_bytes()));
        let mut peers = Vec::new();
        let mut ingresses = Vec::new();
        for id in ["p1", "p2"] {
            let far =
                peer_with_key(dir, &format!("{id}.conf"), "10.7.0.1", "10.7.0.2", &client).await;
            let cfg = chan_wireguard::config::read_file(&far.conf).unwrap();
            ingresses.push(crate::config::WireguardIngress {
                id: id.into(),
                endpoint: cfg.peer.endpoint.to_string(),
                public_key: base64_of(cfg.peer.public_key.as_bytes()),
                hosts: vec![host(&format!("*.{id}.proxy.chan.invalid"), "10.7.0.2")],
            });
            peers.push(far);
        }
        let first = &ingresses[0];
        let discovery = crate::devserver::WireguardDiscovery {
            endpoint: first.endpoint.clone(),
            public_key: first.public_key.clone(),
            allowed_ips: Some(vec!["10.7.0.2/32".into()]),
            persistent_keepalive: None,
            ingresses: Some(ingresses.clone()),
        };
        let params = EnrollmentParams {
            endpoint: first.endpoint.clone(),
            server_public_key: first.public_key.clone(),
            addresses: vec!["10.7.0.1/32".into()],
            allowed_ips: vec!["10.7.0.2/32".into()],
            persistent_keepalive: None,
            hosts: first.hosts.clone(),
            ingresses: Some(
                ingresses
                    .into_iter()
                    .map(|i| EnrollmentIngress {
                        id: i.id,
                        endpoint: i.endpoint,
                        server_public_key: i.public_key,
                        hosts: i.hosts,
                    })
                    .collect(),
            ),
        };
        let enrollment =
            crate::wireguard_keys::prepare(dir, id, &public, &discovery, &params).unwrap();
        let mut row = gateway(id, None);
        row.wireguard_public_key = Some(public.clone());
        row.wireguard_enrolled_key = Some(public);
        row.wireguard_enrollment = Some(enrollment.parameters(key));
        (row, peers)
    }

    #[tokio::test]
    async fn enrolled_adopt_replaces_all_tunnels_when_shared_client_settings_change() {
        let dir = tempfile::tempdir().unwrap();
        let (mut row, _peers) = enrolled_peers(dir.path(), "gw-multi").await;
        let fabric = start(std::slice::from_ref(&row)).await;
        for field in ["addresses", "allowed_ips", "keepalive", "key_file", "key"] {
            let before = fabric.ingress_starts(&row.id);
            let enrollment = row.wireguard_enrollment.as_mut().unwrap();
            match field {
                "addresses" => enrollment.addresses = vec!["10.7.0.3/32".into()],
                "allowed_ips" => enrollment.allowed_ips = vec!["10.7.0.0/24".into()],
                "keepalive" => enrollment.persistent_keepalive = Some(25),
                "key_file" => {
                    enrollment.key_file = owner_only(
                        dir.path(),
                        "other.key",
                        &std::fs::read_to_string(&enrollment.key_file).unwrap(),
                    );
                }
                "key" => {
                    let public = crate::wireguard_keys::generate(dir.path(), "other").unwrap();
                    row.wireguard_public_key = Some(public.clone());
                    row.wireguard_enrolled_key = Some(public);
                }
                _ => unreachable!(),
            }
            fabric.adopt_gateway(&row).unwrap().unwrap();
            let after = fabric.ingress_starts(&row.id);
            assert_eq!(after.len(), 2);
            for (old, new) in before.iter().zip(after.iter()) {
                assert_eq!(old.0, new.0);
                assert_ne!(old.1, new.1, "{field} must replace every tunnel");
            }
        }
    }

    #[tokio::test]
    async fn enrolled_status_uses_the_worst_running_ingress_and_keeps_refusal_visible() {
        let dir = tempfile::tempdir().unwrap();
        let (row, _peers) = enrolled_peers(dir.path(), "gw-multi").await;
        let fabric = start(std::slice::from_ref(&row)).await;
        let status = |handshake, error: Option<&str>| chan_wireguard::Status {
            handshake,
            endpoint: Some("127.0.0.1:9".parse().unwrap()),
            tx_bytes: 0,
            rx_bytes: 0,
            resolution_error: error.map(str::to_owned),
            resolution_stalled: false,
        };
        use chan_wireguard::HandshakeState::{Live, Lost, Never};
        let states = [
            status(Live(Duration::ZERO), None),
            status(Live(Duration::ZERO), Some("DNS retry")),
            status(Never, None),
            status(Never, Some("DNS retry")),
            status(Lost(Duration::from_secs(200)), None),
        ];
        let assign = |a: chan_wireguard::Status, b: chan_wireguard::Status| {
            let mut rows = fabric.rows.lock().unwrap();
            for ((_, ingress), status) in rows
                .get_mut(&row.id)
                .unwrap()
                .ingresses
                .iter_mut()
                .zip([a, b])
            {
                let Row::Running { test_status, .. } = ingress else {
                    panic!("running ingress")
                };
                *test_status = Some(status);
            }
        };
        for (rank, worse) in states.iter().enumerate() {
            for better in &states[..=rank] {
                for pair in [[better, worse], [worse, better]] {
                    assign(pair[0].clone(), pair[1].clone());
                    assert_eq!(
                        fabric.status(&row.id, row.wireguard_source()),
                        Some(describe(worse.clone()))
                    );
                }
            }
        }
        assign(
            status(Never, Some("first lookup")),
            status(Never, Some("second lookup")),
        );
        assert_eq!(
            fabric.status(&row.id, row.wireguard_source()).as_deref(),
            Some("first lookup, retrying")
        );
        assign(states[0].clone(), states[0].clone());
        {
            let mut rows = fabric.rows.lock().unwrap();
            rows.get_mut(&row.id).unwrap().ingresses[1].1 = Row::Refused {
                path: row.wireguard_source().unwrap().to_owned(),
                reason: "WireGuard: ingress start refused".into(),
            };
        }
        assert_eq!(
            fabric.status(&row.id, row.wireguard_source()).as_deref(),
            Some("up")
        );
        assert_eq!(
            fabric
                .connect_refusal(&row.id, row.wireguard_source())
                .as_deref(),
            Some("gw-multi/p2: WireGuard: ingress start refused")
        );
        assert!(fabric
            .status(&row.id, Some(&dir.path().join("other.key")))
            .is_none());
    }

    #[tokio::test]
    async fn two_ingress_enrollment_routes_each_name_to_its_own_peer() {
        let dir = tempfile::tempdir().unwrap();
        let (row, peers) = enrolled_peers(dir.path(), "gw-multi").await;
        let key = row.wireguard_source().unwrap();
        let key_bytes = std::fs::read(key).unwrap();
        let fabric = start(std::slice::from_ref(&row)).await;
        assert_eq!(
            fabric.tunnels(),
            2,
            "every redeemed ingress starts a tunnel"
        );
        assert_eq!(fabric.routes(), 2);
        // Both peers listen at the same IP and port; only the host map can choose one.
        for (id, peer) in ["p1", "p2"].into_iter().zip(&peers) {
            let mut listener = peer.tunnel.listen(8123).unwrap();
            carried_by_name(
                &fabric,
                &mut listener,
                "10.7.0.1",
                &format!("alice--a1.{id}.proxy.chan.invalid"),
            )
            .await;
        }
        assert_eq!(std::fs::read(key).unwrap(), key_bytes);
        assert!(fabric.retire(&row.id));
        assert_eq!(fabric.routes(), 0);
        assert_eq!(fabric.tunnels(), 0);
    }

    #[tokio::test]
    async fn a_dead_ingress_does_not_block_another_nodes_names() {
        let dir = tempfile::tempdir().unwrap();
        let (mut row, peers) = enrolled_peers(dir.path(), "gw-multi").await;
        row.wireguard_enrollment.as_mut().unwrap().ingresses[1].endpoint = "127.0.0.1:9".into();
        let fabric = start(std::slice::from_ref(&row)).await;
        let mut listener = peers[0].tunnel.listen(8123).unwrap();
        carried_by_name(
            &fabric,
            &mut listener,
            "10.7.0.1",
            "alice--a1.p1.proxy.chan.invalid",
        )
        .await;
        let now = Instant::now();
        let ((status, _), ()) = tokio::join!(
            connect_authority(&fabric, "alice--a1.p2.proxy.chan.invalid:8123"),
            carried_by_name(
                &fabric,
                &mut listener,
                "10.7.0.1",
                "bob--b2.p1.proxy.chan.invalid"
            ),
        );
        assert_eq!(status, 502, "only the unreachable ingress refuses");
        assert!(
            now.elapsed() < Duration::from_secs(10),
            "the missing session has the per-tunnel bound"
        );
        assert_eq!(
            fabric.status(&row.id, row.wireguard_source()).as_deref(),
            Some("connecting"),
            "one up ingress must not hide the other pending ingress"
        );
        assert_eq!(
            fabric.reason_for_destination("alice--a1.p1.proxy.chan.invalid", &[]),
            Some(None)
        );
        assert!(fabric
            .reason_for_destination("alice--a1.p2.proxy.chan.invalid", &[])
            .unwrap()
            .unwrap()
            .contains("127.0.0.1:9"));
        assert!(
            fabric
                .discovery_failure(
                    &row.id,
                    row.wireguard_source(),
                    Some("identity.chan.invalid")
                )
                .is_none(),
            "a node cannot explain failure of the public identity service"
        );
    }

    #[tokio::test]
    async fn enrolled_adopt_reorders_without_restarting_and_replaces_only_changed_ingresses() {
        let dir = tempfile::tempdir().unwrap();
        let (mut row, peers) = enrolled_peers(dir.path(), "gw-multi").await;
        let fabric = start(std::slice::from_ref(&row)).await;
        let started = |id: &str| {
            let rows = fabric.rows.lock().unwrap();
            let (_, state) = rows[&row.id]
                .ingresses
                .iter()
                .find(|(held, _)| held == id)
                .unwrap();
            match state {
                Row::Running { started, .. } => *started,
                _ => panic!("running ingress"),
            }
        };
        let original = [started("gw-multi/p1"), started("gw-multi/p2")];
        // A live connection must survive a reorder, not merely get a new session.
        let mut listener = peers[0].tunnel.listen(8123).unwrap();
        let (status, mut client) =
            connect_authority(&fabric, "alice--a1.p1.proxy.chan.invalid:8123").await;
        assert_eq!(status, 200);
        let mut server = tokio::time::timeout(WAIT, listener.accept())
            .await
            .unwrap()
            .unwrap();
        row.wireguard_enrollment
            .as_mut()
            .unwrap()
            .ingresses
            .reverse();
        fabric.adopt_gateway(&row).unwrap().unwrap();
        assert_eq!(started("gw-multi/p1"), original[0]);
        assert_eq!(started("gw-multi/p2"), original[1]);
        client.write_all(b"kept").await.unwrap();
        let mut bytes = [0; 4];
        tokio::time::timeout(WAIT, server.read_exact(&mut bytes))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&bytes, b"kept");
        // Both AllowedIPs contain this address: the reordered first ingress wins.
        assert!(fabric
            .reason_for_destination("unmapped.invalid", &["10.7.0.2".parse().unwrap()])
            .unwrap()
            .is_some());
        let mut other_listener = peers[1].tunnel.listen(8123).unwrap();
        carried(&fabric, &mut other_listener, "10.7.0.1", "10.7.0.2").await;
        for change in ["key", "endpoint", "hosts"] {
            let before = started("gw-multi/p2");
            let ingress = &mut row.wireguard_enrollment.as_mut().unwrap().ingresses[0];
            match change {
                "key" => ingress.public_key = base64_of(PublicKey::from(&secret()).as_bytes()),
                "endpoint" => ingress.endpoint = "127.0.0.1:9".into(),
                "hosts" => ingress.hosts = vec![host("*.renamed.proxy.chan.invalid", "10.7.0.2")],
                _ => unreachable!(),
            }
            fabric.adopt_gateway(&row).unwrap().unwrap();
            assert_ne!(
                started("gw-multi/p2"),
                before,
                "{change} replaces its ingress"
            );
            assert_eq!(
                started("gw-multi/p1"),
                original[0],
                "{change} leaves the other tunnel alone"
            );
        }
        row.wireguard_enrollment
            .as_mut()
            .unwrap()
            .ingresses
            .remove(0);
        fabric.adopt_gateway(&row).unwrap().unwrap();
        assert_eq!(fabric.routes(), 1);
        assert_eq!(started("gw-multi/p1"), original[0]);
        let mut extra = row.wireguard_enrollment.as_ref().unwrap().ingresses[0].clone();
        extra.id = "p3".into();
        extra.hosts = vec![host("*.p3.proxy.chan.invalid", "10.7.0.2")];
        row.wireguard_enrollment
            .as_mut()
            .unwrap()
            .ingresses
            .push(extra);
        fabric.adopt_gateway(&row).unwrap().unwrap();
        assert_eq!(fabric.routes(), 2);
        assert_eq!(started("gw-multi/p1"), original[0]);
        assert!(fabric
            .reason_for_destination("alice--a1.renamed.proxy.chan.invalid", &[])
            .is_none());
    }

    #[tokio::test]
    async fn start_routes_a_rows_host_map_by_name_with_no_lookup() {
        let dir = tempfile::tempdir().unwrap();
        let far = peer(dir.path(), "gw.conf", "10.7.0.1", "10.7.0.2").await;
        let mut listener = far.tunnel.listen(0).unwrap();
        let mut row = gateway("gw", Some(&far.conf));
        row.wireguard_hosts = vec![
            host("gw.chan.invalid", "10.7.0.2"),
            host("*.proxy.chan.invalid", "10.7.0.2"),
        ];
        let fabric = start(&[row]).await;
        // The exact name, and the wildcard one and three labels deep.
        for name in [
            "gw.chan.invalid",
            "alice--a1.proxy.chan.invalid",
            "x.y.alice--a1.proxy.chan.invalid",
        ] {
            carried_by_name(&fabric, &mut listener, "10.7.0.1", name).await;
        }
        // The wildcard's bare suffix is not under it: it takes the lookup,
        // which fails.
        let bare = format!("proxy.chan.invalid:{}", listener.port());
        let (status, _) = connect_authority(&fabric, &bare).await;
        assert_ne!(status, 200, "CONNECT {bare}");
        drop(fabric);
        // The same file with no map routes no name, as before.
        let plain = start(&[gateway("gw", Some(&far.conf))]).await;
        let named = format!("gw.chan.invalid:{}", listener.port());
        let (status, _) = connect_authority(&plain, &named).await;
        assert_ne!(status, 200, "CONNECT {named} with no map");
    }

    #[tokio::test]
    async fn owned_enrollment_migration_preserves_the_tunnel_and_builds_an_added_peer() {
        let dir = tempfile::tempdir().unwrap();
        let far = peer(dir.path(), "far.conf", "10.7.0.1", "10.7.0.2").await;
        let mut listener = far.tunnel.listen(0).unwrap();
        let original = chan_wireguard::config::read_file(&far.conf).unwrap();
        let public = base64_of(original.public_key().as_bytes());
        let store = Arc::new(Mutex::new(crate::config::ConfigStore::at_path(
            dir.path().join("desktop/config.json"),
        )));
        let keys = store.lock().unwrap().wireguard_dir();
        std::fs::create_dir_all(&keys).unwrap();
        let key = owner_only(&keys, "gw-migrate.key", &format!("{}\n", far.private_key));
        let old = keys.join("gw-migrate.conf");
        chan_wireguard::config::write_file(&old, &original).unwrap();
        let key_bytes = std::fs::read(&key).unwrap();
        let mut row = gateway("gw-migrate", Some(&old));
        row.wireguard_public_key = Some(public.clone());
        row.wireguard_enrolled_key = Some(public.clone());
        row.wireguard_hosts = vec![host("tenant.chan.invalid", "10.7.0.2")];
        {
            let mut guard = store.lock().unwrap();
            let mut cfg = guard.get().unwrap();
            cfg.gateways.push(row);
            guard.save(&cfg).unwrap();
        }
        assert_eq!(
            crate::config::migrate_wireguard_enrollments(&store).unwrap(),
            1
        );
        assert!(!old.exists());
        let row = store.lock().unwrap().get().unwrap().gateways.remove(0);
        assert_eq!(row.wireguard, None);
        assert!(row.wireguard_hosts.is_empty());
        let parameters = row.wireguard_enrollment.as_ref().unwrap();
        let migrated = parameters.configs(&public).unwrap().remove(0);
        assert_eq!(
            migrated.private_key.to_bytes(),
            original.private_key.to_bytes()
        );
        assert_eq!(migrated.addresses, original.addresses);
        assert_eq!(migrated.peer.endpoint, original.peer.endpoint);
        assert_eq!(
            migrated.peer.public_key.as_bytes(),
            original.peer.public_key.as_bytes()
        );
        assert_eq!(migrated.peer.allowed_ips, original.peer.allowed_ips);
        assert_eq!(
            migrated.peer.persistent_keepalive,
            original.peer.persistent_keepalive
        );
        let fabric = start(std::slice::from_ref(&row)).await;
        assert_eq!(fabric.tunnels(), 1);
        carried_by_name(&fabric, &mut listener, "10.7.0.1", "tenant.chan.invalid").await;
        let mut expanded = parameters.clone();
        let mut second = expanded.ingresses[0].clone();
        second.id = "p2".into();
        second.endpoint = "127.0.0.1:51821".into();
        second.public_key = base64_of(PublicKey::from(&StaticSecret::from([9u8; 32])).as_bytes());
        second.hosts = vec![host("*.p2.chan.invalid", "10.7.0.2")];
        expanded.ingresses.push(second.clone());
        let configs = expanded.configs(&public).unwrap();
        assert_eq!(configs.len(), 2);
        assert_eq!(configs[0].peer.endpoint, migrated.peer.endpoint);
        assert_eq!(configs[1].peer.endpoint.to_string(), second.endpoint);
        assert_eq!(
            base64_of(configs[1].peer.public_key.as_bytes()),
            second.public_key
        );
        assert_eq!(
            configs[0].private_key.to_bytes(),
            configs[1].private_key.to_bytes()
        );
        assert_eq!(std::fs::read(&key).unwrap(), key_bytes);
        assert_eq!(std::fs::read_dir(&keys).unwrap().count(), 1);
        assert_eq!(
            crate::config::migrate_wireguard_enrollments(&store).unwrap(),
            0
        );
        let mut regenerated = row;
        regenerated.wireguard_public_key =
            Some(crate::wireguard_keys::generate(&keys, "gw-migrate").unwrap());
        assert!(fabric.adopt_gateway(&regenerated).is_none());
        assert_eq!(
            fabric.tunnels(),
            1,
            "the live tunnel still owns its old key"
        );
        carried_by_name(&fabric, &mut listener, "10.7.0.1", "tenant.chan.invalid").await;
    }

    #[tokio::test]
    async fn regenerated_enrollment_clears_a_refusal_but_conflicting_sources_refuse() {
        let fabric = start(&[]).await;
        let key = std::path::PathBuf::from("unused.key");
        let mut row = gateway("gw-conflict", Some(std::path::Path::new("manual.conf")));
        row.wireguard_public_key = Some("new-key".into());
        row.wireguard_enrolled_key = Some("old-key".into());
        row.wireguard_enrollment = Some(crate::config::WireguardEnrollment {
            key_file: key.clone(),
            addresses: Vec::new(),
            allowed_ips: Vec::new(),
            persistent_keepalive: None,
            ingresses: Vec::new(),
        });
        assert!(fabric
            .adopt_gateway(&row)
            .unwrap()
            .unwrap_err()
            .contains("both a manual file"));
        assert!(fabric.failure(&row.id, Some(&key)).is_some());
        row.wireguard = None;
        assert!(fabric.adopt_gateway(&row).is_none());
        assert!(fabric.failure(&row.id, Some(&key)).is_none());
        assert_eq!(fabric.tunnels(), 0);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn migration_retries_owned_orphans_after_cleanup_failure() {
        use std::os::unix::fs::PermissionsExt;
        let lines = crate::devserver::log_capture::Lines::default();
        let _capture = lines.install();
        let dir = tempfile::tempdir().unwrap();
        let far = peer(dir.path(), "far.conf", "10.7.0.1", "10.7.0.2").await;
        let original = chan_wireguard::config::read_file(&far.conf).unwrap();
        let public = base64_of(original.public_key().as_bytes());
        let store = Arc::new(Mutex::new(crate::config::ConfigStore::at_path(
            dir.path().join("desktop/config.json"),
        )));
        let keys = store.lock().unwrap().wireguard_dir();
        std::fs::create_dir_all(&keys).unwrap();
        for id in ["gw-first", "gw-second"] {
            owner_only(
                &keys,
                &format!("{id}.key"),
                &format!("{}\n", far.private_key),
            );
            let old = keys.join(format!("{id}.conf"));
            chan_wireguard::config::write_file(&old, &original).unwrap();
            let mut row = gateway(id, Some(&old));
            row.wireguard_public_key = Some(public.clone());
            row.wireguard_enrolled_key = Some(public.clone());
            let mut guard = store.lock().unwrap();
            let mut cfg = guard.get().unwrap();
            cfg.gateways.push(row);
            guard.save(&cfg).unwrap();
        }
        std::fs::set_permissions(&keys, std::fs::Permissions::from_mode(0o500)).unwrap();
        let migrated = crate::config::migrate_wireguard_enrollments(&store);
        std::fs::set_permissions(&keys, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            migrated.unwrap(),
            2,
            "cleanup failure must not fail conversion"
        );
        let cleanup_warnings: Vec<_> = lines
            .warnings()
            .into_iter()
            .filter(|line| line.contains("cleanup retry"))
            .collect();
        assert_eq!(
            cleanup_warnings.len(),
            2,
            "each failed cleanup must be attempted and logged"
        );
        assert!(keys.join("gw-first.conf").exists());
        assert!(keys.join("gw-second.conf").exists());
        // A valid edited configuration is kept while the unchanged orphan retries.
        let mut replacement = chan_wireguard::config::read_file(&far.conf).unwrap();
        replacement.peer.endpoint = chan_wireguard::config::Endpoint::parse("127.0.0.1:9").unwrap();
        chan_wireguard::config::write_file(&keys.join("gw-first.conf"), &replacement).unwrap();
        let replacement_bytes = std::fs::read(keys.join("gw-first.conf")).unwrap();
        assert_eq!(
            crate::config::migrate_wireguard_enrollments(&store).unwrap(),
            0
        );
        assert_eq!(
            std::fs::read(keys.join("gw-first.conf")).unwrap(),
            replacement_bytes
        );
        assert!(!keys.join("gw-second.conf").exists());
        let rows = store.lock().unwrap().get().unwrap().gateways;
        assert!(rows.iter().all(|row| row.wireguard_enrollment.is_some()));
        assert_eq!(
            rows[0].wireguard_enrollment.as_ref().unwrap().ingresses[0].id,
            crate::wireguard_keys::LEGACY_INGRESS_ID
        );
    }

    #[tokio::test]
    async fn migration_keeps_mismatched_and_hand_written_files_operational() {
        for manual in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let far = peer(dir.path(), "far.conf", "10.7.0.1", "10.7.0.2").await;
            let mut listener = far.tunnel.listen(0).unwrap();
            let original = chan_wireguard::config::read_file(&far.conf).unwrap();
            let store = Arc::new(Mutex::new(crate::config::ConfigStore::at_path(
                dir.path().join("desktop/config.json"),
            )));
            let keys = store.lock().unwrap().wireguard_dir();
            let generated = crate::wireguard_keys::generate(&keys, "gw-migrate").unwrap();
            let old = if manual {
                far.conf.clone()
            } else {
                keys.join("gw-migrate.conf")
            };
            chan_wireguard::config::write_file(&old, &original).unwrap();
            let old_bytes = std::fs::read(&old).unwrap();
            let mut row = gateway("gw-migrate", Some(&old));
            if manual {
                // A leftover owned file must not make an operator path an enrollment.
                chan_wireguard::config::write_file(&keys.join("gw-migrate.conf"), &original)
                    .unwrap();
                owner_only(&keys, "gw-migrate.key", &format!("{}\n", far.private_key));
                row.wireguard_public_key = Some(base64_of(original.public_key().as_bytes()));
            } else {
                row.wireguard_public_key = Some(generated);
            }
            row.wireguard_enrolled_key = Some(base64_of(original.public_key().as_bytes()));
            row.wireguard_hosts = vec![host("tenant.chan.invalid", "10.7.0.2")];
            {
                let mut guard = store.lock().unwrap();
                let mut cfg = guard.get().unwrap();
                cfg.gateways.push(row.clone());
                guard.save(&cfg).unwrap();
            }
            assert_eq!(
                crate::config::migrate_wireguard_enrollments(&store).unwrap(),
                0
            );
            assert_eq!(store.lock().unwrap().get().unwrap().gateways[0], row);
            assert_eq!(std::fs::read(&old).unwrap(), old_bytes);
            let fabric = start(&[row]).await;
            assert_eq!(fabric.tunnels(), 1);
            carried_by_name(&fabric, &mut listener, "10.7.0.1", "tenant.chan.invalid").await;
        }
    }

    #[tokio::test]
    async fn an_enrollment_adopts_its_tunnel_and_routes_its_names_at_once() {
        let lines = crate::devserver::log_capture::Lines::default();
        let _capture = lines.install();
        let started = || {
            lines
                .infos()
                .iter()
                .filter(|line| line.contains("gateway WireGuard tunnel started"))
                .count()
        };
        let dir = tempfile::tempdir().unwrap();
        let far = peer(dir.path(), "far.conf", "10.7.0.1", "10.7.0.2").await;
        let mut listener = far.tunnel.listen(0).unwrap();
        // What a redeem answers for this peer, and the discovery entry the
        // sign-in sent its key against.
        let client = chan_wireguard::config::read_file(&far.conf).unwrap();
        let server_key = base64_of(client.peer.public_key.as_bytes());
        let endpoint = client.peer.endpoint.to_string();
        let sent = base64_of(PublicKey::from(&client.private_key).as_bytes());
        let entry = crate::devserver::WireguardDiscovery {
            allowed_ips: None,
            persistent_keepalive: None,
            ingresses: None,
            endpoint: endpoint.clone(),
            public_key: server_key.clone(),
        };
        let params = crate::wireguard_keys::EnrollmentParams {
            ingresses: None,
            server_public_key: server_key,
            endpoint,
            addresses: vec!["10.7.0.1/32".into()],
            allowed_ips: vec!["10.7.0.2/32".into()],
            persistent_keepalive: None,
            hosts: vec![host("tenant.chan.invalid", "10.7.0.2")],
        };
        // The row, with no file yet, and its key file holding the client key.
        let store = Arc::new(Mutex::new(crate::config::ConfigStore::at_path(
            dir.path().join("desktop").join("config.json"),
        )));
        {
            let mut guard = store.lock().unwrap();
            let mut cfg = guard.get().unwrap();
            cfg.gateways.push(gateway("gw-enroll", None));
            guard.save(&cfg).unwrap();
        }
        let keys = store.lock().unwrap().wireguard_dir();
        std::fs::create_dir_all(&keys).unwrap();
        owner_only(
            &keys,
            "gw-enroll.key",
            &format!(
                "{}
",
                far.private_key
            ),
        );
        let fabric = Arc::new(start(&[]).await);
        let manager = crate::gateway::GatewayManager::default();
        manager.set_wireguard(Arc::clone(&fabric)).unwrap();

        let enrollment =
            crate::wireguard_keys::prepare(&keys, "gw-enroll", &sent, &entry, &params).unwrap();
        let (_recorded, adopted) =
            crate::config::record_wireguard_enrollment(&store, &manager, "gw-enroll", enrollment)
                .unwrap();
        let conf = crate::wireguard_keys::key_path(&keys, "gw-enroll");
        // The running fabric took it: the badge reads the adopt's answer,
        // and a name in the map reaches the peer through the tunnel at once.
        assert_eq!(adopted, Some(Ok("connecting".to_string())));
        assert_eq!(fabric.tunnels(), 1);
        assert_eq!(started(), 1);
        carried_by_name(&fabric, &mut listener, "10.7.0.1", "tenant.chan.invalid").await;
        assert_eq!(
            fabric.status("gw-enroll", Some(&conf)).as_deref(),
            Some("up")
        );
        let row = store.lock().unwrap().get().unwrap().gateways[0].clone();
        assert_eq!(row.wireguard_source(), Some(conf.as_path()));
        assert_eq!(row.wireguard_enrolled_key.as_deref(), Some(sent.as_str()));
        assert_eq!(
            row.wireguard_enrollment.as_ref().unwrap().ingresses[0].hosts,
            params.hosts
        );

        // Enrolling again replaces the parameters and restarts the tunnel.
        let enrollment =
            crate::wireguard_keys::prepare(&keys, "gw-enroll", &sent, &entry, &params).unwrap();
        let (_again, adopted) =
            crate::config::record_wireguard_enrollment(&store, &manager, "gw-enroll", enrollment)
                .unwrap();
        assert_eq!(adopted, Some(Ok("connecting".to_string())));
        assert_eq!(started(), 2);
        assert_eq!(fabric.tunnels(), 1);
        carried_by_name(&fabric, &mut listener, "10.7.0.1", "tenant.chan.invalid").await;
    }

    #[tokio::test]
    async fn reason_for_destination_uses_a_mapped_name_before_address_lookup() {
        let dir = tempfile::tempdir().unwrap();
        let far = peer(dir.path(), "gw.conf", "10.7.0.1", "10.7.0.2").await;
        let fabric = start(&[]).await;
        fabric
            .adopt(
                "gw",
                &far.conf,
                vec![HostRoute {
                    name: "tenant.proxy.chan.invalid".into(),
                    addresses: vec!["10.7.0.2".parse().unwrap()],
                }],
            )
            .unwrap();
        let tunnel = fabric.tunnel("gw").unwrap();
        tokio::time::timeout(WAIT, async {
            while tunnel.status().endpoint.is_none() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let reason = fabric
            .reason_for_destination("tenant.proxy.chan.invalid", &[])
            .expect("the name is routed")
            .expect("the routed tunnel has no session");
        assert!(
            reason.contains("no WireGuard handshake with the peer at 127.0.0.1:"),
            "{reason}"
        );
        assert!(reason.contains("since the tunnel started"), "{reason}");
        assert!(reason.contains(&far.conf.display().to_string()), "{reason}");
        assert!(reason.contains("check PublicKey"), "{reason}");
        assert!(!reason.contains(&far.private_key), "{reason}");
        let counts = Mutex::new(HashMap::new());
        let failed = crate::probe_result_for(
            &counts,
            "window",
            "http://tenant.proxy.chan.invalid/",
            Some(reqwest::StatusCode::BAD_GATEWAY),
            "502 Bad Gateway".into(),
        );
        let decorated =
            crate::with_tunnel_reason(failed, Some(&fabric), "http://tenant.proxy.chan.invalid/")
                .await;
        assert!(decorated
            .tunnel
            .unwrap()
            .contains(&far.conf.display().to_string()));
        let reachable = crate::probe_result_for(
            &counts,
            "window",
            "http://unmapped.chan.invalid/",
            Some(reqwest::StatusCode::OK),
            "200 OK".into(),
        );
        let decorated =
            crate::with_tunnel_reason(reachable, Some(&fabric), "http://unmapped.chan.invalid/")
                .await;
        assert!(decorated.reachable);
        assert_eq!(decorated.tunnel, None);
        assert_eq!(
            fabric.reason_for_destination("unmapped.chan.invalid", &[]),
            None
        );
    }

    #[tokio::test]
    async fn reason_for_destination_preserves_route_order_on_replace_and_retire() {
        let dir = tempfile::tempdir().unwrap();
        let first = peer(dir.path(), "first.conf", "10.7.0.1", "10.7.0.2").await;
        let second = peer(dir.path(), "second.conf", "10.7.0.1", "10.7.0.2").await;
        let replacement = peer(dir.path(), "replacement.conf", "10.7.0.1", "10.7.0.2").await;
        let fabric = start(&[]).await;
        let hosts = || {
            vec![HostRoute {
                name: "tenant.proxy.chan.invalid".into(),
                addresses: vec!["10.7.0.2".parse().unwrap()],
            }]
        };
        fabric.adopt("first", &first.conf, hosts()).unwrap();
        fabric.adopt("second", &second.conf, hosts()).unwrap();
        let reason = |fabric: &WireguardFabric| {
            fabric
                .reason_for_destination("tenant.proxy.chan.invalid", &[])
                .flatten()
                .unwrap()
        };
        for id in ["first", "second"] {
            let tunnel = fabric.tunnel(id).unwrap();
            tokio::time::timeout(WAIT, async {
                while tunnel.status().endpoint.is_none() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
        }
        assert!(reason(&fabric).contains(&first.conf.display().to_string()));
        fabric.adopt("first", &replacement.conf, hosts()).unwrap();
        let tunnel = fabric.tunnel("first").unwrap();
        tokio::time::timeout(WAIT, async {
            while tunnel.status().endpoint.is_none() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(reason(&fabric).contains(&replacement.conf.display().to_string()));
        assert!(fabric.retire("first"));
        fabric.adopt("first", &first.conf, hosts()).unwrap();
        assert!(reason(&fabric).contains(&second.conf.display().to_string()));
    }

    #[tokio::test]
    async fn reason_for_destination_uses_the_first_routed_address_and_skips_live_reasons() {
        let dir = tempfile::tempdir().unwrap();
        let far_a = peer(dir.path(), "a.conf", "10.7.0.1", "10.7.0.2").await;
        let far_b = peer(dir.path(), "b.conf", "10.8.0.1", "10.8.0.2").await;
        let fabric = start(&[]).await;
        fabric.adopt("a", &far_a.conf, Vec::new()).unwrap();
        fabric
            .adopt(
                "b",
                &far_b.conf,
                vec![HostRoute {
                    name: "*.proxy.chan.invalid".into(),
                    addresses: vec!["10.8.0.2".parse().unwrap()],
                }],
            )
            .unwrap();
        for id in ["a", "b"] {
            let tunnel = fabric.tunnel(id).unwrap();
            tokio::time::timeout(WAIT, async {
                while tunnel.status().endpoint.is_none() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
        }
        let ip_a = "10.7.0.2".parse().unwrap();
        let ip_b = "10.8.0.2".parse().unwrap();
        let outside = "192.0.2.9".parse().unwrap();
        assert_eq!(
            fabric.reason_for_destination("none.invalid", &[outside]),
            None
        );
        let reason = fabric
            .reason_for_destination("none.invalid", &[outside, ip_b])
            .expect("the second address is routed")
            .expect("the second tunnel has no session");
        assert!(
            reason.contains(&far_b.conf.display().to_string()),
            "{reason}"
        );
        let mapped = fabric
            .reason_for_destination("A.tenant.PROXY.chan.invalid", &[ip_a])
            .expect("the wildcard name is routed")
            .expect("its tunnel has no session");
        assert!(
            mapped.contains(&far_b.conf.display().to_string()),
            "{mapped}"
        );
        let mut listener = far_a.tunnel.listen(80).unwrap();
        let connecting = tokio::spawn({
            let tunnel = fabric.tunnel("a").unwrap();
            async move { tunnel.connect(SocketAddr::new(ip_a, 80)).await.unwrap() }
        });
        let _server = tokio::time::timeout(WAIT, listener.accept())
            .await
            .unwrap()
            .unwrap();
        let _client = tokio::time::timeout(WAIT, connecting)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            fabric.reason_for_destination("none.invalid", &[ip_a, ip_b]),
            Some(None),
            "the first routed address is live, so a later dark route is irrelevant"
        );
    }

    #[tokio::test]
    async fn adopt_starts_routes_and_reports_connecting() {
        let dir = tempfile::tempdir().unwrap();
        let far = peer(dir.path(), "gw.conf", "10.7.0.1", "10.7.0.2").await;
        let mut listener = far.tunnel.listen(0).unwrap();
        let fabric = start(&[]).await;
        let status = fabric.adopt("gw", &far.conf, Vec::new());
        assert_eq!(status.as_deref(), Ok("connecting"));
        assert_eq!(fabric.tunnels(), 1);
        assert_eq!(
            fabric.status("gw", Some(&far.conf)).as_deref(),
            Some("connecting")
        );
        // The running proxy carries the adopted route.
        carried(&fabric, &mut listener, "10.7.0.1", "10.7.0.2").await;
        assert_eq!(fabric.status("gw", Some(&far.conf)).as_deref(), Some("up"));
        // A row naming another file reads no status.
        assert_eq!(fabric.status("gw", Some(Path::new("/changed.conf"))), None);
        assert_eq!(fabric.status("gw", None), None);
    }

    #[tokio::test]
    async fn adopt_replaces_a_running_tunnel_after_routing_the_new_one() {
        let dir = tempfile::tempdir().unwrap();
        // Two peers at one tunnel address, told apart by the client
        // address each file gives the fabric.
        let first = peer(dir.path(), "first.conf", "10.7.0.1", "10.7.0.2").await;
        let second = peer(dir.path(), "second.conf", "10.7.0.3", "10.7.0.2").await;
        let mut first_listener = first.tunnel.listen(0).unwrap();
        let mut second_listener = second.tunnel.listen(0).unwrap();
        let fabric = start(&[]).await;
        fabric.adopt("gw", &first.conf, Vec::new()).unwrap();
        carried(&fabric, &mut first_listener, "10.7.0.1", "10.7.0.2").await;
        // A stream of the test's own over the first tunnel, and the test's
        // own handle of it.
        let old = fabric.tunnel("gw").unwrap();
        let mut old_stream = tokio::time::timeout(
            WAIT,
            old.connect(SocketAddr::new(
                "10.7.0.2".parse().unwrap(),
                first_listener.port(),
            )),
        )
        .await
        .unwrap()
        .unwrap();
        let _held = first_listener.accept().await.unwrap();

        assert_eq!(
            fabric.adopt("gw", &second.conf, Vec::new()).as_deref(),
            Ok("connecting")
        );
        assert_eq!(fabric.tunnels(), 1);
        assert_eq!(fabric.routes(), 1);
        carried(&fabric, &mut second_listener, "10.7.0.3", "10.7.0.2").await;
        assert_eq!(fabric.status("gw", Some(&first.conf)), None);

        // The fabric let the first tunnel go; once the test's handle is
        // gone too, its stack is closed under the stream.
        drop(old);
        let mut buf = [0u8; 4];
        let err = tokio::time::timeout(WAIT, old_stream.read(&mut buf))
            .await
            .unwrap()
            .expect_err("the first tunnel is closed");
        assert_eq!(err.kind(), io::ErrorKind::ConnectionAborted, "{err}");
    }

    #[tokio::test]
    async fn adopt_of_the_running_path_is_a_no_op() {
        let lines = crate::devserver::log_capture::Lines::default();
        let _capture = lines.install();
        let dir = tempfile::tempdir().unwrap();
        let far = peer(dir.path(), "gw.conf", "10.7.0.1", "10.7.0.2").await;
        let mut listener = far.tunnel.listen(0).unwrap();
        let fabric = start(&[]).await;
        fabric.adopt("gw", &far.conf, Vec::new()).unwrap();
        carried(&fabric, &mut listener, "10.7.0.1", "10.7.0.2").await;
        // The same path again answers the live tunnel's status, `up`, where
        // a fresh tunnel would read `connecting`, and starts nothing.
        assert_eq!(
            fabric.adopt("gw", &far.conf, Vec::new()).as_deref(),
            Ok("up")
        );
        let started = lines
            .infos()
            .iter()
            .filter(|line| line.contains("gateway WireGuard tunnel started"))
            .count();
        assert_eq!(started, 1, "{:?}", lines.infos());
        assert_eq!(fabric.tunnels(), 1);
    }

    #[tokio::test]
    async fn adopt_refuses_a_bad_file_and_disables_that_row_alone() {
        let dir = tempfile::tempdir().unwrap();
        let good = peer(dir.path(), "good.conf", "10.7.0.1", "10.7.0.2").await;
        let changing = peer(dir.path(), "changing.conf", "10.7.0.3", "10.7.0.2").await;
        let bad = owner_only(
            dir.path(),
            "bad.conf",
            &std::fs::read_to_string(&good.conf)
                .unwrap()
                .replace("Address = 10.7.0.1/32", "Address = nowhere"),
        );
        let fabric = start(&[]).await;
        fabric.adopt("good", &good.conf, Vec::new()).unwrap();
        fabric
            .adopt("changing", &changing.conf, Vec::new())
            .unwrap();

        let reason = fabric
            .adopt("bad", &bad, Vec::new())
            .expect_err("a bad file is refused");
        assert!(reason.starts_with("WireGuard: "), "{reason}");
        assert!(reason.contains(&bad.display().to_string()), "{reason}");
        assert!(reason.contains("line 3"), "{reason}");
        assert!(reason.contains("Address"), "{reason}");
        assert!(!reason.contains(&good.private_key), "{reason}");
        assert_eq!(fabric.status("bad", Some(&bad)), None);
        assert_eq!(fabric.failure("bad", Some(&bad)), Some(reason.clone()));
        assert_eq!(fabric.connect_refusal("bad", Some(&bad)), Some(reason));

        // A running row pointed at the bad file loses its tunnel and
        // carries the refusal; the other rows are untouched.
        fabric
            .adopt("changing", &bad, Vec::new())
            .expect_err("the same bad file");
        assert_eq!(fabric.status("changing", Some(&changing.conf)), None);
        assert!(fabric.failure("changing", Some(&bad)).is_some());
        assert_eq!(fabric.tunnels(), 1);
        assert_eq!(fabric.routes(), 1);
        assert_eq!(
            fabric.status("good", Some(&good.conf)).as_deref(),
            Some("connecting")
        );
        assert_eq!(fabric.connect_refusal("good", Some(&good.conf)), None);
        let debug = format!("{fabric:?}");
        assert!(!debug.contains(&good.private_key), "{debug}");
        assert!(debug.contains("tunnels: 1"), "{debug}");
    }

    #[tokio::test]
    async fn retire_removes_the_route_and_the_status() {
        let lines = crate::devserver::log_capture::Lines::default();
        let _capture = lines.install();
        let dir = tempfile::tempdir().unwrap();
        let far = peer(dir.path(), "gw.conf", "10.7.0.1", "10.7.0.2").await;
        let mut listener = far.tunnel.listen(0).unwrap();
        let fabric = start(&[]).await;
        fabric.adopt("gw", &far.conf, Vec::new()).unwrap();
        carried(&fabric, &mut listener, "10.7.0.1", "10.7.0.2").await;

        assert!(fabric.retire("gw"));
        assert_eq!(fabric.status("gw", Some(&far.conf)), None);
        assert_eq!(fabric.tunnels(), 0);
        assert_eq!(fabric.routes(), 0);
        assert!(!fabric.retire("gw"), "nothing is left to retire");
        let retired: Vec<String> = lines
            .infos()
            .into_iter()
            .filter(|line| line.contains("gateway WireGuard tunnel retired"))
            .collect();
        assert_eq!(retired.len(), 1, "{:?}", lines.infos());
        assert!(retired[0].contains("gateway=gw"), "{}", retired[0]);
        // A retired row is adopted again from scratch.
        assert_eq!(
            fabric.adopt("gw", &far.conf, Vec::new()).as_deref(),
            Ok("connecting")
        );
    }

    #[tokio::test]
    async fn a_bind_failure_degrades_every_row_with_the_reason() {
        let dir = tempfile::tempdir().unwrap();
        let far = peer(dir.path(), "gw.conf", "10.7.0.1", "10.7.0.2").await;
        // The proxy binds loopback only, so this address is refused.
        let fabric = start_with_bind(
            &[gateway("gw", Some(&far.conf))],
            "192.0.2.1:0".parse().unwrap(),
        )
        .await;
        assert_eq!(fabric.proxy_url(), None);
        assert_eq!(fabric.tunnels(), 0);
        let reason = fabric
            .adopt("gw", &far.conf, Vec::new())
            .expect_err("no proxy, no tunnel");
        assert!(
            reason.starts_with("WireGuard: starting the proxy: "),
            "{reason}"
        );
        assert_eq!(
            fabric.connect_refusal("gw", Some(&far.conf)),
            Some(reason.clone())
        );
        // Every row with a file reads the reason, one never adopted too;
        // a row without a file has nothing to refuse.
        assert_eq!(
            fabric.connect_refusal("other", Some(Path::new("/other.conf"))),
            Some(reason)
        );
        assert_eq!(fabric.connect_refusal("plain", None), None);
        assert_eq!(fabric.status("gw", Some(&far.conf)), None);
        assert_eq!(fabric.tunnels(), 0);
    }

    /// A failing lookup no longer takes a live session down, so the state
    /// reads up while it fails, and the failure alone only without one. A
    /// stalled lookup says so instead of claiming a retry.
    #[test]
    fn describe_reads_a_live_session_as_up_beside_a_failing_lookup() {
        let status = |handshake: bool, error: Option<&str>, stalled: bool| chan_wireguard::Status {
            handshake: if handshake {
                chan_wireguard::HandshakeState::Live(Duration::from_secs(3))
            } else {
                chan_wireguard::HandshakeState::Never
            },
            tx_bytes: 0,
            rx_bytes: 0,
            endpoint: None,
            resolution_error: error.map(str::to_string),
            resolution_stalled: stalled,
        };
        let failure = "endpoint did not resolve: gw.test:51820: name absent";
        assert_eq!(describe(status(false, None, false)), "connecting");
        let mut lost = status(false, None, false);
        lost.handshake = chan_wireguard::HandshakeState::Lost(Duration::from_secs(212));
        assert_eq!(describe(lost.clone()), "lost; no handshake for 3 min");
        assert_eq!(describe(status(true, None, false)), "up");
        assert_eq!(
            describe(status(false, Some(failure), false)),
            format!("{failure}, retrying")
        );
        assert_eq!(
            describe(status(true, Some(failure), false)),
            format!("up; {failure}, retrying")
        );
        let timeout = "endpoint did not resolve: gw.test:51820: lookup timed out";
        assert_eq!(
            describe(status(false, Some(timeout), true)),
            format!("{timeout}; stalled, waiting for the system resolver")
        );
        assert_eq!(
            describe(status(true, Some(timeout), true)),
            format!("up; {timeout}; stalled, waiting for the system resolver")
        );
        lost.resolution_error = Some(failure.into());
        assert_eq!(
            describe(lost),
            format!("lost; no handshake for 3 min; {failure}, retrying")
        );
    }

    #[test]
    fn missing_handshake_reason_names_state_without_key_values() {
        let status = |handshake, endpoint, error: Option<&str>| chan_wireguard::Status {
            handshake,
            tx_bytes: 0,
            rx_bytes: 0,
            endpoint,
            resolution_error: error.map(str::to_string),
            resolution_stalled: false,
        };
        let endpoint = "127.0.0.1:51820";
        let resolved = Some(endpoint.parse().unwrap());
        let file = Path::new("/tmp/client.conf");
        assert_eq!(
            missing_handshake_reason(
                status(chan_wireguard::HandshakeState::Never, resolved, None),
                endpoint,
                file,
                Duration::from_secs(64),
            )
            .as_deref(),
            Some("no WireGuard handshake with the peer at 127.0.0.1:51820 since the tunnel started 1 min ago; check PublicKey in /tmp/client.conf and that the peer lists this client's key")
        );
        assert_eq!(
            missing_handshake_reason(
                status(chan_wireguard::HandshakeState::Lost(Duration::from_secs(3690)), resolved, None),
                endpoint,
                file,
                Duration::from_secs(5),
            )
            .as_deref(),
            Some("no WireGuard handshake with the peer at 127.0.0.1:51820 for 1 h 1 min; the tunnel had a session and lost it")
        );
        assert_eq!(
            missing_handshake_reason(
                status(chan_wireguard::HandshakeState::Never, None, None),
                endpoint,
                file,
                Duration::from_secs(5),
            )
            .as_deref(),
            Some("connecting")
        );
        let failure = "endpoint did not resolve: gw.test:51820, retrying";
        assert_eq!(
            missing_handshake_reason(
                status(
                    chan_wireguard::HandshakeState::Never,
                    None,
                    Some("endpoint did not resolve: gw.test:51820")
                ),
                endpoint,
                file,
                Duration::from_secs(5),
            )
            .as_deref(),
            Some(failure)
        );
    }

    #[test]
    fn live_handshake_has_no_missing_reason() {
        let status = chan_wireguard::Status {
            handshake: chan_wireguard::HandshakeState::Live(Duration::from_secs(3)),
            tx_bytes: 0,
            rx_bytes: 0,
            endpoint: Some("127.0.0.1:51820".parse().unwrap()),
            resolution_error: None,
            resolution_stalled: false,
        };
        assert_eq!(
            missing_handshake_reason(
                status,
                "127.0.0.1:51820",
                Path::new("/tmp/client.conf"),
                Duration::from_secs(5),
            ),
            None
        );
    }

    #[test]
    fn age_rounds_down_at_each_display_boundary() {
        for (seconds, expected) in [
            (0, "0 s"),
            (59, "59 s"),
            (60, "1 min"),
            (3599, "59 min"),
            (3600, "1 h"),
            (3660, "1 h 1 min"),
            (7200, "2 h"),
        ] {
            assert_eq!(format_age(Duration::from_secs(seconds)), expected);
        }
    }

    /// A stand-in HTTP peer on loopback: it records the request line of
    /// every connection and answers each with `response`, then, when
    /// `echo` is set, copies whatever follows back to the client.
    struct FakePeer {
        addr: SocketAddr,
        requests: Arc<Mutex<Vec<String>>>,
    }

    impl FakePeer {
        async fn start(response: &'static str, echo: bool) -> FakePeer {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let seen = Arc::clone(&requests);
            tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        return;
                    };
                    let seen = Arc::clone(&seen);
                    tokio::spawn(async move {
                        let mut head = Vec::new();
                        let mut byte = [0u8; 1];
                        while !head.ends_with(b"\r\n\r\n") {
                            match socket.read(&mut byte).await {
                                Ok(0) | Err(_) => return,
                                Ok(_) => head.push(byte[0]),
                            }
                        }
                        let text = String::from_utf8_lossy(&head).to_string();
                        seen.lock().unwrap().push(text);
                        if socket.write_all(response.as_bytes()).await.is_err() {
                            return;
                        }
                        if echo {
                            let mut buf = [0u8; 256];
                            while let Ok(n) = socket.read(&mut buf).await {
                                if n == 0 || socket.write_all(&buf[..n]).await.is_err() {
                                    return;
                                }
                            }
                        }
                    });
                }
            });
            FakePeer { addr, requests }
        }

        fn url(&self) -> Url {
            Url::parse(&format!("http://{}", self.addr)).unwrap()
        }

        fn request_lines(&self) -> Vec<String> {
            self.requests
                .lock()
                .unwrap()
                .iter()
                .map(|head| head.lines().next().unwrap_or_default().to_string())
                .collect()
        }
    }

    fn proxy_for(url: &Url) -> reqwest::Proxy {
        reqwest::Proxy::all(url.clone())
            .unwrap()
            .no_proxy(reqwest::NoProxy::from_string(DIRECT_HOSTS))
    }

    fn shared_tls() -> chan_tls::rustls::ClientConfig {
        chan_tls::client_config().unwrap()
    }

    #[tokio::test]
    async fn client_builder_verifies_with_the_config_it_is_given_over_http1() {
        let (tls, handshakes) = chan_tls::testing::recording(shared_tls());
        let sink = chan_tls::testing::Sink::start();
        // No proxy from the environment either, so the dial is the sink's.
        let client = client_builder_with(None, tls)
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let refused = client
            .get(format!("https://{}/roster", sink.addr))
            .send()
            .await;
        assert!(refused.is_err(), "the sink never answers");
        assert_eq!(handshakes.server_names(), ["127.0.0.1"]);
        assert_eq!(sink.alpn_offers(), [["http/1.1"]]);
    }

    #[tokio::test]
    async fn client_builder_applies_the_proxy_exactly_when_a_fabric_exists() {
        const NO_CONTENT: &str = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n";
        let proxy = FakePeer::start(NO_CONTENT, false).await;
        let direct = FakePeer::start(NO_CONTENT, false).await;
        let timeout = Duration::from_secs(5);

        // With a fabric a remote origin is asked of the proxy in absolute
        // form, which is how the proxy learns the destination; the name is
        // never resolved here (`.invalid` never resolves).
        let proxied = client_builder_with(Some(&proxy_for(&proxy.url())), shared_tls())
            .timeout(timeout)
            .build()
            .unwrap();
        let response = proxied
            .get("http://nowhere.invalid:1/roster")
            .send()
            .await
            .expect("the proxy answers for the remote origin");
        assert_eq!(response.status(), 204);
        assert_eq!(
            proxy.request_lines(),
            vec!["GET http://nowhere.invalid:1/roster HTTP/1.1".to_string()]
        );

        // The same client dials a loopback origin directly: the proxy
        // would only pass it through, and the local legs must not depend
        // on it.
        let response = proxied
            .get(format!("http://{}/local", direct.addr))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 204);
        assert_eq!(
            direct.request_lines(),
            vec!["GET /local HTTP/1.1".to_string()]
        );
        assert_eq!(
            proxy.request_lines().len(),
            1,
            "loopback never enters the proxy"
        );

        // Without a fabric nothing reaches the proxy: the remote origin
        // fails on its own resolution and the loopback origin is direct.
        let plain = client_builder_with(None, shared_tls())
            .timeout(timeout)
            .build()
            .unwrap();
        assert!(plain.get("http://nowhere.invalid:1/").send().await.is_err());
        let response = plain
            .get(format!("http://{}/plain", direct.addr))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 204);
        assert_eq!(proxy.request_lines().len(), 1, "no fabric, no proxy");
        assert_eq!(direct.request_lines().len(), 2);
    }

    #[tokio::test]
    async fn connect_through_requires_a_200_and_hands_back_the_stream() {
        let proxy = FakePeer::start("HTTP/1.1 200 Connection Established\r\n\r\n", true).await;
        let mut stream = tokio::time::timeout(WAIT, connect_through(proxy.addr, "10.7.0.2", 443))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            proxy.requests.lock().unwrap()[0],
            "CONNECT 10.7.0.2:443 HTTP/1.1\r\nHost: 10.7.0.2:443\r\n\r\n"
        );
        // What follows the head belongs to the caller: the bytes written
        // next come back through the splice, none swallowed.
        stream.write_all(b"ping").await.unwrap();
        let mut buf = [0u8; 4];
        tokio::time::timeout(WAIT, stream.read_exact(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&buf, b"ping");

        // An IPv6 host is bracketed in the authority.
        let _ = tokio::time::timeout(WAIT, connect_through(proxy.addr, "fd00:7::2", 8443))
            .await
            .unwrap()
            .unwrap();
        assert!(
            proxy.requests.lock().unwrap()[1].starts_with("CONNECT [fd00:7::2]:8443 HTTP/1.1\r\n")
        );

        // A refusal is an error naming the status, not a stream.
        let refusing = FakePeer::start(
            "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            false,
        )
        .await;
        let err = tokio::time::timeout(WAIT, connect_through(refusing.addr, "10.7.0.2", 443))
            .await
            .unwrap()
            .expect_err("a 403 is a refusal");
        assert_eq!(err.kind(), io::ErrorKind::ConnectionRefused);
        assert!(err.to_string().contains("403"), "{err}");
    }

    #[tokio::test]
    async fn connect_through_bounds_a_head_that_never_ends() {
        // A proxy that streams without ever sending the blank line.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let line = vec![b'A'; 1024];
            loop {
                if socket.write_all(&line).await.is_err() {
                    return;
                }
            }
        });
        let err = tokio::time::timeout(WAIT, connect_through(addr, "10.7.0.2", 443))
            .await
            .expect("the read is bounded")
            .expect_err("an endless head is refused");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData, "{err}");
    }

    #[test]
    fn ws_route_dials_loopback_directly_and_the_rest_through_the_proxy() {
        let proxy: SocketAddr = "127.0.0.1:3128".parse().unwrap();
        let route = |uri: &str| ws_route_with(Some(proxy), &uri.parse().unwrap());
        assert_eq!(
            route("wss://alice--x.node.proxy.chan.app/ws?w=1"),
            Some(WsRoute {
                proxy,
                host: "alice--x.node.proxy.chan.app".into(),
                port: 443,
            })
        );
        assert_eq!(
            route("ws://10.7.0.2:8787/api/library/windows/watch"),
            Some(WsRoute {
                proxy,
                host: "10.7.0.2".into(),
                port: 8787,
            })
        );
        assert_eq!(
            route("ws://[fd00:7::2]:8787/ws").map(|r| (r.host, r.port)),
            Some(("fd00:7::2".into(), 8787))
        );
        for direct in [
            "ws://127.0.0.1:8787/ws",
            "ws://127.0.0.2:8787/ws",
            "ws://[::1]:8787/ws",
            "ws://localhost:8787/ws",
        ] {
            assert_eq!(route(direct), None, "{direct}");
        }
        // No proxy, no route.
        assert_eq!(
            ws_route_with(None, &"wss://gw.example/ws".parse().unwrap()),
            None
        );
    }

    #[tokio::test]
    async fn failure_and_status_follow_the_rows() {
        let dir = tempfile::tempdir().unwrap();
        let far = peer(dir.path(), "a.conf", "10.7.0.1", "10.7.0.2").await;
        let b = owner_only(dir.path(), "b.conf", "[Interface]\nAddress = 10.7.0.9/32\n");
        let other = Path::new("/home/u/other.conf");
        let fabric = start(&[gateway("gw-a", Some(&far.conf)), gateway("gw-b", Some(&b))]).await;
        let a = far.conf.as_path();

        // The running row, as it stands, reads its status and no refusal.
        assert_eq!(
            fabric.status("gw-a", Some(a)).as_deref(),
            Some("connecting")
        );
        assert_eq!(fabric.failure("gw-a", Some(a)), None);
        assert_eq!(fabric.connect_refusal("gw-a", Some(a)), None);
        fabric.set_test_status(
            "gw-a",
            chan_wireguard::Status {
                handshake: chan_wireguard::HandshakeState::Never,
                tx_bytes: 0,
                rx_bytes: 0,
                endpoint: Some("127.0.0.1:51820".parse().unwrap()),
                resolution_error: None,
                resolution_stalled: false,
            },
        );
        let reason = fabric.discovery_failure("gw-a", Some(a), None).unwrap();
        assert!(reason.contains("no WireGuard handshake"), "{reason}");
        assert!(reason.contains(&a.display().to_string()), "{reason}");
        // Pointed elsewhere, or at nothing, it reads no status until it is
        // adopted again.
        assert_eq!(fabric.status("gw-a", Some(other)), None);
        assert_eq!(fabric.status("gw-a", None), None);
        assert_eq!(fabric.discovery_failure("gw-a", Some(other), None), None);
        assert_eq!(fabric.discovery_failure("gw-a", None, None), None);
        // The refused file carries its reason while the row names it.
        let reason = fabric.failure("gw-b", Some(&b)).expect("b was refused");
        assert!(reason.contains(&b.display().to_string()), "{reason}");
        assert_eq!(fabric.status("gw-b", Some(&b)), None);
        assert_eq!(fabric.connect_refusal("gw-b", Some(&b)), Some(reason));
        // Pointed elsewhere, the old refusal no longer applies.
        assert_eq!(fabric.failure("gw-b", Some(other)), None);
        assert_eq!(fabric.failure("gw-b", None), None);
        assert_eq!(fabric.connect_refusal("gw-b", None), None);
        // A row the fabric never saw asks nothing.
        assert_eq!(fabric.status("gw-c", Some(other)), None);
        assert_eq!(fabric.connect_refusal("gw-c", Some(other)), None);
    }

    #[test]
    fn connect_status_reads_the_status_line() {
        assert_eq!(
            connect_status(b"HTTP/1.1 200 Connection Established\r\n\r\n"),
            Some(200)
        );
        assert_eq!(
            connect_status(b"HTTP/1.0 502 Bad Gateway\r\nX: y\r\n\r\n"),
            Some(502)
        );
        assert_eq!(connect_status(b"HTTP/2 200\r\n\r\n"), None);
        assert_eq!(connect_status(b"garbage\r\n\r\n"), None);
        assert_eq!(connect_status(b"HTTP/1.1 \r\n\r\n"), None);
    }

    #[test]
    fn proxy_socket_addr_reads_the_url() {
        assert_eq!(
            proxy_socket_addr(&Url::parse("http://127.0.0.1:3128").unwrap()).unwrap(),
            "127.0.0.1:3128".parse::<SocketAddr>().unwrap()
        );
        assert_eq!(
            proxy_socket_addr(&Url::parse("http://[::1]:3128").unwrap()).unwrap(),
            "[::1]:3128".parse::<SocketAddr>().unwrap()
        );
        assert!(proxy_socket_addr(&Url::parse("http://proxy.example:3128").unwrap()).is_err());
        assert!(proxy_socket_addr(&Url::parse("http://127.0.0.1").unwrap()).is_err());
    }
}
