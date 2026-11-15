use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use chan_tls::rustls;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

use super::{fetch_text, http_client_builder, with_loopback_test_base};

const CA: &[u8] = include_bytes!("testdata/ca.der");
const LEAF: &[u8] = include_bytes!("testdata/localhost.der");
const KEY: &[u8] = include_bytes!("testdata/localhost-key.pk8");
const LIMIT: Duration = Duration::from_secs(5);

fn fixture_tls() -> rustls::ClientConfig {
    let mut roots = rustls::RootCertStore::empty();
    roots.add(CertificateDer::from(CA)).unwrap();
    rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth()
}

fn trusted_builder() -> reqwest::ClientBuilder {
    http_client_builder(LIMIT, LIMIT, fixture_tls())
        .no_proxy()
        // Keep the HTTPS fixture reachable when the implementation drops the
        // supplied config, so a redirect refusal cannot be a TLS setup error.
        .add_root_certificate(reqwest::Certificate::from_der(CA).unwrap())
}

fn response(body: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn redirect(location: &str) -> String {
    format!(
        "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )
}

struct Server {
    addr: SocketAddr,
    requests: Arc<Mutex<Vec<String>>>,
    stopped: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Server {
    fn start(tls: bool, answer: impl Fn(&str) -> String + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&requests);
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = Arc::clone(&stopped);
        let config = tls.then(|| {
            let mut config = rustls::ServerConfig::builder_with_provider(Arc::new(
                rustls::crypto::ring::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(LEAF)],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(KEY.to_vec())),
            )
            .unwrap();
            config.alpn_protocols = vec![b"http/1.1".to_vec()];
            Arc::new(config)
        });
        let thread = std::thread::spawn(move || {
            let until = Instant::now() + LIMIT * 2;
            while !stop.load(Ordering::Acquire) && Instant::now() < until {
                let (mut socket, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(1));
                        continue;
                    }
                    Err(_) => break,
                };
                socket.set_nonblocking(false).unwrap();
                socket.set_read_timeout(Some(LIMIT)).unwrap();
                socket.set_write_timeout(Some(LIMIT)).unwrap();
                if let Some(config) = &config {
                    let session = rustls::ServerConnection::new(Arc::clone(config)).unwrap();
                    let mut stream = rustls::StreamOwned::new(session, socket);
                    let _ = serve(&mut stream, &seen, &answer);
                } else {
                    let _ = serve(&mut socket, &seen, &answer);
                }
            }
        });
        Self {
            addr,
            requests,
            stopped,
            thread: Some(thread),
        }
    }

    fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn serve(
    stream: &mut (impl Read + Write),
    seen: &Mutex<Vec<String>>,
    answer: &impl Fn(&str) -> String,
) -> std::io::Result<()> {
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() >= 8192 {
            return Err(std::io::Error::other("oversized test request"));
        }
        let mut byte = [0];
        stream.read_exact(&mut byte)?;
        head.push(byte[0]);
    }
    let request = String::from_utf8_lossy(&head)
        .lines()
        .next()
        .unwrap()
        .to_owned();
    seen.lock().unwrap().push(request.clone());
    stream.write_all(answer(&request).as_bytes())?;
    stream.flush()
}

#[tokio::test]
async fn updater_uses_the_given_tls_config_and_offers_http1() {
    let (tls, handshakes) = chan_tls::testing::recording(chan_tls::client_config().unwrap());
    let sink = chan_tls::testing::Sink::start();
    let client = http_client_builder(LIMIT, LIMIT, tls)
        .no_proxy()
        .build()
        .unwrap();
    let result = client
        .get(format!("https://{}/dl/cli/latest.json", sink.addr))
        .send()
        .await;
    assert!(result.is_err(), "the sink never completes TLS");
    assert_eq!(
        handshakes.server_names(),
        ["127.0.0.1"],
        "the updater must start TLS with the supplied shared config"
    );
    assert_eq!(
        sink.alpn_offers(),
        [["http/1.1"]],
        "the updater must offer HTTP/1.1 on the wire"
    );
}

async fn assert_plaintext_redirect_refused(path: &str) {
    let plaintext = Server::start(false, |_| response("unprotected"));
    let location = format!("http://{}{path}", plaintext.addr);
    let source = Server::start(true, move |_| redirect(&location));
    let client = trusted_builder().build().unwrap();
    let result = client
        .get(format!("https://{}{path}", source.addr))
        .send()
        .await;
    assert_eq!(
        source.requests(),
        [format!("GET {path} HTTP/1.1")],
        "the HTTPS source must answer before judging the redirect"
    );
    assert!(
        plaintext.requests().is_empty(),
        "the updater must not send a plaintext request for {path}"
    );
    let error = result.expect_err("an HTTPS to HTTP redirect must be refused");
    assert!(
        error.is_redirect(),
        "the refusal must name the redirect: {error:?}"
    );
}

#[tokio::test]
async fn metadata_redirect_refuses_plaintext() {
    assert_plaintext_redirect_refused("/dl/cli/latest.json").await;
}

#[tokio::test]
async fn shared_client_refuses_plaintext_redirect_for_archive_path() {
    assert_plaintext_redirect_refused("/chan.tar.gz").await;
}

