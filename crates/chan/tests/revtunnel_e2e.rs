//! End-to-end reverse tunnel (`cs tunnel`): spawn the real `chan devserver`
//! binary and drive every leg of the contract at its real boundary.
//!
//! One scenario walks the same four parties the feature has in production:
//!
//!   1. The DEVSERVER is the spawned binary, with a workspace mounted over the
//!      management API and a library window minted over `/api/library/windows`.
//!   2. The SPA is a plain WebSocket held on the tenant's `/ws?w=<window-id>`;
//!      the `tunnel_open` window_command is read off it, because that push is
//!      the real trigger path and skipping it would leave the fire-and-forget
//!      leg untested.
//!   3. The DESKTOP is `chan_revtunnel::client::open` called in-process with
//!      the devserver's base URL and bearer -- the same Tauri-free module
//!      chan-desktop calls, usable here because this host has no display
//!      server to run the GUI on.
//!   4. `cs tunnel` is a raw control-socket connection carrying one
//!      `ControlRequest::Tunnel` line WITHOUT a half-close: the connection's
//!      lifetime is the tunnel's, so dropping it is Ctrl-C.
//!
//! The sandbox/process plumbing mirrors tests/devserver_resilience.rs (fresh
//! `CHAN_HOME`/`HOME`/`XDG_RUNTIME_DIR` per test); helpers are copied, not
//! shared, so neither suite can destabilize the other.

#![cfg(unix)]

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chan_revtunnel::client::{ClientConfig, TunnelHandle};
use chan_revtunnel::{parse_spec, Proto, SpecError, TunnelSpec};
use chan_shell::{ControlRequest, ControlResponse};
use futures::StreamExt;
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream, UnixStream};
use tokio_tungstenite::tungstenite::Message;

/// The built `chan` binary under test (Cargo points this at the target dir).
const CHAN: &str = env!("CARGO_BIN_EXE_chan");

/// Upper bound for every await in this suite. Generous enough for a loaded CI
/// box; a wait that outlives it panics with the step's name, because a hanging
/// tunnel test is worse than a failing one.
const WAIT: Duration = Duration::from_secs(12);

/// Await `fut` or panic naming the step that hung.
async fn within<T>(what: &str, fut: impl std::future::Future<Output = T>) -> T {
    match tokio::time::timeout(WAIT, fut).await {
        Ok(value) => value,
        Err(_) => panic!("timed out after {WAIT:?} waiting for {what}"),
    }
}

// ---------------------------------------------------------------------------
// Sandbox + process plumbing (mirrors devserver_resilience.rs).
// ---------------------------------------------------------------------------

/// Per-test sandbox: a redirected `HOME` and `XDG_RUNTIME_DIR`, plus a scratch
/// area for workspace roots. Dropping it removes everything.
struct Sandbox {
    chan_home: TempDir,
    home: TempDir,
    runtime: TempDir,
    scratch: TempDir,
}

impl Sandbox {
    fn new() -> Self {
        Self {
            chan_home: tempfile::tempdir().expect("chan home tempdir"),
            home: tempfile::tempdir().expect("home tempdir"),
            runtime: tempfile::tempdir().expect("runtime tempdir"),
            scratch: tempfile::tempdir().expect("scratch tempdir"),
        }
    }

    /// A fresh, empty workspace root under the scratch area, canonicalized
    /// because the devserver keys its registry (and its control-socket
    /// Identify answer) on the canonical path.
    fn workspace(&self, name: &str) -> PathBuf {
        let root = self.scratch.path().join(name);
        std::fs::create_dir_all(&root).expect("create workspace root");
        std::fs::canonicalize(&root).expect("canonicalize workspace root")
    }

    /// A `chan` command preloaded with the sandbox env. The inherited
    /// `CHAN_*` terminal-session vars are stripped so a test launched from
    /// inside a chan terminal doesn't accidentally drive handoff.
    fn command(&self) -> Command {
        let mut cmd = Command::new(CHAN);
        cmd.env("CHAN_HOME", self.chan_home.path())
            .env("HOME", self.home.path())
            .env("XDG_RUNTIME_DIR", self.runtime.path())
            .env("TMPDIR", self.runtime.path())
            .env("CHAN_NO_DESKTOP_HANDOFF", "1")
            .env("CHAN_NO_DEVSERVER_HANDOFF", "1")
            .env_remove("CHAN_CONTROL_SOCKET")
            .env_remove("CHAN_WINDOW_ID")
            .env_remove("CHAN_TAB_NAME")
            .env_remove("CHAN_TAB_GROUP")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd
    }
}

