//! The TLS trust decision chan's Rust clients share.
//!
//! [`client_config`] is where every client that reaches a gateway gets its
//! certificate verification: the desktop's HTTP clients, its WebSocket feeds,
//! its updater, the devserver's tunnel dial and the gateway's WireGuard
//! agent. A gateway one of them trusts is trusted by all of them.
//!
//! The decision depends on the platform. On macOS and Windows the operating
//! system verifies each chain, through `rustls-platform-verifier`, so a CA
//! installed in the keychain or the certificate store verifies and a root the
//! system distrusts is distrusted. On Linux and the other Unixes WebPKI
//! verifies against the system bundle, read through `rustls-native-certs`,
//! beside the Mozilla roots `webpki-roots` carries; those bundled roots are
//! the floor, so a public CA verifies on a machine whose bundle is empty or
//! missing. Nothing here can turn verification off or pin a certificate.

use std::sync::{Arc, OnceLock};

use rustls::client::danger::ServerCertVerifier;
use rustls::crypto::CryptoProvider;
use rustls::ClientConfig;

/// The rustls this crate builds configs with, for callers that name its
/// types: a config handed to reqwest or tokio-tungstenite must be this
/// version's.
pub use rustls;

/// Why the trust decision could not be built.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

/// A client config that verifies servers with this platform's trust
/// decision, offering TLS 1.3 and 1.2 and no ALPN.
///
/// Each call returns a new config around the one verifier the process
/// shares, so a caller sets its own ALPN (and anything else its transport
/// needs) on the config it got without reaching another caller's. The
/// verifier is built on the first call; on Linux that call reads the system
/// bundle, so a CA installed later is trusted from the next process start.
/// A failure is not kept, and the next call tries again.
pub fn client_config() -> Result<ClientConfig, Error> {
    config_with(verifier()?)
}

fn config_with(verifier: Arc<dyn ServerCertVerifier>) -> Result<ClientConfig, Error> {
    Ok(ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .map_err(|e| {
            Error(format!(
                "the TLS crypto provider cannot build a client: {e}"
            ))
        })?
        // rustls names every custom verifier dangerous. This one is the
        // platform's or WebPKI's, and verifies every chain it is shown.
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth())
}

/// ring, the one provider chan links. It is also installed as the process
/// default, once, so a rustls config built from the default elsewhere in the
/// process (tokio-tungstenite's own connector, the updater's) negotiates with
/// the same one.
fn provider() -> Arc<CryptoProvider> {
    static PROVIDER: OnceLock<Arc<CryptoProvider>> = OnceLock::new();
    PROVIDER
        .get_or_init(|| {
            // Refused only when a default is already installed, which stays.
            let _ = rustls::crypto::ring::default_provider().install_default();
            Arc::new(rustls::crypto::ring::default_provider())
        })
        .clone()
}

