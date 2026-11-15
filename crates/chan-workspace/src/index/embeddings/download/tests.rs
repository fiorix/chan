use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, TcpListener};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use chan_tls::testing::{recording, Sink};

use super::*;

const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";
const ETAG: &str = "abcdef0123456789abcdef0123456789abcdef01";
const BODY: &[u8] = b"{\"fixture\":true}\n";

pub(super) struct Server {
    pub(super) endpoint: String,
    pub(super) requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Server {
    pub(super) fn start(handler: impl Fn(&str) -> Vec<u8> + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&requests);
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = Arc::clone(&stop);
        let handler = Arc::new(handler);
        let worker = std::thread::spawn(move || {
            let mut connections = Vec::new();
            while !stopped.load(Ordering::Relaxed) {
                let (mut stream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(e) => panic!("fixture accept: {e}"),
                };
                let seen = Arc::clone(&seen);
                let handler = Arc::clone(&handler);
                connections.push(std::thread::spawn(move || {
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    stream
                        .set_write_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut reader = BufReader::new(&mut stream);
                    let mut request = String::new();
                    loop {
                        let mut line = String::new();
                        let read = reader.read_line(&mut line).unwrap();
                        if read == 0 || line == "\r\n" {
                            break;
                        }
                        request.push_str(&line);
                    }
                    seen.lock().unwrap().push(request.clone());
                    let response = handler(&request);
                    stream.write_all(&response).unwrap();
                }));
            }
            for connection in connections {
                connection.join().unwrap();
            }
        });
        Self {
            endpoint,
            requests,
            stop,
            worker: Some(worker),
        }
    }
}

fn requested_range(request: &str) -> &str {
    request
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case("range").then(|| value.trim())
        })
        .unwrap_or("")
}

fn bytes_response(start: usize) -> Vec<u8> {
    response(
        "206 Partial Content",
        &format!(
            "Content-Range: bytes {start}-{}/{}\r\nx-repo-commit: {COMMIT}\r\netag: \"{ETAG}\"\r\n",
            BODY.len() - 1,
            BODY.len()
        ),
        &BODY[start..],
    )
}

fn metadata_response() -> Vec<u8> {
    response(
        "206 Partial Content",
        &format!(
            "Content-Range: bytes 0-0/{}\r\nx-repo-commit: {COMMIT}\r\netag: \"{ETAG}\"\r\n",
            BODY.len()
        ),
        &BODY[..1],
    )
}

fn part_file(cache: &Path, bytes: &[u8]) -> PathBuf {
    let blobs = cache
        .join(super::super::repo_dir_name("fixture/model"))
        .join("blobs");
    std::fs::create_dir_all(&blobs).unwrap();
    let path = blobs.join(ETAG).with_extension("part");
    std::fs::write(&path, bytes).unwrap();
    path
}

#[test]
fn partial_file_supports_resume_and_restart_writes() {
    let cache = tempfile::tempdir().unwrap();
    let partial = part_file(cache.path(), b"stale");
    let mut file = open_part(&partial).unwrap();
    file.write_all(b"-suffix").unwrap();
    assert_eq!(
        std::fs::read(&partial).unwrap(),
        b"stale-suffix",
        "opening a partial must retain its prefix and position writes at its end"
    );

    file.rewind().unwrap();
    file.write_all(b"fresh").unwrap();
    assert_eq!(
        std::fs::read(&partial).unwrap(),
        b"fresh-suffix",
        "restart writes must honor the cursor instead of an append-only handle"
    );
    file.set_len(5)
        .expect("the partial handle must permit truncation on every platform");
    drop(file);
    assert_eq!(std::fs::read(partial).unwrap(), b"fresh");
}

#[test]
fn partial_download_resumes_and_publishes_exact_bytes() {
    let cache = tempfile::tempdir().unwrap();
    let partial = part_file(cache.path(), &BODY[..3]);
    let server = Server::start(|request| match requested_range(request) {
        "bytes=0-0" => metadata_response(),
        "bytes=3-" => bytes_response(3),
        _ => response("400 Bad Request", "", b"unexpected resume range"),
    });
    let client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    );
    let path = client.get("fixture/model", "config.json").unwrap();
    assert_eq!(
        std::fs::read(&path).unwrap(),
        BODY,
        "resume preserves the prefix exactly once"
    );
    assert!(!partial.exists(), "successful temporary is consumed");
    assert_eq!(server.requests.lock().unwrap().len(), 2);
    assert_eq!(
        Some(path),
        hf_hub::Cache::new(cache.path().to_owned())
            .model("fixture/model".into())
            .get("config.json")
    );
}

#[test]
fn ignored_resume_range_restarts_from_full_response() {
    let cache = tempfile::tempdir().unwrap();
    let partial = part_file(cache.path(), &BODY[..3]);
    let server = Server::start(|request| {
        if requested_range(request) == "bytes=0-0" {
            metadata_response()
        } else {
            response("200 OK", "", BODY)
        }
    });
    let client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    );
    let path = client
        .get("fixture/model", "config.json")
        .expect("an ignored resume range must restart from its full response");
    assert_eq!(
        std::fs::read(&path).unwrap(),
        BODY,
        "the full response replaces the partial prefix"
    );
    assert!(
        !partial.exists(),
        "the restarted download consumes its part"
    );
    assert_eq!(
        server.requests.lock().unwrap().len(),
        2,
        "the full response is consumed without another request"
    );
    assert_eq!(
        Some(path),
        hf_hub::Cache::new(cache.path().to_owned())
            .model("fixture/model".into())
            .get("config.json")
    );
}

#[test]
fn mismatched_resume_range_never_appends_bytes() {
    let cache = tempfile::tempdir().unwrap();
    let partial = part_file(cache.path(), &BODY[..3]);
    let server = Server::start(|request| {
        if requested_range(request) == "bytes=0-0" {
            metadata_response()
        } else {
            bytes_response(0)
        }
    });
    let client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    );
    assert!(
        client.get("fixture/model", "config.json").is_err(),
        "incorrect Content-Range must refuse resume"
    );
    assert_eq!(std::fs::read(partial).unwrap(), &BODY[..3]);
}