/// Drains a child's stdout+stderr in background threads into one transcript,
/// so the pipe buffers never fill (which would wedge the child).
#[derive(Clone)]
struct Transcript {
    lines: Arc<Mutex<Vec<String>>>,
}

impl Transcript {
    fn capture(child: &mut Child) -> Self {
        let lines = Arc::new(Mutex::new(Vec::new()));
        if let Some(out) = child.stdout.take() {
            drain(out, lines.clone());
        }
        if let Some(err) = child.stderr.take() {
            drain(err, lines.clone());
        }
        Self { lines }
    }

    fn find(&self, needle: &str) -> Option<String> {
        self.lines
            .lock()
            .unwrap()
            .iter()
            .find(|line| line.contains(needle))
            .cloned()
    }

    /// Poll the transcript for a line containing `needle` until `timeout`.
    async fn wait_for(&self, needle: &str, timeout: Duration) -> Option<String> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(line) = self.find(needle) {
                return Some(line);
            }
            if Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    fn dump(&self) -> String {
        self.lines.lock().unwrap().join("\n")
    }
}

fn drain<R: std::io::Read + Send + 'static>(reader: R, lines: Arc<Mutex<Vec<String>>>) {
    use std::io::BufRead;
    std::thread::spawn(move || {
        let buf = std::io::BufReader::new(reader);
        for line in buf.lines().map_while(Result::ok) {
            lines.lock().unwrap().push(line);
        }
    });
}

