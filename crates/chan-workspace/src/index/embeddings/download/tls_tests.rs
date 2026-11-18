use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpListener};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use chan_tls::rustls;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

use super::tests::{fixture, in_child, is_child, COMMIT};
use super::{Client, EmbedError};

const CA: &[u8] = include_bytes!("testdata/ca.der");
const LEAF: &[u8] = include_bytes!("testdata/localhost.der");
const KEY: &[u8] = include_bytes!("testdata/localhost-key.pk8");
const IO_LIMIT: Duration = Duration::from_secs(3);
const SERVER_LIMIT: Duration = Duration::from_secs(15);
const BODY: &[u8] = b"{\"tls_fixture\":true}\n";

fn trusted_config() -> rustls::ClientConfig {
    let mut roots = rustls::RootCertStore::empty();
    roots.add(CertificateDer::from(CA)).unwrap();
    rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth()
}

#[derive(Default)]
struct Observation {
    accepted: usize,
    requests: Vec<String>,
    errors: Vec<String>,
}

struct Server {
    addr: SocketAddr,
    stopped: Arc<AtomicBool>,
    observation: Arc<Mutex<Observation>>,
    worker: Option<JoinHandle<()>>,
}

impl Server {
    fn start(tls: bool, answer: impl Fn(&str) -> Vec<u8> + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = Arc::clone(&stopped);
        let observation = Arc::new(Mutex::new(Observation::default()));
        let observed = Arc::clone(&observation);
        let config = tls.then(|| {
            Arc::new(
                rustls::ServerConfig::builder_with_provider(Arc::new(
                    rustls::crypto::ring::default_provider(),
                ))
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_no_client_auth()
                .with_single_cert(
                    vec![CertificateDer::from(LEAF)],
                    PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(KEY.to_vec())),
                )
                .unwrap(),
            )
        });
        let worker = std::thread::spawn(move || {
            let deadline = Instant::now() + SERVER_LIMIT;
            while !stop.load(Ordering::Acquire) && Instant::now() < deadline {
                let (mut socket, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(error) => panic!("fixture accept failed: {error}"),
                };
                socket.set_nonblocking(false).unwrap();
                socket.set_read_timeout(Some(IO_LIMIT)).unwrap();
                socket.set_write_timeout(Some(IO_LIMIT)).unwrap();
                observed.lock().unwrap().accepted += 1;
                let result = if let Some(config) = &config {
                    let connection = rustls::ServerConnection::new(Arc::clone(config)).unwrap();
                    let mut stream = rustls::StreamOwned::new(connection, socket);
                    serve(&mut stream, &observed, &answer)
                } else {
                    serve(&mut socket, &observed, &answer)
                };
                if let Err(error) = result {
                    observed.lock().unwrap().errors.push(error.to_string());
                }
            }
        });
        Self {
            addr,
            stopped,
            observation,
            worker: Some(worker),
        }
    }

    fn endpoint(&self, tls: bool) -> String {
        format!("{}://{}/", if tls { "https" } else { "http" }, self.addr)
    }

    fn finish(mut self) -> Observation {
        self.stopped.store(true, Ordering::Release);
        self.worker.take().unwrap().join().unwrap();
        let mut observation = self.observation.lock().unwrap();
        std::mem::take(&mut *observation)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            // The explicit finish path reports a worker panic. During a failed
            // test, join still owns cleanup without causing a second panic.
            let _ = worker.join();
        }
    }
}

fn serve(
    stream: &mut (impl Read + Write),
    observed: &Mutex<Observation>,
    answer: &impl Fn(&str) -> Vec<u8>,
) -> io::Result<()> {
    let deadline = Instant::now() + IO_LIMIT;
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        if header.len() >= 8192 || Instant::now() >= deadline {
            return Err(io::Error::other(
                "fixture request exceeded its size or time limit",
            ));
        }
        let mut byte = [0];
        stream.read_exact(&mut byte)?;
        header.push(byte[0]);
    }
    let request = String::from_utf8(header)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    observed.lock().unwrap().requests.push(request.clone());
    stream.write_all(&answer(&request))?;
    stream.flush()
}

