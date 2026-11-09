//! CLI diagnostics and the socket-activated Varlink adapter.

#[cfg(any(target_os = "linux", test))]
mod listener;
#[cfg(unix)]
mod varlink;

use std::time::Duration;

use anyhow::{Context, Result};
use chan_server::metrics::View;
use clap::Args;

#[derive(Args, Debug, Clone)]
pub(crate) struct MetricsArgs {
    /// Server base URL, optionally carrying its launch token (?t=...).
    /// Omit to query the devserver belonging to this CHAN_HOME.
    #[arg(long)]
    pub url: Option<String>,
    /// Bearer for an explicit URL; can also be set in CHAN_METRICS_TOKEN.
    #[arg(
        long,
        env = "CHAN_METRICS_TOKEN",
        hide_env_values = true,
        requires = "url"
    )]
    pub token: Option<String>,
    /// Emit the shared metrics schema as JSON.
    #[arg(long)]
    pub json: bool,
    /// Repeat about every second with only what is new: the first output is
    /// complete and each later one carries only newer samples. JSON mode
    /// emits one object per line.
    #[arg(long)]
    pub watch: bool,
    /// Include the server's bounded sample history in JSON output; under
    /// --watch, later lines hold only the samples newer than the last.
    #[arg(long, requires = "json")]
    pub history: bool,
    /// Serve Varlink on stdin/stdout (systemd StandardInput=socket).
    #[arg(long, conflicts_with_all = ["json", "watch", "history"])]
    pub varlink: bool,
}

pub(crate) struct Client {
    args: MetricsArgs,
    http: reqwest::Client,
}

impl Client {
    pub(crate) fn new(args: MetricsArgs) -> Result<Self> {
        let mut http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5));
        // The local devserver is on this host and its bearer must reach only
        // the listener `local_target` checked. reqwest otherwise takes the
        // proxy from the environment (and on macOS and Windows the system),
        // with no loopback exemption, and would hand the bearer to it. An
        // explicit URL keeps the user's proxy, which a remote server may need.
        if args.url.is_none() {
            http = http.no_proxy();
        }
        Ok(Self {
            args,
            http: http.build()?,
        })
    }

    pub(crate) async fn read(&self, history: bool, since: Option<u64>) -> Result<View> {
        // Resolve on every read: the activated adapter can outlive a server
        // restart, port change or token rotation.
        let (url, token) = match &self.args.url {
            Some(raw) => explicit_target(raw, self.args.token.as_deref())?,
            None => local_target()?,
        };
        let mut request = self
            .http
            .get(url)
            .query(&[("history", history.to_string())]);
        if let Some(since) = since {
            request = request.query(&[("since", since)]);
        }
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        let response = request
            .send()
            .await
            .context("cannot reach metrics server")?;
        let status = response.status();
        anyhow::ensure!(status.is_success(), "metrics server returned {status}");
        let view: View = response.json().await.context("invalid metrics response")?;
        anyhow::ensure!(
            view.schema_version == 1,
            "unsupported metrics schema {}",
            view.schema_version
        );
        Ok(view)
    }
}

/// The local devserver's metrics URL and bearer. The address is the one the
/// devserver unit pins, else the persisted port on loopback; the bearer is
/// the devserver's own.
fn local_target() -> Result<(reqwest::Url, Option<String>)> {
    let addr = crate::devserver::persisted::local_devserver_dial_addr()
        .context("no local devserver port; start a devserver or use --url")?;
    // A wildcard bind is reached on loopback.
    let addr = match addr.ip() {
        std::net::IpAddr::V4(ip) if ip.is_unspecified() => {
            std::net::SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, addr.port()))
        }
        std::net::IpAddr::V6(ip) if ip.is_unspecified() => {
            std::net::SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, addr.port()))
        }
        _ => addr,
    };
    let token = chan_server::persisted_devserver_token()
        .context("no local devserver token; start a devserver or use --url")?;
    // The persisted port outlives the devserver, so before the bearer goes
    // out, Linux checks the listener there is this user's. macOS, FreeBSD
    // and Windows name socket owners only through binary sysctl records or
    // per-process handle walks, none of them a small and sound check, so
    // there the bearer goes to the port unverified.
    #[cfg(target_os = "linux")]
    listener::ensure_caller_listens(addr)?;
    let url = reqwest::Url::parse(&format!("http://{addr}/"))?;
    Ok((metrics_url(url), Some(token)))
}

