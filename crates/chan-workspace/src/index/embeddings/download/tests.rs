use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, TcpListener};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use chan_tls::testing::{recording, Sink};

use super::*;

pub(super) const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";
const BODY: &[u8] = b"{\"fixture\":true}\n";
const CHILD: &str = "CHAN_DOWNLOAD_TEST_CHILD";

/// Whether this process is the one `in_child` started to run `test`.
pub(super) fn is_child(test: &str) -> bool {
    std::env::var(CHILD).is_ok_and(|name| name == test)
}

/// Run `test`, its path in the crate, alone in a child process with no proxy
/// or CA bundle variable and `env` set, and return what it printed; fail
/// with its output when it fails. The environment a test reads goes through
/// a child, where no other test runs.
pub(super) fn in_child(test: &str, env: &[(&str, &str)]) -> String {
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command.args(["--exact", test, "--nocapture", "--test-threads=1"]);
    for name in super::super::PROXY_VARS.into_iter().chain([
        "NO_PROXY",
        "no_proxy",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
    ]) {
        command.env_remove(name);
    }
    let output = command
        .env(CHILD, test)
        .envs(env.iter().copied())
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    assert!(
        output.status.success(),
        "{test} failed in its child:\n{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    stdout
}

/// A model table that pins `model` at `revision` to `files`, each with the
/// sha256 and size of its bytes.
pub(super) fn pins(
    model: &'static str,
    revision: &'static str,
    files: &[(&'static str, &[u8])],
) -> &'static [EmbeddingModelInfo] {
    let files: Vec<ModelFile> = files
        .iter()
        .map(|&(name, bytes)| ModelFile {
            name,
            sha256: format!("{:x}", Sha256::digest(bytes)).leak(),
            size: bytes.len() as u64,
        })
        .collect();
    vec![EmbeddingModelInfo {
        id: model,
        label: model,
        dim: 4,
        size_label: "",
        note: "",
        is_default: false,
        revision,
        files: files.leak(),
    }]
    .leak()
}

/// The fixture model, pinned at `COMMIT` to a `config.json` holding `body`.
pub(super) fn fixture(body: &[u8]) -> &'static [EmbeddingModelInfo] {
    pins("fixture/model", COMMIT, &[("config.json", body)])
}

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
                    // An accepted socket inherits the listener's non-blocking
                    // mode on macOS and the BSDs, which would turn an early
                    // read into WouldBlock.
                    stream.set_nonblocking(false).unwrap();
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

pub(super) fn response(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
    let mut bytes = format!(
        "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n",
        body.len()
    )
    .into_bytes();
    bytes.extend_from_slice(body);
    bytes
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

fn requested_path(request: &str) -> &str {
    request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("")
}

/// `bytes` from `start` to the end, as a 206 that names its range.
fn range_response(bytes: &[u8], start: usize) -> Vec<u8> {
    response(
        "206 Partial Content",
        &format!(
            "Content-Range: bytes {start}-{}/{}\r\n",
            bytes.len() - 1,
            bytes.len()
        ),
        &bytes[start..],
    )
}

/// A 206 that announces all of `bytes` and sends only their first `sent`.
fn short_response(bytes: &[u8], sent: usize) -> Vec<u8> {
    let mut response = format!(
        "HTTP/1.1 206 Partial Content\r\nConnection: close\r\nContent-Range: bytes 0-{}/{}\r\n\r\n",
        bytes.len() - 1,
        bytes.len()
    )
    .into_bytes();
    response.extend_from_slice(&bytes[..sent]);
    response
}

fn snapshot(cache: &Path) -> PathBuf {
    cache
        .join(repo_dir_name("fixture/model"))
        .join("snapshots")
        .join(COMMIT)
}

fn part_file(cache: &Path, bytes: &[u8]) -> PathBuf {
    let snapshot = snapshot(cache);
    std::fs::create_dir_all(&snapshot).unwrap();
    let path = snapshot.join("config.json.part");
    std::fs::write(&path, bytes).unwrap();
    path
}

/// A client of `server` with the fixture model pinned to `BODY`.
fn client(cache: &Path, server: &Server) -> Client {
    Client::with_config(cache, &server.endpoint, chan_tls::client_config().unwrap())
        .pinned(fixture(BODY))
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
fn a_download_fetches_its_pinned_commit_and_publishes_it() {
    let cache = tempfile::tempdir().unwrap();
    let server = Server::start(|request| match requested_range(request) {
        "bytes=0-" => range_response(BODY, 0),
        _ => response("400 Bad Request", "", b"unexpected range"),
    });
    let path = client(cache.path(), &server)
        .get("fixture/model", "config.json")
        .unwrap();
    assert_eq!(path, snapshot(cache.path()).join("config.json"));
    assert_eq!(std::fs::read(&path).unwrap(), BODY);
    let repo = cache.path().join(repo_dir_name("fixture/model"));
    assert_eq!(
        std::fs::read_to_string(repo.join("refs/main")).unwrap(),
        COMMIT
    );
    assert!(!snapshot(cache.path()).join("config.json.part").exists());
    let requests = server.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .map(|request| requested_path(request))
            .collect::<Vec<_>>(),
        [format!("/fixture/model/resolve/{COMMIT}/config.json")],
        "one request, for the file at its pinned commit"
    );
    let user_agent = requests[0].lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("user-agent")
            .then(|| value.trim())
    });
    assert_eq!(
        user_agent,
        Some(concat!("chan/", env!("CARGO_PKG_VERSION"))),
        "the download names chan, as the updater does"
    );
    assert_eq!(
        hf_hub::Cache::new(cache.path().to_owned())
            .model("fixture/model".into())
            .get("config.json"),
        Some(path),
        "the pinned layout stays readable by hf-hub"
    );
}