fn range(request: &str) -> &str {
    request
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("range").then(|| value.trim())
        })
        .unwrap_or("")
}

fn response(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
    let mut response = format!(
        "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n",
        body.len()
    )
    .into_bytes();
    response.extend_from_slice(body);
    response
}

fn model_response(request: &str) -> Vec<u8> {
    if range(request) != "bytes=0-" {
        return response("400 Bad Request", "", b"unexpected fixture range");
    }
    response(
        "206 Partial Content",
        &format!(
            "Content-Range: bytes 0-{}/{}\r\n",
            BODY.len() - 1,
            BODY.len()
        ),
        BODY,
    )
}

/// A client of `endpoint` on `config` with the fixture model pinned to `BODY`.
fn client(cache: &std::path::Path, endpoint: &str, config: rustls::ClientConfig) -> Client {
    Client::with_config(cache, endpoint, config).pinned(fixture(BODY))
}

fn payload_redirect_server(destination: &Server) -> Server {
    let location = format!("{}payload", destination.endpoint(true));
    Server::start(false, move |request| match range(request) {
        "bytes=0-" => response("302 Found", &format!("Location: {location}\r\n"), b""),
        _ => response("400 Bad Request", "", b"unexpected pre-redirect range"),
    })
}

fn assert_certificate_error(error: &EmbedError, request_url: &str) {
    assert!(
        matches!(error, EmbedError::Certificate(_)),
        "TLS verification refusal must retain the certificate variant: {error:?}"
    );
    let display = error.to_string();
    assert!(
        display.starts_with(&format!("model download: request error: {request_url}: ")),
        "certificate error must retain the Hub transport context: {display}"
    );
    assert!(
        display.contains("Connection Failed: tls connection init failed:"),
        "certificate error must retain ureq's transport text: {display}"
    );
    assert!(
        display.to_ascii_lowercase().contains("certificate"),
        "certificate error must name its cause: {display}"
    );
}

#[test]
fn trusted_tls_configuration_downloads_the_redirected_payload() {
    let cache = tempfile::tempdir().unwrap();
    let destination = Server::start(true, model_response);
    let source = payload_redirect_server(&destination);
    let client = client(cache.path(), &source.endpoint(false), trusted_config());
    let result = client.get("fixture/model", "config.json");
    let source = source.finish();
    let destination = destination.finish();
    assert!(
        source.errors.is_empty(),
        "source errors: {:?}",
        source.errors
    );
    assert!(
        destination.errors.is_empty(),
        "destination errors: {:?}",
        destination.errors
    );
    let path = result.expect("payload agent must use the explicitly trusted fixture CA");
    assert_eq!(std::fs::read(path).unwrap(), BODY);
    assert_eq!(
        source
            .requests
            .iter()
            .map(|request| range(request))
            .collect::<Vec<_>>(),
        ["bytes=0-"]
    );
    assert_eq!(
        destination
            .requests
            .iter()
            .map(|request| range(request))
            .collect::<Vec<_>>(),
        ["bytes=0-"]
    );
}

#[test]
fn untrusted_payload_certificate_preserves_the_transport_error() {
    let cache = tempfile::tempdir().unwrap();
    let destination = Server::start(true, model_response);
    let source = payload_redirect_server(&destination);
    let client = client(
        cache.path(),
        &source.endpoint(false),
        chan_tls::client_config().unwrap(),
    );
    let result = client.get("fixture/model", "config.json");
    let request_url = format!(
        "{}fixture/model/resolve/{COMMIT}/config.json",
        source.endpoint(false)
    );
    let source = source.finish();
    let destination = destination.finish();
    assert!(
        source.errors.is_empty(),
        "source errors: {:?}",
        source.errors
    );
    assert_eq!(
        source
            .requests
            .iter()
            .map(|request| range(request))
            .collect::<Vec<_>>(),
        ["bytes=0-"]
    );
    assert_eq!(
        destination.accepted, 1,
        "the TLS payload endpoint must have been reached"
    );
    assert!(
        destination.requests.is_empty(),
        "untrusted payload TLS must carry no HTTP"
    );
    assert!(
        !destination.errors.is_empty(),
        "server must observe the TLS refusal"
    );
    let error = result.expect_err("the payload fixture CA is absent from shared trust");
    assert_certificate_error(&error, &request_url);
}