/// The metrics route for a server URL as chan prints it: a launcher or
/// unprefixed serve URL (`/?t=`) names the server root, and a tenant URL
/// (`/<prefix>/index.html?t=`, or the prefix alone) names the tenant, whose
/// routes are mounted under its prefix.
fn metrics_url(mut url: reqwest::Url) -> reqwest::Url {
    let path = url.path();
    let base = path
        .strip_suffix("/index.html")
        .unwrap_or(path)
        .trim_end_matches('/');
    let path = format!("{base}/api/metrics");
    url.set_path(&path);
    url.set_query(None);
    url.set_fragment(None);
    url
}

fn explicit_target(raw: &str, token: Option<&str>) -> Result<(reqwest::Url, Option<String>)> {
    let url = reqwest::Url::parse(raw).context("invalid metrics URL")?;
    anyhow::ensure!(
        matches!(url.scheme(), "http" | "https") && url.host_str().is_some(),
        "metrics URL must use HTTP or HTTPS"
    );
    anyhow::ensure!(
        url.username().is_empty() && url.password().is_none(),
        "metrics URL cannot contain userinfo"
    );
    let token = token.map(str::to_owned).or_else(|| {
        url.query_pairs()
            .find(|(key, _)| key == "t")
            .map(|(_, value)| value.into_owned())
    });
    Ok((metrics_url(url), token))
}

/// Where a stream reads its views: the HTTP client, or in tests a runtime.
pub(crate) trait Source {
    async fn read(&self, history: bool, since: Option<u64>) -> Result<View>;
}

impl Source for Client {
    async fn read(&self, history: bool, since: Option<u64>) -> Result<View> {
        Client::read(self, history, since).await
    }
}

/// A subscribe-style stream of views, as systemd's subscribe methods send
/// state: the first view is complete, and each later one carries only the
/// samples newer than the last one sent, with `latest` the newest and
/// nothing sent while nothing is newer. A new `identity.instanceId` between
/// two successful reads means the server restarted and its sequences with
/// it, so the stream starts over with a complete view. A failed read is
/// returned to the caller, which ends the stream: `--watch` exits with it and
/// a Varlink call ends with `Unavailable`.
pub(crate) struct Subscription {
    history: bool,
    since: Option<u64>,
    /// The instance and the newest sequence already sent, if any was.
    sent: Option<(String, Option<u64>)>,
}

impl Subscription {
    pub(crate) fn new(history: bool, since: Option<u64>) -> Self {
        Self {
            history,
            since,
            sent: None,
        }
    }

    /// The next view to send, or `None` when nothing is newer than what was.
    pub(crate) async fn next(&mut self, source: &impl Source) -> Result<Option<View>> {
        // The caller's `since` shapes the first reply alone. After that each
        // reply holds what is newer than the last sample sent, even when the
        // caller asked from past the server's newest sample.
        let since = match &self.sent {
            None => self.since,
            Some((_, newest)) => *newest,
        };
        let mut view = source.read(self.history, since).await?;
        if let Some((instance, newest)) = &self.sent {
            if view.identity.instance_id != *instance {
                // A restarted server numbers its samples afresh.
                view = source.read(self.history, None).await?;
            } else if view.latest.as_ref().map(|sample| sample.sequence) <= *newest {
                return Ok(None);
            }
        }
        self.sent = Some((
            view.identity.instance_id.clone(),
            view.latest.as_ref().map(|sample| sample.sequence),
        ));
        Ok(Some(view))
    }
}

