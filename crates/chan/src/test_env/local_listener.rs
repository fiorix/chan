//! Call-site checks with private configuration and synthetic Linux socket tables.

use std::cell::RefCell;
use std::future::Future;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::http_proxy::Route;

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Case {
    Owned,
    Foreign,
    Absent,
    Unreadable,
    Fallback,
}

thread_local! {
    // Each fixture runs on a current-thread runtime in its own child process.
    static TABLE: RefCell<Option<std::io::Result<String>>> = const { RefCell::new(None) };
}

pub(crate) fn read_table(path: &str) -> Option<std::io::Result<String>> {
    TABLE.with_borrow(|table| {
        table.as_ref().map(|table| match table {
            Ok(_) if path.ends_with("tcp6") => Ok(String::new()),
            Ok(table) => Ok(table.clone()),
            Err(error) => Err(std::io::Error::from(error.kind())),
        })
    })
}

pub(crate) fn check<F: Future<Output = ()>>(
    name: &str,
    case: Case,
    routes: Vec<Route>,
    run: impl FnOnce(SocketAddr) -> F,
) {
    const CHILD: &str = "LOCAL_LISTENER_TEST_CHILD";
    if std::env::var(CHILD).as_deref() != Ok(name) {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", name, "--nocapture", "--test-threads=1"])
            .env(CHILD, name)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "{stdout}{stderr}");
        assert!(
            stdout.contains("listener case completed"),
            "{stdout}{stderr}"
        );
        if name == "status::tests::activity_owner_refuses_foreign" {
            assert_eq!(
                stderr.matches("cannot read devserver activity:").count(),
                1,
                "{stderr}"
            );
            assert!(stderr.contains("is held by uid"), "{stderr}");
        }
        print!("{stdout}{stderr}");
        return;
    }

    let env = super::ChanTestEnv::new();
    std::env::set_var("XDG_CONFIG_HOME", env.home().join("config"));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let recorded = server.local_addr().unwrap();
        // Keep A reserved even when the table says nobody listens, so a peer
        // cannot reuse it. A bad fallback reaches this 503 stand-in and fails.
        let stale = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let pinned = if case == Case::Fallback {
            stale.local_addr().unwrap()
        } else {
            recorded
        };
        let stale_connections = Arc::new(AtomicUsize::new(0));
        let seen = stale_connections.clone();
        let stale_peer = tokio::spawn(async move {
            loop {
                let (mut socket, _) = stale.accept().await.unwrap();
                seen.fetch_add(1, Ordering::SeqCst);
                socket
                    .write_all(
                        b"HTTP/1.1 503 Unavailable\r\n\
                     content-length: 0\r\n\
                     connection: close\r\n\r\n",
                    )
                    .await
                    .unwrap();
            }
        });
        let uid = rustix::process::geteuid().as_raw();
        let table = match case {
            Case::Unreadable => Err(std::io::ErrorKind::PermissionDenied.into()),
            Case::Absent => Ok(String::new()),
            _ => {
                let owner = if case == Case::Foreign { uid + 1 } else { uid };
                let word = u32::from_ne_bytes([127, 0, 0, 1]);
                Ok(format!(
                    "0: {word:08X}:{:04X} 00000000:0000 0A 0:0 0:0 0 {owner}\n",
                    recorded.port()
                ))
            }
        };
        TABLE.set(Some(table));
        let units = env.home().join("config/systemd/user");
        std::fs::create_dir_all(&units).unwrap();
        std::fs::write(
            units.join("chan-devserver.service"),
            format!(
                "[Service]\nExecStart=/usr/bin/chan devserver run --bind=127.0.0.1 --port={}\n",
                pinned.port()
            ),
        )
        .unwrap();
        let state = env.home().join("devserver");
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(
            state.join("config.json"),
            format!(
                r#"{{"devserver_token":"test-token","port":{}}}"#,
                recorded.port()
            ),
        )
        .unwrap();
        let connections = Arc::new(AtomicUsize::new(0));
        let seen = connections.clone();
        let expected = if matches!(case, Case::Owned | Case::Fallback) {
            routes.len()
        } else {
            0
        };
        let peer = tokio::spawn(async move {
            for route in routes {
                let (mut socket, _) = server.accept().await.unwrap();
                seen.fetch_add(1, Ordering::SeqCst);
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    head.push(socket.read_u8().await.unwrap());
                    assert!(head.len() < 16384);
                }
                let head = String::from_utf8(head).unwrap().to_ascii_lowercase();
                assert!(
                    head.starts_with(&format!(
                        "{} {} http/1.1\r\n",
                        route.method.to_ascii_lowercase(),
                        route.path
                    )),
                    "{head}"
                );
                assert!(
                    head.contains(&format!(
                        "authorization: bearer {}\r\n",
                        route.token.unwrap()
                    )),
                    "{head}"
                );
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\n\
                     content-type: application/json\r\n\
                     content-length: {}\r\n\
                     connection: close\r\n\r\n{}",
                            route.body.len(),
                            route.body
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
        });
        tokio::time::timeout(Duration::from_secs(15), run(pinned))
            .await
            .expect("bounded caller");
        tokio::task::yield_now().await;
        assert_eq!(
            connections.load(Ordering::SeqCst),
            expected,
            "bearers sent to fixture listener"
        );
        assert_eq!(
            stale_connections.load(Ordering::SeqCst),
            0,
            "stale pinned address was dialed"
        );
        if expected > 0 {
            tokio::time::timeout(Duration::from_secs(2), peer)
                .await
                .expect("all routes served")
                .unwrap();
        } else {
            peer.abort();
            assert!(peer.await.unwrap_err().is_cancelled());
        }
        stale_peer.abort();
        assert!(stale_peer.await.unwrap_err().is_cancelled());
        TABLE.set(None);
        println!("listener case completed");
    });
}
