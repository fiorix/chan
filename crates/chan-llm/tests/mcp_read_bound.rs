//! How much of a file an MCP read takes from the disk, counted by the
//! process's own read counter (`rchar` in `/proc/self/io`), which adds up
//! every byte any thread of the process reads through a read-like system
//! call. Each file under `tests/` is its own process and this one holds a
//! single test, so nothing else reads while it counts: the workspace's
//! startup recovery is stopped first, and the MCP session runs over an
//! in-memory pipe. The only other reads in a count are the counter's own
//! reads of `/proc/self/io`, a few hundred bytes.
#![cfg(all(feature = "mcp", target_os = "linux"))]

use base64::Engine as _;
use chan_llm::mcp::Server;
use chan_workspace::Library;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};

/// The `read_media` cap the server is built with.
const CAP: u64 = 1 << 20;

/// Bytes this process has read through read-like system calls so far.
fn bytes_read() -> u64 {
    std::fs::read_to_string("/proc/self/io")
        .expect("read /proc/self/io")
        .lines()
        .find_map(|line| line.strip_prefix("rchar:"))
        .and_then(|value| value.trim().parse().ok())
        .expect("rchar in /proc/self/io")
}

async fn write_rpc<W: AsyncWrite + Unpin>(writer: &mut W, value: serde_json::Value) {
    writer
        .write_all(format!("{value}\n").as_bytes())
        .await
        .unwrap();
}

async fn read_rpc<R: AsyncBufRead + Unpin>(reader: &mut R) -> serde_json::Value {
    let mut line = String::new();
    assert_ne!(reader.read_line(&mut line).await.unwrap(), 0);
    serde_json::from_str(&line).unwrap()
}

/// Call `read_media` on `path` and return the JSON-RPC answer, with the
/// number of bytes the process read while the call ran.
async fn read_media<R, W>(
    reader: &mut R,
    writer: &mut W,
    id: u64,
    path: &str,
) -> (serde_json::Value, u64)
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let before = bytes_read();
    write_rpc(
        writer,
        serde_json::json!({"jsonrpc": "2.0", "id": id, "method": "tools/call",
            "params": {"name": "read_media", "arguments": {"path": path}}}),
    )
    .await;
    let answer = read_rpc(reader).await;
    (answer, bytes_read() - before)
}

/// `read_media` refuses a file over its cap having read none of it, and
/// the counter that shows it sees the tool read a file within the cap.
#[tokio::test]
async fn read_media_reads_none_of_a_file_over_its_cap() {
    let cfg = tempfile::TempDir::new().unwrap();
    let root = tempfile::TempDir::new().unwrap();
    let library = Library::open_at(cfg.path().join("config.toml")).unwrap();
    library.register_workspace(root.path()).unwrap();
    let workspace = library.open_workspace(root.path()).unwrap();
    workspace.stop_open_recovery();
    let within = vec![7u8; (CAP / 4) as usize];
    std::fs::write(root.path().join("within.png"), &within).unwrap();
    // Sparse, eight times the cap: a read of it returns zeros.
    let over_size = 8 * CAP;
    std::fs::File::create(root.path().join("over.png"))
        .unwrap()
        .set_len(over_size)
        .unwrap();

    let server = Server::new(workspace).with_max_media_bytes(CAP);
    let (client, peer) = tokio::io::duplex(64 * 1024);
    let (peer_read, peer_write) = tokio::io::split(peer);
    let _session = tokio::spawn(server.serve_io(peer_read, peer_write));
    let (read, mut write) = tokio::io::split(client);
    let mut read = BufReader::new(read);
    write_rpc(
        &mut write,
        serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                "clientInfo": {"name": "read-bound-test", "version": "0"}}}),
    )
    .await;
    assert_eq!(read_rpc(&mut read).await["id"], 1);
    write_rpc(
        &mut write,
        serde_json::json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
    )
    .await;

    let (answer, counted) = read_media(&mut read, &mut write, 2, "within.png").await;
    let data = answer["result"]["content"][0]["data"]
        .as_str()
        .unwrap_or_else(|| panic!("fixture: no image in {answer}"));
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(data)
            .unwrap(),
        within,
        "fixture: the file within the cap was answered with other bytes"
    );
    assert!(
        counted >= within.len() as u64,
        "fixture: the counter saw {counted} bytes read for a file of {}",
        within.len()
    );

    let (answer, counted) = read_media(&mut read, &mut write, 3, "over.png").await;
    assert_eq!(
        answer["error"]["message"],
        format!("media too large: {over_size} bytes exceeds {CAP} byte cap"),
        "fixture: {answer}"
    );
    assert!(
        counted < 8 * 1024,
        "the tool read {counted} bytes to refuse a file of {over_size} over its cap of {CAP}"
    );
}