#[test]
fn two_downloads_of_the_same_blob_publish_once() {
    let cache = tempfile::tempdir().unwrap();
    let metadata_requests = Arc::new(AtomicUsize::new(0));
    let payload_requests = Arc::new(AtomicUsize::new(0));
    let metadata_seen = Arc::clone(&metadata_requests);
    let payload_seen = Arc::clone(&payload_requests);
    let server = Server::start(move |request| {
        if requested_range(request) == "bytes=0-0" {
            metadata_seen.fetch_add(1, Ordering::SeqCst);
            let deadline = Instant::now() + Duration::from_secs(5);
            while metadata_seen.load(Ordering::SeqCst) < 2 {
                if Instant::now() >= deadline {
                    return response(
                        "503 Service Unavailable",
                        "",
                        b"second downloader missed metadata rendezvous",
                    );
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            metadata_response()
        } else {
            payload_seen.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(100));
            bytes_response(0)
        }
    });
    let client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    );
    std::thread::scope(|scope| {
        let first = scope.spawn(|| client.get("fixture/model", "config.json"));
        let second = scope.spawn(|| client.get("fixture/model", "config.json"));
        let first = first.join().unwrap().unwrap();
        let second = second.join().unwrap().unwrap();
        assert_eq!(first, second);
        assert_eq!(std::fs::read(first).unwrap(), BODY);
    });
    assert_eq!(metadata_requests.load(Ordering::SeqCst), 2);
    assert_eq!(
        payload_requests.load(Ordering::SeqCst),
        1,
        "a contender reuses the blob published under the lock"
    );
}

#[test]
fn the_blob_lock_covers_snapshot_and_reference_publication() {
    let cache = tempfile::tempdir().unwrap();
    let blob = cache
        .path()
        .join(super::super::repo_dir_name("fixture/model"))
        .join("blobs")
        .join(ETAG);
    let server = Server::start(|request| match requested_range(request) {
        "bytes=0-0" => metadata_response(),
        "bytes=0-" => bytes_response(0),
        _ => response("400 Bad Request", "", b"unexpected publication range"),
    });
    let observations = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&observations);
    let expected_blob = blob.clone();
    let mut client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    );
    client.publication_observer = Some(Box::new(move |blob| {
        assert_eq!(blob, expected_blob);
        let contender = OpenOptions::new()
            .write(true)
            .open(blob.with_extension("lock"))
            .expect("publication must retain the existing blob lock file");
        let contention = FileExt::try_lock_exclusive(&contender).expect_err(
            "the blob lock must remain held through snapshot and reference publication",
        );
        assert_eq!(
            contention.kind(),
            fs4::lock_contended_error().kind(),
            "publication must exclude another lock holder, not fail to open its lock"
        );
        observed.fetch_add(1, Ordering::SeqCst);
    }));

    let path = client
        .get("fixture/model", "config.json")
        .expect("a locked download must publish its snapshot and reference");
    assert_eq!(
        observations.load(Ordering::SeqCst),
        2,
        "the lock must be observed before snapshot publication and after reference publication"
    );
    assert_eq!(std::fs::read(&path).unwrap(), BODY);
    assert_eq!(
        hf_hub::Cache::new(cache.path().to_owned())
            .model("fixture/model".into())
            .get("config.json"),
        Some(path),
        "the locked publication must be readable through hf-hub"
    );
    assert_eq!(server.requests.lock().unwrap().len(), 2);
    let contender = OpenOptions::new()
        .write(true)
        .open(blob.with_extension("lock"))
        .unwrap();
    FileExt::try_lock_exclusive(&contender)
        .expect("the blob lock must be released when the completed download returns");
    FileExt::unlock(&contender).unwrap();
}

#[test]
fn a_cached_model_opens_and_embeds_with_its_existing_files() {
    let cache = tempfile::tempdir().unwrap();
    crate::index::test_support::seed_embedding_model(cache.path());
    let server = Server::start(|_| {
        response(
            "503 Service Unavailable",
            "",
            b"unexpected cached-model request",
        )
    });
    let (config, handshakes) = recording(chan_tls::client_config().unwrap());
    let client = Client::with_config(cache.path(), &server.endpoint, config);
    for filename in ["config.json", "tokenizer.json", "model.safetensors"] {
        let path = client.get(crate::DEFAULT_MODEL, filename).unwrap();
        assert!(path.starts_with(cache.path()));
    }
    let model =
        super::super::Embedder::open_with_client(crate::DEFAULT_MODEL, cache.path(), &client)
            .unwrap();
    let rows = model.embed_documents(&["cache hit"]).unwrap();
    assert_eq!(rows[0].len(), 4);
    assert!(rows[0].iter().all(|value| value.is_finite()));
    assert!(server.requests.lock().unwrap().is_empty());
    assert!(handshakes.server_names().is_empty());
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            let joined = worker.join();
            if !std::thread::panicking() {
                joined.unwrap();
            }
        }
    }
}

fn response(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
    let mut bytes = format!(
        "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n",
        body.len()
    )
    .into_bytes();
    bytes.extend_from_slice(body);
    bytes
}

#[test]
fn metadata_uses_the_supplied_tls_configuration() {
    let cache = tempfile::tempdir().unwrap();
    let (config, handshakes) = recording(chan_tls::client_config().unwrap());
    let sink = Sink::start();
    let client = Client::with_config(cache.path(), &format!("https://{}", sink.addr), config);
    assert!(client.get("fixture/model", "config.json").is_err());
    assert_eq!(
        handshakes.server_names(),
        ["127.0.0.1"],
        "metadata must use the supplied TLS configuration"
    );
    assert_eq!(sink.alpn_offers(), [Vec::<String>::new()]);
}

#[test]
fn redirected_metadata_uses_the_payload_tls_configuration() {
    let cache = tempfile::tempdir().unwrap();
    let (config, handshakes) = recording(chan_tls::client_config().unwrap());
    let sink = Sink::start();
    let location = format!("https://{}/payload", sink.addr);
    let server = Server::start(move |_| {
        response(
            "302 Found",
            &format!(
                "Location: {location}\r\nx-repo-commit: {COMMIT}\r\nx-linked-etag: \"{ETAG}\"\r\n"
            ),
            b"",
        )
    });
    let client = Client::with_config(cache.path(), &server.endpoint, config);
    assert!(client.get("fixture/model", "config.json").is_err());
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    assert_eq!(
        handshakes.server_names(),
        ["127.0.0.1"],
        "payload agent must use the supplied TLS configuration"
    );
    assert_eq!(sink.alpn_offers(), [Vec::<String>::new()]);
}