fn authorization(request: &str) -> Option<&str> {
    request.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("authorization")
            .then(|| value.trim())
    })
}

#[test]
fn same_host_relative_redirects_keep_bearer() {
    let cache = tempfile::tempdir().unwrap();
    let server = Server::start(true, |request| {
        if request.starts_with("GET /relative-config ") {
            model_response(request)
        } else {
            response("302 Found", "Location: /relative-config\r\n", b"")
        }
    });
    let mut client = client(cache.path(), &server.endpoint(true), trusted_config());
    client.token = Some("fixture-bearer".to_owned());
    let result = client.get("fixture/model", "config.json");
    let observed = server.finish();
    assert!(
        observed.errors.is_empty(),
        "fixture errors: {:?}",
        observed.errors
    );
    let path = result.expect("same-host relative redirects preserve the transfer");
    assert_eq!(std::fs::read(path).unwrap(), BODY);
    assert_eq!(observed.accepted, 2);
    assert_eq!(
        observed
            .requests
            .iter()
            .map(|request| range(request))
            .collect::<Vec<_>>(),
        ["bytes=0-", "bytes=0-"]
    );
    for request in &observed.requests {
        assert_eq!(
            authorization(request),
            Some("Bearer fixture-bearer"),
            "same-host redirect must retain Authorization: {request}"
        );
    }
}

#[test]
fn cross_host_redirects_strip_bearer() {
    let cache = tempfile::tempdir().unwrap();
    let destination = Server::start(true, model_response);
    let location = format!("https://localhost:{}/payload", destination.addr.port());
    let source = Server::start(true, move |_| {
        response("302 Found", &format!("Location: {location}\r\n"), b"")
    });
    let mut client = client(cache.path(), &source.endpoint(true), trusted_config());
    client.token = Some("fixture-bearer".to_owned());
    let result = client.get("fixture/model", "config.json");
    let source = source.finish();
    let destination = destination.finish();
    assert!(
        source.errors.is_empty(),
        "source errors: {:?}",
        source.errors
    );
    assert!(
        destination.errors.is_empty(),
        "destination errors: {:?}",
        destination.errors
    );
    let path = result.expect("cross-host HTTPS redirects preserve the transfer");
    assert_eq!(std::fs::read(path).unwrap(), BODY);
    assert_eq!(source.accepted, 1);
    assert_eq!(destination.accepted, 1);
    assert_eq!(
        source
            .requests
            .iter()
            .map(|request| range(request))
            .collect::<Vec<_>>(),
        ["bytes=0-"]
    );
    assert_eq!(
        destination
            .requests
            .iter()
            .map(|request| range(request))
            .collect::<Vec<_>>(),
        ["bytes=0-"]
    );
    for request in &source.requests {
        assert_eq!(authorization(request), Some("Bearer fixture-bearer"));
    }
    for request in &destination.requests {
        assert_eq!(
            authorization(request),
            None,
            "cross-host redirect must strip Authorization: {request}"
        );
    }
}

#[test]
fn https_payload_redirect_refuses_http_before_connecting() {
    let cache = tempfile::tempdir().unwrap();
    let destination = Server::start(false, model_response);
    let location = format!("{}payload", destination.endpoint(false));
    let source = Server::start(true, move |_| {
        response("302 Found", &format!("Location: {location}\r\n"), b"")
    });
    let mut client = client(cache.path(), &source.endpoint(true), trusted_config());
    client.token = Some("fixture-bearer".to_owned());
    let result = client.get("fixture/model", "config.json");
    let source = source.finish();
    let destination = destination.finish();
    assert_eq!(
        destination.accepted, 0,
        "an HTTPS payload redirect must never connect to HTTP"
    );
    assert!(destination.requests.is_empty());
    let error = result.expect_err("HTTPS payload downgrade is refused");
    assert!(
        error.to_string().contains("https"),
        "downgrade cause is visible: {error}"
    );
    assert_eq!(source.accepted, 1);
    assert_eq!(
        source
            .requests
            .iter()
            .map(|request| range(request))
            .collect::<Vec<_>>(),
        ["bytes=0-"]
    );
    for request in &source.requests {
        assert_eq!(authorization(request), Some("Bearer fixture-bearer"));
    }
    assert!(source.errors.is_empty());
}