/// A spawned server process plus its captured output. Dropping it always
/// kills and reaps the child, so a panicking test never strands a server.
struct Server {
    child: Child,
    out: Transcript,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The devserver's own AddrInUse wording: the only startup failure worth
/// retrying on another port.
const PORT_IN_USE: &str = "the port is already in use";

/// How many ports a helper draws before giving up on the bind race.
const PORT_ATTEMPTS: usize = 5;

enum Startup {
    Listening(Server, SocketAddr),
    PortInUse,
    Failed(String),
}

/// Spawn `chan devserver` on `port` and wait for it to serve. A child that
/// dies is classified the moment it exits rather than at the ready deadline.
async fn start_devserver(sandbox: &Sandbox, port: u16) -> Startup {
    let mut child = sandbox
        .command()
        .arg("devserver")
        .args(["--bind", "127.0.0.1"])
        .args(["--port", &port.to_string()])
        .spawn()
        .expect("spawn chan devserver");
    let out = Transcript::capture(&mut child);
    let mut server = Server { child, out };
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if server.out.find("listening on http://").is_some() {
            let addr: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
            wait_devserver_up(&http(), addr).await;
            return Startup::Listening(server, addr);
        }
        if server
            .child
            .try_wait()
            .expect("try_wait devserver")
            .is_some()
        {
            // The drain threads publish asynchronously, so the child's last
            // words can still be in flight when its exit is observed.
            let port_taken = server
                .out
                .wait_for(PORT_IN_USE, Duration::from_secs(2))
                .await
                .is_some();
            return if port_taken {
                Startup::PortInUse
            } else {
                Startup::Failed(server.out.dump())
            };
        }
        if Instant::now() >= deadline {
            return Startup::Failed(server.out.dump());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Spawn `chan devserver` on a port the test has no opinion about, redrawing
/// the port when another process wins the bind race.
async fn spawn_devserver_on_free_port(sandbox: &Sandbox) -> (Server, SocketAddr) {
    let mut lost = Vec::new();
    for _ in 0..PORT_ATTEMPTS {
        let port = free_port();
        match start_devserver(sandbox, port).await {
            Startup::Listening(server, addr) => return (server, addr),
            Startup::PortInUse => lost.push(port),
            Startup::Failed(dump) => panic!("chan devserver never listened on {port}:\n{dump}"),
        }
    }
    panic!(
        "lost the bind race on {PORT_ATTEMPTS} ports ({lost:?}); the devserver \
         started every time, another process just got there first"
    );
}

fn devserver_token(server: &Server) -> String {
    let line = server
        .out
        .find("CHAN_DEVSERVER_TOKEN=")
        .unwrap_or_else(|| panic!("no devserver token marker:\n{}", server.out.dump()));
    line.rsplit("CHAN_DEVSERVER_TOKEN=")
        .next()
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .to_string()
}

/// A loopback port that was free a moment ago, found by binding `:0` and
/// releasing it. Callers that must have exactly this port tolerate (or
/// legibly report) the rebind race.
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .expect("bind :0")
        .local_addr()
        .unwrap()
        .port()
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("reqwest client")
}

/// Poll the unauthenticated info probe until the devserver answers.
async fn wait_devserver_up(client: &reqwest::Client, addr: SocketAddr) {
    let url = format!("http://{addr}/api/devserver/info");
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                return;
            }
        }
        if Instant::now() >= deadline {
            panic!("devserver /info never came up at {addr}");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// `POST /api/devserver/workspaces` -- mount `root`, returning its prefix.
async fn mount_workspace(
    client: &reqwest::Client,
    addr: SocketAddr,
    token: &str,
    root: &Path,
) -> String {
    let url = format!("http://{addr}/api/devserver/workspaces");
    let body = serde_json::json!({ "path": root.to_string_lossy() }).to_string();
    let resp = client
        .post(&url)
        .bearer_auth(token)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .expect("POST workspaces");
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    assert!(status.is_success(), "POST workspaces -> {status}: {text}");
    let value: serde_json::Value = serde_json::from_str(&text).expect("prefix json");
    value["prefix"].as_str().expect("prefix field").to_string()
}

// ---------------------------------------------------------------------------
// The tunnel rig: devserver + mounted workspace + minted window + the
// tenant's control socket, i.e. everything a `cs tunnel` needs around it.
// ---------------------------------------------------------------------------

/// The window record fields the harness attaches with.
struct MintedWindow {
    window_id: String,
    prefix: String,
    token: String,
}

/// `POST /api/library/windows` -- mint a workspace window the way the SPA
/// launcher does, returning the attach coordinates from the record.
async fn mint_workspace_window(
    client: &reqwest::Client,
    addr: SocketAddr,
    token: &str,
    root: &Path,
) -> MintedWindow {
    let url = format!("http://{addr}/api/library/windows");
    let body = serde_json::json!({
        "kind": "workspace",
        "workspace_path": root.to_string_lossy(),
    })
    .to_string();
    let resp = client
        .post(&url)
        .bearer_auth(token)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .expect("POST library window");
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    assert!(
        status.is_success(),
        "POST library window -> {status}: {text}"
    );
    let record: serde_json::Value = serde_json::from_str(&text).expect("window record json");
    let field = |name: &str| {
        record[name]
            .as_str()
            .unwrap_or_else(|| panic!("window record missing {name}: {record}"))
            .to_string()
    };
    let minted = MintedWindow {
        window_id: field("window_id"),
        prefix: field("prefix"),
        token: field("token"),
    };
    assert!(
        !minted.token.is_empty(),
        "a running workspace's window must carry a tenant token: {record}"
    );
    minted
}

/// The devserver's stable per-tenant control sockets in the sandbox runtime
/// dir (`chan-control-s<hash>.sock`), as full paths.
fn stable_control_sockets(runtime: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(runtime)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| {
                            name.starts_with("chan-control-s") && name.ends_with(".sock")
                        })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Find the mounted workspace tenant's control socket the way a shell cannot
/// (no `$CHAN_CONTROL_SOCKET` was exported into this test): Identify every
/// stable socket and match the canonical workspace root. The terminal
/// tenant's socket reports no root and is skipped.
async fn workspace_control_socket(runtime: &Path, root: &Path) -> PathBuf {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        for path in stable_control_sockets(runtime) {
            let reply = tokio::time::timeout(
                Duration::from_secs(5),
                chan_shell::send_control_request(&path, ControlRequest::Identify),
            )
            .await;
            let Ok(Ok(reply)) = reply else { continue };
            let Ok(identity) = serde_json::from_str::<chan_shell::Identity>(&reply) else {
                continue;
            };
            if identity.workspace_root.as_deref() == Some(root) {
                return path;
            }
        }
        if Instant::now() >= deadline {
            panic!(
                "no stable control socket identified as workspace {} in {}",
                root.display(),
                runtime.display()
            );
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// The fake SPA's event socket.
type SpaSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Everything one tunnel scenario runs against. The sandbox is held (never
/// read) so its tempdirs -- including the runtime dir carrying the control
/// socket -- outlive the scenario.
struct TunnelRig {
    _sandbox: Sandbox,
    server: Server,
    addr: SocketAddr,
    /// The devserver bearer: gates the management API, the launcher API, and
    /// (as the launcher bearer) the tunnel WebSocket legs the desktop dials.
    token: String,
    window: MintedWindow,
    control_socket: PathBuf,
}

impl TunnelRig {
    async fn new() -> Self {
        let sandbox = Sandbox::new();
        let (server, addr) = spawn_devserver_on_free_port(&sandbox).await;
        let token = devserver_token(&server);
        let client = http();
        let root = sandbox.workspace("tunnel-root");
        let _prefix = mount_workspace(&client, addr, &token, &root).await;
        let window = mint_workspace_window(&client, addr, &token, &root).await;
        let control_socket = workspace_control_socket(sandbox.runtime.path(), &root).await;
        Self {
            _sandbox: sandbox,
            server,
            addr,
            token,
            window,
            control_socket,
        }
    }

    /// Hold the tenant `/ws` tagged with the minted window id -- the SPA whose
    /// presence makes the window "connected" and whose frames carry the
    /// trigger. The per-tenant token rides `?t=` exactly as the browser's does.
    async fn connect_window_ws(&self) -> SpaSocket {
        let url = format!(
            "ws://{}{}/ws?w={}&t={}",
            self.addr, self.window.prefix, self.window.window_id, self.window.token
        );
        let (socket, _) = within("tenant /ws connect", tokio_tungstenite::connect_async(url))
            .await
            .unwrap_or_else(|e| panic!("tenant /ws refused: {e}\n{}", self.server.out.dump()));
        socket
    }

    /// Open a `cs tunnel` the way the CLI does on the wire: one request line,
    /// no half-close. Dropping the returned connection is Ctrl-C.
    async fn open_cs_tunnel(
        &self,
        proto: Proto,
        bind_addr: &str,
        desktop_port: u16,
        devserver_port: u16,
    ) -> CsTunnel {
        let stream = within(
            "control socket connect",
            UnixStream::connect(&self.control_socket),
        )
        .await
        .expect("connect tenant control socket");
        let (read, mut write) = stream.into_split();
        let request = ControlRequest::Tunnel {
            window_id: self.window.window_id.clone(),
            proto,
            bind_addr: bind_addr.to_string(),
            desktop_port,
            devserver_port,
        };
        let mut line = serde_json::to_vec(&request).expect("encode tunnel request");
        line.push(b'\n');
        within("tunnel request write", write.write_all(&line))
            .await
            .expect("write tunnel request");
        CsTunnel {
            reader: BufReader::new(read),
            _write: write,
        }
    }

    /// Play the desktop: read the trigger's fields and open the real client
    /// against the devserver, authenticated with the same bearer the desktop's
    /// connection record carries for a raw attach.
    async fn open_desktop(&self, trigger: &TriggerFrame) -> TunnelHandle {
        let spec = TunnelSpec {
            proto: Proto::Tcp,
            bind_addr: trigger
                .bind_addr
                .parse()
                .unwrap_or_else(|e| panic!("trigger bind_addr {:?}: {e}", trigger.bind_addr)),
            desktop_port: trigger.desktop_port,
            devserver_port: trigger.devserver_port,
        };
        within(
            "desktop tunnel client open",
            chan_revtunnel::client::open(ClientConfig {
                base_ws_url: format!("ws://{}", self.addr),
                bearer: Some(self.token.clone()),
                cookie: None,
                origin: None,
                tunnel_id: trigger.tunnel_id.clone(),
                spec,
            }),
        )
        .await
        .unwrap_or_else(|e| panic!("desktop client open failed: {e}"))
    }
}

/// The still-open `cs tunnel` control connection. Dropping it closes both
/// halves, which the server reads as the foreground command exiting.
struct CsTunnel {
    reader: BufReader<tokio::net::unix::OwnedReadHalf>,
    _write: tokio::net::unix::OwnedWriteHalf,
}

impl CsTunnel {
    /// Read one response line, bounded, naming the step on failure.
    async fn response(&mut self, what: &str) -> ControlResponse {
        let mut line = String::new();
        let n = within(what, self.reader.read_line(&mut line))
            .await
            .unwrap_or_else(|e| panic!("reading {what}: {e}"));
        assert!(n > 0, "control socket closed instead of answering {what}");
        serde_json::from_str(&line)
            .unwrap_or_else(|e| panic!("undecodable response for {what}: {e}: {line:?}"))
    }

    async fn expect_ok(&mut self, what: &str) -> String {
        match self.response(what).await {
            ControlResponse::Ok { message } => message,
            other => panic!("{what}: expected Ok, got {other:?}"),
        }
    }

    async fn expect_error(&mut self, what: &str) -> String {
        match self.response(what).await {
            ControlResponse::Error { message } => message,
            other => panic!("{what}: expected Error, got {other:?}"),
        }
    }

    /// The server hangs up after a terminal line; anything else is a hang or
    /// a stray extra response.
    async fn expect_eof(&mut self, what: &str) {
        let mut line = String::new();
        let n = within(what, self.reader.read_line(&mut line))
            .await
            .unwrap_or_else(|e| panic!("reading {what}: {e}"));
        assert_eq!(n, 0, "{what}: expected EOF, got line {line:?}");
    }

    /// Nothing may arrive for `quiet`: a line here would mean the tunnel died.
    async fn expect_silence(&mut self, quiet: Duration) {
        let mut line = String::new();
        match tokio::time::timeout(quiet, self.reader.read_line(&mut line)).await {
            Err(_) => {}
            Ok(Ok(0)) => panic!("control socket closed while the tunnel should be up"),
            Ok(Ok(_)) => {
                panic!("unexpected control response while the tunnel should be up: {line:?}")
            }
            Ok(Err(e)) => panic!("control socket read error while the tunnel should be up: {e}"),
        }
    }
}

/// The `tunnel_open` window_command as read off the tenant `/ws`.
struct TriggerFrame {
    window_id: String,
    tunnel_id: String,
    proto: String,
    bind_addr: String,
    desktop_port: u16,
    devserver_port: u16,
}

/// Read frames until the `tunnel_open` window_command arrives, skipping the
/// roster and watch frames every `/ws` also carries.
async fn next_tunnel_open(socket: &mut SpaSocket) -> TriggerFrame {
    let deadline = Instant::now() + WAIT;
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .unwrap_or_else(|| panic!("no tunnel_open window_command arrived within {WAIT:?}"));
        let frame = tokio::time::timeout(remaining, socket.next())
            .await
            .unwrap_or_else(|_| panic!("no tunnel_open window_command arrived within {WAIT:?}"))
            .unwrap_or_else(|| panic!("tenant /ws closed before the tunnel_open arrived"))
            .expect("tenant /ws frame");
        let Message::Text(text) = frame else { continue };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(text.as_str()) else {
            continue;
        };
        if value["type"] != "window_command" || value["command"] != "tunnel_open" {
            continue;
        }
        let text_field = |name: &str| {
            value[name]
                .as_str()
                .unwrap_or_else(|| panic!("tunnel_open missing {name}: {value}"))
                .to_string()
        };
        let port_field = |name: &str| {
            u16::try_from(
                value[name]
                    .as_u64()
                    .unwrap_or_else(|| panic!("tunnel_open missing {name}: {value}")),
            )
            .unwrap_or_else(|_| panic!("tunnel_open {name} out of range: {value}"))
        };
        return TriggerFrame {
            window_id: text_field("window_id"),
            tunnel_id: text_field("tunnel_id"),
            proto: text_field("proto"),
            bind_addr: text_field("bind_addr"),
            desktop_port: port_field("desktop_port"),
            devserver_port: port_field("devserver_port"),
        };
    }
}

// ---------------------------------------------------------------------------
// Loopback endpoints on the devserver host.
// ---------------------------------------------------------------------------

/// A loopback echo service standing in for the user's devserver-side server:
/// greets every connection with a banner (proving the devserver -> desktop
/// direction flows unprompted), then echoes.
struct EchoServer {
    port: u16,
    task: tokio::task::JoinHandle<()>,
}

const BANNER: &[u8] = b"hi\n";

impl EchoServer {
    async fn bind(port: u16) -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", port)).await?;
        let port = listener.local_addr()?.port();
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    if sock.write_all(BANNER).await.is_err() {
                        return;
                    }
                    let mut buf = [0u8; 4096];
                    loop {
                        match sock.read(&mut buf).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => {
                                if sock.write_all(&buf[..n]).await.is_err() {
                                    return;
                                }
                            }
                        }
                    }
                });
            }
        });
        Ok(Self { port, task })
    }
}