#[test]
fn cached_file_is_read_without_a_request_and_by_hf_hub() {
    let cache = tempfile::tempdir().unwrap();
    let repo = cache
        .path()
        .join(super::super::repo_dir_name("fixture/model"));
    let snapshot = repo.join("snapshots").join(COMMIT);
    std::fs::create_dir_all(&snapshot).unwrap();
    std::fs::create_dir_all(repo.join("refs")).unwrap();
    std::fs::write(repo.join("refs/main"), COMMIT).unwrap();
    std::fs::write(snapshot.join("config.json"), BODY).unwrap();
    let server = Server::start(|_| {
        response(
            "503 Service Unavailable",
            "",
            b"unexpected cached-file request",
        )
    });
    let (config, handshakes) = recording(chan_tls::client_config().unwrap());
    let client = Client::with_config(cache.path(), &server.endpoint, config);
    let path = client
        .get("fixture/model", "config.json")
        .expect("a cached file must be returned without a metadata request");
    assert_eq!(std::fs::read(&path).unwrap(), BODY);
    assert_eq!(
        Some(path),
        hf_hub::Cache::new(cache.path().to_owned())
            .model("fixture/model".into())
            .get("config.json")
    );
    assert!(server.requests.lock().unwrap().is_empty());
    assert!(handshakes.server_names().is_empty());
}

#[test]
fn cache_reference_cannot_escape_the_snapshot_directory() {
    let cache = tempfile::tempdir().unwrap();
    let repo = cache
        .path()
        .join(super::super::repo_dir_name("fixture/model"));
    std::fs::create_dir_all(repo.join("refs")).unwrap();
    std::fs::create_dir_all(repo.join("snapshots")).unwrap();
    std::fs::create_dir_all(repo.join("escape")).unwrap();
    std::fs::write(repo.join("refs/main"), "../escape").unwrap();
    std::fs::write(repo.join("escape/config.json"), BODY).unwrap();
    let candidate = repo.join("snapshots/../escape/config.json");
    assert!(
        candidate.is_file(),
        "the unguarded traversal fixture must resolve to an existing file"
    );
    assert_eq!(std::fs::read(candidate).unwrap(), BODY);
    assert_eq!(
        cached(&repo, "config.json"),
        None,
        "a cache reference must not escape the snapshot directory"
    );
}

#[test]
fn invalid_model_and_filename_are_refused_before_any_request_or_write() {
    for (model, filename) in [
        ("../fixture", "config.json"),
        ("fixture/model", "../escape"),
    ] {
        let cache = tempfile::tempdir().unwrap();
        let server = Server::start(|_| {
            response(
                "503 Service Unavailable",
                "",
                b"invalid paths must not reach transport",
            )
        });
        let client = Client::with_config(
            cache.path(),
            &server.endpoint,
            chan_tls::client_config().unwrap(),
        );
        let error = client.get(model, filename).expect_err(
            "invalid model or filename must not resolve to a cached or downloaded file",
        );
        assert_eq!(
            error.to_string(),
            "hf-hub: invalid model cache path",
            "invalid model or filename must be refused as an invalid cache path before transport"
        );
        assert!(
            server.requests.lock().unwrap().is_empty(),
            "invalid model or filename must make no network request"
        );
        assert!(
            std::fs::read_dir(cache.path()).unwrap().next().is_none(),
            "invalid model or filename must leave the cache directory empty"
        );
    }
}

#[test]
fn existing_snapshot_bypasses_symlink_publication() {
    let cache = tempfile::tempdir().unwrap();
    let blob = cache.path().join("blobs").join(ETAG);
    let pointer = cache
        .path()
        .join("snapshots")
        .join(COMMIT)
        .join("config.json");
    std::fs::create_dir_all(blob.parent().unwrap()).unwrap();
    std::fs::create_dir_all(pointer.parent().unwrap()).unwrap();
    std::fs::write(&blob, BODY).unwrap();
    let existing = b"existing snapshot\n";
    std::fs::write(&pointer, existing).unwrap();
    let symlink_called = AtomicBool::new(false);
    publish_blob(&blob, &pointer, |_, _| {
        symlink_called.store(true, Ordering::SeqCst);
        Err(std::io::Error::other("unexpected symlink publication"))
    })
    .expect("an existing snapshot must bypass symlink publication");
    assert!(
        !symlink_called.load(Ordering::SeqCst),
        "an existing snapshot must not invoke the symlink callback"
    );
    assert_eq!(
        std::fs::read(&pointer).unwrap(),
        existing,
        "an existing snapshot must retain its bytes"
    );
    assert_eq!(
        std::fs::read(&blob).unwrap(),
        BODY,
        "an existing snapshot must leave the separate blob intact"
    );
}

#[test]
fn symlink_refusal_renames_into_a_cache_hf_hub_can_read() {
    assert_symlink_fallback(std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        "synthetic symlink privilege refusal",
    ));
}

#[test]
fn unsupported_symlink_renames_into_a_cache_hf_hub_can_read() {
    assert_symlink_fallback(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "synthetic filesystem without symlinks",
    ));
}

#[cfg(windows)]
#[test]
fn missing_symlink_privilege_renames_into_a_cache_hf_hub_can_read() {
    assert_symlink_fallback(std::io::Error::from_raw_os_error(
        windows_sys::Win32::Foundation::ERROR_PRIVILEGE_NOT_HELD as i32,
    ));
}

fn assert_symlink_fallback(error: std::io::Error) {
    let cache = tempfile::tempdir().unwrap();
    let repo = cache
        .path()
        .join(super::super::repo_dir_name("fixture/model"));
    let blob = repo.join("blobs").join(ETAG);
    let pointer = repo.join("snapshots").join(COMMIT).join("config.json");
    std::fs::create_dir_all(blob.parent().unwrap()).unwrap();
    std::fs::create_dir_all(pointer.parent().unwrap()).unwrap();
    std::fs::write(&blob, BODY).unwrap();
    publish_blob(&blob, &pointer, |source, destination| {
        assert_eq!(
            source,
            Path::new("../../blobs").join(ETAG),
            "snapshot links must resolve to the cache blob two directories above"
        );
        assert_eq!(destination, pointer);
        Err(error)
    })
    .expect("unavailable symlinks must publish through the rename fallback");
    publish_ref(&repo, COMMIT).unwrap();
    assert_eq!(std::fs::read(&pointer).unwrap(), BODY);
    assert!(!blob.exists(), "refused symlink uses the rename fallback");
    assert!(!std::fs::symlink_metadata(&pointer)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        Some(pointer),
        hf_hub::Cache::new(cache.path().to_owned())
            .model("fixture/model".into())
            .get("config.json"),
        "hf-hub must resolve the published reference to the snapshot file"
    );
}

