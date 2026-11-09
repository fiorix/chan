//! Whether the local listener the devserver bearer is about to reach is this
//! user's own.
//!
//! The persisted devserver port outlives the devserver, so with it stopped
//! another user on the same host can listen there and collect the bearer a
//! read sends, which stays valid for up to 30 days. Linux names each
//! socket's owner in `/proc/net/tcp` and `/proc/net/tcp6`, so the read is
//! refused unless every listener that could accept the connection belongs to
//! the caller's effective uid. The check precedes the connect: only a
//! listener of this user that closes in the moment between the two lets
//! another bind in time, and nobody else can make it close.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

/// What the socket tables say about a local address.
#[derive(Debug, PartialEq)]
pub(super) enum Owner {
    /// Every listener that could accept a connection there is the caller's.
    Caller,
    /// A listener there belongs to this other uid.
    Other(u32),
    /// Nothing listens there.
    Nobody,
}

/// Refuse to send the devserver bearer to `addr` unless the caller owns
/// every listener that could take the connection.
#[cfg(target_os = "linux")]
pub(super) fn ensure_caller_listens(addr: SocketAddr) -> anyhow::Result<()> {
    use anyhow::Context;
    let tcp = std::fs::read_to_string("/proc/net/tcp")
        .context("cannot read /proc/net/tcp to check who listens on the devserver port")?;
    // A kernel without IPv6 has no tcp6 table, and so no IPv6 listener.
    let tcp6 = std::fs::read_to_string("/proc/net/tcp6").unwrap_or_default();
    let uid = rustix::process::geteuid().as_raw();
    match owner(&[&tcp, &tcp6], addr, uid) {
        Owner::Caller => Ok(()),
        Owner::Other(other) => anyhow::bail!(
            "{addr} is held by uid {other}, not this user's devserver; not sending the devserver token"
        ),
        Owner::Nobody => anyhow::bail!("no devserver is listening on {addr}"),
    }
}

/// Classify `addr` against the text of `/proc/net/tcp`-format tables.
pub(super) fn owner(tables: &[&str], addr: SocketAddr, uid: u32) -> Owner {
    let dial = unmapped(addr.ip());
    let mut found = Owner::Nobody;
    for (local, owner_uid) in tables.iter().flat_map(|table| listeners(table)) {
        if local.port() != addr.port() || !accepts(local.ip(), dial) {
            continue;
        }
        if owner_uid != uid {
            return Owner::Other(owner_uid);
        }
        found = Owner::Caller;
    }
    found
}

/// Whether a listener bound to `local` can accept a connection to `dial`.
/// An IPv6 wildcard counts for IPv4 too: a dual-stack socket takes IPv4
/// connections, and the table does not say whether it is IPv6-only.
fn accepts(local: IpAddr, dial: IpAddr) -> bool {
    let local = unmapped(local);
    local == dial || (local.is_unspecified() && (local.is_ipv6() || dial.is_ipv4()))
}

/// A v4-mapped IPv6 address is the IPv4 address it carries, on either end.
fn unmapped(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(ip) => ip.to_ipv4_mapped().map_or(IpAddr::V6(ip), IpAddr::V4),
        ip => ip,
    }
}

/// The LISTEN rows of one table: their local address and owner uid. Rows
/// that do not parse are not listeners this check can reason about, and the
/// header row is one of them.
fn listeners(table: &str) -> impl Iterator<Item = (SocketAddr, u32)> + '_ {
    table.lines().filter_map(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        // sl, local_address, rem_address, st, tx:rx, tr:when, retrnsmt, uid
        if fields.len() < 8 || fields[3] != "0A" {
            return None;
        }
        let local = parse_address(fields[1])?;
        Some((local, fields[7].parse().ok()?))
    })
}

