//! The mobile process's stable CONNECT proxy and retained WireGuard policy.

use std::collections::BTreeMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use base64::Engine;
use chan_wireguard::{ConnectProxy, HostRoute, ProtectedDestinations, ProxyRoute, Tunnel};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::config::{Gateway, WireguardProtection};

const RETIRE_TIMEOUT: Duration = Duration::from_secs(5);
/// The launcher's words for a tunnel whose driver has stopped.
const STOPPED: &str = "stopped; connect the gateway again";
static NATIVE_PROXY: OnceLock<url::Url> = OnceLock::new();

pub(crate) fn client_builder(
    builder: reqwest::ClientBuilder,
) -> Result<reqwest::ClientBuilder, String> {
    let builder = builder.no_proxy();
    match NATIVE_PROXY.get() {
        Some(proxy) => {
            let proxy = proxy.clone();
            Ok(
                builder.proxy(reqwest::Proxy::custom(move |url| match url.host_str() {
                    Some("localhost" | "127.0.0.1" | "::1" | "[::1]") => None,
                    _ => Some(proxy.clone()),
                })),
            )
        }
        None => {
            #[cfg(target_os = "ios")]
            return Err("WireGuard: native proxy has not been initialized".into());
            #[cfg(not(target_os = "ios"))]
            Ok(builder)
        }
    }
}

pub(crate) fn configured(gateway: &Gateway) -> bool {
    gateway.wireguard.is_some()
        || gateway.wireguard_enrollment.is_some()
        || gateway.wireguard_public_key.is_some()
}

pub(crate) struct Prepared {
    pub(crate) protection: WireguardProtection,
    configs: Result<Vec<IngressConfig>, String>,
}

impl Prepared {
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_protection(&self.protection)?;
        if let Ok(configs) = &self.configs {
            let mut ids = std::collections::HashSet::new();
            for config in configs {
                if !ids.insert(&config.id) {
                    return Err("WireGuard: duplicate ingress id".into());
                }
                for host in &config.hosts {
                    if host.addresses.iter().any(|address| {
                        !config
                            .config
                            .peer
                            .allowed_ips
                            .iter()
                            .any(|network| network.contains(*address))
                    }) {
                        return Err("WireGuard: a host address is outside AllowedIPs".into());
                    }
                }
            }
        }
        Ok(())
    }
}

fn validate_protection(protection: &WireguardProtection) -> Result<(), String> {
    let networks = crate::wireguard_keys::cidrs(&protection.networks)
        .ok_or("WireGuard: invalid protected networks")?;
    ProtectedDestinations {
        hosts: protection.hosts.clone(),
        networks,
    }
    .validate()
    .map_err(|error| format!("WireGuard: {error}"))
}

struct IngressConfig {
    id: String,
    fingerprint: [u8; 32],
    config: chan_wireguard::config::Config,
    hosts: Vec<HostRoute>,
}

impl IngressConfig {
    fn new(id: String, config: chan_wireguard::config::Config, hosts: Vec<HostRoute>) -> Self {
        let mut digest = Sha256::new();
        digest.update(format!("{config:?}{hosts:?}"));
        digest.update(config.private_key.to_bytes());
        if let Some(key) = config.peer.preshared_key {
            digest.update(key);
        }
        Self {
            id,
            fingerprint: digest.finalize().into(),
            config,
            hosts,
        }
    }
}

/// Learn policy even when the private key cannot be loaded. Never derive a
/// wildcard from discovery's gateway-wide namespace: other nodes stay public.
pub(crate) fn prepare(gateway: &Gateway) -> Prepared {
    let mut protection = gateway.wireguard_protection.clone();
    let configs = (|| {
        if gateway.wireguard.is_some() && gateway.wireguard_enrollment.is_some() {
            return Err(
                "WireGuard: both a manual file and enrolled parameters are configured".into(),
            );
        }
        if let Some(enrollment) = &gateway.wireguard_enrollment {
            let allowed = crate::wireguard_keys::cidrs(&enrollment.allowed_ips)
                .filter(|nets| !nets.is_empty())
                .ok_or("WireGuard: invalid enrolled AllowedIPs")?;
            crate::wireguard_keys::validate_ingresses(&enrollment.ingresses, &allowed)
                .map_err(|()| "WireGuard: invalid enrolled ingresses")?;
            protection.retain(&WireguardProtection {
                hosts: enrollment
                    .ingresses
                    .iter()
                    .flat_map(|ingress| ingress.hosts.iter().map(|host| host.name.clone()))
                    .collect(),
                networks: allowed.iter().map(ToString::to_string).collect(),
            });
            if gateway.wireguard_pending_enrollment.is_some() {
                return Err(crate::wireguard_keys::FRESH_KEY_REQUIRED.into());
            }
            let key = gateway
                .wireguard_enrolled_key
                .as_deref()
                .ok_or("WireGuard: enrollment has no enrolled key")?;
            if gateway.wireguard_public_key.as_deref() != Some(key) {
                return Err(
                    "WireGuard: the selected key is not enrolled; connect again to enroll it"
                        .into(),
                );
            }
            enrollment
                .configs(key)?
                .into_iter()
                .zip(&enrollment.ingresses)
                .map(|(config, ingress)| {
                    Ok(IngressConfig::new(
                        format!("{}/{}", gateway.id, ingress.id),
                        config,
                        host_routes(&ingress.hosts),
                    ))
                })
                .collect()
        } else if let Some(path) = &gateway.wireguard {
            let config =
                chan_wireguard::config::read_file(path).map_err(|e| format!("WireGuard: {e}"))?;
            protection.retain(&WireguardProtection {
                hosts: gateway
                    .wireguard_hosts
                    .iter()
                    .map(|host| host.name.clone())
                    .collect(),
                networks: config
                    .peer
                    .allowed_ips
                    .iter()
                    .map(ToString::to_string)
                    .collect(),
            });
            Ok(vec![IngressConfig::new(
                gateway.id.clone(),
                config,
                host_routes(&gateway.wireguard_hosts),
            )])
        } else if gateway.wireguard_public_key.is_some() {
            Err("WireGuard: the selected key has not been enrolled".into())
        } else {
            Ok(Vec::new())
        }
    })();
    protection.hosts = protection
        .hosts
        .into_iter()
        .map(|host| host.to_ascii_lowercase())
        .collect();
    protection.retain(&WireguardProtection::default());
    Prepared {
        protection,
        configs,
    }
}

/// Reconcile only public enrolled parameters. Manual files retain their policy.
pub(crate) fn reconcile_discovery(
    gateway: &mut Gateway,
    discovery: &crate::devserver::GatewayDiscovery,
) -> Result<bool, String> {
    if !gateway.enabled || gateway.wireguard.is_some() {
        return Ok(false);
    }
    let (Some(enrollment), Some(entry)) = (&gateway.wireguard_enrollment, &discovery.wireguard)
    else {
        return Ok(false);
    };
    let Some(ingresses) = &entry.ingresses else {
        return Ok(false);
    };
    entry.validate()?;
    let mut next = enrollment.clone();
    next.ingresses = ingresses.clone();
    next.allowed_ips = entry
        .allowed_ips
        .clone()
        .ok_or("WireGuard: discovery has no AllowedIPs")?;
    next.persistent_keepalive = entry.persistent_keepalive;
    if &next == enrollment {
        return Ok(false);
    }
    gateway.wireguard_enrollment = Some(next);
    Ok(true)
}

fn host_routes(hosts: &[crate::config::WireguardHost]) -> Vec<HostRoute> {
    hosts
        .iter()
        .map(|host| HostRoute {
            name: host.name.clone(),
            addresses: host.addresses.clone(),
        })
        .collect()
}

#[cfg(test)]
fn next_ingress_instance() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

#[derive(Clone)]
struct Ingress {
    id: String,
    fingerprint: [u8; 32],
    route: ProxyRoute,
    #[cfg(test)]
    instance: u64,
    #[cfg(test)]
    test_closed: bool,
}

impl Ingress {
    fn is_closed(&self) -> bool {
        #[cfg(test)]
        if self.test_closed {
            return true;
        }
        self.route.tunnel.is_closed()
    }
}

#[derive(Clone, Default)]
struct Row {
    routes: Vec<Ingress>,
    protection: WireguardProtection,
    refusal: Option<String>,
    configured: bool,
    suspended: bool,
    order: u64,
    ingress_refusals: Vec<(String, String)>,
}

#[derive(Clone, Default)]
struct Policy {
    rows: BTreeMap<String, Row>,
    retained: WireguardProtection,
    retiring: Vec<(String, CancellationToken)>,
    next_order: u64,
}

pub(crate) struct Fabric {
    proxy: Arc<ConnectProxy>,
    runtime: tokio::runtime::Handle,
    capability: OnceLock<Result<(), String>>,
    policy: Mutex<Policy>,
    lifecycle: AtomicU64,
}

impl Fabric {
    pub(crate) async fn bind() -> Result<Arc<Self>, String> {
        let proxy = ConnectProxy::bind_routed_with_loopback_bypass(
            Vec::new(),
            "127.0.0.1:0".parse().expect("loopback socket"),
        )
        .await
        .map_err(|error| format!("WireGuard: binding local proxy: {error}"))?;
        Ok(Arc::new(Self {
            proxy: Arc::new(proxy),
            runtime: tokio::runtime::Handle::current(),
            capability: OnceLock::new(),
            policy: Mutex::new(Policy::default()),
            lifecycle: AtomicU64::new(0),
        }))
    }

    pub(crate) fn address(&self) -> SocketAddr {
        self.proxy.local_addr()
    }

    pub(crate) fn install_native_proxy(&self) -> Result<(), String> {
        let url = url::Url::parse(&format!("http://{}", self.address()))
            .map_err(|error| error.to_string())?;
        NATIVE_PROXY
            .set(url)
            .map_err(|_| "WireGuard: native proxy already initialized".into())
    }

    pub(crate) fn set_capability(&self, capability: Result<(), String>) {
        let _ = self.capability.set(capability);
    }

    pub(crate) fn capability(&self) -> Result<(), String> {
        self.capability
            .get()
            .cloned()
            .unwrap_or_else(|| Err("WireGuard: WebView routing is not initialized".into()))
    }

    fn publish(&self, policy: &mut Policy, gateway: &str) -> Result<(), String> {
        let networks = crate::wireguard_keys::cidrs(&policy.retained.networks)
            .ok_or("WireGuard: invalid saved protected networks")?;
        let mut rows = policy.rows.values().collect::<Vec<_>>();
        rows.sort_by_key(|row| row.order);
        let routes = rows
            .into_iter()
            .flat_map(|row| {
                row.routes
                    .iter()
                    .map(|ingress| (ingress.id.clone(), ingress.route.clone()))
            })
            .collect();
        let retirement = self
            .proxy
            .replace_protected_routes(
                routes,
                ProtectedDestinations {
                    hosts: policy.retained.hosts.clone(),
                    networks,
                },
            )
            .map_err(|error| format!("WireGuard: publishing routes: {error}"))?;
        policy.retiring.retain(|(_, fence)| !fence.is_cancelled());
        let fence = CancellationToken::new();
        policy.retiring.push((gateway.to_string(), fence.clone()));
        // The task retains the original wait through any caller's timeout.
        self.runtime.spawn(async move {
            retirement.wait().await;
            fence.cancel();
        });
        Ok(())
    }