#[test]
fn publication_failure_does_not_move_the_blob() {
    let cache = tempfile::tempdir().unwrap();
    let blob = cache.path().join(ETAG);
    let pointer = cache.path().join("config.json");
    std::fs::write(&blob, BODY).unwrap();
    let error = publish_blob(&blob, &pointer, |_, _| {
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "synthetic missing parent",
        ))
    })
    .expect_err("unrelated symlink failures must be returned without renaming the blob");
    assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    assert_eq!(std::fs::read(blob).unwrap(), BODY);
    assert!(!pointer.exists());
}

#[test]
fn metadata_cannot_escape_the_cache_with_identifiers() {
    for (name, value) in [("etag", "../escape"), ("x-repo-commit", "..")] {
        let cache = tempfile::tempdir().unwrap();
        let server = Server::start(move |_| {
            let etag = if name == "etag" { value } else { ETAG };
            let commit = if name == "x-repo-commit" {
                value
            } else {
                COMMIT
            };
            response(
                "206 Partial Content",
                &format!(
                    "Content-Range: bytes 0-0/{}\r\nx-repo-commit: {commit}\r\netag: {etag}\r\n",
                    BODY.len()
                ),
                &BODY[..1],
            )
        });
        let client = Client::with_config(
            cache.path(),
            &server.endpoint,
            chan_tls::client_config().unwrap(),
        );
        assert!(
            client.get("fixture/model", "config.json").is_err(),
            "unsafe {name} refused: {value}"
        );
        assert_eq!(
            server.requests.lock().unwrap().len(),
            1,
            "path refusal precedes payload fetch"
        );
        assert_eq!(
            std::fs::read_dir(cache.path()).unwrap().count(),
            0,
            "path refusal precedes cache writes"
        );
    }
}

#[test]
fn a_relative_metadata_redirect_cycle_is_bounded() {
    let cache = tempfile::tempdir().unwrap();
    let server = Server::start(|_| response("302 Found", "Location: /cycle\r\n", b""));
    let client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    );
    let error = client.get("fixture/model", "config.json").unwrap_err();
    assert!(
        error.to_string().contains("too many relative redirects"),
        "{error}"
    );
    assert_eq!(
        server.requests.lock().unwrap().len(),
        6,
        "five relative redirects are followed"
    );
}

#[test]
fn completed_part_publishes_without_an_invalid_end_range_request() {
    let cache = tempfile::tempdir().unwrap();
    part_file(cache.path(), BODY);
    let server = Server::start(|request| {
        if requested_range(request) == "bytes=0-0" {
            metadata_response()
        } else {
            response("400 Bad Request", "", b"complete part requested a payload")
        }
    });
    let client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    );
    let path = client
        .get("fixture/model", "config.json")
        .expect("a complete part must publish without an end-of-file payload request");
    assert_eq!(std::fs::read(path).unwrap(), BODY);
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}

#[test]
fn oversized_part_restarts_and_publishes_exact_bytes() {
    let cache = tempfile::tempdir().unwrap();
    let oversized = [BODY, b"extra"].concat();
    let part = part_file(cache.path(), &oversized);
    let server = Server::start(|request| match requested_range(request) {
        "bytes=0-0" => metadata_response(),
        "bytes=0-" => bytes_response(0),
        _ => response(
            "400 Bad Request",
            "",
            b"oversized part must restart at zero",
        ),
    });
    let client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    );
    let path = client
        .get("fixture/model", "config.json")
        .expect("an oversized part must restart from zero in the same call");
    assert_eq!(
        std::fs::read(path).unwrap(),
        BODY,
        "the oversized prefix must be discarded"
    );
    assert!(!part.exists());
    assert_eq!(
        server.requests.lock().unwrap().len(),
        2,
        "an oversized part needs metadata and one fresh payload"
    );
}

#[test]
fn a_short_transfer_stays_partial_and_resumes_on_the_next_attempt() {
    let cache = tempfile::tempdir().unwrap();
    let payloads = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&payloads);
    let server = Server::start(move |request| match requested_range(request) {
        "bytes=0-0" => metadata_response(),
        "bytes=0-" => {
            seen.fetch_add(1, Ordering::SeqCst);
            let mut response = format!("HTTP/1.1 206 Partial Content\r\nConnection: close\r\nContent-Range: bytes 0-{}/{}\r\n\r\n", BODY.len() - 1, BODY.len()).into_bytes();
            response.extend_from_slice(&BODY[..4]);
            response
        }
        "bytes=4-" => {
            seen.fetch_add(1, Ordering::SeqCst);
            bytes_response(4)
        }
        _ => response("400 Bad Request", "", b"unexpected recovery range"),
    });
    let client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    );
    let error = client
        .get("fixture/model", "config.json")
        .expect_err("short response must not publish a snapshot");
    assert!(error.to_string().contains("advertised size"), "{error}");
    let repo = cache
        .path()
        .join(super::super::repo_dir_name("fixture/model"));
    assert_eq!(
        std::fs::read(repo.join("blobs").join(ETAG).with_extension("part")).unwrap(),
        &BODY[..4]
    );
    assert!(!repo.join("refs/main").exists());
    let path = client.get("fixture/model", "config.json").unwrap();
    assert_eq!(std::fs::read(path).unwrap(), BODY);
    assert_eq!(payloads.load(Ordering::SeqCst), 2);
}

#[test]
fn excess_body_bytes_preserve_the_original_partial() {
    let cache = tempfile::tempdir().unwrap();
    let part = part_file(cache.path(), &BODY[..3]);
    let server = Server::start(|request| {
        if requested_range(request) == "bytes=0-0" {
            return metadata_response();
        }
        let mut response = format!("HTTP/1.1 206 Partial Content\r\nConnection: close\r\nContent-Range: bytes 3-{}/{}\r\n\r\n", BODY.len() - 1, BODY.len()).into_bytes();
        response.extend_from_slice(&BODY[3..]);
        response.extend_from_slice(b"extra");
        response
    });
    let client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    );
    assert!(
        client.get("fixture/model", "config.json").is_err(),
        "excess body must not publish a snapshot"
    );
    assert_eq!(
        std::fs::read(part).unwrap(),
        &BODY[..3],
        "excess body rolls back to the original partial"
    );
}