impl Drop for EchoServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Dial the DESKTOP-side listener and prove the full splice: banner first
/// (devserver -> desktop with no client byte sent), then a payload echo.
/// Returns the open connection so callers can interleave several.
async fn connect_and_echo(bound: SocketAddr, payload: &[u8]) -> TcpStream {
    let mut sock = within("desktop listener connect", TcpStream::connect(bound))
        .await
        .unwrap_or_else(|e| panic!("connect {bound}: {e}"));
    let mut banner = [0u8; BANNER.len()];
    within("echo banner", sock.read_exact(&mut banner))
        .await
        .expect("read echo banner");
    assert_eq!(&banner, BANNER, "banner must arrive before any client byte");
    echo_round(&mut sock, payload).await;
    sock
}

/// One request/response on an already-open tunnel connection.
async fn echo_round(sock: &mut TcpStream, payload: &[u8]) {
    within("echo write", sock.write_all(payload))
        .await
        .expect("write echo payload");
    let mut back = vec![0u8; payload.len()];
    within("echo read", sock.read_exact(&mut back))
        .await
        .expect("read echo payload");
    assert_eq!(back, payload, "echoed bytes must round-trip unchanged");
}

// ---------------------------------------------------------------------------
// Scenarios.
// ---------------------------------------------------------------------------