    pub(crate) fn protect(&self, protection: &WireguardProtection) -> Result<(), String> {
        validate_protection(protection)?;
        let mut current = self.policy.lock().unwrap();
        let mut policy = current.clone();
        policy.retained.retain(protection);
        self.publish(&mut policy, "")?;
        *current = policy;
        Ok(())
    }

    pub(crate) fn reconcile(&self, gateway: &Gateway, prepared: Prepared) -> Result<(), String> {
        prepared.validate()?;
        let mut current = self.policy.lock().unwrap();
        let mut policy = current.clone();
        policy.retained.retain(&prepared.protection);
        let previous = policy.rows.remove(&gateway.id).unwrap_or_else(|| {
            let order = policy.next_order;
            policy.next_order += 1;
            Row {
                order,
                suspended: self.lifecycle.load(Ordering::Acquire) & 1 != 0,
                ..Row::default()
            }
        });
        let mut row = Row {
            protection: prepared.protection,
            configured: configured(gateway),
            order: previous.order,
            suspended: previous.suspended,
            ..Row::default()
        };
        let admissible = if !gateway.enabled {
            Err("WireGuard: disconnected".into())
        } else {
            self.capability()
        };
        match prepared.configs.and_then(|configs| {
            if row.configured {
                admissible.map(|()| configs)
            } else {
                Ok(configs)
            }
        }) {
            Err(reason) => row.refusal = Some(reason),
            Ok(configs) => {
                let _runtime = self.runtime.enter();
                for next in configs {
                    if let Some(ingress) = previous.routes.iter().find(|old| {
                        old.id == next.id && old.fingerprint == next.fingerprint && !old.is_closed()
                    }) {
                        row.routes.push(ingress.clone());
                        continue;
                    }
                    match Tunnel::start(next.config) {
                        Ok(tunnel) => row.routes.push(Ingress {
                            id: next.id,
                            fingerprint: next.fingerprint,
                            route: ProxyRoute {
                                tunnel,
                                hosts: next.hosts,
                            },
                            #[cfg(test)]
                            instance: next_ingress_instance(),
                            #[cfg(test)]
                            test_closed: false,
                        }),
                        Err(error) => {
                            let reason = format!("WireGuard: {}: {error}", next.id);
                            row.refusal = Some(reason.clone());
                            row.ingress_refusals.push((next.id, reason));
                        }
                    }
                }
            }
        }
        policy.rows.insert(gateway.id.clone(), row);
        self.publish(&mut policy, &gateway.id)?;
        *current = policy;
        Ok(())
    }

    /// Synchronously deny before asynchronous connection/session cleanup.
    pub(crate) fn deny(&self, id: &str) -> Result<(), String> {
        let mut current = self.policy.lock().unwrap();
        let mut policy = current.clone();
        if let Some(row) = policy.rows.get_mut(id) {
            row.routes.clear();
            row.refusal = Some("WireGuard: disconnected".into());
        }
        self.publish(&mut policy, id)?;
        *current = policy;
        Ok(())
    }

    pub(crate) async fn settled(&self) -> Result<(), String> {
        let fences = self.policy.lock().unwrap().retiring.clone();
        tokio::time::timeout(RETIRE_TIMEOUT, async {
            for (_, fence) in fences {
                fence.cancelled().await;
            }
        })
        .await
        .map_err(|_| "WireGuard: previous connections are still closing; try again".into())
    }

    pub(crate) async fn settled_gateway(&self, id: &str) -> Result<(), String> {
        tokio::time::timeout(RETIRE_TIMEOUT, self.wait_retired(id))
            .await
            .map_err(|_| {
                "WireGuard: previous gateway connections are still closing; try again".into()
            })
    }

    pub(crate) async fn wait_retired(&self, id: &str) {
        let fences = self.policy.lock().unwrap().retiring.clone();
        for (gateway, fence) in fences {
            if gateway == id {
                fence.cancelled().await;
            }
        }
    }

