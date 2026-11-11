//! Address selection for authenticated calls to this host's devserver.

#[cfg(any(target_os = "linux", test))]
mod ownership;

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

/// Try the preferred address, then the recorded port when it differs. Linux
/// requires every listener at the chosen address to belong to the caller.
/// macOS, FreeBSD and Windows cannot name socket owners with a small, sound
/// check, so they keep sending to the first address unverified.
pub(crate) fn resolve(addr: SocketAddr) -> anyhow::Result<SocketAddr> {
    // A wildcard bind is reached on loopback.
    let addr = match addr.ip() {
        IpAddr::V4(ip) if ip.is_unspecified() => {
            SocketAddr::from((Ipv4Addr::LOCALHOST, addr.port()))
        }
        IpAddr::V6(ip) if ip.is_unspecified() => {
            SocketAddr::from((Ipv6Addr::LOCALHOST, addr.port()))
        }
        _ => addr,
    };
    #[cfg(target_os = "linux")]
    {
        let mut candidates = vec![addr];
        candidates.extend(
            crate::devserver::persisted::recorded_devserver_addr()
                .filter(|recorded| *recorded != addr),
        );
        Ok(ownership::callers_listener(&candidates)?)
    }
    #[cfg(not(target_os = "linux"))]
    Ok(addr)
}

/// Offline token rotation is safe only when every candidate has no listener;
/// a foreign listener or an unreadable table must leave the file unchanged.
#[cfg(target_os = "linux")]
pub(crate) fn no_listener(error: &anyhow::Error) -> bool {
    matches!(
        error.downcast_ref::<ownership::Refusal>(),
        Some(ownership::Refusal::NoListener(_))
    )
}