#[test]
fn embedder_transport_failure_preserves_another_downloaders_cache() {
    let cache = tempfile::tempdir().unwrap();
    let repo = cache
        .path()
        .join(super::super::repo_dir_name(crate::DEFAULT_MODEL));
    std::fs::create_dir_all(repo.join("blobs")).unwrap();
    let part = repo.join("blobs/other-download.part");
    let lock = repo.join("blobs/other-download.lock");
    std::fs::write(&part, b"other downloader's partial bytes").unwrap();
    std::fs::write(&lock, b"").unwrap();
    let server = Server::start(|_| {
        response(
            "503 Service Unavailable",
            "",
            b"synthetic temporary refusal",
        )
    });
    let client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    );
    let error =
        super::super::Embedder::open_with_client(crate::DEFAULT_MODEL, cache.path(), &client)
            .expect_err("the transport fails");
    assert!(matches!(error, EmbedError::HfHub(_)));
    assert!(
        part.exists(),
        "a transport failure must preserve another downloader's partial file"
    );
    assert_eq!(
        std::fs::read(part).unwrap(),
        b"other downloader's partial bytes"
    );
    assert!(
        lock.exists(),
        "a transport failure must not unlink another downloader's lock inode"
    );
    assert_eq!(
        server.requests.lock().unwrap().len(),
        1,
        "transport failures do not wipe and retry"
    );
}

#[test]
fn embedder_lock_timeout_keeps_the_active_lock_and_partial() {
    let cache = tempfile::tempdir().unwrap();
    let repo = cache
        .path()
        .join(super::super::repo_dir_name(crate::DEFAULT_MODEL));
    let blobs = repo.join("blobs");
    std::fs::create_dir_all(&blobs).unwrap();
    let partial = blobs.join(ETAG).with_extension("part");
    let lock_path = blobs.join(ETAG).with_extension("lock");
    std::fs::write(&partial, &BODY[..3]).unwrap();
    let holder = std::fs::File::create(&lock_path).unwrap();
    fs4::fs_std::FileExt::try_lock_exclusive(&holder).unwrap();
    let server = Server::start(|_| metadata_response());
    let client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    );
    let error =
        super::super::Embedder::open_with_client(crate::DEFAULT_MODEL, cache.path(), &client)
            .expect_err("another download holds the blob lock");
    assert!(
        lock_path.is_file(),
        "a lock timeout preserves the held lock path"
    );
    let contender = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&lock_path)
        .unwrap();
    let contention = fs4::fs_std::FileExt::try_lock_exclusive(&contender)
        .expect_err("the cache lock path must still name the active downloader's lock");
    assert_eq!(contention.kind(), fs4::lock_contended_error().kind());
    fs4::fs_std::FileExt::unlock(&holder).unwrap();
    assert!(
        partial.exists(),
        "a lock timeout must preserve the active downloader's partial"
    );
    assert_eq!(std::fs::read(partial).unwrap(), &BODY[..3]);
    assert!(
        error.to_string().contains("Lock acquisition failed"),
        "the lock error is retained: {error}"
    );
    assert_eq!(
        server.requests.lock().unwrap().len(),
        1,
        "a lock timeout never retries under a different inode"
    );
}

#[test]
fn embedder_interrupted_payload_keeps_the_resumable_part() {
    let cache = tempfile::tempdir().unwrap();
    let repo = cache
        .path()
        .join(super::super::repo_dir_name(crate::DEFAULT_MODEL));
    std::fs::create_dir_all(&repo).unwrap();
    let marker = repo.join("existing-cache-marker");
    std::fs::write(&marker, b"keep").unwrap();
    let server = Server::start(|request| {
        if requested_range(request) == "bytes=0-0" {
            return metadata_response();
        }
        let mut response = format!("HTTP/1.1 206 Partial Content\r\nConnection: close\r\nContent-Range: bytes 0-{}/{}\r\n\r\n", BODY.len() - 1, BODY.len()).into_bytes();
        response.extend_from_slice(&BODY[..4]);
        response
    });
    let client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    );
    let error =
        super::super::Embedder::open_with_client(crate::DEFAULT_MODEL, cache.path(), &client)
            .expect_err("the payload ends early");
    assert!(error.to_string().contains("advertised size"), "{error}");
    assert!(
        marker.exists(),
        "an interrupted payload must preserve the existing model cache"
    );
    assert_eq!(
        std::fs::read(repo.join("blobs").join(ETAG).with_extension("part")).unwrap(),
        &BODY[..4]
    );
    assert_eq!(
        server.requests.lock().unwrap().len(),
        2,
        "the wrapper preserves partial progress instead of wiping and retrying"
    );
}

#[test]
fn cache_identifiers_refuse_paths_and_empty_values() {
    for value in [
        "",
        ".",
        "..",
        "../escape",
        "/absolute",
        "C:\\outside",
        "a/b",
        "a\\b",
    ] {
        assert!(!identifier(value), "unsafe identifier accepted: {value:?}");
    }
    for value in [COMMIT, ETAG, "test-model", "model_1"] {
        assert!(identifier(value), "valid identifier refused: {value:?}");
    }
}

fn parsed_response(status: &str, headers: &str) -> Response {
    format!("HTTP/1.1 {status}\r\n{headers}\r\n")
        .parse()
        .unwrap()
}

#[test]
fn resume_status_guard_is_independent_of_body_length() {
    let response = parsed_response("200 OK", "Content-Length: 7\r\n");
    assert!(
        matches!(
            validate_resume(&response, 3, 10),
            Err(DownloadError::InvalidResume)
        ),
        "a 200 response cannot append to a nonempty part even when its length fits"
    );
    let response = parsed_response("200 OK", "Content-Length: 10\r\n");
    validate_resume(&response, 0, 10).unwrap();
}

#[test]
fn resume_range_guard_is_independent_of_body_length() {
    let response = parsed_response(
        "206 Partial Content",
        "Content-Range: bytes 0-6/10\r\nContent-Length: 7\r\n",
    );
    assert!(
        matches!(
            validate_resume(&response, 3, 10),
            Err(DownloadError::InvalidResume)
        ),
        "a wrong range is refused even when Content-Length matches remaining bytes"
    );
    let response = parsed_response(
        "206 Partial Content",
        "Content-Range: bytes 3-9/10\r\nContent-Length: 7\r\n",
    );
    validate_resume(&response, 3, 10).unwrap();
}