/// Happy path (scenarios 1 + 2): the trigger rides the tenant `/ws` to the
/// window, the desktop's listener comes up on an ephemeral port, the ack line
/// reports the REAL bound port, bytes round-trip both ways, and a second
/// concurrent connection shares the tunnel without disturbing the first.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tunnel_round_trips_tcp_both_ways_for_concurrent_connections() {
    let rig = TunnelRig::new().await;
    let mut spa = rig.connect_window_ws().await;
    let echo = EchoServer::bind(0).await.expect("bind echo server");

    let mut cs = rig
        .open_cs_tunnel(Proto::Tcp, "127.0.0.1", 0, echo.port)
        .await;
    let trigger = next_tunnel_open(&mut spa).await;
    assert_eq!(trigger.window_id, rig.window.window_id);
    assert_eq!(trigger.proto, "tcp");
    assert_eq!(trigger.bind_addr, "127.0.0.1");
    assert_eq!(trigger.desktop_port, 0);
    assert_eq!(trigger.devserver_port, echo.port);
    assert!(
        trigger.tunnel_id.len() >= 16,
        "the tunnel id is the capability; a short one is guessable: {:?}",
        trigger.tunnel_id
    );

    let handle = rig.open_desktop(&trigger).await;
    assert_ne!(
        handle.bound.port(),
        0,
        "a port-0 ask must resolve to a real ephemeral port"
    );

    let ack = cs.expect_ok("tunnel ready ack").await;
    assert!(
        ack.contains(&handle.bound.to_string()),
        "the ack must report the RESOLVED bound address {}, not the requested \
         port 0: {ack:?}",
        handle.bound
    );
    assert!(
        ack.contains(&format!("devserver 127.0.0.1:{}", echo.port)),
        "the ack must name the devserver end: {ack:?}"
    );

    // Two concurrent connections, interleaved: B must not steal A's stream.
    let mut conn_a = connect_and_echo(handle.bound, b"alpha").await;
    let mut conn_b = connect_and_echo(handle.bound, b"bravo").await;
    echo_round(&mut conn_a, b"alpha-again").await;
    echo_round(&mut conn_b, b"bravo-again").await;
    drop(conn_a);
    drop(conn_b);

    // Ctrl-C: the connection's end is the tunnel's end, and the desktop's
    // client task winds down without being told anything else.
    drop(cs);
    within("desktop client teardown on cs exit", handle.wait()).await;
}