pub(crate) async fn cmd_metrics(args: MetricsArgs) -> Result<()> {
    let client = Client::new(args.clone())?;
    if args.varlink {
        #[cfg(unix)]
        return varlink::serve(&client, tokio::io::stdin(), tokio::io::stdout()).await;
        #[cfg(not(unix))]
        anyhow::bail!("Varlink socket activation is available on Unix");
    }
    if !args.watch {
        let view = client.read(args.history, None).await?;
        if args.json {
            println!("{}", serde_json::to_string_pretty(&view)?);
        } else {
            print!("{}", render(&view));
        }
        return Ok(());
    }
    let mut stream = Subscription::new(args.history, None);
    loop {
        if let Some(view) = stream.next(&client).await? {
            if args.json {
                println!("{}", serde_json::to_string(&view)?);
            } else {
                print!("{}", render(&view));
            }
        }
        tokio::select! {
            _ = tokio::signal::ctrl_c() => return Ok(()),
            _ = tokio::time::sleep(Duration::from_secs(1)) => {}
        }
    }
}

fn bytes(value: u64) -> String {
    let mut n = value as f64;
    let units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut i = 0;
    while n >= 1024.0 && i < units.len() - 1 {
        n /= 1024.0;
        i += 1;
    }
    format!("{n:.1} {}", units[i])
}

fn per_second(value: Option<f64>) -> String {
    value
        .map(|v| format!("{}/s", bytes(v.max(0.0) as u64)))
        .unwrap_or_else(|| "n/a".into())
}