#[tokio::test]
async fn updater_keeps_verified_https_redirects() {
    let destination = Server::start(true, |_| response("verified"));
    let location = format!("https://{}/archive", destination.addr);
    let source = Server::start(true, move |_| redirect(&location));
    let text = fetch_text(
        &trusted_builder().build().unwrap(),
        &format!("https://{}/metadata", source.addr),
    )
    .await
    .unwrap();
    assert_eq!(text, "verified");
    assert_eq!(source.requests(), ["GET /metadata HTTP/1.1"]);
    assert_eq!(destination.requests(), ["GET /archive HTTP/1.1"]);
}

#[tokio::test]
async fn certificate_refusal_survives_the_metadata_error_chain() {
    let source = Server::start(true, |_| response("must not be read"));
    let client = http_client_builder(LIMIT, LIMIT, chan_tls::client_config().unwrap())
        .no_proxy()
        .build()
        .unwrap();
    let error = fetch_text(&client, &format!("https://{}/metadata", source.addr))
        .await
        .expect_err("the fixture CA is absent from system and bundled stores");
    let chain = format!("{error:#}");
    assert!(
        chain.contains("GET https://"),
        "missing operation context: {chain}"
    );
    assert!(
        chain.to_ascii_lowercase().contains("certificate"),
        "the error chain must name the certificate refusal: {chain}"
    );
    assert!(
        error.chain().count() > 2,
        "the TLS cause must be retained: {chain}"
    );
    assert!(
        source.requests().is_empty(),
        "untrusted TLS must not carry HTTP"
    );
}

#[tokio::test]
async fn compiled_loopback_base_keeps_requests_and_same_origin_redirects() {
    let source = Server::start(false, |request| {
        if request == "GET /dl/cli/latest.json HTTP/1.1" {
            redirect("/dl/cli/v1.0.0.json")
        } else {
            response("loopback")
        }
    });
    let base = format!("http://{}/dl/cli", source.addr);
    let client = with_loopback_test_base(trusted_builder(), &base)
        .unwrap()
        .build()
        .unwrap();
    let text = client
        .get(format!("{base}/latest.json"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(text, "loopback");
    assert_eq!(
        source.requests(),
        [
            "GET /dl/cli/latest.json HTTP/1.1",
            "GET /dl/cli/v1.0.0.json HTTP/1.1"
        ]
    );
}

#[tokio::test]
async fn compiled_loopback_base_refuses_redirects_to_another_origin() {
    let destination = Server::start(false, |_| response("wrong origin"));
    let location = format!("http://{}/archive", destination.addr);
    let source = Server::start(false, move |_| redirect(&location));
    let base = format!("http://{}/dl/cli", source.addr);
    let client = with_loopback_test_base(trusted_builder(), &base)
        .unwrap()
        .build()
        .unwrap();
    let result = client.get(format!("{base}/latest.json")).send().await;
    assert_eq!(source.requests(), ["GET /dl/cli/latest.json HTTP/1.1"]);
    assert!(
        destination.requests().is_empty(),
        "test-origin authority must not escape"
    );
    assert!(result.unwrap_err().is_redirect());
}

#[tokio::test]
async fn compiled_loopback_base_keeps_the_ten_redirect_limit() {
    let source = Server::start(false, |_| redirect("/dl/cli/latest.json"));
    let base = format!("http://{}/dl/cli", source.addr);
    let client = with_loopback_test_base(trusted_builder(), &base)
        .unwrap()
        .build()
        .unwrap();
    let error = client
        .get(format!("{base}/latest.json"))
        .send()
        .await
        .expect_err("an endless same-origin redirect must stop");
    assert!(
        error.is_redirect(),
        "the limit must refuse the redirect: {error:?}"
    );
    assert_eq!(
        source.requests().len(),
        11,
        "the loopback client keeps reqwest's default redirect bound"
    );
}

#[tokio::test]
async fn compiled_loopback_base_cannot_receive_an_https_downgrade() {
    let plaintext = Server::start(false, |_| response("must not receive a downgrade"));
    let base = format!("http://{}/dl/cli", plaintext.addr);
    let location = format!("{base}/latest.json");
    let source = Server::start(true, move |_| redirect(&location));
    let client = with_loopback_test_base(trusted_builder(), &base)
        .unwrap()
        .build()
        .unwrap();
    let result = client
        .get(format!("https://{}/metadata", source.addr))
        .send()
        .await;
    assert_eq!(source.requests(), ["GET /metadata HTTP/1.1"]);
    assert!(
        plaintext.requests().is_empty(),
        "the compiled test origin must not receive an HTTPS downgrade"
    );
    assert!(result.unwrap_err().is_redirect());
}

#[test]
fn compiled_test_base_requires_loopback_http() {
    for base in [
        "http://example.com/dl/cli",
        "https://127.0.0.1:43191/dl/cli",
        "file:///tmp/dl/cli",
        "not a URL",
    ] {
        assert!(
            with_loopback_test_base(trusted_builder(), base).is_err(),
            "invalid compiled loopback base must be refused: {base}"
        );
    }
}