/// The process's verifier. Two first calls racing may both build one; the
/// first stored wins and both callers return it.
fn verifier() -> Result<Arc<dyn ServerCertVerifier>, Error> {
    static VERIFIER: OnceLock<Arc<dyn ServerCertVerifier>> = OnceLock::new();
    if let Some(verifier) = VERIFIER.get() {
        return Ok(Arc::clone(verifier));
    }
    let built = platform::verifier(provider())?;
    Ok(Arc::clone(VERIFIER.get_or_init(|| built)))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod platform {
    use std::sync::Arc;

    use rustls::client::danger::ServerCertVerifier;
    use rustls::crypto::CryptoProvider;

    use crate::Error;

    /// The operating system's verifier. No bundled roots are added: extra
    /// anchors would be trusted whatever the system says of them, which
    /// would re-trust a root the system distrusts.
    pub(crate) fn verifier(
        provider: Arc<CryptoProvider>,
    ) -> Result<Arc<dyn ServerCertVerifier>, Error> {
        let verifier = rustls_platform_verifier::Verifier::new(provider).map_err(|e| {
            Error(format!(
                "cannot start the platform certificate verifier: {e}"
            ))
        })?;
        tracing::debug!("TLS servers are verified by the platform's certificate verifier");
        Ok(Arc::new(verifier))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use std::sync::Arc;

    use rustls::client::danger::ServerCertVerifier;
    use rustls::client::WebPkiServerVerifier;
    use rustls::crypto::CryptoProvider;
    use rustls::pki_types::CertificateDer;
    use rustls::RootCertStore;

    use crate::Error;

    /// WebPKI over the system bundle and the bundled roots. A bundle that
    /// does not read is logged, not fatal: the bundled roots still verify a
    /// public CA, and the log names why a private one does not.
    pub(crate) fn verifier(
        provider: Arc<CryptoProvider>,
    ) -> Result<Arc<dyn ServerCertVerifier>, Error> {
        let loaded = rustls_native_certs::load_native_certs();
        if let Some(first) = loaded.errors.first() {
            tracing::warn!(
                errors = loaded.errors.len(),
                first = %first,
                "the system certificate store did not read cleanly; verifying against what it gave and the bundled roots",
            );
        }
        let roots = roots_with_floor(loaded.certs);
        if roots.ignored > 0 {
            tracing::warn!(
                ignored = roots.ignored,
                "the system certificate store holds certificates that are not usable trust anchors; they are not trusted",
            );
        }
        // Once per process, when the verifier is built. An absent or empty
        // store is the one case a private CA cannot verify in, so it warns.
        let bundled = webpki_roots::TLS_SERVER_ROOTS.len();
        if roots.system == 0 {
            tracing::warn!(
                bundled,
                "the system certificate store gave no trust anchors; TLS servers are verified against the bundled roots alone, so a private CA is not trusted",
            );
        } else {
            tracing::info!(
                system = roots.system,
                bundled,
                "TLS servers are verified against the system certificate store and the bundled roots",
            );
        }
        webpki_verifier(roots.store, provider)
    }

    /// A root store and what went into it from the system.
    pub(crate) struct Roots {
        pub(crate) store: RootCertStore,
        pub(crate) system: usize,
        pub(crate) ignored: usize,
    }

    /// The system's certificates beside the bundled roots. The bundled ones
    /// are always added, so a root removed from the system bundle is still
    /// trusted through them: on these platforms the floor wins over a
    /// removal.
    pub(crate) fn roots_with_floor(system: Vec<CertificateDer<'static>>) -> Roots {
        let mut store = RootCertStore::empty();
        let (system, ignored) = store.add_parsable_certificates(system);
        store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        Roots {
            store,
            system,
            ignored,
        }
    }

    pub(crate) fn webpki_verifier(
        store: RootCertStore,
        provider: Arc<CryptoProvider>,
    ) -> Result<Arc<dyn ServerCertVerifier>, Error> {
        let verifier = WebPkiServerVerifier::builder_with_provider(Arc::new(store), provider)
            .build()
            .map_err(|e| {
                Error(format!(
                    "cannot build the certificate verifier over the system store and the bundled roots: {e}"
                ))
            })?;
        Ok(verifier)
    }
}

/// Stand-ins for the tests of the clients that take [`client_config`]: a
/// test hands a client a recorded copy of the shared config and a sink to
/// dial, and reads back that the client started its handshake with that
/// config and what it offered on the wire.
#[cfg(any(test, feature = "test-support"))]
pub mod testing {
    use std::io::Read;
    use std::net::{Ipv4Addr, SocketAddr, TcpListener};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use rustls::client::{
        ClientSessionStore, Resumption, Tls12ClientSessionValue, Tls13ClientSessionValue,
    };
    use rustls::pki_types::ServerName;
    use rustls::{ClientConfig, NamedGroup};

    /// The server names the handshakes of a recorded config were started
    /// for, in order.
    #[derive(Debug, Clone, Default)]
    pub struct Handshakes(Arc<Mutex<Vec<String>>>);

    impl Handshakes {
        pub fn server_names(&self) -> Vec<String> {
            self.0.lock().unwrap().clone()
        }
    }

    /// `config` with a session store that records every handshake started
    /// with it, and keeps no session. rustls asks the store for a key-share
    /// hint while it writes the ClientHello, so the record exists as soon as
    /// the client has started TLS, whatever the server does next.
    pub fn recording(mut config: ClientConfig) -> (ClientConfig, Handshakes) {
        let handshakes = Handshakes::default();
        config.resumption = Resumption::store(Arc::new(Recorder(handshakes.clone())));
        (config, handshakes)
    }

    #[derive(Debug)]
    struct Recorder(Handshakes);

    impl ClientSessionStore for Recorder {
        fn set_kx_hint(&self, _: ServerName<'static>, _: NamedGroup) {}

        fn kx_hint(&self, server_name: &ServerName<'_>) -> Option<NamedGroup> {
            (self.0)
                .0
                .lock()
                .unwrap()
                .push(server_name.to_str().into_owned());
            None
        }

        fn set_tls12_session(&self, _: ServerName<'static>, _: Tls12ClientSessionValue) {}

        fn tls12_session(&self, _: &ServerName<'_>) -> Option<Tls12ClientSessionValue> {
            None
        }

        fn remove_tls12_session(&self, _: &ServerName<'static>) {}

        fn insert_tls13_ticket(&self, _: ServerName<'static>, _: Tls13ClientSessionValue) {}

        fn take_tls13_ticket(&self, _: &ServerName<'static>) -> Option<Tls13ClientSessionValue> {
            None
        }
    }

    /// A loopback listener that reads each connection's ClientHello, records
    /// the ALPN protocols it offers, and closes it, so the handshake fails
    /// right after the client has shown what it sends.
    #[derive(Debug, Clone)]
    pub struct Sink {
        pub addr: SocketAddr,
        offers: Arc<Mutex<Vec<Vec<String>>>>,
    }

    impl Sink {
        pub fn start() -> Self {
            let listener =
                TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind the loopback sink");
            let addr = listener.local_addr().expect("the sink's address");
            let offers = Arc::new(Mutex::new(Vec::new()));
            let seen = Arc::clone(&offers);
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { continue };
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                    if let Some(alpn) = read_client_hello(&mut stream).and_then(|h| alpn_of(&h)) {
                        seen.lock().unwrap().push(alpn);
                    }
                }
            });
            Self { addr, offers }
        }

        /// The ALPN protocols each ClientHello offered, one list per
        /// connection, empty for a hello without the extension.
        pub fn alpn_offers(&self) -> Vec<Vec<String>> {
            self.offers.lock().unwrap().clone()
        }
    }

    /// The first TLS record of a connection, which holds the ClientHello.
    fn read_client_hello(stream: &mut impl Read) -> Option<Vec<u8>> {
        let mut record = vec![0u8; 5];
        stream.read_exact(&mut record).ok()?;
        let len = usize::from(u16::from_be_bytes([record[3], record[4]]));
        record.resize(5 + len, 0);
        stream.read_exact(&mut record[5..]).ok()?;
        Some(record)
    }

    fn take<'a>(bytes: &mut &'a [u8], n: usize) -> Option<&'a [u8]> {
        if bytes.len() < n {
            return None;
        }
        let (head, rest) = bytes.split_at(n);
        *bytes = rest;
        Some(head)
    }

    fn take_u8_len<'a>(bytes: &mut &'a [u8]) -> Option<&'a [u8]> {
        let n = usize::from(*take(bytes, 1)?.first()?);
        take(bytes, n)
    }

    fn take_u16_len<'a>(bytes: &mut &'a [u8]) -> Option<&'a [u8]> {
        let len = take(bytes, 2)?;
        take(bytes, usize::from(u16::from_be_bytes([len[0], len[1]])))
    }

    /// The ALPN list of a ClientHello record (RFC 8446 section 4.1.2,
    /// RFC 7301 section 3.1), `None` for anything else.
    fn alpn_of(record: &[u8]) -> Option<Vec<String>> {
        let mut bytes = record;
        // A handshake record whose message is a ClientHello.
        if take(&mut bytes, 5)?[0] != 22 || take(&mut bytes, 4)?[0] != 1 {
            return None;
        }
        take(&mut bytes, 2 + 32)?; // legacy_version, random
        take_u8_len(&mut bytes)?; // legacy_session_id
        take_u16_len(&mut bytes)?; // cipher_suites
        take_u8_len(&mut bytes)?; // legacy_compression_methods
        let mut extensions = take_u16_len(&mut bytes)?;
        let mut alpn = Vec::new();
        while !extensions.is_empty() {
            let kind = take(&mut extensions, 2)?;
            let mut data = take_u16_len(&mut extensions)?;
            if kind == [0, 16] {
                let mut names = take_u16_len(&mut data)?;
                while !names.is_empty() {
                    alpn.push(String::from_utf8_lossy(take_u8_len(&mut names)?).into_owned());
                }
            }
        }
        Some(alpn)
    }
}