#[test]
fn publishing_a_file_removes_the_part_an_earlier_layout_left_for_it() {
    let cache = tempfile::tempdir().unwrap();
    let blobs = cache
        .path()
        .join(repo_dir_name("fixture/model"))
        .join("blobs");
    std::fs::create_dir_all(&blobs).unwrap();
    let sha256 = format!("{:x}", Sha256::digest(BODY));
    let old = blobs.join(format!("{sha256}.part"));
    let other = blobs.join("another-file.part");
    std::fs::write(&old, &BODY[..3]).unwrap();
    std::fs::write(&other, b"not this file's").unwrap();
    let server = Server::start(|_| range_response(BODY, 0));
    client(cache.path(), &server)
        .get("fixture/model", "config.json")
        .unwrap();
    assert!(
        !old.exists(),
        "the earlier download of the published file is removed"
    );
    assert!(other.exists(), "another file's part is left alone");
}

#[cfg(unix)]
#[test]
fn a_dangling_link_at_the_pinned_path_is_replaced_by_the_download() {
    // An old cache's snapshot file links into blobs/; with the blob gone the
    // link dangles, and the download's rename replaces the link itself.
    let cache = tempfile::tempdir().unwrap();
    let snapshot = snapshot(cache.path());
    std::fs::create_dir_all(&snapshot).unwrap();
    let pinned = snapshot.join("config.json");
    std::os::unix::fs::symlink("../../blobs/gone", &pinned).unwrap();
    let server = Server::start(|_| range_response(BODY, 0));
    let path = client(cache.path(), &server)
        .get("fixture/model", "config.json")
        .expect("a dangling link does not block the download");
    assert_eq!(path, pinned);
    assert!(!std::fs::symlink_metadata(&path)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(std::fs::read(path).unwrap(), BODY);
}

#[test]
fn partial_download_resumes_and_publishes_exact_bytes() {
    let cache = tempfile::tempdir().unwrap();
    let partial = part_file(cache.path(), &BODY[..3]);
    let server = Server::start(|request| match requested_range(request) {
        "bytes=3-" => range_response(BODY, 3),
        _ => response("400 Bad Request", "", b"unexpected resume range"),
    });
    let path = client(cache.path(), &server)
        .get("fixture/model", "config.json")
        .expect("the resumed bytes, hashed with their prefix, match the pin");
    assert_eq!(
        std::fs::read(&path).unwrap(),
        BODY,
        "resume preserves the prefix exactly once"
    );
    assert!(!partial.exists(), "successful temporary is consumed");
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}

#[test]
fn bytes_that_miss_their_pin_are_not_published() {
    let cache = tempfile::tempdir().unwrap();
    let wrong = b"{\"fixture\":TRUE}\n";
    assert_eq!(wrong.len(), BODY.len());
    let server = Server::start(move |_| range_response(wrong, 0));
    let error = client(cache.path(), &server)
        .get("fixture/model", "config.json")
        .expect_err("bytes of the pinned size that hash wrong must be refused");
    assert!(
        error
            .to_string()
            .contains("does not match its pinned sha256"),
        "{error}"
    );
    let repo = cache.path().join(repo_dir_name("fixture/model"));
    assert!(!snapshot(cache.path()).join("config.json").exists());
    assert!(!repo.join("refs/main").exists());
    assert_eq!(
        std::fs::read(snapshot(cache.path()).join("config.json.part")).unwrap(),
        b"",
        "the refused bytes are discarded, not kept to resume"
    );
}

#[test]
fn a_completed_part_that_hashes_wrong_is_fetched_again_in_the_same_call() {
    let cache = tempfile::tempdir().unwrap();
    let partial = part_file(cache.path(), b"{\"fixture\":TRUE}\n");
    let server = Server::start(|request| match requested_range(request) {
        "bytes=0-" => range_response(BODY, 0),
        _ => response("400 Bad Request", "", b"unexpected range"),
    });
    let path = client(cache.path(), &server)
        .get("fixture/model", "config.json")
        .expect("a kept part that hashes wrong is replaced by the whole file");
    assert_eq!(std::fs::read(path).unwrap(), BODY);
    assert!(!partial.exists());
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}

#[test]
fn a_resume_whose_kept_prefix_is_wrong_restarts_once_from_zero() {
    let cache = tempfile::tempdir().unwrap();
    part_file(cache.path(), b"XYZ");
    let server = Server::start(|request| match requested_range(request) {
        "bytes=3-" => range_response(BODY, 3),
        "bytes=0-" => range_response(BODY, 0),
        _ => response("400 Bad Request", "", b"unexpected range"),
    });
    let path = client(cache.path(), &server)
        .get("fixture/model", "config.json")
        .expect("a resume that hashes wrong fetches the whole file once more");
    assert_eq!(std::fs::read(path).unwrap(), BODY);
    assert_eq!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| requested_range(request))
            .collect::<Vec<_>>(),
        ["bytes=3-", "bytes=0-"],
        "the resume, then one fresh download in the same call"
    );
}

#[test]
fn a_fresh_download_that_hashes_wrong_after_a_restart_fails() {
    let cache = tempfile::tempdir().unwrap();
    let wrong = b"{\"fixture\":TRUE}\n";
    part_file(cache.path(), &wrong[..3]);
    // A third request is refused, so a restart that is not bounded fails
    // the message below rather than looping.
    let fresh = AtomicBool::new(false);
    let server = Server::start(move |request| match requested_range(request) {
        "bytes=3-" => range_response(wrong, 3),
        "bytes=0-" if !fresh.swap(true, Ordering::SeqCst) => range_response(wrong, 0),
        _ => response("503 Service Unavailable", "", b"no third attempt"),
    });
    let error = client(cache.path(), &server)
        .get("fixture/model", "config.json")
        .expect_err("bytes that hash wrong from zero are refused");
    assert!(
        error
            .to_string()
            .contains("does not match its pinned sha256"),
        "{error}"
    );
    assert_eq!(
        server.requests.lock().unwrap().len(),
        2,
        "one restart, not a loop"
    );
    assert_eq!(
        std::fs::read(snapshot(cache.path()).join("config.json.part")).unwrap(),
        b""
    );
}