#[test]
fn http_proxy_environment_routes_the_download() {
    const TEST: &str =
        "index::embeddings::download::tls_tests::http_proxy_environment_routes_the_download";
    const ORIGIN: &str = "CHAN_DOWNLOAD_TEST_ORIGIN";
    if is_child(TEST) {
        let cache = tempfile::tempdir().unwrap();
        let mut client = client(
            cache.path(),
            &std::env::var(ORIGIN).unwrap(),
            trusted_config(),
        );
        client.proxy_from_env = true;
        let path = client.get("fixture/model", "config.json").unwrap();
        assert_eq!(std::fs::read(path).unwrap(), BODY);
        return;
    }
    let origin = Server::start(false, model_response);
    let proxy = Server::start(false, model_response);
    let endpoint = origin.endpoint(false);
    in_child(
        TEST,
        &[(ORIGIN, &endpoint), ("HTTP_PROXY", &proxy.endpoint(false))],
    );
    let proxy = proxy.finish();
    let origin = origin.finish();
    assert_eq!(
        proxy.requests.len(),
        1,
        "HTTP_PROXY must carry the download request"
    );
    let absolute_request =
        format!("GET {endpoint}fixture/model/resolve/{COMMIT}/config.json HTTP/1.1");
    for request in &proxy.requests {
        assert_eq!(
            request.lines().next(),
            Some(absolute_request.as_str()),
            "the proxy must receive an absolute-form request"
        );
    }
    assert!(
        origin.requests.is_empty(),
        "the client must not bypass HTTP_PROXY"
    );
    assert!(proxy.errors.is_empty());
}

#[test]
fn unusable_proxy_takes_precedence_over_certificate_error() {
    const TEST: &str =
        "index::embeddings::download::tls_tests::unusable_proxy_takes_precedence_over_certificate_error";
    if !is_child(TEST) {
        in_child(TEST, &[("HTTPS_PROXY", "https://proxy.invalid:443")]);
        return;
    }
    let cache = tempfile::tempdir().unwrap();
    let marker = cache
        .path()
        .join(super::super::repo_dir_name(crate::DEFAULT_MODEL))
        .join("cache-marker");
    std::fs::create_dir_all(marker.parent().unwrap()).unwrap();
    std::fs::write(&marker, b"preserve proxy failure").unwrap();
    let server = Server::start(true, model_response);
    let client = Client::with_config(
        cache.path(),
        &server.endpoint(true),
        chan_tls::client_config().unwrap(),
    );
    let result =
        super::super::Embedder::open_with_client(crate::DEFAULT_MODEL, cache.path(), &client);
    let observed = server.finish();
    assert!(
        marker.is_file(),
        "proxy configuration failure must preserve the model cache"
    );
    assert_eq!(std::fs::read(&marker).unwrap(), b"preserve proxy failure");
    assert_eq!(
        observed.accepted, 1,
        "the unusable proxy falls through to the TLS endpoint"
    );
    assert!(
        observed.requests.is_empty(),
        "untrusted TLS carries no HTTP"
    );
    assert!(
        !observed.errors.is_empty(),
        "server observes the TLS refusal"
    );
    let error = result.expect_err("both proxy configuration and TLS are invalid");
    assert!(
        matches!(error, EmbedError::ProxyConfig { ref var, ref value }
        if var == "HTTPS_PROXY" && value == "https://proxy.invalid:443"),
        "the unusable proxy takes precedence over certificate classification: {error:?}"
    );
}