#[test]
fn resume_length_guard_is_independent_of_range() {
    for length in ["6", "8", "not-a-size"] {
        let response = parsed_response(
            "206 Partial Content",
            &format!("Content-Range: bytes 3-9/10\r\nContent-Length: {length}\r\n"),
        );
        assert!(
            matches!(
                validate_resume(&response, 3, 10),
                Err(DownloadError::InvalidResume)
            ),
            "a wrong length is refused even when the range matches: {length}"
        );
    }
    let response = parsed_response("206 Partial Content", "Content-Range: bytes 3-9/10\r\n");
    validate_resume(&response, 3, 10).unwrap();
}

fn recovers_corrupt_cached_file(filename: &str, corrupt: &[u8]) {
    recovers_corrupt_cached_file_with(filename, |_| corrupt.to_vec(), false);
}

fn model_file_server(files: std::collections::HashMap<String, Vec<u8>>) -> Server {
    Server::start(move |request| {
        let filename = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|path| path.rsplit('/').next())
            .unwrap_or("");
        let Some(bytes) = files.get(filename) else {
            return response("404 Not Found", "", b"unexpected model file");
        };
        let (last, body) = match requested_range(request) {
            "bytes=0-0" => (0, &bytes[..1]),
            "bytes=0-" => (bytes.len() - 1, bytes.as_slice()),
            _ => return response("400 Bad Request", "", b"unexpected model range"),
        };
        response(
            "206 Partial Content",
            &format!(
                "Content-Range: bytes 0-{last}/{}\r\nx-repo-commit: {COMMIT}\r\netag: recovered-{}\r\n",
                bytes.len(), filename.replace('.', "-")
            ),
            body,
        )
    })
}

#[cfg(unix)]
fn missing_model_file_preserves_cache(filename: &str) {
    use std::os::unix::fs::MetadataExt;

    let cache = tempfile::tempdir().unwrap();
    crate::index::test_support::seed_embedding_model(cache.path());
    let repo = cache
        .path()
        .join(super::super::repo_dir_name(crate::DEFAULT_MODEL));
    let snapshot = repo.join("snapshots/test-model");
    let files: std::collections::HashMap<String, Vec<u8>> =
        ["config.json", "tokenizer.json", "model.safetensors"]
            .into_iter()
            .map(|name| (name.to_owned(), std::fs::read(snapshot.join(name)).unwrap()))
            .collect();
    std::fs::remove_file(snapshot.join("model.safetensors")).unwrap();

    let marker = repo.join("existing-cache-marker");
    std::fs::write(&marker, b"keep existing model cache").unwrap();
    let blobs = repo.join("blobs");
    std::fs::create_dir_all(&blobs).unwrap();
    let partial = blobs.join("other-download.part");
    std::fs::write(&partial, b"another downloader's resumable bytes").unwrap();
    let lock_path = blobs.join("other-download.lock");
    let holder = File::create(&lock_path).unwrap();
    FileExt::try_lock_exclusive(&holder).unwrap();
    let held_inode = holder.metadata().unwrap();

    let removed_path = if filename == "model.safetensors" {
        repo.join("snapshots").join(COMMIT).join(filename)
    } else {
        snapshot.join(filename)
    };
    let reference = repo.join("refs/main");
    let observations = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&observations);
    let server = model_file_server(files);
    let mut client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    );
    client.publication_observer = Some(Box::new(move |_| {
        if observed.fetch_add(1, Ordering::SeqCst) != 1 {
            return;
        }
        assert_eq!(
            std::fs::read_to_string(&reference).unwrap(),
            COMMIT,
            "the file disappears only after weights and their reference are published"
        );
        std::fs::remove_file(&removed_path).expect("the resolved model file must exist");
        assert_eq!(
            File::open(&removed_path)
                .expect_err("the resolved file must be absent before the model loader runs")
                .kind(),
            std::io::ErrorKind::NotFound
        );
    }));

    let result =
        super::super::Embedder::open_with_client(crate::DEFAULT_MODEL, cache.path(), &client);
    assert!(
        observations.load(Ordering::SeqCst) >= 2,
        "the publication hook must remove the resolved model file"
    );
    assert!(
        marker.is_file(),
        "a missing {filename} must preserve the existing model cache"
    );
    assert_eq!(std::fs::read(marker).unwrap(), b"keep existing model cache");
    assert_eq!(
        std::fs::read(partial).unwrap(),
        b"another downloader's resumable bytes",
        "a missing {filename} must preserve another downloader's partial"
    );
    let retained_inode = std::fs::metadata(&lock_path)
        .expect("a missing model file must preserve the active lock path");
    assert_eq!(
        (retained_inode.dev(), retained_inode.ino()),
        (held_inode.dev(), held_inode.ino()),
        "a missing {filename} must preserve the active downloader's lock inode"
    );
    let contender = OpenOptions::new().write(true).open(&lock_path).unwrap();
    let contention = FileExt::try_lock_exclusive(&contender)
        .expect_err("the retained lock path must still exclude another downloader");
    assert_eq!(contention.kind(), fs4::lock_contended_error().kind());
    FileExt::unlock(&holder).unwrap();

    let requests = server.requests.lock().unwrap();
    assert_eq!(
        requests.len(),
        2,
        "a missing {filename} must not wipe the cache and download replacements"
    );
    let weights_request = format!(
        "GET /{}/resolve/main/model.safetensors HTTP/1.1",
        crate::DEFAULT_MODEL
    );
    assert!(requests
        .iter()
        .all(|request| request.lines().next() == Some(weights_request.as_str())));
    assert_eq!(
        requests
            .iter()
            .map(|request| requested_range(request))
            .collect::<Vec<_>>(),
        ["bytes=0-0", "bytes=0-"],
        "only the original missing weights are fetched"
    );
    let error = result.expect_err("a missing model file must remain a filesystem failure");
    assert!(
        matches!(&error, EmbedError::Io(error) if error.kind() == std::io::ErrorKind::NotFound),
        "a missing {filename} retains its OS error variant: {error}"
    );
}

#[cfg(unix)]
#[test]
fn embedder_missing_cached_tokenizer_preserves_cache() {
    missing_model_file_preserves_cache("tokenizer.json");
}

#[cfg(unix)]
#[test]
fn embedder_missing_downloaded_weights_preserves_cache() {
    missing_model_file_preserves_cache("model.safetensors");
}