#[test]
fn a_whole_file_answer_to_a_resume_that_hashes_wrong_is_not_fetched_again() {
    let cache = tempfile::tempdir().unwrap();
    part_file(cache.path(), &BODY[..3]);
    let wrong = b"{\"fixture\":TRUE}\n";
    let server = Server::start(move |_| response("200 OK", "", wrong));
    let error = client(cache.path(), &server)
        .get("fixture/model", "config.json")
        .expect_err("the whole file hashes wrong");
    assert!(
        error
            .to_string()
            .contains("does not match its pinned sha256"),
        "{error}"
    );
    assert_eq!(
        server.requests.lock().unwrap().len(),
        1,
        "the whole-file answer was the fresh attempt: no second download in the call"
    );
}

#[test]
fn a_whole_file_answer_to_a_resume_restarts_from_it() {
    // A proxy that ignores Range answers with every byte, as a 200 or as a
    // 206 that names the whole file.
    for whole in [response("200 OK", "", BODY), range_response(BODY, 0)] {
        let cache = tempfile::tempdir().unwrap();
        let partial = part_file(cache.path(), &BODY[..3]);
        let server = Server::start(move |_| whole.clone());
        let path = client(cache.path(), &server)
            .get("fixture/model", "config.json")
            .expect("a whole-file answer to a resume must restart from it");
        assert_eq!(
            std::fs::read(&path).unwrap(),
            BODY,
            "the whole file replaces the partial prefix"
        );
        assert!(
            !partial.exists(),
            "the restarted download consumes its part"
        );
        assert_eq!(
            server.requests.lock().unwrap().len(),
            1,
            "the whole file is consumed without another request"
        );
    }
}

#[test]
fn a_foreign_resume_range_empties_the_part_for_the_next_attempt() {
    let cache = tempfile::tempdir().unwrap();
    let partial = part_file(cache.path(), &BODY[..3]);
    let server = Server::start(|request| match requested_range(request) {
        "bytes=3-" => range_response(BODY, 2),
        "bytes=0-" => range_response(BODY, 0),
        _ => response("400 Bad Request", "", b"unexpected range"),
    });
    let client = client(cache.path(), &server);
    let error = client
        .get("fixture/model", "config.json")
        .expect_err("a reply at another range must not continue the part");
    assert!(error.to_string().contains("does not continue"), "{error}");
    assert_eq!(
        std::fs::read(&partial).unwrap(),
        b"",
        "the refused part is emptied, so the same request is not refused again"
    );
    let path = client.get("fixture/model", "config.json").unwrap();
    assert_eq!(std::fs::read(path).unwrap(), BODY);
    assert_eq!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| requested_range(request))
            .collect::<Vec<_>>(),
        ["bytes=3-", "bytes=0-"]
    );
}

/// Return once a download waits on the lock at `path`. Linux lists a
/// waiting flock in /proc/locks with `->`, against the file's inode;
/// elsewhere the contender gets a pause to reach the lock.
fn until_the_lock_has_a_waiter(path: &Path) {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::MetadataExt;
        let inode = format!(":{}", std::fs::metadata(path).unwrap().ino());
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !std::fs::read_to_string("/proc/locks")
            .unwrap()
            .lines()
            .any(|line| line.contains("->") && line.split_whitespace().any(|f| f.ends_with(&inode)))
        {
            assert!(
                std::time::Instant::now() < deadline,
                "no download waits on the lock"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = path;
        std::thread::sleep(Duration::from_millis(300));
    }
}

#[test]
fn a_waiting_download_reuses_the_winners_file() {
    let cache = tempfile::tempdir().unwrap();
    let snapshot = snapshot(cache.path());
    std::fs::create_dir_all(&snapshot).unwrap();
    let holder = lock(&snapshot.join("config.json.lock")).unwrap();
    let server = Server::start(|_| {
        response(
            "503 Service Unavailable",
            "",
            b"the winner already published the file",
        )
    });
    let client = client(cache.path(), &server);
    std::thread::scope(|scope| {
        let downloader = scope.spawn(|| client.get("fixture/model", "config.json"));
        // The contender misses the cache and waits on the lock the winner
        // holds while it publishes.
        until_the_lock_has_a_waiter(&snapshot.join("config.json.lock"));
        std::fs::write(snapshot.join("config.json"), BODY).unwrap();
        drop(holder);
        let path = downloader
            .join()
            .unwrap()
            .expect("the contender must reuse the winner's file after taking the lock");
        assert_eq!(path, snapshot.join("config.json"));
        assert_eq!(std::fs::read(path).unwrap(), BODY);
    });
    assert!(
        server.requests.lock().unwrap().is_empty(),
        "a published file needs no second download"
    );
}

#[test]
fn a_stalled_server_ends_the_download_at_the_read_timeout() {
    let cache = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (release, released) = std::sync::mpsc::channel::<()>();
    let stalled = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0; 4096];
        let _ = std::io::Read::read(&mut stream, &mut request);
        // The headers promise the body; none of it comes.
        stream
            .write_all(
                format!(
                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-{}/{}\r\n\r\n",
                    BODY.len() - 1,
                    BODY.len()
                )
                .as_bytes(),
            )
            .unwrap();
        let _ = released.recv_timeout(Duration::from_secs(30));
    });
    let mut client =
        Client::with_config(cache.path(), &endpoint, chan_tls::client_config().unwrap())
            .pinned(fixture(BODY));
    client.read_timeout = Duration::from_millis(300);
    let (done, finished) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = done.send(client.get("fixture/model", "config.json").map(|_| ()));
    });
    let result = finished.recv_timeout(Duration::from_secs(10));
    let _ = release.send(());
    stalled.join().unwrap();
    result
        .expect("a stalled server must not hang the download")
        .expect_err("the stalled download fails");
    assert_eq!(
        std::fs::read(snapshot(cache.path()).join("config.json.part")).unwrap(),
        b"",
        "nothing arrived to keep"
    );
}

