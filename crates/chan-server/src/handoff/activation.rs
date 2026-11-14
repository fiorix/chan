//! The activation a launching process passes to an already running desktop.

/// Capture the launcher's activation before its handoff retries begin.
///
/// On the GTK platforms, a supplied `DESKTOP_STARTUP_ID` takes precedence over
/// `XDG_ACTIVATION_TOKEN`, and either is preserved verbatim. Without either,
/// an X11 launch reads the server's timestamp through its own connection.
/// Wayland never takes that fallback. Other platforms return `None`.
///
/// X11 socket I/O shares a 500 ms deadline. Local Unix displays and numeric
/// or localhost TCP displays are supported; DNS display names are left alone
/// because resolving them synchronously could hold the launch indefinitely.
/// An unavailable display returns `None`, without inventing a timestamp.
#[cfg(any(target_os = "linux", target_os = "freebsd"))]
pub fn launch_startup_id() -> Option<String> {
    startup_id_with(
        |name| std::env::var(name).ok(),
        || match x11::server_time() {
            Ok(time) => Some(time),
            Err(error) => {
                tracing::debug!(%error, "could not read the launch activation's X11 time");
                None
            }
        },
    )
}

/// The non-GTK platforms keep their native activation behavior.
#[cfg(not(any(target_os = "linux", target_os = "freebsd")))]
pub fn launch_startup_id() -> Option<String> {
    None
}

#[cfg(any(target_os = "linux", target_os = "freebsd", test))]
fn startup_id_with(
    env: impl Fn(&str) -> Option<String>,
    server_time: impl FnOnce() -> Option<u32>,
) -> Option<String> {
    if let Some(id) = env("DESKTOP_STARTUP_ID").or_else(|| env("XDG_ACTIVATION_TOKEN")) {
        return Some(id);
    }
    if env("WAYLAND_DISPLAY").is_some()
        || env("XDG_SESSION_TYPE").as_deref() == Some("wayland")
        || env("DISPLAY").is_none_or(|display| display.is_empty())
    {
        return None;
    }
    // Zero is X11's CurrentTime sentinel, not a timestamp the caller owns.
    server_time()
        .filter(|time| *time != 0)
        .map(|time| format!("_TIME{time}"))
}

#[cfg(any(target_os = "linux", target_os = "freebsd"))]
mod x11 {
    use std::io;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
    use std::os::fd::AsFd;
    use std::os::unix::net::UnixStream;
    use std::time::{Duration, Instant};

    use anyhow::{bail, Result};
    use rustix::event::{poll, PollFd, PollFlags, Timespec};
    use rustix::net::{self, AddressFamily, SocketAddrUnix, SocketFlags, SocketType};
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{
        AtomEnum, ConnectionExt, CreateWindowAux, EventMask, PropMode, WindowClass,
    };
    use x11rb::protocol::Event;
    use x11rb::reexports::x11rb_protocol::parse_display::{parse_display, ConnectAddress};
    use x11rb::reexports::x11rb_protocol::xauth::{get_auth, Family};
    use x11rb::rust_connection::{DefaultStream, PollMode, RustConnection, Stream};
    use x11rb::utils::RawFdContainer;
    use x11rb::wrapper::ConnectionExt as _;

    const QUERY_BOUND: Duration = Duration::from_millis(500);

    pub(super) fn server_time() -> Result<u32> {
        let deadline = Instant::now() + QUERY_BOUND;
        let display = parse_display(None)?;
        // x11rb's connection instructions add the TCP base without checking.
        if display.display.checked_add(6000).is_none() {
            bail!("X11 display number is outside the TCP port range");
        }
        let mut last_error = None;
        for address in display.connect_instruction() {
            let (stream, (family, address)) = match connect(&address, deadline) {
                Ok(connected) => connected,
                Err(error) => {
                    last_error = Some(error);
                    continue;
                }
            };
            let (auth_name, auth_data) = get_auth(family, &address, display.display)
                .unwrap_or(None)
                .unwrap_or_default();
            let connection = RustConnection::connect_to_stream_with_auth_info(
                DeadlineStream { stream, deadline },
                usize::from(display.screen),
                auth_name,
                auth_data,
            )?;
            return timestamp(&connection, usize::from(display.screen));
        }
        Err(last_error
            .unwrap_or_else(|| io::Error::other("no supported X11 address"))
            .into())
    }