/// Scenario 3: nothing listening on the devserver port. Each connection is
/// accepted and then closed with no data (the dead `ssh -R` shape), and the
/// tunnel survives: once something DOES listen, the next connection works.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unreachable_devserver_port_ends_the_connection_but_not_the_tunnel() {
    let rig = TunnelRig::new().await;
    let mut spa = rig.connect_window_ws().await;
    // A port that was just free: nothing serves it until the test binds it.
    let dead_port = free_port();

    let mut cs = rig
        .open_cs_tunnel(Proto::Tcp, "127.0.0.1", 0, dead_port)
        .await;
    let trigger = next_tunnel_open(&mut spa).await;
    let handle = rig.open_desktop(&trigger).await;
    cs.expect_ok("tunnel ready ack").await;

    // The desktop listener accepts (it cannot know the far end is dead), then
    // the connection dies with zero bytes when the devserver's dial refuses.
    let mut sock = within("desktop listener connect", TcpStream::connect(handle.bound))
        .await
        .expect("connect desktop listener");
    let mut buf = [0u8; 8];
    match within("dead-port connection close", sock.read(&mut buf)).await {
        Ok(0) | Err(_) => {}
        Ok(n) => panic!(
            "received {n} bytes through a port nothing listens on: {:?}",
            &buf[..n]
        ),
    }
    drop(sock);

    // The refused dial must not have torn the tunnel down.
    cs.expect_silence(Duration::from_millis(300)).await;
    let echo = EchoServer::bind(dead_port).await.unwrap_or_else(|e| {
        panic!(
            "rebinding {dead_port} failed ({e}); if this repeats, another \
             process won the port race"
        )
    });
    let conn = connect_and_echo(handle.bound, b"revived").await;
    drop(conn);
    drop(echo);

    drop(cs);
    within("desktop client teardown on cs exit", handle.wait()).await;
}

