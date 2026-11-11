//! Proxy tests run alone in child processes because reqwest reads ambient settings.

use std::future::Future;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(crate) struct Route {
    pub method: &'static str,
    pub path: &'static str,
    pub token: Option<&'static str>,
    pub body: &'static str,
}

pub(crate) fn check<F: Future<Output = ()>>(
    name: &str,
    routes: Vec<Route>,
    expected_proxy_connections: usize,
    run: impl FnOnce(SocketAddr) -> F,
) {
    const CHILD: &str = "LOCAL_HTTP_PROXY_TEST_CHILD";
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
            stdout.contains("proxy case completed"),
            "child did not run its case: {stdout}{stderr}"
        );
        print!("{stdout}{stderr}");
        return;
    }

    let env = super::ChanTestEnv::new();
    std::env::set_var("XDG_CONFIG_HOME", env.home().join("config"));
    let proxy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    proxy.set_nonblocking(true).unwrap();
    let proxy_url = format!("http://{}", proxy.local_addr().unwrap());
    for name in [
        "http_proxy",
        "HTTP_PROXY",
        "https_proxy",
        "HTTPS_PROXY",
        "all_proxy",
        "ALL_PROXY",
    ] {
        std::env::set_var(name, &proxy_url);
    }
    for name in ["no_proxy", "NO_PROXY", "REQUEST_METHOD"] {
        std::env::remove_var(name);
    }

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let proxy = tokio::net::TcpListener::from_std(proxy).unwrap();
        let connections = Arc::new(AtomicUsize::new(0));
        let seen = connections.clone();
        let recorder = tokio::spawn(async move {
            loop {
                let (socket, _) = proxy.accept().await.unwrap();
                seen.fetch_add(1, Ordering::SeqCst);
                eprintln!("recording proxy accepted a connection");
                drop(socket);
            }
        });
        let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = server.local_addr().unwrap();
        let state = env.home().join("devserver");
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(
            state.join("config.json"),
            format!(r#"{{"devserver_token":"test-token","port":{}}}"#, addr.port()),
        )
        .unwrap();
        let peer = tokio::spawn(async move {
            for route in routes {
                let (mut socket, _) = server.accept().await.unwrap();
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    let byte = socket.read_u8().await.unwrap();
                    head.push(byte);
                    assert!(head.len() < 16384, "request headers exceed fixture limit");
                }
                let head = String::from_utf8(head).unwrap().to_ascii_lowercase();
                assert!(head.starts_with(&format!(
                    "{} {} http/1.1\r\n", route.method.to_ascii_lowercase(), route.path
                )), "unexpected request: {head}");
                match route.token {
                    Some(token) => assert!(head.contains(&format!("authorization: bearer {token}\r\n"))),
                    None => assert!(!head.contains("authorization:")),
                }
                eprintln!("stand-in received {} {}", route.method, route.path);
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    route.body.len(), route.body
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        tokio::time::timeout(Duration::from_secs(15), run(addr))
            .await
            .expect("proxy test finishes within its deadline");
        assert_eq!(connections.load(Ordering::SeqCst), expected_proxy_connections);
        tokio::time::timeout(Duration::from_secs(5), peer)
            .await
            .expect("all stand-in routes were called")
            .unwrap();
        recorder.abort();
        assert!(recorder.await.unwrap_err().is_cancelled());
        println!("proxy case completed");
    });
}