fn render(view: &View) -> String {
    let identity = &view.identity;
    let mut out = format!(
        "chan {} ({})  PID {}  Host: {}\n",
        identity.version,
        identity.build,
        identity.pid,
        identity.hostname.as_deref().unwrap_or("n/a")
    );
    let Some(sample) = &view.latest else {
        out.push_str("Waiting for the first sample.\n");
        return out;
    };
    if let Some(process) = &sample.process {
        let cpu = process
            .cpu_percent
            .map(|v| format!("{v:.1}%"))
            .unwrap_or_else(|| "n/a".into());
        out.push_str(&format!(
            "Uptime {}s  CPU {}  RSS {}\n",
            process.uptime_seconds,
            cpu,
            bytes(process.resident_bytes)
        ));
        out.push_str(&format!(
            "{} read {} ({})  write {} ({})\n",
            process.io_scope,
            process
                .read_bytes
                .map(bytes)
                .unwrap_or_else(|| "n/a".into()),
            per_second(process.read_bytes_per_second),
            process
                .written_bytes
                .map(bytes)
                .unwrap_or_else(|| "n/a".into()),
            per_second(process.written_bytes_per_second)
        ));
    } else {
        out.push_str("Process readings unavailable.\n");
    }
    for (name, traffic) in [
        ("Service transport", &sample.network),
        ("HTTP/2 payload", &sample.http2),
        ("yamux payload", &sample.yamux),
        ("Reverse TCP", &sample.reverse_connections),
        ("File payload", &sample.transfer_payload),
    ] {
        out.push_str(&format!(
            "{name}: {} active  RX {} ({})  TX {} ({})\n",
            traffic.totals.active,
            bytes(traffic.totals.received_bytes),
            per_second(traffic.received_bytes_per_second),
            bytes(traffic.totals.sent_bytes),
            per_second(traffic.sent_bytes_per_second)
        ));
    }
    let t = &sample.transfers;
    out.push_str(&format!("Transfers: {}/{} running, {}/{} queued, {} finished, {} cancelled, {} stalled, {} refused\n",
        t.running,t.worker_capacity,t.queued,t.queue_capacity,t.finished,t.cancelled,t.stalled,t.refused));
    out.push_str(&format!(
        "Tunnels: {} gateway, {} reverse listeners; yamux {}/{} serving, {} waiting\n",
        sample.gateway_tunnels,
        sample.reverse_listeners,
        sample.yamux_serving,
        sample.yamux_service_capacity,
        sample.yamux_waiting
    ));
    let storage = &view.storage;
    out.push_str(&format!(
        "{}: {} logical, {} allocated{}\n",
        storage.path,
        storage
            .logical_bytes
            .map(bytes)
            .unwrap_or_else(|| "pending".into()),
        storage
            .allocated_bytes
            .map(bytes)
            .unwrap_or_else(|| "n/a".into()),
        if storage.error.is_some() {
            " (scan failed; last completed total)"
        } else {
            ""
        }
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_io_stays_unavailable_in_terminal_output() {
        let home = tempfile::tempdir().unwrap();
        let runtime = chan_server::metrics::Runtime::start(home.path().into()).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut view = loop {
            let view = runtime.view(false, None);
            if view
                .latest
                .as_ref()
                .and_then(|sample| sample.process.as_ref())
                .is_some()
            {
                break view;
            }
            assert!(std::time::Instant::now() < deadline, "no process sample");
            std::thread::sleep(Duration::from_millis(10));
        };
        let process = view.latest.as_mut().unwrap().process.as_mut().unwrap();
        process.io_scope = "unavailable".into();
        process.read_bytes = None;
        process.written_bytes = None;
        process.read_bytes_per_second = None;
        process.written_bytes_per_second = None;
        assert!(render(&view).contains("unavailable read n/a (n/a)  write n/a (n/a)"));
    }

    #[test]
    fn explicit_targets_do_not_inherit_local_credentials_and_strip_launch_secrets() {
        let (url, token) = explicit_target("https://example.test/work?t=secret#x", None).unwrap();
        assert_eq!(url.as_str(), "https://example.test/work/api/metrics");
        assert_eq!(token.as_deref(), Some("secret"));
        assert!(explicit_target("https://example.test/", None)
            .unwrap()
            .1
            .is_none());
        assert!(explicit_target("https://user:secret@example.test/", None).is_err());
        assert!(explicit_target("file:///tmp/x", None).is_err());
    }

    #[test]
    fn explicit_targets_resolve_every_url_shape_chan_prints() {
        let resolve = |raw: &str| explicit_target(raw, None).unwrap().0.to_string();
        // `chan serve` and `chan serve --prefix`, printed by the one launch URL
        // builder; a prefixed tenant's routes are mounted under its prefix.
        let addr = "127.0.0.1:1234".parse().unwrap();
        for (prefix, path) in [
            ("", "/api/metrics"),
            ("/notes", "/notes/api/metrics"),
            ("/team/notes-1a2b", "/team/notes-1a2b/api/metrics"),
        ] {
            let printed = chan_server::ServeHandle {
                addr,
                prefix: prefix.into(),
                token: Some("token".into()),
            }
            .launch_url();
            assert_eq!(
                resolve(&printed),
                format!("http://127.0.0.1:1234{path}"),
                "{printed}"
            );
        }
        for (printed, resolved) in [
            // The devserver's launcher URL and its marker line.
            (
                "http://127.0.0.1:8787/?t=tok",
                "http://127.0.0.1:8787/api/metrics",
            ),
            ("http://127.0.0.1:8787", "http://127.0.0.1:8787/api/metrics"),
            // The desktop's window and terminal tenants.
            (
                "http://127.0.0.1:4090/api/w-1/index.html?t=x&w=w-1",
                "http://127.0.0.1:4090/api/w-1/api/metrics",
            ),
            (
                "http://127.0.0.1:4090/terminal/index.html?t=x",
                "http://127.0.0.1:4090/terminal/api/metrics",
            ),
            // The docs/metrics.md example, a tenant prefix without index.html.
            (
                "http://127.0.0.1:8787/workspace?t=TOKEN",
                "http://127.0.0.1:8787/workspace/api/metrics",
            ),
            (
                "http://127.0.0.1:8787/workspace/",
                "http://127.0.0.1:8787/workspace/api/metrics",
            ),
        ] {
            assert_eq!(resolve(printed), resolved, "{printed}");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_local_target_is_the_pinned_listener_and_only_this_users() {
        let env = crate::test_env::ChanTestEnv::new();
        // The unit directory comes from XDG_CONFIG_HOME, which the guard does
        // not own; point it into the guard's home for this test alone.
        struct Restore(Option<std::ffi::OsString>);
        impl Drop for Restore {
            fn drop(&mut self) {
                match self.0.take() {
                    Some(value) => std::env::set_var("XDG_CONFIG_HOME", value),
                    None => std::env::remove_var("XDG_CONFIG_HOME"),
                }
            }
        }
        let _restore = Restore(std::env::var_os("XDG_CONFIG_HOME"));
        std::env::set_var("XDG_CONFIG_HOME", env.home().join("config"));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let pinned = listener.local_addr().unwrap().port();
        let units = env.home().join("config").join("systemd").join("user");
        std::fs::create_dir_all(&units).unwrap();
        std::fs::write(
            units.join("chan-devserver.service"),
            format!(
                "[Service]\nExecStart=/usr/bin/chan devserver run --bind=0.0.0.0 --port={pinned}\n"
            ),
        )
        .unwrap();
        // The persisted port is stale: the unit's pinned one wins.
        let stale = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let stale_port = stale.local_addr().unwrap().port();
        drop(stale);
        let state = env.home().join("devserver");
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(
            state.join("config.json"),
            format!(r#"{{"devserver_token":"tok","port":{stale_port}}}"#),
        )
        .unwrap();
        let (url, token) = local_target().unwrap();
        assert_eq!(
            url.as_str(),
            format!("http://127.0.0.1:{pinned}/api/metrics")
        );
        assert_eq!(token.as_deref(), Some("tok"));
        // With this user's listener gone, the bearer goes nowhere.
        drop(listener);
        let error = local_target().unwrap_err().to_string();
        assert!(error.contains("no devserver is listening"), "{error}");
    }

    /// The child half of `a_local_read_ignores_a_proxy_in_the_environment`.
    /// Proxy variables are process-wide and every reqwest client reads them
    /// when it is built, so they are set only in a child process that runs
    /// this case alone.
    #[cfg(target_os = "linux")]
    fn local_read_through_a_proxy_environment() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let env = crate::test_env::ChanTestEnv::new();
        std::env::set_var("XDG_CONFIG_HOME", env.home().join("config"));
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let proxy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
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
        let state = env.home().join("devserver");
        std::fs::create_dir_all(&state).unwrap();
        let port = server.local_addr().unwrap().port();
        std::fs::write(
            state.join("config.json"),
            format!(r#"{{"devserver_token":"tok","port":{port}}}"#),
        )
        .unwrap();
        let view = chan_server::metrics::Runtime::start(env.home().join("metrics-home"))
            .unwrap()
            .view(false, None);
        let body = serde_json::to_string(&view).unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async move {
            let proxied = std::sync::Arc::new(AtomicBool::new(false));
            let proxy = tokio::net::TcpListener::from_std({
                proxy.set_nonblocking(true).unwrap();
                proxy
            })
            .unwrap();
            let seen = proxied.clone();
            tokio::spawn(async move {
                // A proxy that takes the request answers nothing.
                if let Ok((socket, _)) = proxy.accept().await {
                    seen.store(true, Ordering::SeqCst);
                    drop(socket);
                }
            });
            server.set_nonblocking(true).unwrap();
            let server = tokio::net::TcpListener::from_std(server).unwrap();
            tokio::spawn(async move {
                let (mut socket, _) = server.accept().await.unwrap();
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    let mut byte = [0u8; 1];
                    if socket.read(&mut byte).await.unwrap() == 0 {
                        return;
                    }
                    head.push(byte[0]);
                }
                assert!(String::from_utf8_lossy(&head)
                    .to_ascii_lowercase()
                    .contains("authorization: bearer tok"));
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            });
            let client = Client::new(MetricsArgs {
                url: None,
                token: None,
                json: false,
                watch: false,
                history: false,
                varlink: false,
            })
            .unwrap();
            let read = client.read(false, None).await;
            assert!(!proxied.load(Ordering::SeqCst), "the bearer went to the proxy");
            assert_eq!(read.unwrap().schema_version, 1);
        });
        println!("local read answered directly");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_local_read_ignores_a_proxy_in_the_environment() {
        const CHILD: &str = "METRICS_PROXY_TEST_CHILD";
        const NAME: &str = "metrics::tests::a_local_read_ignores_a_proxy_in_the_environment";
        if std::env::var_os(CHILD).is_some() {
            return local_read_through_a_proxy_environment();
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", NAME, "--nocapture", "--test-threads=1"])
            .env(CHILD, "1")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "{stdout}{stderr}");
        // A filter that matched nothing would pass too; the child prints
        // this only after its case ran to the end.
        assert!(
            stdout.contains("local read answered directly"),
            "the child did not run its case: {stdout}"
        );
    }

    /// Views from a script, recording the `since` each read asked for.
    struct Script {
        views: std::sync::Mutex<std::collections::VecDeque<View>>,
        asked: std::sync::Mutex<Vec<Option<u64>>>,
    }

    impl Source for Script {
        async fn read(&self, history: bool, since: Option<u64>) -> Result<View> {
            assert!(history);
            self.asked.lock().unwrap().push(since);
            let mut view = self
                .views
                .lock()
                .unwrap()
                .pop_front()
                .expect("an unscripted read");
            // The route's filter.
            view.history
                .retain(|sample| since.is_none_or(|seq| sample.sequence > seq));
            Ok(view)
        }
    }

    /// A real view with a sample, to copy scripted views from.
    async fn sampled_view() -> View {
        let home = tempfile::tempdir().unwrap();
        let runtime = chan_server::metrics::Runtime::start(home.path().into()).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let view = runtime.view(false, None);
            if view.latest.is_some() {
                return view;
            }
            assert!(std::time::Instant::now() < deadline, "no sample");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// The history and latest sequences of a sent view.
    fn sequences(view: Option<View>) -> Option<(Vec<u64>, Option<u64>)> {
        view.map(|view| {
            let latest = view.latest.map(|sample| sample.sequence);
            let history = view.history.iter().map(|s| s.sequence).collect();
            (history, latest)
        })
    }

    fn view_of(base: &View, instance: &str, sequences: std::ops::RangeInclusive<u64>) -> View {
        let sample = base.latest.clone().unwrap();
        let mut view = base.clone();
        view.identity.instance_id = instance.into();
        view.history = sequences
            .map(|sequence| chan_server::metrics::Sample {
                sequence,
                ..sample.clone()
            })
            .collect();
        view.latest = view.history.last().cloned();
        view
    }

    #[tokio::test]
    async fn a_subscription_sends_the_whole_view_once_then_only_what_is_new() {
        let base = sampled_view().await;
        let script = Script {
            views: std::sync::Mutex::new(
                [
                    view_of(&base, "a", 1..=5),
                    view_of(&base, "a", 1..=6),
                    view_of(&base, "a", 1..=6),
                    view_of(&base, "a", 1..=8),
                    // A restart: the new instance's sequences start again.
                    view_of(&base, "b", 1..=2),
                    view_of(&base, "b", 1..=2),
                    view_of(&base, "b", 1..=3),
                ]
                .into(),
            ),
            asked: Default::default(),
        };
        let mut stream = Subscription::new(true, Some(2));
        let expected = [
            Some((vec![3, 4, 5], Some(5))),
            Some((vec![6], Some(6))),
            // Nothing newer, nothing sent.
            None,
            Some((vec![7, 8], Some(8))),
            // The restart starts over with the whole view.
            Some((vec![1, 2], Some(2))),
            Some((vec![3], Some(3))),
        ];
        for expected in expected {
            assert_eq!(sequences(stream.next(&script).await.unwrap()), expected);
        }
        assert_eq!(
            *script.asked.lock().unwrap(),
            [Some(2), Some(5), Some(6), Some(6), Some(8), None, Some(2)]
        );
    }

    #[tokio::test]
    async fn a_since_past_the_servers_newest_sample_shapes_only_the_first_reply() {
        // A caller resuming from an older instance can ask from a sequence
        // this server has not reached; later replies still carry what is new.
        let base = sampled_view().await;
        let script = Script {
            views: std::sync::Mutex::new(
                [
                    view_of(&base, "a", 1..=5),
                    view_of(&base, "a", 1..=6),
                    view_of(&base, "a", 1..=8),
                ]
                .into(),
            ),
            asked: Default::default(),
        };
        let mut stream = Subscription::new(true, Some(900));
        for expected in [
            Some((vec![], Some(5))),
            Some((vec![6], Some(6))),
            Some((vec![7, 8], Some(8))),
        ] {
            assert_eq!(sequences(stream.next(&script).await.unwrap()), expected);
        }
        assert_eq!(*script.asked.lock().unwrap(), [Some(900), Some(5), Some(6)]);
    }
}
