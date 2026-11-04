//! One HTTP GET through a WireGuard tunnel, for proving the crate against
//! a real peer.
//!
//! ```text
//! wg-connect FILE HOST:PORT [PATH] [--hold SECS] [--settle SECS] [--timeout SECS]
//! ```
//!
//! Starts a tunnel from the wg-quick file, opens a TCP connection to
//! `HOST:PORT` through it, sends a minimal HTTP/1.1 GET for `PATH` (`/`
//! when none is given) and prints the status line, the headers, the body's
//! length and SHA-256, and the tunnel's own status. With `--hold SECS` the
//! tunnel stays up and idle for that long after the first response and the
//! GET is repeated, so a peer's `wg show` can be read while the tunnel is
//! idle and across the two minutes after which the protocol rekeys a
//! session the next time it carries data. `--settle SECS` keeps the tunnel
//! up for that long after the repeated GET and prints the status once more,
//! so the handshake that GET set off has completed when the peer's `wg
//! show` is read. `--timeout SECS` bounds each connect (default 30); a
//! connect that times out exits 2, every other failure exits 1.

use std::io::Write as _;
use std::net::SocketAddr;
use std::process::ExitCode;
use std::time::Duration;

use base64::Engine as _;
use chan_wireguard::config::Config;
use chan_wireguard::Tunnel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const USAGE: &str =
    "usage: wg-connect FILE HOST:PORT [PATH] [--hold SECS] [--settle SECS] [--timeout SECS]";

struct Args {
    file: String,
    target: SocketAddr,
    path: String,
    hold: Option<Duration>,
    settle: Option<Duration>,
    timeout: Duration,
}

fn parse_args() -> Result<Args, String> {
    let mut positional = Vec::new();
    let mut hold = None;
    let mut settle = None;
    let mut timeout = Duration::from_secs(30);
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--hold" => {
                let secs: u64 = args
                    .next()
                    .ok_or("--hold needs a number of seconds")?
                    .parse()
                    .map_err(|_| "--hold is not a number of seconds")?;
                hold = Some(Duration::from_secs(secs));
            }
            "--settle" => {
                let secs: u64 = args
                    .next()
                    .ok_or("--settle needs a number of seconds")?
                    .parse()
                    .map_err(|_| "--settle is not a number of seconds")?;
                settle = Some(Duration::from_secs(secs));
            }
            "--timeout" => {
                let secs: u64 = args
                    .next()
                    .ok_or("--timeout needs a number of seconds")?
                    .parse()
                    .map_err(|_| "--timeout is not a number of seconds")?;
                timeout = Duration::from_secs(secs);
            }
            _ if arg.starts_with("--") => return Err(format!("unknown option {arg}")),
            _ => positional.push(arg),
        }
    }
    if positional.len() < 2 || positional.len() > 3 {
        return Err(USAGE.to_string());
    }
    let target: SocketAddr = positional[1]
        .parse()
        .map_err(|_| format!("{} is not an address with a port", positional[1]))?;
    Ok(Args {
        file: positional[0].clone(),
        target,
        path: positional
            .get(2)
            .cloned()
            .unwrap_or_else(|| "/".to_string()),
        hold,
        settle,
        timeout,
    })
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("wg-connect: {message}");
            return ExitCode::from(1);
        }
    };
    match run(args).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(Failure::ConnectTimedOut(after)) => {
            println!("connect: timed out after {}s", after.as_secs());
            ExitCode::from(2)
        }
        Err(Failure::Other(message)) => {
            eprintln!("wg-connect: {message}");
            ExitCode::from(1)
        }
    }
}

enum Failure {
    ConnectTimedOut(Duration),
    Other(String),
}

impl From<String> for Failure {
    fn from(message: String) -> Self {
        Failure::Other(message)
    }
}

async fn run(args: Args) -> Result<(), Failure> {
    let text =
        std::fs::read_to_string(&args.file).map_err(|e| format!("reading {}: {e}", args.file))?;
    let config = Config::parse(&text).map_err(|e| format!("{}: {e}", args.file))?;
    let public_key = base64::engine::general_purpose::STANDARD.encode(config.public_key());
    println!(
        "tunnel: endpoint {}, public key {public_key}, keepalive {}",
        config.peer.endpoint,
        match config.peer.persistent_keepalive {
            Some(secs) => format!("{secs}s"),
            None => "off".to_string(),
        }
    );
    let tunnel = Tunnel::start(config)
        .await
        .map_err(|e| format!("starting the tunnel: {e}"))?;

    get(&tunnel, &args, 1).await?;
    if let Some(hold) = args.hold {
        println!("hold: {}s idle", hold.as_secs());
        let _ = std::io::stdout().flush();
        tokio::time::sleep(hold).await;
        print_status(&tunnel, "after hold");
        get(&tunnel, &args, 2).await?;
        if let Some(settle) = args.settle {
            println!("settle: {}s up after the second GET", settle.as_secs());
            let _ = std::io::stdout().flush();
            tokio::time::sleep(settle).await;
            print_status(&tunnel, "after settle");
        }
    }
    Ok(())
}

async fn get(tunnel: &Tunnel, args: &Args, n: usize) -> Result<(), Failure> {
    println!("request {n}: GET {} at {}", args.path, args.target);
    let _ = std::io::stdout().flush();
    let connect = tokio::time::timeout(args.timeout, tunnel.connect(args.target));
    let mut stream = match connect.await {
        Ok(Ok(stream)) => stream,
        Ok(Err(e)) => return Err(format!("connect {}: {e}", args.target).into()),
        Err(_) => return Err(Failure::ConnectTimedOut(args.timeout)),
    };
    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: chan-wireguard wg-connect\r\nConnection: close\r\n\r\n",
        args.path,
        args.target.ip()
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| format!("sending the request: {e}"))?;
    let mut response = Vec::new();
    tokio::time::timeout(args.timeout, stream.read_to_end(&mut response))
        .await
        .map_err(|_| format!("response {n}: timed out after {}s", args.timeout.as_secs()))?
        .map_err(|e| format!("reading the response: {e}"))?;
    drop(stream);

    let Some(split) = response.windows(4).position(|w| w == b"\r\n\r\n") else {
        return Err(format!(
            "response {n}: no end of headers in {} bytes",
            response.len()
        )
        .into());
    };
    let head = String::from_utf8_lossy(&response[..split]);
    let body = &response[split + 4..];
    let mut lines = head.lines();
    println!("response {n}: {}", lines.next().unwrap_or(""));
    for line in lines {
        println!("header {n}: {line}");
    }
    println!(
        "body {n}: {} bytes, sha256 {}",
        body.len(),
        sha256_hex(body)
    );
    if !body.is_empty()
        && body.len() <= 200
        && body
            .iter()
            .all(|b| b.is_ascii_graphic() || *b == b' ' || *b == b'\n')
    {
        println!(
            "body {n} text: {}",
            String::from_utf8_lossy(body).trim_end()
        );
    }
    print_status(tunnel, &format!("after response {n}"));
    Ok(())
}

fn print_status(tunnel: &Tunnel, when: &str) {
    let status = tunnel.status();
    println!(
        "status {when}: handshake {}, tx {} bytes, rx {} bytes, endpoint {}",
        match status.last_handshake {
            Some(ago) => format!("{:.1}s ago", ago.as_secs_f64()),
            None => "never".to_string(),
        },
        status.tx_bytes,
        status.rx_bytes,
        status.endpoint
    );
    let _ = std::io::stdout().flush();
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, bytes);
    digest.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}