    fn timestamp(connection: &RustConnection<DeadlineStream>, screen: usize) -> Result<u32> {
        let window = connection.generate_id()?;
        connection
            .create_window(
                0,
                window,
                connection.setup().roots[screen].root,
                0,
                0,
                1,
                1,
                0,
                WindowClass::INPUT_ONLY,
                0,
                &CreateWindowAux::new().event_mask(EventMask::PROPERTY_CHANGE),
            )?
            .check()?;
        // This unmapped window belongs only to this connection. Closing the
        // connection destroys it on every return path, including a timeout.
        connection
            .change_property8(
                PropMode::REPLACE,
                window,
                AtomEnum::WM_NAME,
                AtomEnum::STRING,
                &[0],
            )?
            .check()?;
        loop {
            remaining(connection.stream().deadline)?;
            match connection.wait_for_event()? {
                Event::PropertyNotify(event)
                    if event.window == window
                        && event.atom == u32::from(AtomEnum::WM_NAME)
                        && event.response_type & 0x80 == 0
                        && event.time != 0 =>
                {
                    return Ok(event.time)
                }
                _ => {}
            }
        }
    }

    type Connected = (DefaultStream, (Family, Vec<u8>));

    fn connect(address: &ConnectAddress<'_>, deadline: Instant) -> io::Result<Connected> {
        remaining(deadline)?;
        match address {
            ConnectAddress::Socket(path) => {
                #[cfg(target_os = "linux")]
                if let Some(stream) = SocketAddrUnix::new_abstract_name(path.as_bytes())
                    .ok()
                    .and_then(|address| connect_unix(&address, deadline).ok())
                {
                    return DefaultStream::from_unix_stream(stream);
                }
                let address = SocketAddrUnix::new(path)?;
                DefaultStream::from_unix_stream(connect_unix(&address, deadline)?)
            }
            ConnectAddress::Hostname(host, port) => {
                let addresses = numeric_addresses(host, *port)?;
                let mut last_error = None;
                for address in addresses {
                    match TcpStream::connect_timeout(&address, remaining(deadline)?) {
                        Ok(stream) => return DefaultStream::from_tcp_stream(stream),
                        Err(error) => last_error = Some(error),
                    }
                }
                Err(last_error.unwrap_or_else(|| io::Error::other("no TCP address")))
            }
            _ => Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "unsupported X11 address",
            )),
        }
    }

    fn numeric_addresses(host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
        if host == "localhost" {
            return Ok(vec![
                SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
                SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port),
            ]);
        }
        host.trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
            .map(|ip| vec![SocketAddr::new(ip, port)])
            .map_err(|_| {
                io::Error::new(
                    io::ErrorKind::Unsupported,
                    "X11 DNS display names need a launcher activation id",
                )
            })
    }

    fn connect_unix(address: &SocketAddrUnix, deadline: Instant) -> io::Result<UnixStream> {
        let socket = net::socket_with(
            AddressFamily::UNIX,
            SocketType::STREAM,
            SocketFlags::CLOEXEC | SocketFlags::NONBLOCK,
            None,
        )?;
        match net::connect(&socket, address) {
            Ok(()) => {}
            Err(rustix::io::Errno::INPROGRESS | rustix::io::Errno::INTR) => {
                wait(&socket, PollFlags::OUT, deadline)?;
                net::sockopt::socket_error(&socket)??;
            }
            Err(error) => return Err(error.into()),
        }
        remaining(deadline)?;
        Ok(socket.into())
    }

    fn remaining(deadline: Instant) -> io::Result<Duration> {
        deadline
            .checked_duration_since(Instant::now())
            .filter(|duration| !duration.is_zero())
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::TimedOut, "X11 activation time query expired")
            })
    }

    fn wait(fd: &impl AsFd, flags: PollFlags, deadline: Instant) -> io::Result<()> {
        loop {
            let timeout: Timespec = remaining(deadline)?.try_into().map_err(io::Error::other)?;
            let mut fds = [PollFd::new(fd, flags)];
            match poll(&mut fds, Some(&timeout)) {
                Ok(0) => {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "X11 activation time query expired",
                    ));
                }
                Ok(_) => return Ok(()),
                Err(rustix::io::Errno::INTR) => {}
                Err(error) => return Err(error.into()),
            }
        }
    }

    struct DeadlineStream {
        stream: DefaultStream,
        deadline: Instant,
    }

    impl Stream for DeadlineStream {
        fn poll(&self, mode: PollMode) -> io::Result<()> {
            let mut flags = PollFlags::empty();
            if mode.readable() {
                flags |= PollFlags::IN;
            }
            if mode.writable() {
                flags |= PollFlags::OUT;
            }
            wait(&self.stream, flags, self.deadline)
        }

        fn read(&self, bytes: &mut [u8], fds: &mut Vec<RawFdContainer>) -> io::Result<usize> {
            remaining(self.deadline)?;
            self.stream.read(bytes, fds)
        }

        fn write(&self, bytes: &[u8], fds: &mut Vec<RawFdContainer>) -> io::Result<usize> {
            remaining(self.deadline)?;
            self.stream.write(bytes, fds)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn startup_id_x11_display_addresses_never_resolve_dns() {
            assert_eq!(
                numeric_addresses("127.0.0.1", 6001).unwrap(),
                vec!["127.0.0.1:6001".parse::<SocketAddr>().unwrap()]
            );
            assert_eq!(
                numeric_addresses("[::1]", 6001).unwrap(),
                vec!["[::1]:6001".parse::<SocketAddr>().unwrap()]
            );
            assert_eq!(numeric_addresses("localhost", 6001).unwrap().len(), 2);
            assert_eq!(
                numeric_addresses("unknown.example", 6001)
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::Unsupported
            );
        }

        #[test]
        fn startup_id_x11_setup_stops_when_the_peer_never_answers() {
            let (client, _peer) = UnixStream::pair().unwrap();
            let (stream, _) = DefaultStream::from_unix_stream(client).unwrap();
            let started = Instant::now();
            let deadline = started + Duration::from_millis(30);
            let result = RustConnection::connect_to_stream(DeadlineStream { stream, deadline }, 0);
            let error = result.err().expect("a silent peer cannot complete setup");
            assert!(error.to_string().contains("expired"), "{error}");
            assert!(started.elapsed() >= Duration::from_millis(30));
            assert!(started.elapsed() < Duration::from_secs(2));
        }

        #[test]
        fn startup_id_x11_expired_deadline_refuses_even_ready_io() {
            let (client, _peer) = UnixStream::pair().unwrap();
            let (stream, _) = DefaultStream::from_unix_stream(client).unwrap();
            let stream = DeadlineStream {
                stream,
                deadline: Instant::now(),
            };
            assert_eq!(
                stream.poll(PollMode::Writable).unwrap_err().kind(),
                io::ErrorKind::TimedOut
            );
            assert_eq!(
                stream.write(&[0], &mut vec![]).unwrap_err().kind(),
                io::ErrorKind::TimedOut
            );
            assert_eq!(
                stream.read(&mut [0], &mut vec![]).unwrap_err().kind(),
                io::ErrorKind::TimedOut
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn environment<'a>(entries: &'a [(&str, &str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |key| {
            entries
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| value.to_string())
        }
    }

    #[test]
    fn startup_id_preserves_the_desktop_id_and_never_queries_time() {
        let entries = [
            ("DESKTOP_STARTUP_ID", "launch /name_TIME12345"),
            ("XDG_ACTIVATION_TOKEN", "token"),
        ];
        assert_eq!(
            startup_id_with(environment(&entries), || panic!("no X query with an id")),
            Some("launch /name_TIME12345".into())
        );
    }

    #[test]
    fn startup_id_preserves_the_activation_token_and_never_queries_time() {
        let entries = [("XDG_ACTIVATION_TOKEN", "opaque token\nvalue")];
        assert_eq!(
            startup_id_with(environment(&entries), || panic!("no X query with a token")),
            Some("opaque token\nvalue".into())
        );
    }

    #[test]
    fn startup_id_preserves_an_empty_supplied_id() {
        let entries = [("DESKTOP_STARTUP_ID", "")];
        assert_eq!(
            startup_id_with(environment(&entries), || panic!(
                "present id stays verbatim"
            )),
            Some(String::new())
        );
    }

    #[test]
    fn startup_id_uses_only_the_x_server_time_when_no_id_exists() {
        assert_eq!(
            startup_id_with(environment(&[("DISPLAY", ":1")]), || Some(1987654321)),
            Some("_TIME1987654321".into())
        );
    }

    #[test]
    fn startup_id_never_queries_x_in_a_wayland_session_or_without_display() {
        for entries in [
            vec![],
            vec![("DISPLAY", ":1"), ("WAYLAND_DISPLAY", "wayland-0")],
            vec![("DISPLAY", ":1"), ("XDG_SESSION_TYPE", "wayland")],
        ] {
            assert_eq!(
                startup_id_with(environment(&entries), || panic!("not an X11 launch")),
                None
            );
        }
    }

    #[test]
    fn startup_id_does_not_invent_a_time_when_the_query_fails_or_returns_current_time() {
        for stamp in [None, Some(0)] {
            assert_eq!(
                startup_id_with(environment(&[("DISPLAY", ":1")]), || stamp),
                None
            );
        }
    }
}