    pub(crate) fn suspend(&self) {
        let mut policy = self.policy.lock().unwrap();
        for row in policy.rows.values_mut() {
            row.suspended = true;
        }
        self.lifecycle
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |epoch| {
                Some(epoch.wrapping_add(2) | 1)
            })
            .expect("infallible lifecycle update");
    }

    pub(crate) fn resume_gateway(&self, id: &str, ticket: u64) -> bool {
        let mut policy = self.policy.lock().unwrap();
        if self.lifecycle.load(Ordering::Acquire) != ticket {
            return false;
        }
        if let Some(row) = policy.rows.get_mut(id) {
            row.suspended = false;
        }
        true
    }

    pub(crate) fn resume_ticket(&self) -> u64 {
        self.lifecycle.load(Ordering::Acquire)
    }

    pub(crate) fn resume(&self, ticket: u64) -> bool {
        self.lifecycle
            .compare_exchange(ticket, ticket & !1, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    pub(crate) fn changes_routes(&self, id: &str, prepared: &Prepared, enabled: bool) -> bool {
        let policy = self.policy.lock().unwrap();
        let Some(row) = policy.rows.get(id) else {
            return true;
        };
        match &prepared.configs {
            Ok(configs) if enabled => {
                configs.len() != row.routes.len()
                    || configs.iter().zip(&row.routes).any(|(next, old)| {
                        next.id != old.id || next.fingerprint != old.fingerprint || old.is_closed()
                    })
            }
            _ => !row.routes.is_empty(),
        }
    }

    pub(crate) fn is_configured(&self, id: &str) -> bool {
        self.policy
            .lock()
            .unwrap()
            .rows
            .get(id)
            .is_some_and(|row| row.configured)
    }

    pub(crate) fn require_destination(&self, id: &str, origin: &str) -> Result<(), String> {
        let policy = self.policy.lock().unwrap();
        let Some(row) = policy.rows.get(id) else {
            return Err("WireGuard: gateway transport is no longer available".into());
        };
        let url = url::Url::parse(origin).map_err(|error| error.to_string())?;
        let host = url.host_str().ok_or("WireGuard: destination has no host")?;
        let address = match url.host() {
            Some(url::Host::Ipv4(ip)) => Some(IpAddr::V4(ip)),
            Some(url::Host::Ipv6(ip)) => Some(IpAddr::V6(ip)),
            _ => None,
        };
        let protected = row.protection.is_empty()
            || row
                .protection
                .hosts
                .iter()
                .any(|pattern| host_matches(pattern, host))
            || address.is_some_and(|ip| {
                crate::wireguard_keys::cidrs(&row.protection.networks)
                    .is_some_and(|nets| nets.iter().any(|net| protected_address(net, ip)))
            });
        if !row.configured || !protected {
            return Ok(());
        }
        self.capability()?;
        if row.suspended {
            return Err("WireGuard: waiting for foreground recovery".into());
        }
        if policy
            .retiring
            .iter()
            .any(|(gateway, fence)| gateway == id && !fence.is_cancelled())
        {
            return Err("WireGuard: previous connections are still closing".into());
        }
        if row.routes.iter().any(|route| {
            !route.is_closed()
                && route
                    .route
                    .hosts
                    .iter()
                    .any(|mapped| host_matches(&mapped.name, host))
        }) {
            return Ok(());
        }
        if row.routes.iter().any(|route| {
            route.is_closed()
                && route
                    .route
                    .hosts
                    .iter()
                    .any(|mapped| host_matches(&mapped.name, host))
        }) {
            return Err(format!("WireGuard: {STOPPED}"));
        }
        if row
            .protection
            .hosts
            .iter()
            .any(|pattern| host_matches(pattern, host))
        {
            return Err(row
                .refusal
                .clone()
                .unwrap_or_else(|| "WireGuard: no active ingress for this destination".into()));
        }
        match &row.refusal {
            Some(reason) => Err(reason.clone()),
            None if row.routes.iter().any(|route| !route.is_closed()) => Ok(()),
            None if row.routes.iter().any(Ingress::is_closed) => {
                Err(format!("WireGuard: {STOPPED}"))
            }
            None => Err("WireGuard: no active ingress".into()),
        }
    }

    pub(crate) fn view(
        &self,
        id: &str,
    ) -> (
        Option<String>,
        Vec<chan_server::WireguardIngressStatus>,
        Option<String>,
    ) {
        let policy = self.policy.lock().unwrap();
        let Some(row) = policy.rows.get(id) else {
            return (None, Vec::new(), None);
        };
        let mut ingresses: Vec<_> = row
            .routes
            .iter()
            .map(|ingress| chan_server::WireguardIngressStatus {
                id: ingress
                    .id
                    .strip_prefix(&format!("{id}/"))
                    .unwrap_or(&ingress.id)
                    .to_string(),
                status: if ingress.is_closed() {
                    STOPPED
                } else {
                    match ingress.route.tunnel.status().handshake {
                        chan_wireguard::HandshakeState::Live(_) => "connected",
                        chan_wireguard::HandshakeState::Never => "connecting",
                        chan_wireguard::HandshakeState::Lost(_) => "disconnected",
                    }
                }
                .into(),
            })
            .collect();
        ingresses.extend(row.ingress_refusals.iter().map(|(ingress, reason)| {
            chan_server::WireguardIngressStatus {
                id: ingress
                    .strip_prefix(&format!("{id}/"))
                    .unwrap_or(ingress)
                    .to_string(),
                status: reason.clone(),
            }
        }));
        let status = ingresses
            .iter()
            .find(|ingress| ingress.status == STOPPED)
            .or_else(|| {
                ingresses
                    .iter()
                    .find(|ingress| ingress.status != "connected")
            })
            .or_else(|| ingresses.first())
            .map(|ingress| ingress.status.clone());
        (
            status,
            ingresses,
            row.refusal.clone().filter(|_| row.configured),
        )
    }

    #[cfg(test)]
    pub(crate) fn mark_closed_for_test(&self, gateway_id: &str, ingress_id: &str) {
        let mut policy = self.policy.lock().unwrap();
        let ingress = policy
            .rows
            .get_mut(gateway_id)
            .expect("test gateway row")
            .routes
            .iter_mut()
            .find(|route| route.id == ingress_id)
            .expect("test ingress");
        ingress.test_closed = true;
    }

    #[cfg(test)]
    pub(crate) fn ingress_instances(&self, gateway_id: &str) -> Vec<(String, u64)> {
        self.policy
            .lock()
            .unwrap()
            .rows
            .get(gateway_id)
            .map(|row| {
                row.routes
                    .iter()
                    .map(|route| (route.id.clone(), route.instance))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[cfg(test)]
    pub(crate) async fn shut_down_ingress_for_test(&self, gateway_id: &str, ingress_id: &str) {
        let tunnel = {
            let policy = self.policy.lock().unwrap();
            policy
                .rows
                .get(gateway_id)
                .expect("test gateway row")
                .routes
                .iter()
                .find(|route| route.id == ingress_id)
                .expect("test ingress")
                .route
                .tunnel
                .clone()
        };
        let scratch = Arc::new(
            ConnectProxy::bind_routed_with_loopback_bypass(
                Vec::new(),
                "127.0.0.1:0".parse().expect("loopback socket"),
            )
            .await
            .unwrap(),
        );
        let _install = scratch
            .replace_protected_routes(
                vec![(
                    "kill".into(),
                    ProxyRoute {
                        tunnel: tunnel.clone(),
                        hosts: Vec::new(),
                    },
                )],
                ProtectedDestinations::default(),
            )
            .unwrap();
        let retirement = scratch
            .replace_protected_routes(Vec::new(), ProtectedDestinations::default())
            .unwrap();
        retirement.wait().await;
        assert!(tunnel.is_closed());
    }
}

// Match the proxy's explicit mapped-IPv6 alias rule; ::/0 remains IPv6-only.
fn protected_address(network: &chan_wireguard::config::Cidr, address: IpAddr) -> bool {
    if network.contains(address) {
        return true;
    }
    let alias = match address {
        IpAddr::V4(address) => match network.addr {
            IpAddr::V6(prefix) if network.prefix >= 96 && prefix.to_ipv4_mapped().is_some() => {
                Some(IpAddr::V6(address.to_ipv6_mapped()))
            }
            _ => None,
        },
        IpAddr::V6(address) => address.to_ipv4_mapped().map(IpAddr::V4),
    };
    alias.is_some_and(|address| network.contains(address))
}

fn host_matches(pattern: &str, host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let pattern = pattern.to_ascii_lowercase();
    match pattern.strip_prefix("*.") {
        Some(suffix) => host
            .strip_suffix(suffix)
            .is_some_and(|prefix| prefix.ends_with('.') && prefix.len() > 1),
        None => pattern == host,
    }
}

/// A stale native session must not publish cookies or navigate after teardown.
#[derive(Clone)]
pub(crate) struct AccessGuard {
    state: Weak<crate::AppState>,
    id: String,
    gateway: String,
    generation: u64,
}

impl AccessGuard {
    pub(crate) fn new(
        state: &Arc<crate::AppState>,
        id: &str,
        gateway: &str,
        generation: u64,
    ) -> Result<Option<Self>, String> {
        let selected = state
            .store
            .lock()
            .unwrap()
            .get()
            .map_err(|error| error.to_string())?
            .gateways
            .into_iter()
            .find(|row| row.id == gateway)
            .ok_or("gateway was removed")?;
        Ok(configured(&selected).then(|| Self {
            state: Arc::downgrade(state),
            id: id.into(),
            gateway: gateway.into(),
            generation,
        }))
    }

    #[cfg(any(target_os = "ios", test))]
    pub(crate) fn cookie_writer(
        &self,
        origin: &str,
    ) -> Result<tokio::sync::OwnedMutexGuard<()>, String> {
        self.check(origin)?;
        self.state
            .upgrade()
            .ok_or("WireGuard: connection closed")?
            .cookie_writer(origin)
    }

    pub(crate) fn epoch(&self) -> Result<u64, String> {
        let state = self.state.upgrade().ok_or("WireGuard: connection closed")?;
        let fabric = state
            .gateway_manager
            .fabric
            .get()
            .ok_or("WireGuard: transport is unavailable")?;
        Ok(fabric.resume_ticket() & !1)
    }

    pub(crate) fn check_epoch(&self, origin: &str, epoch: u64) -> Result<(), String> {
        if self.epoch()? != epoch {
            return Err("WireGuard: request crossed a background transition".into());
        }
        self.check(origin)
    }

    pub(crate) fn check(&self, origin: &str) -> Result<(), String> {
        let state = self.state.upgrade().ok_or("WireGuard: connection closed")?;
        if state.native_policy_generation(&self.id) != self.generation {
            return Err("WireGuard: connection was superseded".into());
        }
        let fabric = state
            .gateway_manager
            .fabric
            .get()
            .ok_or("WireGuard: transport is unavailable")?;
        fabric.require_destination(&self.gateway, origin)
    }
}

impl crate::config::WireguardEnrollment {
    /// Build each node's tunnel from one key read. No file is written.
    pub fn configs(
        &self,
        enrolled_key: &str,
    ) -> Result<Vec<chan_wireguard::config::Config>, String> {
        let invalid = || "WireGuard: invalid enrolled tunnel parameters".to_string();
        let addresses = crate::wireguard_keys::cidrs(&self.addresses)
            .filter(|v| !v.is_empty())
            .ok_or_else(invalid)?;
        let allowed_ips = crate::wireguard_keys::cidrs(&self.allowed_ips)
            .filter(|v| !v.is_empty())
            .ok_or_else(invalid)?;
        if self.persistent_keepalive == Some(0) {
            return Err(invalid());
        }
        crate::wireguard_keys::validate_ingresses(&self.ingresses, &allowed_ips)
            .map_err(|_| invalid())?;
        let private_key = crate::wireguard_keys::read_key_file(&self.key_file)?;
        if base64::engine::general_purpose::STANDARD
            .encode(chan_wireguard::x25519::PublicKey::from(&private_key).as_bytes())
            != enrolled_key
        {
            return Err("WireGuard: the key file does not hold the enrolled key; connect again to enroll it".into());
        }
        self.ingresses
            .iter()
            .map(|ingress| {
                Ok(chan_wireguard::config::Config {
                    private_key: private_key.clone(),
                    addresses: addresses.clone(),
                    mtu: None,
                    peer: chan_wireguard::config::Peer {
                        public_key: parse_public_key(&ingress.public_key).map_err(|_| invalid())?,
                        preshared_key: None,
                        endpoint: chan_wireguard::config::Endpoint::parse(&ingress.endpoint)
                            .map_err(|_| invalid())?,
                        allowed_ips: allowed_ips.clone(),
                        persistent_keepalive: self.persistent_keepalive,
                    },
                })
            })
            .collect()
    }
}

fn parse_public_key(value: &str) -> Result<chan_wireguard::x25519::PublicKey, ()> {
    let bytes: [u8; 32] = base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|_| ())?
        .try_into()
        .map_err(|_| ())?;
    Ok(chan_wireguard::x25519::PublicKey::from(bytes))
}

/// Persist newly validated policy before admitting its destinations.
pub(crate) fn reconcile_saved(state: &crate::AppState, id: &str) -> Result<(), String> {
    let Some(fabric) = state.gateway_manager.fabric.get() else {
        return Ok(());
    };
    let mut store = state.store.lock().unwrap();
    let mut config = store.get().map_err(|error| error.to_string())?;
    if !state.gateway_manager.transport_ready(id) {
        fabric.deny(id)?;
        return Err("WireGuard: gateway teardown is still pending".into());
    }
    let gateway = config
        .gateways
        .iter_mut()
        .find(|gateway| gateway.id == id)
        .ok_or("gateway was removed")?;
    let prepared = prepare(gateway);
    prepared.validate()?;
    let changed = gateway.wireguard_protection != prepared.protection;
    gateway.wireguard_protection = prepared.protection.clone();
    let gateway = gateway.clone();
    if changed {
        store.save(&config).map_err(|error| error.to_string())?;
    }
    if fabric.changes_routes(id, &prepared, gateway.enabled) {
        if let Some(invalidate) = state.gateway_manager.transport_invalidate.get() {
            invalidate(id);
        }
    }
    fabric.reconcile(&gateway, prepared)
}

pub(crate) fn invalidate_native<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<crate::AppState>,
    gateway: &str,
) {
    let ids = state.invalidate_gateway_native(gateway);
    let any = !ids.is_empty();
    for id in ids {
        state.devservers.remove(&id);
        state.devserver_feed.forget(&id);
        stop_selected(app, state, &id);
    }
    if any {
        if let Some(embedded) = state.embedded() {
            embedded.signal_library_change();
        }
        let _ = tauri::Emitter::emit(app, crate::serve::SERVES_CHANGED, ());
    }
}

#[derive(Clone)]
pub(crate) struct Selected {
    pub(crate) id: String,
    origin: String,
    generation: u64,
    navigation_epoch: u64,
}

impl Selected {
    fn can_stop(&self, state: &crate::AppState) -> bool {
        state.navigation_epoch.load(Ordering::Acquire) == self.navigation_epoch
            && state.selected_wireguard.lock().unwrap().is_none()
            && state.native_policy_generation(&self.id) != self.generation
    }
}

pub(crate) fn stop_selected<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &crate::AppState,
    id: &str,
) {
    use tauri::Manager;
    let selected = {
        let mut selected = state.selected_wireguard.lock().unwrap();
        if selected.as_ref().is_some_and(|selected| selected.id == id) {
            selected.take()
        } else {
            None
        }
    };
    let Some(selected) = selected else {
        return;
    };
    let Ok(home) = crate::mobile_auth::mobile_launcher_url(state) else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let app_for_stop = app.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    if let Err(error) = app.run_on_main_thread(move || {
        let state = app_for_stop.state::<Arc<crate::AppState>>();
        // A queued return home must not replace a successor's navigation.
        if selected.can_stop(&state)
            && window
                .url()
                .is_ok_and(|url| url.origin().ascii_serialization() == selected.origin)
        {
            #[cfg(target_os = "ios")]
            if let Err(error) = window.with_webview(|webview| {
                // SAFETY: Tauri supplies the live WKWebView on its main thread.
                unsafe {
                    let view = &*webview.inner().cast::<objc2::runtime::AnyObject>();
                    let _: () = objc2::msg_send![view, stopLoading];
                }
            }) {
                tracing::warn!(%error, "stopping the WireGuard page failed");
            }
            if let Err(error) = window.navigate(home) {
                tracing::warn!(%error, "returning from WireGuard page failed");
            }
        }
        let _ = send.send(());
    }) {
        tracing::warn!(%error, "dispatching WireGuard page stop failed");
        return;
    }
    tauri::async_runtime::spawn(async move {
        if tokio::time::timeout(Duration::from_secs(5), receive)
            .await
            .is_err()
        {
            tracing::warn!("WireGuard page stop remains pending; transport stays denied");
        }
    });
}

pub(crate) async fn navigate<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<crate::AppState>,
    id: &str,
    conn: &crate::devserver::DevserverConn,
    window: tauri::WebviewWindow<R>,
    url: url::Url,
    epoch: Option<u64>,
) -> Result<(), String> {
    let access = conn
        .gateway
        .as_ref()
        .and_then(|gateway| gateway.access.clone());
    let state = Arc::clone(state);
    let id = id.to_string();
    let (send, receive) = tokio::sync::oneshot::channel();
    let expired = CancellationToken::new();
    let queued = expired.clone();
    app.run_on_main_thread(move || {
        let result = (|| {
            if queued.is_cancelled() {
                return Err("gateway navigation expired".into());
            }
            if let Some(access) = &access {
                let epoch = epoch.ok_or("WireGuard: navigation has no operation epoch")?;
                access.check_epoch(&url.origin().ascii_serialization(), epoch)?;
            }
            let navigation_epoch = state.navigation_epoch.fetch_add(1, Ordering::AcqRel) + 1;
            *state.selected_wireguard.lock().unwrap() = access.map(|access| Selected {
                id,
                origin: url.origin().ascii_serialization(),
                generation: access.generation,
                navigation_epoch,
            });
            window.navigate(url).map_err(|error| error.to_string())
        })();
        let _ = send.send(result);
    })
    .map_err(|error| error.to_string())?;
    let result = tokio::time::timeout(Duration::from_secs(5), receive).await;
    expired.cancel();
    result
        .map_err(|_| "gateway navigation timed out".to_string())?
        .map_err(|_| "gateway navigation cancelled".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use chan_server::GatewayRegistry;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn gateway() -> Gateway {
        serde_json::from_value(
            serde_json::json!({"id":"gw-12345678", "url":"https://identity.example"}),
        )
        .unwrap()
    }

    fn manual(dir: &std::path::Path) -> Gateway {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("client.conf");
        std::fs::write(&path, format!("[Interface]\nPrivateKey = {}\nAddress = 10.7.0.2/32\n[Peer]\nPublicKey = {}\nEndpoint = 127.0.0.1:9\nAllowedIPs = 10.7.0.0/24\n", base64::engine::general_purpose::STANDARD.encode([1u8;32]), base64::engine::general_purpose::STANDARD.encode([2u8;32]))).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let mut gateway = gateway();
        gateway.wireguard = Some(path);
        gateway.wireguard_hosts = vec![crate::config::WireguardHost {
            name: "*.private.example".into(),
            addresses: vec!["10.7.0.1".parse().unwrap()],
        }];
        gateway
    }

    async fn fabric() -> Arc<Fabric> {
        let fabric = Fabric::bind().await.unwrap();
        fabric.set_capability(Ok(()));
        fabric
    }

    #[tokio::test]
    async fn removal_keeps_protection_and_retires_an_existing_direct_connection() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (closed, observed_close) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 4096];
            assert!(stream.read(&mut bytes).await.unwrap() > 0);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                .await
                .unwrap();
            assert_eq!(stream.read(&mut bytes).await.unwrap(), 0);
            let _ = closed.send(());
            // A new dial would be a direct bypass, not a legitimate retry.
            assert!(
                tokio::time::timeout(Duration::from_millis(100), listener.accept())
                    .await
                    .is_err()
            );
        });
        let fabric = fabric().await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::all(format!("http://{}", fabric.address())).unwrap())
            .build()
            .unwrap();
        let url = format!("http://localhost.:{}/sentinel", address.port());
        // Deliberate direct control proves the sentinel is reachable.
        assert_eq!(
            client.get(&url).send().await.unwrap().text().await.unwrap(),
            "ok"
        );
        let mut gateway = gateway();
        gateway.wireguard = Some("/missing/client.conf".into());
        gateway.wireguard_protection.networks = vec!["127.0.0.1/32".into()];
        fabric.reconcile(&gateway, prepare(&gateway)).unwrap();
        fabric.settled().await.unwrap();
        observed_close.await.unwrap();
        fabric.deny(&gateway.id).unwrap();
        fabric.settled().await.unwrap();
        let response = client.get(&url).send().await.unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::BAD_GATEWAY);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn unsupported_wireguard_preserves_public_non_ingress_nodes() {
        let dir = tempfile::tempdir().unwrap();
        let gateway = manual(dir.path());
        let fabric = Fabric::bind().await.unwrap();
        fabric.set_capability(Err("WireGuard requires iOS 17".into()));
        fabric.reconcile(&gateway, prepare(&gateway)).unwrap();
        fabric.settled().await.unwrap();
        assert!(fabric
            .require_destination(&gateway.id, "https://tenant.private.example")
            .unwrap_err()
            .contains("iOS 17"));
        assert!(fabric
            .require_destination(&gateway.id, "https://tenant.public.example")
            .is_ok());
        assert!(fabric.view(&gateway.id).0.is_none());
    }

    #[tokio::test]
    async fn an_older_foreground_task_cannot_resume_after_another_background() {
        let fabric = fabric().await;
        fabric.suspend();
        let old = fabric.resume_ticket();
        fabric.suspend();
        assert!(!fabric.resume(old));
        let current = fabric.resume_ticket();
        assert_ne!(current & 1, 0);
        assert!(fabric.resume(current));
        assert_eq!(fabric.resume_ticket() & 1, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn timeout_retains_the_original_fence_through_later_publication() {
        let fabric = fabric().await;
        let original = CancellationToken::new();
        fabric
            .policy
            .lock()
            .unwrap()
            .retiring
            .push(("original".into(), original.clone()));
        assert!(fabric.settled().await.is_err());
        fabric.protect(&WireguardProtection::default()).unwrap();
        assert!(fabric.settled().await.is_err());
        original.cancel();
        fabric.settled().await.unwrap();
    }

    #[tokio::test]
    async fn native_guard_refuses_a_late_callback_after_invalidation() {
        let dir = tempfile::tempdir().unwrap();
        let gateway = manual(dir.path());
        let store = Arc::new(Mutex::new(crate::config::ConfigStore::at_path(
            dir.path().join("config.json"),
        )));
        let mut config = store.lock().unwrap().get().unwrap();
        config.gateways.push(gateway.clone());
        store.lock().unwrap().save(&config).unwrap();
        let state = Arc::new(crate::AppState::with_store(store));
        let fabric = fabric().await;
        fabric.reconcile(&gateway, prepare(&gateway)).unwrap();
        fabric.settled().await.unwrap();
        assert!(state.gateway_manager.fabric.set(fabric).is_ok());
        let id = crate::gateway::synthesized_row_id(&gateway.id, "owner", "device");
        let guard = AccessGuard::new(
            &state,
            &id,
            &gateway.id,
            state.native_policy_generation(&id),
        )
        .unwrap()
        .unwrap();
        guard.check("https://tenant.private.example").unwrap();
        let old_epoch = guard.epoch().unwrap();
        let fabric = state.gateway_manager.fabric.get().unwrap();
        fabric.suspend();
        assert!(guard.check("https://tenant.private.example").is_err());
        let ticket = fabric.resume_ticket();
        assert!(fabric.resume_gateway(&gateway.id, ticket));
        let recovered_epoch = guard.epoch().unwrap();
        guard
            .check_epoch("https://tenant.private.example", recovered_epoch)
            .unwrap();
        assert!(fabric.resume(ticket));
        guard
            .check_epoch("https://tenant.private.example", recovered_epoch)
            .unwrap();
        guard.check("https://tenant.private.example").unwrap();
        assert!(guard
            .check_epoch("https://tenant.private.example", old_epoch)
            .is_err());
        guard
            .check_epoch("https://tenant.private.example", guard.epoch().unwrap())
            .unwrap();
        let origin = "https://tenant.private.example";
        let writer = guard.cookie_writer(origin).unwrap();
        let cookie = Arc::new(Mutex::new(String::new()));
        let old_cookie = Arc::clone(&cookie);
        // A timed-out caller leaves its submitted callback owning the writer.
        let cancelled = CancellationToken::new();
        let late_completion = move || {
            *old_cookie.lock().unwrap() = "old".into();
            drop(writer);
        };
        cancelled.cancel();
        state.invalidate_gateway_native(&gateway.id);
        assert!(guard.check(origin).unwrap_err().contains("superseded"));
        let successor = AccessGuard::new(
            &state,
            &id,
            &gateway.id,
            state.native_policy_generation(&id),
        )
        .unwrap()
        .unwrap();
        assert!(successor.cookie_writer(origin).is_err());
        assert!(state.cookie_writer(origin).is_err());
        late_completion();
        let successor_writer = successor.cookie_writer(origin).unwrap();
        *cookie.lock().unwrap() = "successor".into();
        assert_eq!(*cookie.lock().unwrap(), "successor");
        drop(successor_writer);
        let plain_writer = state.cookie_writer(origin).unwrap();
        assert!(successor.cookie_writer(origin).is_err());
        drop(plain_writer);
        assert!(successor.cookie_writer(origin).is_ok());
    }

    #[tokio::test]
    async fn plain_navigation_supersedes_a_queued_wireguard_return_home() {
        let (_dir, state) = crate::gateway::tests::pat_load_test_state("https://id.example");
        let origin = "https://tenant.private.example";
        let selected = Selected {
            id: "old".into(),
            origin: origin.into(),
            generation: state.native_policy_generation("old"),
            navigation_epoch: state.navigation_epoch.load(Ordering::Acquire),
        };
        state.bump_native_policy_generation("old");
        assert!(selected.can_stop(&state));
        let app = tauri::test::mock_app();
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External(origin.parse().unwrap()),
        )
        .build()
        .unwrap();
        let conn = crate::devserver::DevserverConn {
            host: "tenant.private.example".into(),
            port: 443,
            token: String::new(),
            name: "plain".into(),
            gateway: None,
        };
        navigate(
            app.handle(),
            &state,
            "plain",
            &conn,
            window,
            origin.parse().unwrap(),
            None,
        )
        .await
        .unwrap();
        assert!(state.selected_wireguard.lock().unwrap().is_none());
        assert!(!selected.can_stop(&state));
    }

    #[tokio::test]
    async fn registry_save_failure_preserves_the_live_policy_and_saved_protection() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let gateway = manual(dir.path());
        let config_dir = dir.path().join("config");
        std::fs::create_dir(&config_dir).unwrap();
        let store = Arc::new(Mutex::new(crate::config::ConfigStore::at_path(
            config_dir.join("config.json"),
        )));
        let state = Arc::new(crate::AppState::with_store(Arc::clone(&store)));
        let fabric = fabric().await;
        assert!(state
            .gateway_manager
            .fabric
            .set(Arc::clone(&fabric))
            .is_ok());
        let registry = crate::config::GatewayConfigRegistry::new(
            Arc::clone(&store),
            Arc::clone(&state.gateway_remove_hook),
            Arc::clone(&state.gateway_manager),
        );
        let row = registry
            .add(chan_server::GatewayInput {
                url: gateway.url.clone(),
                label: None,
                wireguard: Some(gateway.wireguard.unwrap().display().to_string()),
            })
            .unwrap();
        fabric.settled().await.unwrap();
        let saved = store.lock().unwrap().get().unwrap();
        assert_eq!(
            saved.gateways[0].wireguard_protection.networks,
            ["10.7.0.0/24"]
        );
        let before = fabric.view(&row.id).0;
        std::fs::set_permissions(&config_dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        let refused = registry.remove(&row.id);
        std::fs::set_permissions(&config_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(refused.is_err());
        assert_eq!(fabric.view(&row.id).0, before);
        assert_eq!(
            store.lock().unwrap().get().unwrap().gateways,
            saved.gateways
        );
        assert!(registry.remove(&row.id).unwrap());
        assert!(fabric.view(&row.id).0.is_none());
        assert!(fabric
            .policy
            .lock()
            .unwrap()
            .retained
            .networks
            .contains(&"10.7.0.0/24".into()));
    }

    #[test]
    fn missing_key_retains_only_validated_enrolled_ingress_destinations() {
        let dir = tempfile::tempdir().unwrap();
        let mut gateway = gateway();
        gateway.wireguard_public_key = Some("key".into());
        gateway.wireguard_enrolled_key = Some("key".into());
        gateway.wireguard_enrollment = Some(crate::config::WireguardEnrollment {
            key_file: dir.path().join("missing.key"),
            addresses: vec!["10.7.0.2/32".into()],
            allowed_ips: vec!["10.7.0.0/24".into()],
            persistent_keepalive: Some(25),
            ingresses: vec![crate::config::WireguardIngress {
                id: "private".into(),
                endpoint: "127.0.0.1:9".into(),
                public_key: base64::engine::general_purpose::STANDARD.encode([2u8; 32]),
                hosts: vec![crate::config::WireguardHost {
                    name: "*.private.example".into(),
                    addresses: vec!["10.7.0.1".parse().unwrap()],
                }],
            }],
        });
        let prepared = prepare(&gateway);
        assert!(prepared.configs.is_err());
        assert_eq!(prepared.protection.hosts, ["*.private.example"]);
        assert_eq!(prepared.protection.networks, ["10.7.0.0/24"]);
        assert!(!host_matches(
            &prepared.protection.hosts[0],
            "tenant.public.example"
        ));
    }

    #[tokio::test]
    async fn invalid_candidate_cannot_poison_later_retirement() {
        let dir = tempfile::tempdir().unwrap();
        let mut gateway = manual(dir.path());
        let fabric = fabric().await;
        fabric.reconcile(&gateway, prepare(&gateway)).unwrap();
        fabric.settled().await.unwrap();
        let original = fabric.policy.lock().unwrap().retained.clone();
        let original_status = fabric.view(&gateway.id).0;
        gateway.wireguard_hosts[0].name = "127.0.0.1".into();
        assert!(prepare(&gateway).validate().is_err());
        assert!(fabric.reconcile(&gateway, prepare(&gateway)).is_err());
        assert_eq!(fabric.policy.lock().unwrap().retained, original);
        assert_eq!(fabric.view(&gateway.id).0, original_status);
        fabric.deny(&gateway.id).unwrap();
        fabric.settled().await.unwrap();
        assert!(fabric.view(&gateway.id).0.is_none());
        assert!(host_matches("*.PRIVATE.Example", "tenant.private.example"));
    }

    #[tokio::test]
    async fn a_parked_gateway_does_not_block_a_healthy_cached_connection() {
        let dir = tempfile::tempdir().unwrap();
        let first = manual(dir.path());
        let mut second = first.clone();
        second.id = "gw-87654321".into();
        second.wireguard_hosts[0].name = "*.second.example".into();
        let fabric = fabric().await;
        fabric.reconcile(&first, prepare(&first)).unwrap();
        fabric.reconcile(&second, prepare(&second)).unwrap();
        fabric.settled().await.unwrap();
        fabric.suspend();
        let ticket = fabric.resume_ticket();
        let pending = CancellationToken::new();
        fabric
            .policy
            .lock()
            .unwrap()
            .retiring
            .push((first.id.clone(), pending.clone()));
        fabric.settled_gateway(&second.id).await.unwrap();
        assert!(fabric.resume_gateway(&second.id, ticket));
        assert!(fabric
            .require_destination(&second.id, "https://tenant.second.example")
            .is_ok());
        assert!(fabric
            .require_destination(&first.id, "https://tenant.private.example")
            .is_err());
        pending.cancel();
    }

    #[tokio::test]
    async fn discovery_add_remove_and_peer_rotation_preserve_protection_and_healthy_ingress() {
        let dir = tempfile::tempdir().unwrap();
        let mut gateway = gateway();
        let generated = crate::wireguard_keys::generate(dir.path(), &gateway.id).unwrap();
        gateway.wireguard_public_key = Some(generated.public_key.clone());
        gateway.wireguard_enrolled_key = Some(generated.public_key);
        gateway.wireguard_key_file = Some(generated.path.clone());
        let ingress = |id: &str, key: u8, port: u16| crate::config::WireguardIngress {
            id: id.into(),
            endpoint: format!("127.0.0.1:{port}"),
            public_key: base64::engine::general_purpose::STANDARD.encode([key; 32]),
            hosts: vec![crate::config::WireguardHost {
                name: format!("*.{id}.example"),
                addresses: vec!["10.7.0.1".parse().unwrap()],
            }],
        };
        gateway.wireguard_enrollment = Some(crate::config::WireguardEnrollment {
            key_file: generated.path,
            addresses: vec!["10.7.0.2/32".into()],
            allowed_ips: vec!["10.7.0.0/24".into()],
            persistent_keepalive: None,
            ingresses: vec![ingress("first", 2, 9)],
        });
        let fabric = fabric().await;
        let prepared = prepare(&gateway);
        gateway.wireguard_protection = prepared.protection.clone();
        fabric.reconcile(&gateway, prepared).unwrap();
        fabric.settled().await.unwrap();
        let first_fingerprint =
            fabric.policy.lock().unwrap().rows[&gateway.id].routes[0].fingerprint;
        let mut discovery = crate::devserver::GatewayDiscovery {
            kind: "chan-gateway".into(),
            api_version: 1,
            identity_origin: gateway.url.clone(),
            mobile_authorize_url: format!("{}/mobile/authorize", gateway.url),
            mobile_entry_url: format!("{}/mobile/entry", gateway.url),
            mobile_roster_url: format!("{}/mobile/roster", gateway.url),
            devserver_proxy_origin: "https://proxy.example".into(),
            devserver_proxy_host_depth: 2,
            wireguard: Some(crate::devserver::WireguardDiscovery {
                mobile_enrollment: false,
                endpoint: "127.0.0.1:9".into(),
                public_key: ingress("first", 2, 9).public_key,
                allowed_ips: Some(vec!["10.7.0.0/24".into()]),
                persistent_keepalive: None,
                ingresses: Some(vec![ingress("first", 2, 9), ingress("second", 3, 10)]),
            }),
        };
        assert!(reconcile_discovery(&mut gateway, &discovery).unwrap());
        let prepared = prepare(&gateway);
        prepared.validate().unwrap();
        gateway.wireguard_protection = prepared.protection.clone();
        fabric.reconcile(&gateway, prepared).unwrap();
        fabric.settled().await.unwrap();
        let before = fabric.policy.lock().unwrap().rows[&gateway.id]
            .routes
            .iter()
            .map(|route| (route.id.clone(), route.fingerprint))
            .collect::<Vec<_>>();
        assert_eq!(before[0].1, first_fingerprint);
        assert_eq!(before.len(), 2);
        assert!(gateway
            .wireguard_protection
            .hosts
            .contains(&"*.second.example".into()));
        let entry = discovery.wireguard.as_mut().unwrap();
        let next = ingress("second", 4, 11);
        entry.endpoint = next.endpoint.clone();
        entry.public_key = next.public_key.clone();
        entry.ingresses = Some(vec![next]);
        assert!(reconcile_discovery(&mut gateway, &discovery).unwrap());
        let prepared = prepare(&gateway);
        gateway.wireguard_protection = prepared.protection.clone();
        fabric.reconcile(&gateway, prepared).unwrap();
        fabric.settled().await.unwrap();
        let policy = fabric.policy.lock().unwrap();
        assert_eq!(policy.rows[&gateway.id].routes.len(), 1);
        assert_ne!(policy.rows[&gateway.id].routes[0].fingerprint, before[1].1);
        assert!(policy.retained.hosts.contains(&"*.first.example".into()));
        drop(policy);
        assert!(fabric
            .require_destination(&gateway.id, "https://tenant.first.example")
            .is_err());
        assert!(fabric
            .require_destination(&gateway.id, "https://tenant.second.example")
            .is_ok());
        let mut manual = manual(dir.path());
        assert!(!reconcile_discovery(&mut manual, &discovery).unwrap());
    }

    #[tokio::test]
    async fn protected_literal_ipv6_and_mapped_aliases_refuse_without_webview_capability() {
        for (network, target) in [
            ("fd77::/64", "https://[fd77::1]"),
            ("10.7.0.0/24", "https://[::ffff:10.7.0.1]"),
            ("::ffff:10.7.0.0/120", "https://10.7.0.1"),
        ] {
            let mut gateway = gateway();
            gateway.wireguard = Some("/missing/client.conf".into());
            gateway.wireguard_protection.networks = vec![network.into()];
            let fabric = Fabric::bind().await.unwrap();
            fabric.set_capability(Err("WireGuard requires iOS 17".into()));
            fabric.reconcile(&gateway, prepare(&gateway)).unwrap();
            fabric.settled().await.unwrap();
            assert!(fabric
                .require_destination(&gateway.id, target)
                .unwrap_err()
                .contains("iOS 17"));
        }
        let networks = crate::wireguard_keys::cidrs(&["::/0".into()]).unwrap();
        assert!(!protected_address(
            &networks[0],
            "127.0.0.1".parse().unwrap()
        ));
    }

    fn generate_secret() -> (chan_wireguard::x25519::StaticSecret, String) {
        let mut bytes = [0u8; 32];
        getrandom::getrandom(&mut bytes).unwrap();
        let secret = chan_wireguard::x25519::StaticSecret::from(bytes);
        let public = base64::engine::general_purpose::STANDARD
            .encode(chan_wireguard::x25519::PublicKey::from(&secret).as_bytes());
        (secret, public)
    }

    struct LoopbackPeer {
        _tunnel: Tunnel,
        endpoint: String,
        public_key: String,
        http_port: u16,
        hits: Arc<std::sync::atomic::AtomicUsize>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for LoopbackPeer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn start_loopback_peer(client_public_key: &str, body: &'static str) -> LoopbackPeer {
        let (peer_secret, peer_public) = generate_secret();
        let client_pub = parse_public_key(client_public_key).unwrap();
        let udp = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let udp_addr = udp.local_addr().unwrap();
        let placeholder: SocketAddr = "127.0.0.1:9".parse().unwrap();
        let config = chan_wireguard::config::Config {
            private_key: peer_secret,
            addresses: vec![chan_wireguard::config::Cidr {
                addr: "10.7.0.1".parse().unwrap(),
                prefix: 32,
            }],
            mtu: None,
            peer: chan_wireguard::config::Peer {
                public_key: client_pub,
                preshared_key: None,
                endpoint: chan_wireguard::config::Endpoint::parse("127.0.0.1:9").unwrap(),
                allowed_ips: vec![chan_wireguard::config::Cidr {
                    addr: "10.7.0.2".parse().unwrap(),
                    prefix: 32,
                }],
                persistent_keepalive: None,
            },
        };
        let tunnel = Tunnel::start_on(config, udp, placeholder).unwrap();
        let mut listener = tunnel.listen(0).unwrap();
        let http_port = listener.port();
        let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let task_hits = Arc::clone(&hits);
        let task = tokio::spawn(async move {
            loop {
                let Ok(mut stream) = listener.accept().await else {
                    break;
                };
                let conn_hits = Arc::clone(&task_hits);
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    if stream.read(&mut buf).await.unwrap_or(0) == 0 {
                        return;
                    }
                    conn_hits.fetch_add(1, Ordering::Relaxed);
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        LoopbackPeer {
            _tunnel: tunnel,
            endpoint: udp_addr.to_string(),
            public_key: peer_public,
            http_port,
            hits,
            task,
        }
    }

    fn proxy_client(fabric: &Fabric) -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::all(format!("http://{}", fabric.address())).unwrap())
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap()
    }

    fn enrolled_gateway_with_peers(
        id: &str,
        key: &crate::wireguard_keys::GeneratedKey,
        peers: &[(&str, &LoopbackPeer)],
    ) -> Gateway {
        let mut gw = gateway();
        gw.id = id.into();
        gw.wireguard_public_key = Some(key.public_key.clone());
        gw.wireguard_enrolled_key = Some(key.public_key.clone());
        gw.wireguard_key_file = Some(key.path.clone());
        let ingresses = peers
            .iter()
            .map(|(ingress_id, peer)| crate::config::WireguardIngress {
                id: (*ingress_id).into(),
                endpoint: peer.endpoint.clone(),
                public_key: peer.public_key.clone(),
                hosts: vec![crate::config::WireguardHost {
                    name: format!("*.{ingress_id}.example.test"),
                    addresses: vec!["10.7.0.1".parse().unwrap()],
                }],
            })
            .collect();
        gw.wireguard_enrollment = Some(crate::config::WireguardEnrollment {
            key_file: key.path.clone(),
            addresses: vec!["10.7.0.2/32".into()],
            allowed_ips: vec!["10.7.0.1/32".into()],
            persistent_keepalive: Some(5),
            ingresses,
        });
        let prepared = prepare(&gw);
        gw.wireguard_protection = prepared.protection;
        gw
    }

    #[tokio::test]
    async fn reconcile_replaces_a_tunnel_whose_driver_stopped() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let (client_secret, client_public) = generate_secret();
        let peer = start_loopback_peer(&client_public, "ok").await;

        let conf = dir.path().join("client.conf");
        std::fs::write(
            &conf,
            format!(
                "[Interface]\nPrivateKey = {}\nAddress = 10.7.0.2/32\n[Peer]\nPublicKey = {}\nEndpoint = {}\nAllowedIPs = 10.7.0.1/32\n",
                base64::engine::general_purpose::STANDARD.encode(client_secret.to_bytes()),
                peer.public_key,
                peer.endpoint
            ),
        )
        .unwrap();
        std::fs::set_permissions(&conf, std::fs::Permissions::from_mode(0o600)).unwrap();

        let mut gw = gateway();
        gw.wireguard = Some(conf);
        gw.wireguard_hosts = vec![crate::config::WireguardHost {
            name: "*.private.example.test".into(),
            addresses: vec!["10.7.0.1".parse().unwrap()],
        }];
        let fabric = fabric().await;
        fabric.reconcile(&gw, prepare(&gw)).unwrap();
        fabric.settled().await.unwrap();

        let client = proxy_client(&fabric);
        let url = format!(
            "http://tenant.private.example.test:{}/probe",
            peer.http_port
        );
        assert_eq!(
            client.get(&url).send().await.unwrap().text().await.unwrap(),
            "ok"
        );
        assert_eq!(fabric.view(&gw.id).0.as_deref(), Some("connected"));
        let before = fabric.ingress_instances(&gw.id);

        fabric.mark_closed_for_test(&gw.id, &gw.id);
        let (status, ingresses, _) = fabric.view(&gw.id);
        assert_eq!(status.as_deref(), Some(STOPPED));
        assert_eq!(ingresses[0].status, STOPPED);
        assert!(fabric.changes_routes(&gw.id, &prepare(&gw), true));
        assert!(fabric
            .require_destination(&gw.id, "https://tenant.private.example.test")
            .unwrap_err()
            .contains(STOPPED));

        fabric.reconcile(&gw, prepare(&gw)).unwrap();
        fabric.settled().await.unwrap();
        assert_ne!(fabric.ingress_instances(&gw.id), before);
        assert!(!fabric.changes_routes(&gw.id, &prepare(&gw), true));
        assert!(fabric
            .require_destination(&gw.id, "https://tenant.private.example.test")
            .is_ok());
        assert_eq!(
            client.get(&url).send().await.unwrap().text().await.unwrap(),
            "ok"
        );
        assert_eq!(fabric.view(&gw.id).0.as_deref(), Some("connected"));
    }

    #[tokio::test]
    async fn enrolled_reconcile_restarts_only_the_ingress_whose_driver_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let key = crate::wireguard_keys::generate(dir.path(), "gw-multi").unwrap();
        let p1 = start_loopback_peer(&key.public_key, "p1").await;
        let p2 = start_loopback_peer(&key.public_key, "p2").await;
        let gw = enrolled_gateway_with_peers("gw-multi", &key, &[("p1", &p1), ("p2", &p2)]);

        let fabric = fabric().await;
        fabric.reconcile(&gw, prepare(&gw)).unwrap();
        fabric.settled().await.unwrap();
        let instances =
            || -> BTreeMap<String, u64> { fabric.ingress_instances(&gw.id).into_iter().collect() };
        let initial = instances();

        // While p1 is still "connecting", marking p2 closed must give STOPPED precedence.
        fabric.mark_closed_for_test(&gw.id, "gw-multi/p2");
        let (summary, ingresses, _) = fabric.view(&gw.id);
        assert_eq!(ingresses[0].status, "connecting");
        assert_eq!(ingresses[1].status, STOPPED);
        assert_eq!(summary.as_deref(), Some(STOPPED));
        assert!(fabric.changes_routes(&gw.id, &prepare(&gw), true));

        fabric.reconcile(&gw, prepare(&gw)).unwrap();
        fabric.settled().await.unwrap();
        let after_p2 = instances();
        assert_eq!(after_p2["gw-multi/p1"], initial["gw-multi/p1"]);
        assert_ne!(after_p2["gw-multi/p2"], initial["gw-multi/p2"]);

        let client = proxy_client(&fabric);
        let u1 = format!("http://tenant.p1.example.test:{}/probe", p1.http_port);
        let u2 = format!("http://tenant.p2.example.test:{}/probe", p2.http_port);
        assert_eq!(
            client.get(&u1).send().await.unwrap().text().await.unwrap(),
            "p1"
        );
        assert_eq!(
            client.get(&u2).send().await.unwrap().text().await.unwrap(),
            "p2"
        );

        // Now mark p1 closed while p2 stays live and connected.
        fabric.mark_closed_for_test(&gw.id, "gw-multi/p1");
        let (summary, ingresses, _) = fabric.view(&gw.id);
        assert_eq!(ingresses[0].status, STOPPED);
        assert_eq!(ingresses[1].status, "connected");
        assert_eq!(summary.as_deref(), Some(STOPPED));
        assert!(fabric
            .require_destination(&gw.id, "https://tenant.p1.example.test")
            .unwrap_err()
            .contains(STOPPED));
        assert!(fabric
            .require_destination(&gw.id, "https://tenant.p2.example.test")
            .is_ok());

        fabric.reconcile(&gw, prepare(&gw)).unwrap();
        fabric.settled().await.unwrap();
        let after_p1 = instances();
        assert_ne!(after_p1["gw-multi/p1"], after_p2["gw-multi/p1"]);
        assert_eq!(after_p1["gw-multi/p2"], after_p2["gw-multi/p2"]);
        assert_eq!(
            client.get(&u1).send().await.unwrap().text().await.unwrap(),
            "p1"
        );
        assert_eq!(
            client.get(&u2).send().await.unwrap().text().await.unwrap(),
            "p2"
        );
    }

    #[tokio::test]
    async fn real_tunnel_shutdown_and_reconcile_saved_resume_recovery() {
        use tauri::{Listener, Manager};
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(crate::config::ConfigStore::at_path(
            dir.path().join("config.json"),
        )));
        let wg_dir = store.lock().unwrap().wireguard_dir();
        let key = crate::wireguard_keys::generate(&wg_dir, "gw-resume").unwrap();
        let p1 = start_loopback_peer(&key.public_key, "p1").await;
        let p2 = start_loopback_peer(&key.public_key, "p2").await;
        let gw = enrolled_gateway_with_peers("gw-resume", &key, &[("p1", &p1), ("p2", &p2)]);
        {
            let mut guard = store.lock().unwrap();
            let mut cfg = guard.get().unwrap();
            cfg.gateways.push(gw.clone());
            guard.save(&cfg).unwrap();
        }

        let state = Arc::new(crate::AppState::with_store(store));
        let fabric = fabric().await;
        assert!(state
            .gateway_manager
            .fabric
            .set(Arc::clone(&fabric))
            .is_ok());

        let app = tauri::test::mock_app();
        app.manage(Arc::clone(&state));
        let (signal_tx, mut signal_rx) = tokio::sync::mpsc::unbounded_channel();
        app.listen(crate::serve::SERVES_CHANGED, move |_| {
            let _ = signal_tx.send(());
        });
        let app_for_invalidate = app.handle().clone();
        let _ = state
            .gateway_manager
            .transport_invalidate
            .set(Arc::new(move |id| {
                let state = app_for_invalidate.state::<Arc<crate::AppState>>();
                invalidate_native(&app_for_invalidate, &state, id);
            }));

        reconcile_saved(&state, &gw.id).unwrap();
        fabric.settled_gateway(&gw.id).await.unwrap();

        let client = proxy_client(&fabric);
        let u1 = format!("http://tenant.p1.example.test:{}/probe", p1.http_port);
        let u2 = format!("http://tenant.p2.example.test:{}/probe", p2.http_port);
        assert_eq!(
            client.get(&u1).send().await.unwrap().text().await.unwrap(),
            "p1"
        );
        assert_eq!(
            client.get(&u2).send().await.unwrap().text().await.unwrap(),
            "p2"
        );

        let synth_id = crate::gateway::synthesized_row_id(&gw.id, "alice", &"d".repeat(64));
        let gen_before = state.native_policy_generation(&synth_id);
        state.devservers.set(
            synth_id.clone(),
            crate::devserver::DevserverConn {
                host: "tenant.p1.example.test".into(),
                port: 443,
                token: String::new(),
                name: "alice".into(),
                gateway: None,
            },
        );
        assert!(state.devservers.is_connected(&synth_id));
        let before: BTreeMap<String, u64> = fabric.ingress_instances(&gw.id).into_iter().collect();

        // Trigger a real Tunnel::shut_down() on p1 via scratch ConnectProxy retirement.
        fabric
            .shut_down_ingress_for_test(&gw.id, "gw-resume/p1")
            .await;
        let (summary, ingresses, _) = fabric.view(&gw.id);
        assert_eq!(ingresses[0].status, STOPPED);
        assert_eq!(summary.as_deref(), Some(STOPPED));
        assert!(fabric
            .require_destination(&gw.id, "https://tenant.p1.example.test")
            .unwrap_err()
            .contains(STOPPED));
        assert!(fabric.changes_routes(&gw.id, &prepare(&gw), true));

        // Execute the exact mobile_auth::resume_wireguard foreground call sequence.
        fabric.suspend();
        let ticket = fabric.resume_ticket();
        fabric.settled_gateway(&gw.id).await.unwrap();
        reconcile_saved(&state, &gw.id).unwrap();
        fabric.settled_gateway(&gw.id).await.unwrap();
        assert!(fabric.resume_gateway(&gw.id, ticket));
        assert!(fabric.resume(ticket));

        assert!(!state.devservers.is_connected(&synth_id));
        assert!(state.native_policy_generation(&synth_id) > gen_before);
        assert!(signal_rx.try_recv().is_ok());

        let after: BTreeMap<String, u64> = fabric.ingress_instances(&gw.id).into_iter().collect();
        assert_ne!(after["gw-resume/p1"], before["gw-resume/p1"]);
        assert_eq!(after["gw-resume/p2"], before["gw-resume/p2"]);
        assert_ne!(fabric.view(&gw.id).0.as_deref(), Some(STOPPED));
        assert!(fabric
            .require_destination(&gw.id, "https://tenant.p1.example.test")
            .is_ok());
        assert_eq!(
            client.get(&u1).send().await.unwrap().text().await.unwrap(),
            "p1"
        );
        assert_eq!(
            client.get(&u2).send().await.unwrap().text().await.unwrap(),
            "p2"
        );
    }

    #[tokio::test]
    async fn local_enrollment_routing_and_stopped_recovery_e2e() {
        use std::sync::atomic::AtomicUsize;
        use tauri::Manager;

        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(crate::config::ConfigStore::at_path(
            dir.path().join("config.json"),
        )));
        let state = Arc::new(crate::AppState::with_store(Arc::clone(&store)));
        let fabric = fabric().await;
        assert!(state
            .gateway_manager
            .fabric
            .set(Arc::clone(&fabric))
            .is_ok());

        let app = tauri::test::mock_app();
        app.manage(Arc::clone(&state));
        let app_for_invalidate = app.handle().clone();
        let _ = state
            .gateway_manager
            .transport_invalidate
            .set(Arc::new(move |id| {
                let state = app_for_invalidate.state::<Arc<crate::AppState>>();
                invalidate_native(&app_for_invalidate, &state, id);
            }));

        // Bind UDP sockets for p1 and p2 ahead of discovery so discovery advertises real endpoints.
        let p1_udp = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let p2_udp = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let p1_udp_addr = p1_udp.local_addr().unwrap();
        let p2_udp_addr = p2_udp.local_addr().unwrap();
        let (p1_secret, p1_pub) = generate_secret();
        let (p2_secret, p2_pub) = generate_secret();

        #[derive(Clone)]
        struct AuthCodeRecord {
            challenge: String,
            wireguard_public_key: String,
        }

        struct MockGateway {
            origin: String,
            p1_pub: String,
            p1_endpoint: String,
            p2_pub: String,
            p2_endpoint: String,
            expected_client_key: Mutex<Option<String>>,
            codes: Mutex<std::collections::HashMap<String, AuthCodeRecord>>,
            pat_secret: String,
        }

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mock_addr = listener.local_addr().unwrap();
        let mock_origin = format!("http://{mock_addr}");
        let pat_secret = "pat-e2e-secret".to_string();
        let mock = Arc::new(MockGateway {
            origin: mock_origin.clone(),
            p1_pub: p1_pub.clone(),
            p1_endpoint: p1_udp_addr.to_string(),
            p2_pub: p2_pub.clone(),
            p2_endpoint: p2_udp_addr.to_string(),
            expected_client_key: Mutex::new(None),
            codes: Mutex::new(std::collections::HashMap::new()),
            pat_secret: pat_secret.clone(),
        });

        let router = axum::Router::new()
            .route(
                "/.well-known/chan-gateway",
                axum::routing::get({
                    let mock = Arc::clone(&mock);
                    move || {
                        let mock = Arc::clone(&mock);
                        async move {
                            axum::Json(serde_json::json!({
                                "kind": "chan-gateway",
                                "api_version": 1,
                                "identity_origin": mock.origin,
                                "mobile_authorize_url": format!("{}/mobile/authorize", mock.origin),
                                "mobile_entry_url": format!("{}/mobile/v1/devserver/entry", mock.origin),
                                "mobile_roster_url": format!("{}/mobile/v1/devservers", mock.origin),
                                "devserver_proxy_origin": "https://proxy.e2e.invalid",
                                "devserver_proxy_host_depth": 2,
                                "wireguard": {
                                    "mobile_enrollment": true,
                                    "endpoint": mock.p1_endpoint,
                                    "public_key": mock.p1_pub,
                                    "allowed_ips": ["10.7.0.1/32"],
                                    "persistent_keepalive": 5,
                                    "ingresses": [
                                        {
                                            "id": "p1",
                                            "endpoint": mock.p1_endpoint,
                                            "public_key": mock.p1_pub,
                                            "hosts": [{
                                                "name": "*.p1.proxy.e2e.invalid",
                                                "addresses": ["10.7.0.1"]
                                            }]
                                        },
                                        {
                                            "id": "p2",
                                            "endpoint": mock.p2_endpoint,
                                            "public_key": mock.p2_pub,
                                            "hosts": [{
                                                "name": "*.p2.proxy.e2e.invalid",
                                                "addresses": ["10.7.0.1"]
                                            }]
                                        }
                                    ]
                                }
                            }))
                        }
                    }
                }),
            )
            .route(
                "/mobile/authorize",
                axum::routing::get({
                    let mock = Arc::clone(&mock);
                    move |axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>| {
                        let mock = Arc::clone(&mock);
                        async move {
                            assert_eq!(q.get("redirect_uri").map(String::as_str), Some("chan://auth/callback"));
                            assert_eq!(q.get("code_challenge_method").map(String::as_str), Some("S256"));
                            assert_eq!(q.get("scopes").map(String::as_str), Some("mobile.account"));
                            let wg_key = q.get("wireguard_public_key").cloned().unwrap();
                            assert_eq!(
                                Some(wg_key.as_str()),
                                mock.expected_client_key.lock().unwrap().as_deref()
                            );
                            let challenge = q.get("code_challenge").cloned().unwrap();
                            let state_param = q.get("state").cloned().unwrap();
                            let code = "code-once-1".to_string();
                            mock.codes.lock().unwrap().insert(
                                code.clone(),
                                AuthCodeRecord {
                                    challenge,
                                    wireguard_public_key: wg_key,
                                },
                            );
                            let location = format!("chan://auth/callback?code={code}&state={state_param}");
                            axum::response::Response::builder()
                                .status(axum::http::StatusCode::FOUND)
                                .header(axum::http::header::LOCATION, location)
                                .body(axum::body::Body::empty())
                                .unwrap()
                        }
                    }
                }),
            )
            .route(
                "/mobile/authorize/redeem",
                axum::routing::post({
                    let mock = Arc::clone(&mock);
                    move |axum::Json(body): axum::Json<serde_json::Value>| {
                        let mock = Arc::clone(&mock);
                        async move {
                            let code = body.get("code").and_then(|v| v.as_str()).unwrap_or("");
                            let verifier = body.get("code_verifier").and_then(|v| v.as_str()).unwrap_or("");
                            let Some(rec) = mock.codes.lock().unwrap().remove(code) else {
                                return axum::response::Response::builder()
                                    .status(axum::http::StatusCode::GONE)
                                    .body(axum::body::Body::empty())
                                    .unwrap();
                            };
                            let digest = Sha256::digest(verifier.as_bytes());
                            let expected_challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);
                            assert_eq!(expected_challenge, rec.challenge);
                            assert!(!rec.wireguard_public_key.is_empty());
                            let payload = serde_json::json!({
                                "id": "11111111-1111-1111-1111-111111111111",
                                "secret": mock.pat_secret,
                                "label": "ios-e2e",
                                "expires_at": null,
                                "wireguard": {
                                    "server_public_key": mock.p1_pub,
                                    "endpoint": mock.p1_endpoint,
                                    "addresses": ["10.7.0.2/32"],
                                    "allowed_ips": ["10.7.0.1/32"],
                                    "persistent_keepalive": 5,
                                    "hosts": [{
                                        "name": "*.p1.proxy.e2e.invalid",
                                        "addresses": ["10.7.0.1"]
                                    }],
                                    "ingresses": [
                                        {
                                            "id": "p1",
                                            "server_public_key": mock.p1_pub,
                                            "endpoint": mock.p1_endpoint,
                                            "hosts": [{
                                                "name": "*.p1.proxy.e2e.invalid",
                                                "addresses": ["10.7.0.1"]
                                            }]
                                        },
                                        {
                                            "id": "p2",
                                            "server_public_key": mock.p2_pub,
                                            "endpoint": mock.p2_endpoint,
                                            "hosts": [{
                                                "name": "*.p2.proxy.e2e.invalid",
                                                "addresses": ["10.7.0.1"]
                                            }]
                                        }
                                    ]
                                }
                            });
                            axum::response::Response::builder()
                                .status(axum::http::StatusCode::OK)
                                .header(axum::http::header::CONTENT_TYPE, "application/json")
                                .body(axum::body::Body::from(payload.to_string()))
                                .unwrap()
                        }
                    }
                }),
            )
            .route(
                "/mobile/v1/devservers",
                axum::routing::get({
                    let mock = Arc::clone(&mock);
                    move |headers: axum::http::HeaderMap| {
                        let mock = Arc::clone(&mock);
                        async move {
                            let expected = format!("Bearer {}", mock.pat_secret);
                            let auth = headers
                                .get(axum::http::header::AUTHORIZATION)
                                .and_then(|v| v.to_str().ok());
                            assert_eq!(auth, Some(expected.as_str()));
                            axum::Json(serde_json::json!([{
                                "owner_user_id": "22222222-2222-2222-2222-222222222222",
                                "owner": "alice",
                                "devserver_id": "d".repeat(64),
                                "label": "box",
                                "online": true,
                                "shared": false,
                                "proxy_origin": "https://alice--dddddddddddd.p1.proxy.e2e.invalid"
                            }]))
                        }
                    }
                }),
            );
        let server_task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });

        let registry = crate::config::GatewayConfigRegistry::new(
            Arc::clone(&store),
            Arc::clone(&state.gateway_remove_hook),
            Arc::clone(&state.gateway_manager),
        );
        let added = registry
            .add(chan_server::GatewayInput {
                url: mock_origin.clone(),
                label: Some("e2e".into()),
                wireguard: None,
            })
            .unwrap();
        let gw_id = added.id;

        // Generate client key through config::generate_wireguard_key against mock discovery.
        let outcome = crate::config::generate_wireguard_key(&store, &state.gateway_manager, &gw_id)
            .await
            .unwrap();
        let chan_server::WireguardKeyOutcome::Generated(entry) = outcome else {
            panic!("expected generated WireGuard key");
        };
        let client_public = entry.wireguard_public_key.unwrap();
        *mock.expected_client_key.lock().unwrap() = Some(client_public.clone());

        let (key_file, raw_config_json) = {
            let guard = store.lock().unwrap();
            let cfg = guard.get().unwrap();
            let row = cfg.gateways.iter().find(|g| g.id == gw_id).unwrap();
            let path = crate::wireguard_keys::selected_path(&guard.wireguard_dir(), row).unwrap();
            let raw = std::fs::read_to_string(dir.path().join("config.json")).unwrap();
            (path, raw)
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&key_file).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let secret_text = std::fs::read_to_string(&key_file).unwrap();
        assert!(!raw_config_json.contains(secret_text.trim()));

        // Start real loopback peer tunnels admitting the generated client public key.
        let spawn_peer = |secret: chan_wireguard::x25519::StaticSecret,
                          udp: tokio::net::UdpSocket,
                          body: &'static str| {
            let client_pub = parse_public_key(&client_public).unwrap();
            let placeholder: SocketAddr = "127.0.0.1:9".parse().unwrap();
            let cfg = chan_wireguard::config::Config {
                private_key: secret,
                addresses: vec![chan_wireguard::config::Cidr {
                    addr: "10.7.0.1".parse().unwrap(),
                    prefix: 32,
                }],
                mtu: None,
                peer: chan_wireguard::config::Peer {
                    public_key: client_pub,
                    preshared_key: None,
                    endpoint: chan_wireguard::config::Endpoint::parse("127.0.0.1:9").unwrap(),
                    allowed_ips: vec![chan_wireguard::config::Cidr {
                        addr: "10.7.0.2".parse().unwrap(),
                        prefix: 32,
                    }],
                    persistent_keepalive: None,
                },
            };
            let tunnel = Tunnel::start_on(cfg, udp, placeholder).unwrap();
            let mut listener = tunnel.listen(0).unwrap();
            let port = listener.port();
            let hits = Arc::new(AtomicUsize::new(0));
            let task_hits = Arc::clone(&hits);
            let task = tokio::spawn(async move {
                loop {
                    let Ok(mut stream) = listener.accept().await else {
                        break;
                    };
                    let conn_hits = Arc::clone(&task_hits);
                    tokio::spawn(async move {
                        let mut buf = [0u8; 4096];
                        if stream.read(&mut buf).await.unwrap_or(0) == 0 {
                            return;
                        }
                        conn_hits.fetch_add(1, Ordering::Relaxed);
                        let response = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        );
                        let _ = stream.write_all(response.as_bytes()).await;
                        let _ = stream.shutdown().await;
                    });
                }
            });
            (tunnel, port, hits, task)
        };
        let (_t1, p1_http_port, p1_hits, p1_task) = spawn_peer(p1_secret, p1_udp, "p1-ok");
        let (_t2, p2_http_port, p2_hits, p2_task) = spawn_peer(p2_secret, p2_udp, "p2-ok");

        // Exercise OAuth /mobile/authorize + PKCE S256 + /mobile/authorize/redeem + /mobile/v1/devservers.
        let direct = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let discovery = crate::devserver::discover_gateway(&mock_origin)
            .await
            .unwrap();
        let verifier = "e2e-pkce-verifier-0123456789abcdef0123456789";
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(verifier.as_bytes()));
        let state_nonce = "state-e2e-1";
        let auth_url = url::Url::parse_with_params(
            &discovery.mobile_authorize_url,
            &[
                ("redirect_uri", "chan://auth/callback"),
                ("state", state_nonce),
                ("label", "ios-e2e"),
                ("code_challenge", challenge.as_str()),
                ("code_challenge_method", "S256"),
                ("scopes", "mobile.account"),
                ("expires_in", "3600"),
                ("wireguard_public_key", client_public.as_str()),
            ],
        )
        .unwrap();
        let auth_resp = direct.get(auth_url).send().await.unwrap();
        assert_eq!(auth_resp.status(), reqwest::StatusCode::FOUND);
        let location = auth_resp
            .headers()
            .get(reqwest::header::LOCATION)
            .unwrap()
            .to_str()
            .unwrap();
        let callback_url = url::Url::parse(location).unwrap();
        assert_eq!(callback_url.scheme(), "chan");
        assert_eq!(callback_url.host_str(), Some("auth"));
        assert_eq!(callback_url.path(), "/callback");
        let callback_params: std::collections::HashMap<String, String> =
            callback_url.query_pairs().into_owned().collect();
        assert_eq!(
            callback_params.get("state").map(String::as_str),
            Some(state_nonce)
        );
        let code = callback_params.get("code").unwrap().clone();

        let redeem_url = format!("{mock_origin}/mobile/authorize/redeem");
        let redeem_resp = direct
            .post(&redeem_url)
            .json(&serde_json::json!({
                "code": code,
                "code_verifier": verifier,
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(redeem_resp.status(), reqwest::StatusCode::OK);
        let redeem_json: serde_json::Value = redeem_resp.json().await.unwrap();
        let replay = direct
            .post(&redeem_url)
            .json(&serde_json::json!({
                "code": code,
                "code_verifier": verifier,
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(replay.status(), reqwest::StatusCode::GONE);

        let token = redeem_json.get("secret").and_then(|v| v.as_str()).unwrap();
        let roster_resp = direct
            .get(&discovery.mobile_roster_url)
            .bearer_auth(token)
            .send()
            .await
            .unwrap();
        assert_eq!(roster_resp.status(), reqwest::StatusCode::OK);
        let roster: Vec<serde_json::Value> = roster_resp.json().await.unwrap();
        assert_eq!(roster.len(), 1);

        let wg_params: crate::wireguard_keys::EnrollmentParams =
            serde_json::from_value(redeem_json.get("wireguard").cloned().unwrap()).unwrap();
        let prepared_enrollment = crate::wireguard_keys::prepare(
            &key_file,
            &client_public,
            discovery.wireguard.as_ref().unwrap(),
            &wg_params,
        )
        .unwrap();
        {
            let mut guard = store.lock().unwrap();
            let mut cfg = guard.get().unwrap();
            let row = cfg.gateways.iter_mut().find(|g| g.id == gw_id).unwrap();
            row.wireguard_enrolled_key = Some(client_public.clone());
            row.wireguard_enrollment = Some(prepared_enrollment.parameters(key_file.clone()));
            guard.save(&cfg).unwrap();
        }

        reconcile_saved(&state, &gw_id).unwrap();
        fabric.settled_gateway(&gw_id).await.unwrap();

        let client = proxy_client(&fabric);
        let p1_url =
            format!("http://alice--dddddddddddd.p1.proxy.e2e.invalid:{p1_http_port}/probe");
        let p2_url =
            format!("http://alice--dddddddddddd.p2.proxy.e2e.invalid:{p2_http_port}/probe");
        assert_eq!(
            client
                .get(&p1_url)
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "p1-ok"
        );
        assert_eq!(p1_hits.load(Ordering::Relaxed), 1);
        assert_eq!(p2_hits.load(Ordering::Relaxed), 0);
        assert_eq!(
            client
                .get(&p2_url)
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "p2-ok"
        );
        assert_eq!(p2_hits.load(Ordering::Relaxed), 1);

        // Protected unmapped IP fails via the proxy without bypassing to host.
        let unmapped_resp = client.get("http://10.7.0.1:1/probe").send().await.unwrap();
        assert_eq!(unmapped_resp.status(), reqwest::StatusCode::BAD_GATEWAY);

        let before: BTreeMap<String, u64> = fabric.ingress_instances(&gw_id).into_iter().collect();

        // Shut down p1's real tunnel driver and verify fail-closed + STOPPED view.
        fabric
            .shut_down_ingress_for_test(&gw_id, &format!("{gw_id}/p1"))
            .await;
        assert_eq!(fabric.view(&gw_id).0.as_deref(), Some(STOPPED));
        assert!(fabric
            .require_destination(&gw_id, "https://alice--dddddddddddd.p1.proxy.e2e.invalid")
            .unwrap_err()
            .contains(STOPPED));
        assert!(fabric
            .require_destination(&gw_id, "https://alice--dddddddddddd.p2.proxy.e2e.invalid")
            .is_ok());
        assert_eq!(
            client.get(&p1_url).send().await.unwrap().status(),
            reqwest::StatusCode::BAD_GATEWAY
        );
        assert_eq!(p1_hits.load(Ordering::Relaxed), 1);

        // Foreground reconcile_saved restarts only p1 and traffic succeeds again.
        reconcile_saved(&state, &gw_id).unwrap();
        fabric.settled_gateway(&gw_id).await.unwrap();
        let after: BTreeMap<String, u64> = fabric.ingress_instances(&gw_id).into_iter().collect();
        assert_ne!(
            after[&format!("{gw_id}/p1")],
            before[&format!("{gw_id}/p1")]
        );
        assert_eq!(
            after[&format!("{gw_id}/p2")],
            before[&format!("{gw_id}/p2")]
        );
        assert_ne!(fabric.view(&gw_id).0.as_deref(), Some(STOPPED));
        assert_eq!(
            client
                .get(&p1_url)
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "p1-ok"
        );
        assert_eq!(p1_hits.load(Ordering::Relaxed), 2);
        assert_eq!(
            client
                .get(&p2_url)
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "p2-ok"
        );
        assert_eq!(p2_hits.load(Ordering::Relaxed), 2);

        p1_task.abort();
        p2_task.abort();
        server_task.abort();
    }
}