/// Scenario 4: Ctrl-C (the cs connection closing) is the one teardown path.
/// The desktop's client ends and its listener stops serving.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn closing_the_cs_connection_stops_the_desktop_listener() {
    let rig = TunnelRig::new().await;
    let mut spa = rig.connect_window_ws().await;
    let echo = EchoServer::bind(0).await.expect("bind echo server");

    let mut cs = rig
        .open_cs_tunnel(Proto::Tcp, "127.0.0.1", 0, echo.port)
        .await;
    let trigger = next_tunnel_open(&mut spa).await;
    let handle = rig.open_desktop(&trigger).await;
    cs.expect_ok("tunnel ready ack").await;
    let bound = handle.bound;
    drop(connect_and_echo(bound, b"pre-close").await);

    drop(cs);
    within("desktop client teardown on cs exit", handle.wait()).await;

    // The listener is gone with the client task, so a fresh dial is refused
    // (or, at worst on a raced accept, closed with no data).
    let deadline = Instant::now() + WAIT;
    loop {
        match TcpStream::connect(bound).await {
            Err(_) => break,
            Ok(mut sock) => {
                let mut buf = [0u8; 8];
                match tokio::time::timeout(Duration::from_secs(1), sock.read(&mut buf)).await {
                    Ok(Ok(0)) | Ok(Err(_)) => break,
                    _ => {}
                }
            }
        }
        assert!(
            Instant::now() < deadline,
            "the desktop listener at {bound} kept serving after cs exited"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Scenario 5: the desktop dies mid-tunnel. The blocked `cs tunnel` receives
/// a SECOND response line naming the desktop's disconnect, then EOF.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_desktop_that_disconnects_writes_a_second_error_line() {
    let rig = TunnelRig::new().await;
    let mut spa = rig.connect_window_ws().await;
    let echo = EchoServer::bind(0).await.expect("bind echo server");

    let mut cs = rig
        .open_cs_tunnel(Proto::Tcp, "127.0.0.1", 0, echo.port)
        .await;
    let trigger = next_tunnel_open(&mut spa).await;
    let handle = rig.open_desktop(&trigger).await;
    cs.expect_ok("tunnel ready ack").await;
    drop(connect_and_echo(handle.bound, b"pre-stop").await);

    handle.stop();
    let second = cs.expect_error("desktop-gone second line").await;
    assert!(
        second.contains("desktop disconnected"),
        "the second line must name the desktop's death: {second:?}"
    );
    cs.expect_eof("connection close after desktop-gone").await;
}

/// Scenarios 6 + 7 (and the server-side spec re-validation): every refusal is
/// one immediate error line followed by the connection closing -- never a
/// hang, and never a udp request silently forwarded as tcp. No `/ws` is held,
/// so the windowless case is exactly "nothing can receive the trigger".
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn udp_bad_specs_and_a_windowless_tunnel_are_refused_with_one_line() {
    let rig = TunnelRig::new().await;

    // UDP parses on the wire but no end relays datagrams yet.
    let mut cs = rig
        .open_cs_tunnel(Proto::Udp, "127.0.0.1", 8080, 3000)
        .await;
    let message = cs.expect_error("udp refusal").await;
    assert!(
        message.contains("not implemented yet"),
        "udp must be refused as unimplemented: {message:?}"
    );
    cs.expect_eof("connection close after udp refusal").await;

    // The server re-validates what the CLI already validated: a raw client
    // can hand it garbage the clap edge would have caught.
    let mut cs = rig
        .open_cs_tunnel(Proto::Tcp, "not-an-address", 8080, 3000)
        .await;
    let message = cs.expect_error("bad bind address refusal").await;
    assert!(
        message.contains("invalid tunnel bind address"),
        "a malformed bind address must be named: {message:?}"
    );

    let mut cs = rig.open_cs_tunnel(Proto::Tcp, "127.0.0.1", 8080, 0).await;
    let message = cs.expect_error("devserver port 0 refusal").await;
    assert!(
        message.contains("nothing to dial"),
        "devserver port 0 must be refused: {message:?}"
    );

    // A valid ask with no window connected anywhere: the trigger has no
    // subscriber, and the user is told so instead of waiting out the ready
    // timeout.
    let mut cs = rig
        .open_cs_tunnel(Proto::Tcp, "127.0.0.1", 8080, 3000)
        .await;
    let message = cs.expect_error("windowless refusal").await;
    assert!(
        message.contains("no chan window is connected"),
        "a windowless tunnel must fail on the trigger, not the timeout: {message:?}"
    );
    cs.expect_eof("connection close after windowless refusal")
        .await;
}

/// Scenario 8: invalid specs never reach a server. The shared parser rejects
/// them, and the real `cs` binary (driven through its symlink name, with no
/// control socket in the environment) fails locally with the parser's own
/// words -- proving the CLI edge, not the socket error, answers first.
#[test]
fn invalid_specs_fail_at_the_cli_edge_without_a_server() {
    // The parser both ends share.
    assert_eq!(
        parse_spec("8080", Proto::Tcp).unwrap_err(),
        SpecError::MissingPorts
    );
    assert_eq!(
        parse_spec("70000:3000", Proto::Tcp).unwrap_err(),
        SpecError::BadDesktopPort("70000".into())
    );
    assert_eq!(
        parse_spec("8080:0", Proto::Tcp).unwrap_err(),
        SpecError::ZeroDevserverPort
    );

    // The binary, invoked as `cs`.
    let dir = tempfile::tempdir().expect("tempdir");
    let cs = dir.path().join("cs");
    std::os::unix::fs::symlink(CHAN, &cs).expect("symlink cs -> chan");
    let run = |args: &[&str]| {
        let output = Command::new(&cs)
            .args(args)
            .env_remove("CHAN_CONTROL_SOCKET")
            .env_remove("CHAN_WINDOW_ID")
            .output()
            .unwrap_or_else(|e| panic!("run cs {args:?}: {e}"));
        assert!(
            !output.status.success(),
            "cs {args:?} must fail locally: {output:?}"
        );
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        assert!(
            !stderr.contains("CHAN_CONTROL_SOCKET"),
            "cs {args:?} must fail before looking for a control socket: {stderr}"
        );
        stderr
    };

    let stderr = run(&["tunnel", "8080"]);
    assert!(
        stderr.contains("desktop-port:devserver-port"),
        "a missing port names the spec shape: {stderr}"
    );
    let stderr = run(&["tunnel", "70000:3000"]);
    assert!(
        stderr.contains("invalid desktop port"),
        "an out-of-range port names the offending end: {stderr}"
    );
    let stderr = run(&["tunnel", "8080:0"]);
    assert!(
        stderr.contains("nothing to dial"),
        "devserver port 0 is refused at parse time: {stderr}"
    );
    let stderr = run(&["tunnel", "--proto", "udp", "8080:3000"]);
    assert!(
        stderr.contains("not implemented yet"),
        "udp is refused before any round-trip: {stderr}"
    );
}
