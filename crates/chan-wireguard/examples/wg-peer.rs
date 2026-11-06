//! The far side of the desktop end-to-end check: a loopback WireGuard
//! peer standing in for a gateway host, with the client's file written
//! for it.
//!
//! ```text
//! wg-peer CLIENT_FILE [--port PORT] [--status SECS]
//! wg-peer --client-key KEY [--port PORT] [--status SECS]
//! ```
//!
//! Mints a key pair for each side and writes `CLIENT_FILE`, owner-only
//! and refusing to overwrite, as the wg-quick file the client (a
//! chan-desktop gateway row, or `wg-connect`) dials this peer with: the
//! endpoint is this process's loopback UDP socket, AllowedIPs is the
//! peer's tunnel address, and `PersistentKeepalive = 5` makes the client
//! handshake at its start rather than at its first connection. Runs the
//! peer's tunnel at 10.7.0.2 with the client at 10.7.0.1, listens on
//! `PORT` (default 8080) inside it and answers every connection as an
//! HTTP server that prints the request line and answers 404 with no
//! body, so a gateway discovery reaches a real listener and fails at the
//! HTTP level, which is the expected outcome. Prints one `peer: ready`
//! line with the URL and the UDP address once listening, a `request:`
//! line per request and a `status:` line every `SECS` (default 2) with
//! the handshake age, the byte counters and the endpoint; runs until
//! killed.
//!
//! With `--client-key`, the client holds its own key pair: the peer takes
//! the client's public key (base64, as `wg` prints it), writes no file and
//! adds `public_key=` with its own public key to the ready line, so a
//! client given that key and the UDP address can dial it.
//!
//! The peer's endpoint for the client is a placeholder, the discard port
//! on loopback: the client's UDP port is unknown until it starts, nothing
//! is sent before it speaks, and the first datagram it authenticates
//! moves the endpoint to its source, as roaming does for any peer.

use std::io::Write as _;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use base64::Engine as _;
use chan_wireguard::config::{parse_public_key, Config};
use chan_wireguard::x25519::{PublicKey, StaticSecret};
use chan_wireguard::{Stream, Tunnel};
use rand_core::OsRng;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UdpSocket;

const USAGE: &str = "usage: wg-peer CLIENT_FILE | --client-key KEY [--port PORT] [--status SECS]";
const PEER_ADDRESS: &str = "10.7.0.2";
const CLIENT_ADDRESS: &str = "10.7.0.1";
const PLACEHOLDER_ENDPOINT: &str = "127.0.0.1:9";

/// A request head longer than this is answered as it stands.
const MAX_HEAD: usize = 16 * 1024;

const RESPONSE: &[u8] = b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

/// The client the peer admits.
enum Client {
    /// Minted here and written to this file.
    File(PathBuf),
    /// Holding its own private key; this is its public half.
    Key(PublicKey),
}

struct Args {
    client: Client,
    port: u16,
    status: Duration,
}

fn parse_args() -> Result<Args, String> {
    let mut positional = Vec::new();
    let mut client_key = None;
    let mut port = 8080;
    let mut status = Duration::from_secs(2);
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--client-key" => {
                let key = args.next().ok_or("--client-key needs a public key")?;
                client_key =
                    Some(parse_public_key(&key).map_err(|e| format!("--client-key: {e}"))?);
            }
            "--port" => {
                port = args
                    .next()
                    .ok_or("--port needs a port number")?
                    .parse()
                    .map_err(|_| "--port is not a port number")?;
            }
            "--status" => {
                let secs: u64 = args
                    .next()
                    .ok_or("--status needs a number of seconds")?
                    .parse()
                    .map_err(|_| "--status is not a number of seconds")?;
                status = Duration::from_secs(secs);
            }
            _ if arg.starts_with("--") => return Err(format!("unknown option {arg}")),
            _ => positional.push(arg),
        }
    }
    let client = match (positional.as_slice(), client_key) {
        ([file], None) => Client::File(PathBuf::from(file)),
        ([], Some(key)) => Client::Key(key),
        _ => return Err(USAGE.to_string()),
    };
    Ok(Args {
        client,
        port,
        status,
    })
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("wg-peer: {message}");
            return ExitCode::from(1);
        }
    };
    match run(args).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("wg-peer: {message}");
            ExitCode::from(1)
        }
    }
}