/// `ADDR:PORT` as the kernel prints it: the port in hex, the address as
/// 32-bit words in hex, each word the native-endian read of four bytes in
/// network order.
fn parse_address(field: &str) -> Option<SocketAddr> {
    let (ip, port) = field.split_once(':')?;
    let port = u16::from_str_radix(port, 16).ok()?;
    let mut bytes = [0u8; 16];
    let words = ip.len() / 8;
    if !matches!(words, 1 | 4) || ip.len() % 8 != 0 {
        return None;
    }
    for word in 0..words {
        let value = u32::from_str_radix(&ip[word * 8..word * 8 + 8], 16).ok()?;
        bytes[word * 4..word * 4 + 4].copy_from_slice(&value.to_ne_bytes());
    }
    let ip = if words == 1 {
        IpAddr::V4(Ipv4Addr::new(bytes[0], bytes[1], bytes[2], bytes[3]))
    } else {
        IpAddr::V6(Ipv6Addr::from(bytes))
    };
    Some(SocketAddr::new(ip, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER: &str = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

    /// One `/proc/net/tcp`-format row, with the address words written the way
    /// this host's kernel would print them.
    fn row(ip: IpAddr, port: u16, state: &str, uid: u32) -> String {
        let octets = match ip {
            IpAddr::V4(ip) => ip.octets().to_vec(),
            IpAddr::V6(ip) => ip.octets().to_vec(),
        };
        let words: String = octets
            .chunks(4)
            .map(|word| format!("{:08X}", u32::from_ne_bytes(word.try_into().unwrap())))
            .collect();
        format!("   0: {words}:{port:04X} 00000000:0000 {state} 00000000:00000000 00:00000000 00000000 {uid:>5}        0 4242 1 0000000000000000 100 0 0 10 0")
    }

    fn table(rows: &[String]) -> String {
        std::iter::once(HEADER.to_string())
            .chain(rows.iter().cloned())
            .collect::<Vec<_>>()
            .join("\n")
    }

    const ME: u32 = 1000;
    const OTHER: u32 = 1001;

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn the_kernel_word_format_parses_to_addresses() {
        // Literal rows as an x86_64 or aarch64 kernel prints them.
        if cfg!(target_endian = "little") {
            assert_eq!(
                parse_address("0100007F:2253"),
                Some("127.0.0.1:8787".parse().unwrap())
            );
            assert_eq!(
                parse_address("00000000000000000000000001000000:2253"),
                Some("[::1]:8787".parse().unwrap())
            );
            assert_eq!(
                parse_address("0000000000000000FFFF00000100007F:2253"),
                Some("[::ffff:127.0.0.1]:8787".parse().unwrap())
            );
        }
        assert_eq!(
            parse_address("00000000:0050"),
            Some("0.0.0.0:80".parse().unwrap())
        );
        assert_eq!(parse_address("0100007:2253"), None);
        assert_eq!(parse_address("0100007F"), None);
    }

    #[test]
    fn the_callers_own_listener_gets_the_bearer() {
        let addr: SocketAddr = "127.0.0.1:8787".parse().unwrap();
        let tcp = table(&[row(ip("127.0.0.1"), 8787, "0A", ME)]);
        assert_eq!(owner(&[&tcp, ""], addr, ME), Owner::Caller);
        // A wildcard listener of the caller's takes loopback connections.
        let tcp = table(&[row(ip("0.0.0.0"), 8787, "0A", ME)]);
        assert_eq!(owner(&[&tcp], addr, ME), Owner::Caller);
        // The caller's established connections on the port do not count as
        // listeners, and neither do other ports.
        let tcp = table(&[
            row(ip("127.0.0.1"), 8787, "0A", ME),
            row(ip("127.0.0.1"), 8787, "01", OTHER),
            row(ip("127.0.0.1"), 8788, "0A", OTHER),
        ]);
        assert_eq!(owner(&[&tcp], addr, ME), Owner::Caller);
    }

    #[test]
    fn another_users_listener_is_refused() {
        let addr: SocketAddr = "127.0.0.1:8787".parse().unwrap();
        let tcp = table(&[row(ip("127.0.0.1"), 8787, "0A", OTHER)]);
        assert_eq!(owner(&[&tcp], addr, ME), Owner::Other(OTHER));
        let tcp = table(&[row(ip("0.0.0.0"), 8787, "0A", OTHER)]);
        assert_eq!(owner(&[&tcp], addr, ME), Owner::Other(OTHER));
        // An IPv6 wildcard may be dual-stack and take the IPv4 connection.
        let tcp6 = table(&[row(ip("::"), 8787, "0A", OTHER)]);
        assert_eq!(owner(&["", &tcp6], addr, ME), Owner::Other(OTHER));
        // So does a v4-mapped listener on the same address.
        let tcp6 = table(&[row(ip("::ffff:127.0.0.1"), 8787, "0A", OTHER)]);
        assert_eq!(owner(&["", &tcp6], addr, ME), Owner::Other(OTHER));
        // One foreign listener beside the caller's is enough to refuse.
        let tcp = table(&[
            row(ip("127.0.0.1"), 8787, "0A", ME),
            row(ip("0.0.0.0"), 8787, "0A", OTHER),
        ]);
        assert_eq!(owner(&[&tcp], addr, ME), Owner::Other(OTHER));
    }

    #[test]
    fn listeners_that_cannot_take_the_connection_are_ignored() {
        let addr: SocketAddr = "127.0.0.1:8787".parse().unwrap();
        // Another address of the same port, and an IPv6-only address.
        let tcp = table(&[row(ip("127.0.0.2"), 8787, "0A", OTHER)]);
        let tcp6 = table(&[row(ip("::1"), 8787, "0A", OTHER)]);
        assert_eq!(owner(&[&tcp, &tcp6], addr, ME), Owner::Nobody);
        // An IPv4 wildcard cannot take an IPv6 connection.
        let v6: SocketAddr = "[::1]:8787".parse().unwrap();
        let tcp = table(&[row(ip("0.0.0.0"), 8787, "0A", OTHER)]);
        let tcp6 = table(&[row(ip("::1"), 8787, "0A", ME)]);
        assert_eq!(owner(&[&tcp, &tcp6], v6, ME), Owner::Caller);
        assert_eq!(owner(&[HEADER, "garbage", ""], addr, ME), Owner::Nobody);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn this_processs_listener_reads_as_the_callers() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        ensure_caller_listens(listener.local_addr().unwrap()).unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let error = ensure_caller_listens(addr).unwrap_err().to_string();
        assert!(error.contains("no devserver is listening"), "{error}");
    }
}
