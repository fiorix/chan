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
//!
//! A devserver can be at more than one recorded address (the one its unit
//! file pins, the port it last bound), so the check takes them in order and
//! names the first that passes; an address that fails is never dialed.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

#[derive(Debug)]
pub(super) enum Refusal {
    NoListener(Vec<SocketAddr>),
    Foreign(SocketAddr, u32),
    Unreadable(&'static str, std::io::Error),
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoListener(candidates) => {
                let tried: Vec<String> = candidates.iter().map(SocketAddr::to_string).collect();
                write!(f, "no devserver is listening on {}", tried.join(" or "))
            }
            Self::Foreign(addr, uid) => write!(f,
                "{addr} is held by uid {uid}, not this user's devserver; not sending the devserver token"
            ),
            Self::Unreadable(path, _) => write!(f, "cannot read {path} to check who listens on the devserver port"),
        }
    }
}

impl std::error::Error for Refusal {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Unreadable(_, error) => Some(error),
            _ => None,
        }
    }
}

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

/// The address the devserver bearer may go to: the first of `candidates`
/// where the caller owns every listener that could take the connection. A
/// refusal when there is none.
#[cfg(target_os = "linux")]
pub(super) fn callers_listener(candidates: &[SocketAddr]) -> Result<SocketAddr, Refusal> {
    let (tcp, tcp6) = tables(|path| {
        #[cfg(test)]
        if let Some(result) = crate::test_env::local_listener::read_table(path) {
            return result;
        }
        std::fs::read_to_string(path)
    })?;
    let uid = rustix::process::geteuid().as_raw();
    first_owned(&[&tcp, &tcp6], candidates, uid)
}

/// The first of `candidates` that reads as the caller's in `tables`, else
/// the refusal. Another user's listener is named before an address nobody
/// listens on: it is the answer that says where the bearer would have gone.
fn first_owned(
    tables: &[&str],
    candidates: &[SocketAddr],
    uid: u32,
) -> Result<SocketAddr, Refusal> {
    let mut foreign = None;
    for &addr in candidates {
        match owner(tables, addr, uid) {
            Owner::Caller => return Ok(addr),
            Owner::Other(other) => {
                foreign.get_or_insert((addr, other));
            }
            Owner::Nobody => {}
        }
    }
    Err(match foreign {
        Some((addr, other)) => Refusal::Foreign(addr, other),
        None => Refusal::NoListener(candidates.to_vec()),
    })
}

/// The IPv4 and IPv6 socket tables, read through `read`. Only a missing
/// tcp6 table means no IPv6 listener: a kernel without IPv6 has none. Any
/// other failure refuses, since a table that cannot be read could hide
/// another user's listener.
fn tables(read: impl Fn(&str) -> std::io::Result<String>) -> Result<(String, String), Refusal> {
    let tcp = read("/proc/net/tcp").map_err(|error| Refusal::Unreadable("/proc/net/tcp", error))?;
    let tcp6 = match read("/proc/net/tcp6") {
        Ok(table) => table,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(Refusal::Unreadable("/proc/net/tcp6", error)),
    };
    Ok((tcp, tcp6))
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

    #[test]
    fn only_a_missing_tcp6_table_reads_as_no_ipv6_listeners() {
        use std::io::{Error, ErrorKind};
        let reading = |tcp6: Option<ErrorKind>| {
            move |path: &str| match (path.ends_with("tcp6"), tcp6) {
                (true, Some(kind)) => Err(Error::from(kind)),
                _ => Ok(table(&[row(ip("127.0.0.1"), 8787, "0A", ME)])),
            }
        };
        let (tcp, tcp6) = tables(reading(None)).unwrap();
        assert!(!tcp.is_empty() && !tcp6.is_empty());
        let (_, tcp6) = tables(reading(Some(ErrorKind::NotFound))).unwrap();
        assert_eq!(tcp6, "", "a kernel without IPv6");
        for kind in [ErrorKind::PermissionDenied, ErrorKind::Other] {
            let error = tables(reading(Some(kind))).unwrap_err();
            assert!(error.to_string().contains("/proc/net/tcp6"), "{error}");
        }
        // A missing IPv4 table is never a kernel shape to wave through.
        assert!(tables(|_| Err(Error::from(ErrorKind::NotFound))).is_err());
    }

    #[test]
    fn the_first_address_the_caller_listens_on_is_the_one_dialed() {
        let pinned: SocketAddr = "127.0.0.1:8787".parse().unwrap();
        let recorded: SocketAddr = "127.0.0.1:9000".parse().unwrap();
        let both = [pinned, recorded];
        let listening = |rows: &[(SocketAddr, u32)]| {
            let rows: Vec<String> = rows
                .iter()
                .map(|(addr, uid)| row(addr.ip(), addr.port(), "0A", *uid))
                .collect();
            first_owned(&[&table(&rows)], &both, ME).map_err(|error| error.to_string())
        };
        // The pinned address wins while the caller listens there.
        assert_eq!(listening(&[(pinned, ME), (recorded, ME)]), Ok(pinned));
        // Nothing at the pinned address, or another user's listener there:
        // the recorded port is read, and the pinned one is never dialed.
        assert_eq!(listening(&[(recorded, ME)]), Ok(recorded));
        assert_eq!(listening(&[(pinned, OTHER), (recorded, ME)]), Ok(recorded));
        // No address of the caller's: the refusal names every address tried,
        // or the listener that is not the caller's, whichever address has it.
        assert_eq!(
            listening(&[]),
            Err("no devserver is listening on 127.0.0.1:8787 or 127.0.0.1:9000".into())
        );
        for foreign in both {
            let refusal = listening(&[(foreign, OTHER)]).unwrap_err();
            assert!(
                refusal.starts_with(&format!("{foreign} is held by uid {OTHER}")),
                "{refusal}"
            );
        }
        assert_eq!(
            first_owned(&[""], &[pinned], ME).map_err(|error| error.to_string()),
            Err("no devserver is listening on 127.0.0.1:8787".into())
        );
    }

    // The live table is read only for a listener this process holds: once
    // it is dropped, a parallel test can bind the freed port, or a child a
    // sibling test forks can hold the socket until it execs, so "nobody
    // listens" is pinned by the fixtures above instead.
    #[cfg(target_os = "linux")]
    #[test]
    fn this_processs_listener_reads_as_the_callers() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        assert_eq!(callers_listener(&[addr]).unwrap(), addr);
    }
}