fn recovers_corrupt_cached_file_with(
    filename: &str,
    corrupt: impl FnOnce(&[u8]) -> Vec<u8>,
    probe_only: bool,
) {
    let cache = tempfile::tempdir().unwrap();
    crate::index::test_support::seed_embedding_model(cache.path());
    let repo = cache
        .path()
        .join(super::super::repo_dir_name(crate::DEFAULT_MODEL));
    let snapshot = repo.join("snapshots/test-model");
    let files: std::collections::HashMap<String, Vec<u8>> =
        ["config.json", "tokenizer.json", "model.safetensors"]
            .into_iter()
            .map(|name| (name.to_owned(), std::fs::read(snapshot.join(name)).unwrap()))
            .collect();
    let expected = files.clone();
    std::fs::write(snapshot.join(filename), corrupt(&files[filename])).unwrap();
    let server = model_file_server(files);
    let client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    );
    if probe_only {
        let loaded = super::super::Embedder::open_once(crate::DEFAULT_MODEL, cache.path(), &client)
            .expect("the probe fixture must load successfully before inference");
        assert!(
            matches!(loaded.probe(), Err(EmbedError::Candle(_))),
            "the probe fixture must fail in the forward pass"
        );
        assert!(server.requests.lock().unwrap().is_empty());
        drop(loaded);
    }
    let model =
        super::super::Embedder::open_with_client(crate::DEFAULT_MODEL, cache.path(), &client)
            .expect("a corrupt cached model must be fetched once and pass inference");
    let rows = model
        .embed_documents(&["recovered model"])
        .expect("the recovered model must run inference");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].len(), 4);
    assert!(rows[0].iter().all(|value| value.is_finite()));
    assert!(
        !snapshot.exists(),
        "corrupt snapshot must be removed before retry"
    );
    assert_eq!(
        std::fs::read_to_string(repo.join("refs/main")).unwrap(),
        COMMIT
    );
    for (name, bytes) in expected {
        let path = hf_hub::Cache::new(cache.path().to_owned())
            .model(crate::DEFAULT_MODEL.to_owned())
            .get(&name)
            .expect("the repaired model stays readable through hf-hub");
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
    let requests = server.requests.lock().unwrap();
    assert_eq!(
        requests.len(),
        6,
        "one metadata and payload request for each repaired file"
    );
    for name in ["config.json", "tokenizer.json", "model.safetensors"] {
        let path = format!("GET /{}/resolve/main/{name} HTTP/1.1", crate::DEFAULT_MODEL);
        let ranges: Vec<_> = requests
            .iter()
            .filter(|request| request.lines().next() == Some(path.as_str()))
            .map(|request| requested_range(request))
            .collect();
        assert_eq!(
            ranges,
            ["bytes=0-0", "bytes=0-"],
            "repair fetched {name} exactly once"
        );
    }
}

#[test]
fn embedder_retries_a_corrupt_cached_config() {
    recovers_corrupt_cached_file("config.json", b"{");
}

#[test]
fn embedder_retries_corrupt_cached_tokenizer() {
    recovers_corrupt_cached_file("tokenizer.json", b"{");
}

#[test]
fn embedder_retries_corrupt_cached_weights() {
    recovers_corrupt_cached_file("model.safetensors", b"not-safetensors");
}

#[test]
fn embedder_retries_empty_cached_weights() {
    recovers_corrupt_cached_file("model.safetensors", b"");
}

#[test]
fn a_waiting_download_reuses_the_winners_renamed_snapshot() {
    let cache = tempfile::tempdir().unwrap();
    let repo = cache
        .path()
        .join(super::super::repo_dir_name("fixture/model"));
    let blobs = repo.join("blobs");
    std::fs::create_dir_all(&blobs).unwrap();
    let blob = blobs.join(ETAG);
    let holder = lock_blob(&blob).unwrap();
    let (metadata_seen, metadata_arrived) = std::sync::mpsc::sync_channel(1);
    let server = Server::start(move |request| {
        if requested_range(request) == "bytes=0-0" {
            let _ = metadata_seen.try_send(());
            metadata_response()
        } else {
            response(
                "503 Service Unavailable",
                "",
                b"winner already published the payload",
            )
        }
    });
    let client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    );
    std::thread::scope(|scope| {
        let downloader = scope.spawn(|| client.get("fixture/model", "config.json"));
        metadata_arrived
            .recv_timeout(Duration::from_secs(5))
            .expect("the contender reaches metadata after its initial cache miss");
        let snapshot = repo.join("snapshots").join(COMMIT);
        std::fs::create_dir_all(&snapshot).unwrap();
        let pointer = snapshot.join("config.json");
        std::fs::write(&blob, BODY).unwrap();
        publish_blob(&blob, &pointer, |_, _| {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "synthetic symlink privilege refusal",
            ))
        })
        .unwrap();
        publish_ref(&repo, COMMIT).unwrap();
        assert!(
            !blob.exists(),
            "the winner's rename moved the blob into the snapshot"
        );
        drop(holder);
        let path = downloader
            .join()
            .unwrap()
            .expect("the contender must reuse the winner snapshot after acquiring the blob lock");
        assert_eq!(path, pointer);
        assert_eq!(std::fs::read(path).unwrap(), BODY);
    });
    let requests = server.requests.lock().unwrap();
    assert_eq!(
        requests.len(),
        1,
        "a renamed winner snapshot needs no second payload"
    );
    assert_eq!(requested_range(&requests[0]), "bytes=0-0");
}

#[test]
fn a_complete_blob_is_published_without_another_payload() {
    let cache = tempfile::tempdir().unwrap();
    let repo = cache
        .path()
        .join(super::super::repo_dir_name("fixture/model"));
    let blobs = repo.join("blobs");
    std::fs::create_dir_all(&blobs).unwrap();
    std::fs::write(blobs.join(ETAG), BODY).unwrap();
    let server = Server::start(|request| {
        if requested_range(request) == "bytes=0-0" {
            metadata_response()
        } else {
            response(
                "503 Service Unavailable",
                "",
                b"complete blob needs no payload",
            )
        }
    });
    let client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    );
    let path = client
        .get("fixture/model", "config.json")
        .expect("a complete cached blob must publish without another payload request");
    assert_eq!(std::fs::read(&path).unwrap(), BODY);
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    assert_eq!(
        hf_hub::Cache::new(cache.path().to_owned())
            .model("fixture/model".into())
            .get("config.json"),
        Some(path)
    );
}