/// The CA, leaf and in-memory handshake the integration tests use too.
#[cfg(test)]
#[path = "../tests/support/mod.rs"]
mod support;

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
    use rustls::Error as TlsError;

    use super::*;

    /// A leaf for `localhost` and `127.0.0.1`, valid until 2126, signed by
    /// a throwaway CA whose key was discarded when the two were made.
    const THROWAWAY_LEAF: &[u8] = include_bytes!("../testdata/throwaway-localhost.der");

    fn der(bytes: &'static [u8]) -> CertificateDer<'static> {
        CertificateDer::from(bytes)
    }

    fn name(name: &str) -> ServerName<'static> {
        ServerName::try_from(name.to_string()).unwrap()
    }

    #[test]
    fn the_config_builds_here_without_alpn_around_one_verifier() {
        let config = client_config().expect("the trust decision builds on this platform");
        assert!(config.alpn_protocols.is_empty());
        assert!(
            Arc::ptr_eq(&verifier().unwrap(), &verifier().unwrap()),
            "one verifier per process"
        );
    }

    #[test]
    fn each_caller_sets_its_alpn_on_its_own_config() {
        let mut tunnel = client_config().unwrap();
        tunnel.alpn_protocols = vec![b"h2".to_vec()];
        let mut http = tunnel.clone();
        http.alpn_protocols = vec![b"http/1.1".to_vec()];
        assert_eq!(tunnel.alpn_protocols, [b"h2".to_vec()]);
        assert_eq!(http.alpn_protocols, [b"http/1.1".to_vec()]);
        assert!(
            client_config().unwrap().alpn_protocols.is_empty(),
            "a caller's ALPN never reaches the next config"
        );
    }

    use crate::support;

    #[test]
    fn a_server_under_a_ca_in_neither_store_fails_the_handshake() {
        let ca = support::ca("chan-tls refused test CA");
        let leaf = support::leaf(&ca);
        let error = support::handshake(client_config().unwrap(), &leaf)
            .expect_err("the config client_config returns refuses an unknown CA");
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        assert_eq!(
            error,
            TlsError::InvalidCertificate(rustls::CertificateError::UnknownIssuer)
        );
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        assert!(
            matches!(error, TlsError::InvalidCertificate(_)),
            "{error:?}"
        );
    }

    #[test]
    fn a_chain_with_no_trusted_anchor_is_refused() {
        let error = verifier()
            .unwrap()
            .verify_server_cert(
                &der(THROWAWAY_LEAF),
                &[],
                &name("localhost"),
                &[],
                UnixTime::now(),
            )
            .expect_err("a CA in neither store verifies nothing");
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        assert_eq!(
            error,
            TlsError::InvalidCertificate(rustls::CertificateError::UnknownIssuer)
        );
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        assert!(
            matches!(error, TlsError::InvalidCertificate(_)),
            "{error:?}"
        );
    }

    #[test]
    fn the_recorder_sees_a_handshake_and_the_sink_its_alpn() {
        let (mut config, handshakes) = testing::recording(client_config().unwrap());
        config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
        let sink = testing::Sink::start();
        let mut tcp = std::net::TcpStream::connect(sink.addr).unwrap();
        let mut client =
            rustls::ClientConnection::new(Arc::new(config), name("127.0.0.1")).unwrap();
        assert_eq!(handshakes.server_names(), ["127.0.0.1"]);
        while client.wants_write() {
            client.write_tls(&mut tcp).unwrap();
        }
        // The sink closes once it has read the hello.
        let _ = client.read_tls(&mut tcp);
        assert_eq!(sink.alpn_offers(), [["h2", "http/1.1"]]);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    mod system_bundle {
        use std::net::{IpAddr, Ipv4Addr};
        use std::time::Duration;

        use rustls::CertificateError;

        use super::*;
        use crate::platform::{roots_with_floor, webpki_verifier};

        /// The CA that signed the throwaway leaf.
        const THROWAWAY_CA: &[u8] = include_bytes!("../testdata/throwaway-ca.der");

        /// letsencrypt.org's leaf and its E8 intermediate, which chains to
        /// ISRG Root X1, as captured on 2026-04-08 for
        /// rustls-platform-verifier 0.7.0's real-world tests.
        const LETSENCRYPT_ORG: &[u8] = include_bytes!("../testdata/letsencrypt-org.der");
        const LETSENCRYPT_E8: &[u8] = include_bytes!("../testdata/letsencrypt-e8.der");

        /// 2026-04-08 12:03 UTC, inside the leaf's validity (2026-03-08 to
        /// 2026-06-06).
        fn captured() -> UnixTime {
            UnixTime::since_unix_epoch(Duration::from_secs(1_775_649_786))
        }

        #[test]
        fn an_empty_system_store_keeps_the_bundled_roots() {
            let roots = roots_with_floor(Vec::new());
            assert_eq!((roots.system, roots.ignored), (0, 0));
            assert_eq!(roots.store.len(), webpki_roots::TLS_SERVER_ROOTS.len());
            let verifier = webpki_verifier(roots.store, provider()).unwrap();
            verifier
                .verify_server_cert(
                    &der(LETSENCRYPT_ORG),
                    &[der(LETSENCRYPT_E8)],
                    &name("letsencrypt.org"),
                    &[],
                    captured(),
                )
                .expect("a public CA verifies with the bundled roots alone");
        }

        #[test]
        fn the_floor_still_checks_the_name_and_the_time() {
            let verifier = webpki_verifier(roots_with_floor(Vec::new()).store, provider()).unwrap();
            let chain = [der(LETSENCRYPT_E8)];
            let wrong_name = verifier
                .verify_server_cert(
                    &der(LETSENCRYPT_ORG),
                    &chain,
                    &name("gw.example.com"),
                    &[],
                    captured(),
                )
                .unwrap_err();
            assert!(
                matches!(
                    wrong_name,
                    TlsError::InvalidCertificate(
                        CertificateError::NotValidForName
                            | CertificateError::NotValidForNameContext { .. }
                    )
                ),
                "{wrong_name:?}"
            );
            let expired = verifier
                .verify_server_cert(
                    &der(LETSENCRYPT_ORG),
                    &chain,
                    &name("letsencrypt.org"),
                    &[],
                    UnixTime::now(),
                )
                .unwrap_err();
            assert!(
                matches!(
                    expired,
                    TlsError::InvalidCertificate(
                        CertificateError::Expired | CertificateError::ExpiredContext { .. }
                    )
                ),
                "{expired:?}"
            );
        }

        #[test]
        fn a_ca_in_the_system_store_verifies_its_leaves() {
            let roots = roots_with_floor(vec![der(THROWAWAY_CA)]);
            assert_eq!((roots.system, roots.ignored), (1, 0));
            let verifier = webpki_verifier(roots.store, provider()).unwrap();
            for server in [
                name("localhost"),
                ServerName::IpAddress(IpAddr::V4(Ipv4Addr::LOCALHOST).into()),
            ] {
                verifier
                    .verify_server_cert(&der(THROWAWAY_LEAF), &[], &server, &[], UnixTime::now())
                    .unwrap_or_else(|e| panic!("{server:?}: {e:?}"));
            }
            assert!(verifier
                .verify_server_cert(
                    &der(THROWAWAY_LEAF),
                    &[],
                    &name("gw.example.com"),
                    &[],
                    UnixTime::now(),
                )
                .is_err());
        }

        /// The control for the refusal above: the same kind of chain
        /// completes a handshake once its CA is in the root store, so the
        /// refusal is about trust, not about how the certificates are made.
        #[test]
        fn a_server_under_a_ca_in_the_store_completes_the_handshake() {
            let ca = support::ca("chan-tls trusted test CA");
            let leaf = support::leaf(&ca);
            let roots = roots_with_floor(vec![ca.cert.clone()]);
            let config = config_with(webpki_verifier(roots.store, provider()).unwrap()).unwrap();
            support::handshake(config, &leaf).expect("a CA in the store verifies its leaf");
        }

        #[test]
        fn an_unusable_system_certificate_is_counted_and_not_trusted() {
            let roots = roots_with_floor(vec![CertificateDer::from(vec![
                0x30, 0x03, 0x02, 0x01, 0x00,
            ])]);
            assert_eq!((roots.system, roots.ignored), (0, 1));
            assert_eq!(roots.store.len(), webpki_roots::TLS_SERVER_ROOTS.len());
        }
    }
}