#[test]
fn the_tests_client_ignores_the_environments_proxy() {
    const TEST: &str =
        "index::embeddings::download::tests::the_tests_client_ignores_the_environments_proxy";
    if !is_child(TEST) {
        // A port nothing listens on: a client that took the proxy fails.
        let closed = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let proxy = format!("http://{}", closed.local_addr().unwrap());
        drop(closed);
        in_child(
            TEST,
            &[
                ("ALL_PROXY", &proxy),
                ("HTTPS_PROXY", &proxy),
                ("HTTP_PROXY", &proxy),
            ],
        );
        return;
    }
    let cache = tempfile::tempdir().unwrap();
    let server = Server::start(|_| range_response(BODY, 0));
    let path = client(cache.path(), &server)
        .get("fixture/model", "config.json")
        .expect("the tests' client downloads direct with proxy variables set");
    assert_eq!(std::fs::read(path).unwrap(), BODY);
}

#[test]
fn an_unusable_proxy_is_not_blamed_for_a_failure_without_a_request() {
    const TEST: &str = "index::embeddings::download::tests::an_unusable_proxy_is_not_blamed_for_a_failure_without_a_request";
    if !is_child(TEST) {
        in_child(TEST, &[("HTTPS_PROXY", "https://proxy.invalid:443")]);
        return;
    }
    // A cache root that is a file fails before any request is made.
    let root = tempfile::tempdir().unwrap();
    let cache = root.path().join("cache");
    std::fs::write(&cache, b"not a directory").unwrap();
    let server = Server::start(|_| response("503 Service Unavailable", "", b"no request expected"));
    let error = client(&cache, &server)
        .get("fixture/model", "config.json")
        .expect_err("the cache cannot hold a snapshot");
    assert!(
        matches!(&error, EmbedError::Download(message) if message.starts_with("I/O error")),
        "the filesystem error is reported, not the proxy variable: {error:?}"
    );
    assert!(server.requests.lock().unwrap().is_empty());
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

#[test]
fn a_download_uses_the_supplied_tls_configuration() {
    let cache = tempfile::tempdir().unwrap();
    let (config, handshakes) = recording(chan_tls::client_config().unwrap());
    let sink = Sink::start();
    let client = Client::with_config(cache.path(), &format!("https://{}", sink.addr), config)
        .pinned(fixture(BODY));
    assert!(client.get("fixture/model", "config.json").is_err());
    assert_eq!(
        handshakes.server_names(),
        ["127.0.0.1"],
        "the download must use the supplied TLS configuration"
    );
    assert_eq!(sink.alpn_offers(), [Vec::<String>::new()]);
}

#[test]
fn a_pinned_file_is_read_without_a_request() {
    let cache = tempfile::tempdir().unwrap();
    let snapshot = snapshot(cache.path());
    std::fs::create_dir_all(&snapshot).unwrap();
    std::fs::write(snapshot.join("config.json"), BODY).unwrap();
    let server = Server::start(|_| {
        response(
            "503 Service Unavailable",
            "",
            b"unexpected cached-file request",
        )
    });
    let (config, handshakes) = recording(chan_tls::client_config().unwrap());
    let client = Client::with_config(cache.path(), &server.endpoint, config).pinned(fixture(BODY));
    let path = client
        .get("fixture/model", "config.json")
        .expect("a file in the pinned snapshot must be returned without a request");
    assert_eq!(path, snapshot.join("config.json"));
    assert!(server.requests.lock().unwrap().is_empty());
    assert!(handshakes.server_names().is_empty());
}

#[test]
fn an_incomplete_snapshot_at_another_commit_is_not_mixed_with_the_pinned_one() {
    const OLD: &str = "1111111111111111111111111111111111111111";
    let cache = tempfile::tempdir().unwrap();
    let repo = cache.path().join(repo_dir_name("fixture/model"));
    let old = repo.join("snapshots").join(OLD);
    std::fs::create_dir_all(&old).unwrap();
    std::fs::create_dir_all(repo.join("refs")).unwrap();
    std::fs::write(repo.join("refs/main"), OLD).unwrap();
    std::fs::write(old.join("config.json"), b"{\"old\":true}\n").unwrap();
    let server = Server::start(|_| range_response(BODY, 0));
    let client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    )
    .pinned(pins(
        "fixture/model",
        COMMIT,
        &[("config.json", BODY), ("tokenizer.json", BODY)],
    ));
    let path = client
        .get("fixture/model", "config.json")
        .expect("the pinned file is fetched beside the incomplete old snapshot");
    assert_eq!(
        path,
        snapshot(cache.path()).join("config.json"),
        "a snapshot that lacks a pinned file supplies none of the model's files"
    );
    assert_eq!(std::fs::read(path).unwrap(), BODY);
}

#[test]
fn a_complete_snapshot_at_another_commit_supplies_every_file_over_a_partial_pinned_one() {
    const OLD: &str = "1111111111111111111111111111111111111111";
    let cache = tempfile::tempdir().unwrap();
    let repo = cache.path().join(repo_dir_name("fixture/model"));
    let old = repo.join("snapshots").join(OLD);
    std::fs::create_dir_all(&old).unwrap();
    std::fs::create_dir_all(repo.join("refs")).unwrap();
    std::fs::write(repo.join("refs/main"), OLD).unwrap();
    std::fs::write(old.join("config.json"), BODY).unwrap();
    std::fs::write(old.join("tokenizer.json"), BODY).unwrap();
    // A download at the pin got as far as one file, then an earlier chan
    // put its own snapshot back in front.
    let pinned = snapshot(cache.path());
    std::fs::create_dir_all(&pinned).unwrap();
    std::fs::write(pinned.join("config.json"), BODY).unwrap();
    let server = Server::start(|_| response("503 Service Unavailable", "", b"no request expected"));
    let client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    )
    .pinned(pins(
        "fixture/model",
        COMMIT,
        &[("config.json", BODY), ("tokenizer.json", BODY)],
    ));
    for name in ["config.json", "tokenizer.json"] {
        assert_eq!(
            client.get("fixture/model", name).unwrap(),
            old.join(name),
            "every file of the model comes from the one complete snapshot"
        );
    }
    assert!(server.requests.lock().unwrap().is_empty());
}