#[test]
fn a_wrong_sized_blob_is_replaced_before_publication() {
    for bytes in [BODY[..3].to_vec(), [BODY, b"extra"].concat()] {
        let cache = tempfile::tempdir().unwrap();
        let repo = cache
            .path()
            .join(super::super::repo_dir_name("fixture/model"));
        let blobs = repo.join("blobs");
        std::fs::create_dir_all(&blobs).unwrap();
        std::fs::write(blobs.join(ETAG), bytes).unwrap();
        let server = Server::start(|request| match requested_range(request) {
            "bytes=0-0" => metadata_response(),
            "bytes=0-" => bytes_response(0),
            _ => response("400 Bad Request", "", b"unexpected replacement range"),
        });
        let client = Client::with_config(
            cache.path(),
            &server.endpoint,
            chan_tls::client_config().unwrap(),
        );
        let path = client.get("fixture/model", "config.json").unwrap();
        assert_eq!(
            std::fs::read(path).unwrap(),
            BODY,
            "a blob with the wrong size must be replaced before publication"
        );
        assert_eq!(
            server.requests.lock().unwrap().len(),
            2,
            "one payload repairs the wrong-sized blob"
        );
    }
}

#[test]
fn excess_after_written_chunks_rolls_back_to_the_original_partial() {
    let cache = tempfile::tempdir().unwrap();
    let body = vec![b'x'; 128 * 1024 + 3];
    let prefix = body[..3].to_vec();
    let part = part_file(cache.path(), &prefix);
    let server = Server::start(move |request| {
        if requested_range(request) == "bytes=0-0" {
            return response(
                "206 Partial Content",
                &format!(
                    "Content-Range: bytes 0-0/{}\r\nx-repo-commit: {COMMIT}\r\netag: {ETAG}\r\n",
                    body.len()
                ),
                &body[..1],
            );
        }
        if requested_range(request) != "bytes=3-" {
            return response("400 Bad Request", "", b"unexpected large-body resume range");
        }
        let mut bytes = format!("HTTP/1.1 206 Partial Content\r\nConnection: close\r\nContent-Range: bytes 3-{}/{}\r\n\r\n", body.len() - 1, body.len()).into_bytes();
        bytes.extend_from_slice(&body[3..]);
        bytes.extend_from_slice(b"excess");
        bytes
    });
    let client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    );
    let result = client.get("fixture/model", "config.json");
    assert!(
        result.is_err(),
        "an excess body must refuse publication after earlier chunks were written"
    );
    assert_eq!(
        std::fs::read(part).unwrap(),
        prefix,
        "excess body must roll back chunks appended before the overflow"
    );
    assert!(hf_hub::Cache::new(cache.path().to_owned())
        .model("fixture/model".into())
        .get("config.json")
        .is_none());
    assert_eq!(server.requests.lock().unwrap().len(), 2);
}

#[test]
fn embedder_retries_a_cached_model_that_only_fails_its_probe() {
    recovers_corrupt_cached_file_with("tokenizer.json", tokenizer_with_invalid_cls, true);
}

fn tokenizer_with_invalid_cls(bytes: &[u8]) -> Vec<u8> {
    let mut tokenizer: serde_json::Value = serde_json::from_slice(bytes).unwrap();
    let cls_id = tokenizer
        .pointer_mut("/post_processor/cls/1")
        .expect("the seeded tokenizer uses a BertProcessing CLS token");
    *cls_id = serde_json::json!(999_999);
    serde_json::to_vec(&tokenizer).unwrap()
}

#[test]
fn embedder_refuses_a_retry_model_that_only_fails_its_probe() {
    let cache = tempfile::tempdir().unwrap();
    crate::index::test_support::seed_embedding_model(cache.path());
    let repo = cache
        .path()
        .join(super::super::repo_dir_name(crate::DEFAULT_MODEL));
    let snapshot = repo.join("snapshots/test-model");
    let mut files: std::collections::HashMap<String, Vec<u8>> =
        ["config.json", "tokenizer.json", "model.safetensors"]
            .into_iter()
            .map(|name| (name.to_owned(), std::fs::read(snapshot.join(name)).unwrap()))
            .collect();
    let invalid_tokenizer = tokenizer_with_invalid_cls(&files["tokenizer.json"]);
    files.insert("tokenizer.json".to_owned(), invalid_tokenizer.clone());
    std::fs::write(snapshot.join("config.json"), b"{").unwrap();
    let server = model_file_server(files);
    let client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    );

    assert!(
        matches!(
            super::super::Embedder::open_once(crate::DEFAULT_MODEL, cache.path(), &client),
            Err(EmbedError::Config(_))
        ),
        "the original cached model must fail before inference"
    );
    assert!(server.requests.lock().unwrap().is_empty());
    assert!(
        matches!(
            super::super::Embedder::open_with_client(crate::DEFAULT_MODEL, cache.path(), &client),
            Err(EmbedError::Candle(_))
        ),
        "a replacement that loads but fails inference must not open successfully"
    );

    assert!(
        !snapshot.exists(),
        "the original corrupt snapshot was replaced"
    );
    let downloaded = hf_hub::Cache::new(cache.path().to_owned())
        .model(crate::DEFAULT_MODEL.to_owned())
        .get("tokenizer.json")
        .expect("the failed replacement stays cached after the one permitted retry");
    assert_eq!(std::fs::read(downloaded).unwrap(), invalid_tokenizer);
    let loaded = super::super::Embedder::open_once(crate::DEFAULT_MODEL, cache.path(), &client)
        .expect("the downloaded model must load successfully before its probe");
    assert!(
        matches!(loaded.probe(), Err(EmbedError::Candle(_))),
        "the downloaded fixture fails in its forward pass"
    );
    let requests = server.requests.lock().unwrap();
    assert_eq!(
        requests.len(),
        6,
        "a failed replacement must not be downloaded a third time"
    );
    for name in ["config.json", "tokenizer.json", "model.safetensors"] {
        let path = format!("GET /{}/resolve/main/{name} HTTP/1.1", crate::DEFAULT_MODEL);
        let ranges: Vec<_> = requests
            .iter()
            .filter(|request| request.lines().next() == Some(path.as_str()))
            .map(|request| requested_range(request))
            .collect();
        assert_eq!(
            ranges,
            ["bytes=0-0", "bytes=0-"],
            "repair fetched {name} exactly once"
        );
    }
}

#[test]
fn embedder_retries_non_utf8_cached_config() {
    recovers_corrupt_cached_file("config.json", &[0xff, 0xfe]);
}