fn base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Write the client's file so that no one but the owner can ever read
/// it: created with the mode rather than tightened after, and never over
/// an existing file, since the key inside is minted for this run alone.
fn write_private(path: &Path, contents: &str) -> Result<(), String> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|e| format!("creating {}: {e}", path.display()))?;
    file.write_all(contents.as_bytes())
        .map_err(|e| format!("writing {}: {e}", path.display()))
}

async fn run(args: Args) -> Result<(), String> {
    let peer_key = StaticSecret::random_from_rng(OsRng);
    let udp = UdpSocket::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("binding the UDP socket: {e}"))?;
    let udp_at = udp
        .local_addr()
        .map_err(|e| format!("reading the UDP address: {e}"))?;

    let client_public = match &args.client {
        Client::File(path) => {
            let client_key = StaticSecret::random_from_rng(OsRng);
            let client_file = format!(
                "[Interface]\nPrivateKey = {}\nAddress = {CLIENT_ADDRESS}/32\n\n\
                 [Peer]\nPublicKey = {}\nEndpoint = {udp_at}\nAllowedIPs = {PEER_ADDRESS}/32\n\
                 PersistentKeepalive = 5\n",
                base64(&client_key.to_bytes()),
                base64(PublicKey::from(&peer_key).as_bytes()),
            );
            write_private(path, &client_file)?;
            PublicKey::from(&client_key)
        }
        Client::Key(key) => *key,
    };

    let peer_file = format!(
        "[Interface]\nPrivateKey = {}\nAddress = {PEER_ADDRESS}/32\n\n\
         [Peer]\nPublicKey = {}\nEndpoint = {PLACEHOLDER_ENDPOINT}\nAllowedIPs = {CLIENT_ADDRESS}/32\n",
        base64(&peer_key.to_bytes()),
        base64(client_public.as_bytes()),
    );
    let config = Config::parse(&peer_file).map_err(|e| format!("the peer's configuration: {e}"))?;
    let placeholder: SocketAddr = PLACEHOLDER_ENDPOINT.parse().expect("a literal address");
    let tunnel = Tunnel::start_on(config, udp, placeholder)
        .map_err(|e| format!("starting the tunnel: {e}"))?;
    let mut listener = tunnel
        .listen(args.port)
        .map_err(|e| format!("listening on port {}: {e}", args.port))?;
    let client = match &args.client {
        Client::File(path) => format!("file={}", path.display()),
        Client::Key(_) => format!(
            "public_key={}",
            base64(PublicKey::from(&peer_key).as_bytes())
        ),
    };
    println!(
        "peer: ready url=http://{PEER_ADDRESS}:{} udp={udp_at} {client}",
        listener.port()
    );

    let status = tunnel.clone();
    let every = args.status;
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(every).await;
            let s = status.status();
            println!(
                "status: handshake={} rx={} tx={} endpoint={}",
                match s.handshake {
                    chan_wireguard::HandshakeState::Live(ago) =>
                        format!("{:.1}s", ago.as_secs_f64()),
                    chan_wireguard::HandshakeState::Never
                    | chan_wireguard::HandshakeState::Lost(_) => "never".to_string(),
                },
                s.rx_bytes,
                s.tx_bytes,
                s.endpoint
                    .map_or_else(|| "unresolved".to_string(), |addr| addr.to_string())
            );
        }
    });

    loop {
        let stream = listener
            .accept()
            .await
            .map_err(|e| format!("accepting a connection: {e}"))?;
        tokio::spawn(answer(stream));
    }
}

/// Read the request head, print its first line and answer 404.
async fn answer(mut stream: Stream) {
    let from = stream.peer_addr();
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") && head.len() < MAX_HEAD {
        match stream.read(&mut byte).await {
            Ok(0) | Err(_) => break,
            Ok(_) => head.push(byte[0]),
        }
    }
    let text = String::from_utf8_lossy(&head);
    println!(
        "request: from={from} line={}",
        text.lines().next().unwrap_or("")
    );
    // The client may be gone already; there is nothing to do then.
    let _ = stream.write_all(RESPONSE).await;
    let _ = stream.shutdown().await;
}