#[test]
fn a_pinned_snapshot_without_its_ref_is_downloaded_and_gets_its_ref() {
    let cache = tempfile::tempdir().unwrap();
    let model = config::embedding_model(crate::DEFAULT_MODEL).unwrap();
    let repo = cache.path().join(repo_dir_name(crate::DEFAULT_MODEL));
    let pinned = repo.join("snapshots").join(model.revision);
    std::fs::create_dir_all(&pinned).unwrap();
    for name in MODEL_FILES {
        std::fs::write(pinned.join(name), b"x").unwrap();
    }
    assert!(
        super::super::model_downloaded_in(crate::DEFAULT_MODEL, cache.path()).unwrap(),
        "every pinned file in the pinned snapshot is a downloaded model, ref or not"
    );
    let server = Server::start(|_| response("503 Service Unavailable", "", b"no request expected"));
    let path = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    )
    .get(crate::DEFAULT_MODEL, "config.json")
    .unwrap();
    assert_eq!(path, pinned.join("config.json"));
    assert_eq!(
        std::fs::read_to_string(repo.join("refs/main")).unwrap(),
        model.revision,
        "a hit in the pinned snapshot names its commit"
    );
    assert!(server.requests.lock().unwrap().is_empty());
}

#[test]
fn a_model_that_pins_no_weights_is_never_downloaded() {
    let cache = tempfile::tempdir().unwrap();
    let model = &unpublished()[0];
    let repo = cache.path().join(repo_dir_name(model.id));
    let pinned = repo.join("snapshots").join(model.revision);
    std::fs::create_dir_all(&pinned).unwrap();
    for name in MODEL_FILES {
        std::fs::write(pinned.join(name), b"x").unwrap();
    }
    assert!(!downloaded(&repo, model));
}

/// A model whose repository publishes no weights: it pins the config and the
/// tokenizer only. No model chan offers is one now.
fn unpublished() -> &'static [EmbeddingModelInfo] {
    pins(
        "fixture/unpublished",
        COMMIT,
        &[("config.json", BODY), ("tokenizer.json", BODY)],
    )
}

#[test]
fn a_model_opens_from_one_snapshot_when_the_cache_changes_between_its_files() {
    const OLD: &str = "1111111111111111111111111111111111111111";
    let cache = tempfile::tempdir().unwrap();
    let repo = cache.path().join(repo_dir_name("fixture/model"));
    let pinned = snapshot(cache.path());
    std::fs::create_dir_all(&pinned).unwrap();
    std::fs::write(pinned.join("config.json"), BODY).unwrap();
    let server = Server::start(|_| range_response(BODY, 0));
    let mut client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    )
    .pinned(pins(
        "fixture/model",
        COMMIT,
        &[
            ("config.json", BODY),
            ("tokenizer.json", BODY),
            ("model.safetensors", BODY),
        ],
    ));
    // While the tokenizer downloads, an earlier chan puts its own complete
    // snapshot in front: the weights' lookup would read that one.
    let old = repo.join("snapshots").join(OLD);
    let (front, named) = (old.clone(), repo.join("refs/main"));
    client.publication_observer = Some(Box::new(move |_| {
        std::fs::create_dir_all(&front).unwrap();
        for name in MODEL_FILES {
            std::fs::write(front.join(name), BODY).unwrap();
        }
        std::fs::write(&named, OLD).unwrap();
    }));
    let paths = client.get_model("fixture/model").unwrap();
    assert_eq!(
        paths.each_ref().map(|path| path.parent().unwrap()),
        [old.as_path(); 3],
        "the three files come from one snapshot: {paths:?}"
    );
}

#[test]
fn cache_reference_cannot_escape_the_snapshot_directory() {
    let cache = tempfile::tempdir().unwrap();
    let repo = cache.path().join(repo_dir_name("fixture/model"));
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
    assert_eq!(
        cached(&repo, &fixture(BODY)[0], "config.json"),
        None,
        "a cache reference must not escape the snapshot directory"
    );
}

#[test]
fn an_unpinned_model_or_file_is_refused_before_any_request_or_write() {
    for (model, filename) in [
        ("other/model", "config.json"),
        ("fixture/model", "model.safetensors"),
    ] {
        let cache = tempfile::tempdir().unwrap();
        let server = Server::start(|_| {
            response(
                "503 Service Unavailable",
                "",
                b"unpinned files must not reach transport",
            )
        });
        let error = client(cache.path(), &server)
            .get(model, filename)
            .expect_err("an unpinned file must not resolve to a cached or downloaded file");
        assert_eq!(
            error.to_string(),
            format!("model download: {model} has no pinned {filename}"),
        );
        assert!(
            server.requests.lock().unwrap().is_empty(),
            "an unpinned file must make no network request"
        );
        assert!(
            std::fs::read_dir(cache.path()).unwrap().next().is_none(),
            "an unpinned file must leave the cache directory empty"
        );
    }
}

#[test]
fn a_model_that_publishes_no_weights_is_refused_before_any_request() {
    let cache = tempfile::tempdir().unwrap();
    let server = Server::start(|_| {
        response(
            "503 Service Unavailable",
            "",
            b"an unpublished model must not reach transport",
        )
    });
    let client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    )
    .pinned(unpublished());
    let error =
        super::super::Embedder::open_with_client("fixture/unpublished", cache.path(), &client)
            .expect_err("a model whose repository publishes no weights cannot open");
    assert_eq!(
        error.to_string(),
        "fixture/unpublished cannot be downloaded: its Hub repository publishes no model.safetensors"
    );
    assert!(
        server.requests.lock().unwrap().is_empty(),
        "none of the model's files is fetched"
    );
    assert!(
        std::fs::read_dir(cache.path()).unwrap().next().is_none(),
        "the cache is not touched"
    );
}

#[test]
fn completed_part_publishes_without_an_invalid_end_range_request() {
    let cache = tempfile::tempdir().unwrap();
    part_file(cache.path(), BODY);
    let server =
        Server::start(|_| response("400 Bad Request", "", b"complete part requested a payload"));
    let path = client(cache.path(), &server)
        .get("fixture/model", "config.json")
        .expect("a complete part must publish without an end-of-file request");
    assert_eq!(std::fs::read(path).unwrap(), BODY);
    assert!(server.requests.lock().unwrap().is_empty());
}

#[test]
fn oversized_part_restarts_and_publishes_exact_bytes() {
    let cache = tempfile::tempdir().unwrap();
    let oversized = [BODY, b"extra"].concat();
    let part = part_file(cache.path(), &oversized);
    let server = Server::start(|request| match requested_range(request) {
        "bytes=0-" => range_response(BODY, 0),
        _ => response(
            "400 Bad Request",
            "",
            b"oversized part must restart at zero",
        ),
    });
    let path = client(cache.path(), &server)
        .get("fixture/model", "config.json")
        .expect("an oversized part must restart from zero in the same call");
    assert_eq!(
        std::fs::read(path).unwrap(),
        BODY,
        "the oversized prefix must be discarded"
    );
    assert!(!part.exists());
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}

#[test]
fn a_short_transfer_stays_partial_and_resumes_on_the_next_attempt() {
    let cache = tempfile::tempdir().unwrap();
    let server = Server::start(move |request| match requested_range(request) {
        "bytes=0-" => short_response(BODY, 4),
        "bytes=4-" => range_response(BODY, 4),
        _ => response("400 Bad Request", "", b"unexpected recovery range"),
    });
    let client = client(cache.path(), &server);
    let error = client
        .get("fixture/model", "config.json")
        .expect_err("short response must not publish a snapshot");
    assert!(error.to_string().contains("advertised size"), "{error}");
    let repo = cache.path().join(repo_dir_name("fixture/model"));
    assert_eq!(
        std::fs::read(snapshot(cache.path()).join("config.json.part")).unwrap(),
        &BODY[..4]
    );
    assert!(!repo.join("refs/main").exists());
    let path = client.get("fixture/model", "config.json").unwrap();
    assert_eq!(std::fs::read(path).unwrap(), BODY);
    assert_eq!(server.requests.lock().unwrap().len(), 2);
}

#[test]
fn excess_after_written_chunks_empties_the_part_for_the_next_attempt() {
    let cache = tempfile::tempdir().unwrap();
    let body = vec![b'x'; 128 * 1024 + 3];
    let part = part_file(cache.path(), &body[..3]);
    let pinned = fixture(&body);
    let server = Server::start(move |request| match requested_range(request) {
        // The asked range and then more, with no length to refuse it by.
        "bytes=3-" => {
            let mut bytes = format!(
                "HTTP/1.1 206 Partial Content\r\nConnection: close\r\nContent-Range: bytes 3-{}/{}\r\n\r\n",
                body.len() - 1,
                body.len()
            )
            .into_bytes();
            bytes.extend_from_slice(&body[3..]);
            bytes.extend_from_slice(b"excess");
            bytes
        }
        "bytes=0-" => range_response(&body, 0),
        _ => response("400 Bad Request", "", b"unexpected large-body range"),
    });
    let client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    )
    .pinned(pinned);
    assert!(
        client.get("fixture/model", "config.json").is_err(),
        "an excess body must refuse publication after earlier chunks were written"
    );
    assert_eq!(
        std::fs::read(&part).unwrap(),
        b"",
        "the refused part is emptied, so the same request is not refused again"
    );
    assert!(!snapshot(cache.path()).join("config.json").exists());
    client
        .get("fixture/model", "config.json")
        .expect("the next attempt starts clean");
    assert_eq!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| requested_range(request))
            .collect::<Vec<_>>(),
        ["bytes=3-", "bytes=0-"]
    );
}

/// The default model's pinned snapshot in `cache`.
fn default_snapshot(cache: &Path) -> PathBuf {
    let revision = config::embedding_model(crate::DEFAULT_MODEL)
        .unwrap()
        .revision;
    cache
        .join(repo_dir_name(crate::DEFAULT_MODEL))
        .join("snapshots")
        .join(revision)
}

#[test]
fn embedder_transport_failure_preserves_another_downloaders_cache() {
    let cache = tempfile::tempdir().unwrap();
    let snapshot = default_snapshot(cache.path());
    std::fs::create_dir_all(&snapshot).unwrap();
    let part = snapshot.join("other-download.part");
    let lock = snapshot.join("other-download.lock");
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
    assert!(matches!(error, EmbedError::Download(_)));
    assert_eq!(
        std::fs::read(part).unwrap(),
        b"other downloader's partial bytes",
        "a transport failure must preserve another downloader's partial file"
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
fn embedder_interrupted_payload_keeps_the_resumable_part() {
    let cache = tempfile::tempdir().unwrap();
    let repo = cache.path().join(repo_dir_name(crate::DEFAULT_MODEL));
    std::fs::create_dir_all(&repo).unwrap();
    let marker = repo.join("existing-cache-marker");
    std::fs::write(&marker, b"keep").unwrap();
    let pinned = config::embedding_model(crate::DEFAULT_MODEL).unwrap().files[0];
    let announced = vec![b'x'; pinned.size as usize];
    let server = Server::start(move |_| short_response(&announced, 4));
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
        std::fs::read(default_snapshot(cache.path()).join("config.json.part")).unwrap(),
        b"xxxx"
    );
    assert_eq!(
        server.requests.lock().unwrap().len(),
        1,
        "the wrapper preserves partial progress instead of wiping and retrying"
    );
}

fn parsed_response(status: &str, headers: &str) -> Response {
    format!("HTTP/1.1 {status}\r\n{headers}\r\n")
        .parse()
        .unwrap()
}

#[test]
fn each_resume_guard_refuses_on_its_own() {
    // Each refused reply fails one guard and passes the others: a 200 for a
    // nonempty part, a wrong range, a wrong length.
    for (status, headers, start, size, accepted) in [
        ("200 OK", "Content-Length: 7\r\n", 3, 10, false),
        ("200 OK", "Content-Length: 10\r\n", 0, 10, true),
        (
            "206 Partial Content",
            "Content-Range: bytes 0-6/10\r\nContent-Length: 7\r\n",
            3,
            10,
            false,
        ),
        (
            "206 Partial Content",
            "Content-Range: bytes 3-9/10\r\nContent-Length: 7\r\n",
            3,
            10,
            true,
        ),
        (
            "206 Partial Content",
            "Content-Range: bytes 3-9/10\r\nContent-Length: 6\r\n",
            3,
            10,
            false,
        ),
        (
            "206 Partial Content",
            "Content-Range: bytes 3-9/10\r\nContent-Length: 8\r\n",
            3,
            10,
            false,
        ),
        (
            "206 Partial Content",
            "Content-Range: bytes 3-9/10\r\nContent-Length: not-a-size\r\n",
            3,
            10,
            false,
        ),
        (
            "206 Partial Content",
            "Content-Range: bytes 3-9/10\r\n",
            3,
            10,
            true,
        ),
    ] {
        let response = parsed_response(status, headers);
        let result = validate_resume(&response, start, size);
        assert_eq!(
            result.is_ok(),
            accepted,
            "{status} with {headers:?} resuming at {start} of {size}: {result:?}"
        );
        if !accepted {
            assert!(matches!(result, Err(DownloadError::InvalidResume)));
        }
    }
}

use crate::index::config::MODEL_FILES;

/// The seeded model's files in `cache`, by name.
fn seeded_files(cache: &Path) -> HashMap<&'static str, Vec<u8>> {
    let snapshot = cache
        .join(repo_dir_name(crate::DEFAULT_MODEL))
        .join("snapshots/test-model");
    MODEL_FILES
        .into_iter()
        .map(|name| (name, std::fs::read(snapshot.join(name)).unwrap()))
        .collect()
}

/// The default model pinned at `revision` to `files`.
fn default_pins(
    revision: &'static str,
    files: &HashMap<&'static str, Vec<u8>>,
) -> &'static [EmbeddingModelInfo] {
    let files: Vec<_> = MODEL_FILES
        .into_iter()
        .map(|name| (name, files[name].as_slice()))
        .collect();
    pins(crate::DEFAULT_MODEL, revision, &files)
}

/// A server for the default model's `files` at `revision`.
fn model_file_server(revision: &'static str, files: HashMap<&'static str, Vec<u8>>) -> Server {
    let prefix = format!("/{}/resolve/{revision}/", crate::DEFAULT_MODEL);
    Server::start(move |request| {
        let Some(bytes) = requested_path(request)
            .strip_prefix(prefix.as_str())
            .and_then(|name| files.get(name))
        else {
            return response("404 Not Found", "", b"unexpected model file");
        };
        match requested_range(request) {
            "bytes=0-" => range_response(bytes, 0),
            _ => response("400 Bad Request", "", b"unexpected model range"),
        }
    })
}

fn recovers_corrupt_cached_file_with(
    filename: &str,
    corrupt: impl FnOnce(&[u8]) -> Vec<u8>,
    probe_only: bool,
) {
    let cache = tempfile::tempdir().unwrap();
    crate::index::test_support::seed_embedding_model(cache.path());
    let repo = cache.path().join(repo_dir_name(crate::DEFAULT_MODEL));
    let seeded = repo.join("snapshots/test-model");
    let files = seeded_files(cache.path());
    let expected = files.clone();
    std::fs::write(seeded.join(filename), corrupt(&files[filename])).unwrap();
    let pinned = default_pins(COMMIT, &files);
    let server = model_file_server(COMMIT, files);
    let client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    )
    .pinned(pinned);
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
        !seeded.exists(),
        "corrupt snapshot must be removed before retry"
    );
    assert_eq!(
        std::fs::read_to_string(repo.join("refs/main")).unwrap(),
        COMMIT
    );
    for (name, bytes) in expected {
        assert_eq!(
            std::fs::read(repo.join("snapshots").join(COMMIT).join(name)).unwrap(),
            bytes
        );
    }
    let requests = server.requests.lock().unwrap();
    let mut fetched: Vec<_> = requests
        .iter()
        .map(|request| (requested_path(request), requested_range(request)))
        .collect();
    fetched.sort();
    let mut wanted: Vec<_> = MODEL_FILES
        .into_iter()
        .map(|name| {
            (
                format!("/{}/resolve/{COMMIT}/{name}", crate::DEFAULT_MODEL),
                "bytes=0-",
            )
        })
        .collect();
    wanted.sort();
    assert_eq!(
        fetched,
        wanted
            .iter()
            .map(|(path, range)| (path.as_str(), *range))
            .collect::<Vec<_>>(),
        "repair fetched each file exactly once"
    );
}

#[test]
fn embedder_retries_a_corrupt_cached_file() {
    for (filename, corrupt) in [
        ("config.json", &b"{"[..]),
        ("config.json", &[0xff, 0xfe][..]),
        ("tokenizer.json", &b"{"[..]),
        ("model.safetensors", &b"not-safetensors"[..]),
        ("model.safetensors", &b""[..]),
    ] {
        recovers_corrupt_cached_file_with(filename, |_| corrupt.to_vec(), false);
    }
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
    let repo = cache.path().join(repo_dir_name(crate::DEFAULT_MODEL));
    let seeded = repo.join("snapshots/test-model");
    let mut files = seeded_files(cache.path());
    let invalid_tokenizer = tokenizer_with_invalid_cls(&files["tokenizer.json"]);
    files.insert("tokenizer.json", invalid_tokenizer.clone());
    std::fs::write(seeded.join("config.json"), b"{").unwrap();
    let pinned = default_pins(COMMIT, &files);
    let server = model_file_server(COMMIT, files);
    let client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    )
    .pinned(pinned);

    assert!(
        matches!(
            super::super::Embedder::open_once(crate::DEFAULT_MODEL, cache.path(), &client),
            Err(EmbedError::Config(_))
        ),
        "the original cached model must fail before inference"
    );
    assert!(server.requests.lock().unwrap().is_empty());
    let result =
        super::super::Embedder::open_with_client(crate::DEFAULT_MODEL, cache.path(), &client);
    assert!(
        matches!(&result, Err(EmbedError::Candle(_))),
        "a replacement that loads but fails inference must return Candle; got {:?}",
        result.as_ref().map(|_| ())
    );
    assert!(
        !seeded.exists(),
        "the original corrupt snapshot was replaced"
    );
    assert_eq!(
        std::fs::read(repo.join("snapshots").join(COMMIT).join("tokenizer.json")).unwrap(),
        invalid_tokenizer,
        "the failed replacement stays cached after the one permitted retry"
    );
    assert_eq!(
        server.requests.lock().unwrap().len(),
        3,
        "a failed replacement must not be downloaded a third time"
    );
}

#[test]
fn a_failed_probe_with_every_file_as_pinned_keeps_the_cache() {
    let cache = tempfile::tempdir().unwrap();
    crate::index::test_support::seed_embedding_model(cache.path());
    let seeded = cache
        .path()
        .join(repo_dir_name(crate::DEFAULT_MODEL))
        .join("snapshots/test-model");
    let mut files = seeded_files(cache.path());
    let tokenizer = tokenizer_with_invalid_cls(&files["tokenizer.json"]);
    std::fs::write(seeded.join("tokenizer.json"), &tokenizer).unwrap();
    files.insert("tokenizer.json", tokenizer);
    // The pins name the bytes the cache holds, so the failure is not
    // corruption: a download would bring the same bytes back.
    let pinned = default_pins("test-model", &files);
    let server = Server::start(|_| {
        response(
            "503 Service Unavailable",
            "",
            b"a model as pinned is not fetched again",
        )
    });
    let client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    )
    .pinned(pinned);
    let error =
        super::super::Embedder::open_with_client(crate::DEFAULT_MODEL, cache.path(), &client)
            .expect_err("the pinned model fails its probe");
    assert!(
        matches!(error, EmbedError::Candle(_)),
        "the probe's own failure surfaces: {error}"
    );
    assert!(server.requests.lock().unwrap().is_empty());
    for (name, bytes) in files {
        assert_eq!(
            std::fs::read(seeded.join(name)).unwrap(),
            bytes,
            "the cache is kept"
        );
    }
}

#[cfg(unix)]
#[test]
fn embedder_missing_downloaded_weights_preserves_cache() {
    use std::os::unix::fs::MetadataExt;
    use std::sync::atomic::AtomicUsize;

    let cache = tempfile::tempdir().unwrap();
    crate::index::test_support::seed_embedding_model(cache.path());
    let repo = cache.path().join(repo_dir_name(crate::DEFAULT_MODEL));
    let snapshot = repo.join("snapshots/test-model");
    let files = seeded_files(cache.path());
    let weights = snapshot.join("model.safetensors");
    std::fs::remove_file(&weights).unwrap();

    let marker = repo.join("existing-cache-marker");
    std::fs::write(&marker, b"keep existing model cache").unwrap();
    let partial = snapshot.join("other-download.part");
    std::fs::write(&partial, b"another downloader's resumable bytes").unwrap();
    let lock_path = snapshot.join("other-download.lock");
    let holder = File::create(&lock_path).unwrap();
    FileExt::try_lock_exclusive(&holder).unwrap();
    let held_inode = holder.metadata().unwrap();

    let pinned = default_pins("test-model", &files);
    let server = model_file_server("test-model", files);
    let observations = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&observations);
    let mut client = Client::with_config(
        cache.path(),
        &server.endpoint,
        chan_tls::client_config().unwrap(),
    )
    .pinned(pinned);
    client.publication_observer = Some(Box::new(move |published| {
        observed.fetch_add(1, Ordering::SeqCst);
        // The weights vanish after their publication, before the loader
        // maps them.
        std::fs::remove_file(published).expect("the published weights must exist");
    }));

    let result =
        super::super::Embedder::open_with_client(crate::DEFAULT_MODEL, cache.path(), &client);
    assert_eq!(observations.load(Ordering::SeqCst), 1);
    assert_eq!(std::fs::read(marker).unwrap(), b"keep existing model cache");
    assert_eq!(
        std::fs::read(partial).unwrap(),
        b"another downloader's resumable bytes",
        "a missing model file must preserve another downloader's partial"
    );
    let retained_inode = std::fs::metadata(&lock_path)
        .expect("a missing model file must preserve the active lock path");
    assert_eq!(
        (retained_inode.dev(), retained_inode.ino()),
        (held_inode.dev(), held_inode.ino()),
        "a missing model file must preserve the active downloader's lock inode"
    );
    let contender = OpenOptions::new().write(true).open(&lock_path).unwrap();
    let contention = FileExt::try_lock_exclusive(&contender)
        .expect_err("the retained lock path must still exclude another downloader");
    assert_eq!(contention.kind(), fs4::lock_contended_error().kind());
    FileExt::unlock(&holder).unwrap();

    let requests = server.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .map(|request| requested_path(request))
            .collect::<Vec<_>>(),
        [format!(
            "/{}/resolve/test-model/model.safetensors",
            crate::DEFAULT_MODEL
        )],
        "a missing model file must not wipe the cache and download replacements"
    );
    let error = result.expect_err("a missing model file must remain a filesystem failure");
    assert!(
        matches!(&error, EmbedError::Io(error) if error.kind() == std::io::ErrorKind::NotFound),
        "a missing model file retains its OS error variant: {error}"
    );
}
