//! CLI diagnostics and the socket-activated Varlink adapter.

#[cfg(unix)]
mod varlink;

use std::time::Duration;

use anyhow::{Context, Result};
use chan_server::metrics::{View, SCHEMA_VERSION};

use crate::cli::MetricsArgs;

pub(crate) struct Client {
    args: MetricsArgs,
    http: reqwest::Client,
}

impl Client {
    pub(crate) fn new(args: MetricsArgs) -> Result<Self> {
        let timeout = Duration::from_secs(5);
        let http = if args.url.is_some() {
            crate::http_client::explicit_url(timeout)?
        } else {
            crate::http_client::local_devserver(timeout)?
        };
        Ok(Self { args, http })
    }

    /// The metrics URL and bearer to read, resolved afresh on every read: the
    /// activated adapter can outlive a server restart, port change or token
    /// rotation.
    fn target(&self) -> Result<(reqwest::Url, Option<String>)> {
        match &self.args.url {
            Some(raw) => explicit_target(raw, url_token(self.args.token.as_deref()).as_deref()),
            None => local_target(),
        }
    }

    pub(crate) async fn read(&self, history: bool, since: Option<u64>) -> Result<View> {
        let (url, token) = self.target()?;
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
        let body = response
            .bytes()
            .await
            .context("cannot read the metrics response")?;
        decode(&body)
    }
}

/// Decode a metrics response. The schema version is read before the view: a
/// version this build does not know has a shape it cannot decode, and the
/// version is the thing to report, not the first field that differs.
fn decode(body: &[u8]) -> Result<View> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Versioned {
        schema_version: u32,
    }
    let Versioned { schema_version } =
        serde_json::from_slice(body).context("invalid metrics response")?;
    anyhow::ensure!(
        schema_version == SCHEMA_VERSION,
        "unsupported metrics schema {schema_version}"
    );
    serde_json::from_slice(body).context("invalid metrics response")
}

/// The local devserver's metrics URL and bearer. The address is the one the
/// devserver unit pins, else the persisted port on loopback, which Linux
/// also reads when no listener of this user's is at the pinned one; the
/// bearer is the devserver's own.
fn local_target() -> Result<(reqwest::Url, Option<String>)> {
    use crate::devserver::persisted;
    let addr = persisted::local_devserver_dial_addr()
        .context("no local devserver port; start a devserver or use --url")?;
    let token = chan_server::persisted_devserver_token()
        .context("no local devserver token; start a devserver or use --url")?;
    let addr = crate::local_listener::resolve(addr)?;
    let url = reqwest::Url::parse(&format!("http://{addr}/"))?;
    Ok((metrics_url(url), Some(token)))
}

/// The metrics route for a server URL as chan prints it: a launcher or
/// unprefixed serve URL (`/?t=`) names the server root, and a tenant URL
/// (`/<prefix>/index.html?t=`, or the prefix alone) names the tenant, whose
/// routes are mounted under its prefix. A URL that already ends in the
/// route names the same server or tenant, and is not appended to.
fn metrics_url(mut url: reqwest::Url) -> reqwest::Url {
    const ROUTE: &str = "/api/metrics";
    let path = url.path();
    let base = path
        .strip_suffix("/index.html")
        .unwrap_or(path)
        .trim_end_matches('/');
    let base = base.strip_suffix(ROUTE).unwrap_or(base);
    let path = format!("{base}{ROUTE}");
    url.set_path(&path);
    url.set_query(None);
    url.set_fragment(None);
    url
}

/// The bearer an explicit URL is read with when `--token` gave none: the
/// CHAN_METRICS_TOKEN variable, which applies only beside `--url`.
fn url_token(flag: Option<&str>) -> Option<String> {
    flag.map(str::to_owned).or_else(|| {
        std::env::var("CHAN_METRICS_TOKEN")
            .ok()
            .filter(|token| !token.is_empty())
    })
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
    // The lock is taken for one view at a time and never held across a read.
    let print = |view: &View| {
        let text = output(view, args.json, args.watch)?;
        write_output(&mut std::io::stdout().lock(), &text)
    };
    if !args.watch {
        print(&client.read(args.history, None).await?)?;
        return Ok(());
    }
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    watch(&client, args.history, ctrl_c, print).await
}

/// `--watch`: print each view the stream sends, about once per second, until
/// `cancel` (Ctrl-C) or until `print` reports that nobody reads the output
/// any more. A failed read ends it with the error.
async fn watch(
    source: &impl Source,
    history: bool,
    cancel: impl std::future::Future<Output = ()>,
    mut print: impl FnMut(&View) -> Result<bool>,
) -> Result<()> {
    // One future for the whole watch, polled around the read as well as the
    // wait. tokio delivers a signal only to a listener that exists when it
    // arrives, so a listener made anew for each wait would miss a Ctrl-C
    // that lands while a read is in flight.
    tokio::pin!(cancel);
    let mut stream = Subscription::new(history, None);
    loop {
        let view = tokio::select! {
            _ = &mut cancel => return Ok(()),
            view = stream.next(source) => view?,
        };
        if let Some(view) = view {
            if !print(&view)? {
                return Ok(());
            }
        }
        tokio::select! {
            _ = &mut cancel => return Ok(()),
            _ = tokio::time::sleep(Duration::from_secs(1)) => {}
        }
    }
}

/// One view as the command prints it: the text block, pretty JSON for a
/// single read, or one JSON object per line under `--watch`.
fn output(view: &View, json: bool, watch: bool) -> Result<String> {
    Ok(match (json, watch) {
        (false, _) => render(view),
        (true, false) => format!("{}\n", serde_json::to_string_pretty(view)?),
        (true, true) => format!("{}\n", serde_json::to_string(view)?),
    })
}

/// Write one output and flush it. False when the reader is gone: a closed
/// pipe (`chan metrics --watch --json | head -n1`) ends the output, and the
/// command with it, without being a failure of the command.
fn write_output(out: &mut impl std::io::Write, text: &str) -> Result<bool> {
    match out.write_all(text.as_bytes()).and_then(|()| out.flush()) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => Ok(false),
        Err(error) => Err(error).context("cannot write the metrics output"),
    }
}

fn bytes(value: u64) -> String {
    // A count of bytes is whole; only the scaled units carry a fraction.
    if value < 1024 {
        return format!("{value} B");
    }
    let units = ["KiB", "MiB", "GiB", "TiB"];
    let mut n = value as f64 / 1024.0;
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
    // Two short literals: rustfmt leaves a statement alone, unformatted, once
    // one string in it cannot fit the line width.
    let transfers = &sample.transfers;
    out.push_str(&format!(
        "Transfers: {}/{} running, {}/{} queued, {} finished, ",
        transfers.running,
        transfers.worker_capacity,
        transfers.queued,
        transfers.queue_capacity,
        transfers.finished
    ));
    out.push_str(&format!(
        "{} cancelled, {} stalled, {} panicked, {} refused\n",
        transfers.cancelled, transfers.stalled, transfers.panicked, transfers.refused
    ));
    out.push_str(&format!(
        "Tunnels: {} gateway, {} reverse listeners, {} dial failures; ",
        sample.gateway_tunnels, sample.reverse_listeners, sample.tunnel_dial_failures
    ));
    out.push_str(&format!(
        "yamux {}/{} serving, {} waiting\n",
        sample.yamux_serving, sample.yamux_service_capacity, sample.yamux_waiting
    ));
    let storage = &view.storage;
    let failed = match (&storage.error, storage.logical_bytes) {
        (None, _) => String::new(),
        // A failed refresh keeps the totals of the last scan that completed;
        // a failed first scan has none to keep.
        (Some(error), Some(_)) => format!(" (scan failed: {error}; last completed total)"),
        (Some(error), None) => format!(" (scan failed: {error})"),
    };
    out.push_str(&format!(
        "{}: {} logical, {} allocated{failed}\n",
        storage.path,
        storage
            .logical_bytes
            .map(bytes)
            .unwrap_or_else(|| "pending".into()),
        storage
            .allocated_bytes
            .map(bytes)
            .unwrap_or_else(|| "n/a".into()),
    ));
    out
}

/// A view built by hand with every optional part present, so a test of the
/// text output or of the wire names waits on no sampler.
#[cfg(test)]
pub(crate) fn full_view() -> View {
    use chan_server::metrics::{Identity, Process, Sample, Storage, Traffic, Transfers};
    let traffic = |received_bytes, sent_bytes| {
        let mut traffic = Traffic {
            received_bytes_per_second: Some(0.0),
            sent_bytes_per_second: Some(2048.0),
            ..Traffic::default()
        };
        traffic.totals.active = 1;
        traffic.totals.opened = 2;
        traffic.totals.received_bytes = received_bytes;
        traffic.totals.sent_bytes = sent_bytes;
        traffic
    };
    let sample = Sample {
        sequence: 7,
        elapsed_ms: 7_000,
        sampled_at_ms: 1_700_000_007_000,
        collection_micros: 120,
        process: Some(Process {
            uptime_seconds: 3_600,
            cpu_time_ms: 1_250,
            cpu_percent: Some(1.5),
            resident_bytes: 12 * 1024 * 1024,
            io_scope: "storage_io".into(),
            read_bytes: Some(512),
            written_bytes: Some(3 * 1024 * 1024),
            read_bytes_per_second: Some(0.0),
            written_bytes_per_second: Some(1536.0),
        }),
        network: traffic(512, 2048),
        http2: traffic(0, 0),
        yamux: traffic(0, 0),
        reverse_connections: traffic(0, 0),
        transfer_payload: traffic(1023, 1024),
        transfers: Transfers {
            queued: 1,
            running: 2,
            worker_capacity: 4,
            queue_capacity: 16,
            finished: 9,
            cancelled: 3,
            stalled: 5,
            panicked: 6,
            refused: 8,
        },
        gateway_tunnels: 1,
        tunnel_dial_failures: 11,
        reverse_listeners: 2,
        yamux_waiting: 0,
        yamux_serving: 3,
        yamux_service_capacity: 8,
        yamux_stream_limit: 256,
    };
    View {
        schema_version: SCHEMA_VERSION,
        identity: Identity {
            instance_id: "0123456789abcdef0123456789abcdef".into(),
            version: "0.127.0".into(),
            build: "git-0123456789ab".into(),
            pid: 184_223,
            hostname: Some("box".into()),
        },
        latest: Some(sample.clone()),
        history: vec![sample],
        storage: Storage {
            path: "/home/you/.chan".into(),
            logical_bytes: Some(1536),
            allocated_bytes: Some(4096),
            files: Some(3),
            sampled_at_ms: Some(1_700_000_000_000),
            scan_ms: Some(12),
            error: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_help_example_is_the_text_output() {
        // The first two output lines the help shows, as comments.
        let shown: Vec<&str> = crate::help::CHAN_METRICS_AFTER
            .lines()
            .filter_map(|line| line.strip_prefix("  # "))
            .take(2)
            .collect();
        let text = render(&full_view());
        assert_eq!(shown, text.lines().take(2).collect::<Vec<_>>());
    }

    #[test]
    fn the_text_output_counts_every_outcome_and_prints_whole_bytes() {
        let text = render(&full_view());
        let line = |prefix: &str| {
            text.lines()
                .find(|line| line.starts_with(prefix))
                .unwrap_or_else(|| panic!("no {prefix} line in:\n{text}"))
        };
        // Below 1 KiB a count of bytes is whole.
        assert_eq!(
            line("Service transport:"),
            "Service transport: 1 active  RX 512 B (0 B/s)  TX 2.0 KiB (2.0 KiB/s)"
        );
        assert_eq!(
            [0, 1, 1023, 1024, 1536].map(bytes),
            ["0 B", "1 B", "1023 B", "1.0 KiB", "1.5 KiB"]
        );
        // Every outcome the transfer lane counts, and the failed dials.
        assert_eq!(
            line("Transfers:"),
            "Transfers: 2/4 running, 1/16 queued, 9 finished, 3 cancelled, 5 stalled, \
             6 panicked, 8 refused"
        );
        assert_eq!(
            line("Tunnels:"),
            "Tunnels: 1 gateway, 2 reverse listeners, 11 dial failures; \
             yamux 3/8 serving, 0 waiting"
        );
    }

    /// The storage line, the last one of the text output.
    fn storage_line(view: &View) -> String {
        render(view).lines().last().unwrap().to_string()
    }

    #[test]
    fn a_failed_scan_prints_its_error_and_names_a_total_only_when_there_is_one() {
        let mut view = full_view();
        assert_eq!(
            storage_line(&view),
            "/home/you/.chan: 1.5 KiB logical, 4.0 KiB allocated"
        );
        // The first scan failed: there is no total to speak of.
        let mut first = view.clone();
        first.storage.logical_bytes = None;
        first.storage.allocated_bytes = None;
        first.storage.error = Some("storage scan exceeded its bound".into());
        assert_eq!(
            storage_line(&first),
            "/home/you/.chan: pending logical, n/a allocated \
             (scan failed: storage scan exceeded its bound)"
        );
        // A refresh failed: the totals are those of the last completed scan.
        view.storage.error = Some("storage scan exceeded its bound".into());
        assert_eq!(
            storage_line(&view),
            "/home/you/.chan: 1.5 KiB logical, 4.0 KiB allocated \
             (scan failed: storage scan exceeded its bound; last completed total)"
        );
    }

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

    /// A loopback server that answers one connection per body, in order,
    /// with that JSON body.
    async fn canned(bodies: Vec<String>) -> std::net::SocketAddr {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            for body in bodies {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    let mut byte = [0u8; 1];
                    if socket.read(&mut byte).await.unwrap() == 0 {
                        break;
                    }
                    head.push(byte[0]);
                }
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\
                     content-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        addr
    }

    #[tokio::test]
    async fn the_schema_version_is_read_before_the_view_is_decoded() {
        // This schema with fields a later release added to it, at the top,
        // in an object and beside flattened counters: a reader skips them.
        let mut current = serde_json::to_value(full_view()).unwrap();
        current["addedLater"] = 1.into();
        current["storage"]["addedLater"] = "x".into();
        current["latest"]["network"]["addedLater"] = true.into();
        let addr = canned(vec![
            // A later schema keeps nothing of this one but the version.
            r#"{"schemaVersion":2,"samples":[]}"#.into(),
            current.to_string(),
            r#"{"identity":{}}"#.into(),
        ])
        .await;
        let client = Client::new(MetricsArgs {
            url: Some(format!("http://{addr}/")),
            token: None,
            json: false,
            watch: false,
            history: false,
            varlink: false,
        })
        .unwrap();
        let error = client.read(false, None).await.unwrap_err();
        assert_eq!(format!("{error:#}"), "unsupported metrics schema 2");
        let view = client.read(false, None).await.unwrap();
        assert_eq!(view.schema_version, 1);
        assert_eq!(view.latest.unwrap().network.totals.received_bytes, 512);
        // A body with no version is not a metrics response at all.
        let error = client.read(false, None).await.unwrap_err();
        assert!(
            format!("{error:#}").starts_with("invalid metrics response"),
            "{error:#}"
        );
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
            // The route itself, as docs/metrics.md names it, on the server
            // root and on a tenant: read as given, not appended to.
            (
                "http://127.0.0.1:8787/api/metrics",
                "http://127.0.0.1:8787/api/metrics",
            ),
            (
                "http://127.0.0.1:8787/workspace/api/metrics/?t=TOKEN",
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
        // The variable belongs to --url reads; the local read keeps the
        // devserver's own bearer.
        std::env::set_var("CHAN_METRICS_TOKEN", "from-env");
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
        // The unit file outlives a stopped unit. A devserver started in a
        // terminal afterwards records its own port, and that listener, this
        // user's, is the one read.
        let foreground = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let recorded = foreground.local_addr().unwrap().port();
        std::fs::write(
            state.join("config.json"),
            format!(r#"{{"devserver_token":"tok","port":{recorded}}}"#),
        )
        .unwrap();
        let target = local_target()
            .map(|(url, token)| (url.to_string(), token))
            .map_err(|error| error.to_string());
        assert_eq!(
            target,
            Ok((
                format!("http://127.0.0.1:{recorded}/api/metrics"),
                Some("tok".to_string())
            )),
            "the unit pins closed port {pinned}"
        );
    }

    #[test]
    fn the_token_variable_applies_only_beside_an_explicit_url() {
        use clap::Parser;
        let parse =
            |argv: &[&str]| match crate::cli::Cli::try_parse_from(argv).map(|cli| cli.command) {
                Ok(crate::cli::Command::Metrics(args)) => Ok(args),
                Ok(other) => panic!("not metrics: {other:?}"),
                Err(error) => Err(error),
            };
        // The guard owns CHAN_* and restores them; tests reading this
        // variable hold the same permit.
        let _env = crate::test_env::ChanTestEnv::new();
        std::env::set_var("CHAN_METRICS_TOKEN", "from-env");
        // Exported, it neither breaks a local read nor stands in for --token.
        for argv in [
            ["chan", "metrics"].as_slice(),
            ["chan", "metrics", "--varlink"].as_slice(),
        ] {
            let args = parse(argv).unwrap_or_else(|error| panic!("{argv:?}: {error}"));
            assert_eq!(args.token, None);
        }
        // Beside --url it supplies the bearer, and --token still wins.
        let args = parse(&["chan", "metrics", "--url", "http://example.test/"]).unwrap();
        let (_, token) = Client::new(args).unwrap().target().unwrap();
        assert_eq!(token.as_deref(), Some("from-env"));
        let args = parse(&[
            "chan",
            "metrics",
            "--url",
            "http://example.test/",
            "--token",
            "flag",
        ])
        .unwrap();
        let (_, token) = Client::new(args).unwrap().target().unwrap();
        assert_eq!(token.as_deref(), Some("flag"));
        // An explicit --token still needs --url.
        let error = parse(&["chan", "metrics", "--token", "flag"]).unwrap_err();
        assert_eq!(
            error.kind(),
            clap::error::ErrorKind::MissingRequiredArgument
        );
    }

    #[test]
    fn explicit_url_keeps_proxy() {
        crate::test_env::http_proxy::check(
            "metrics::tests::explicit_url_keeps_proxy",
            vec![],
            1,
            |addr| async move {
                let client = Client::new(MetricsArgs {
                    url: Some(format!("http://{addr}/")),
                    token: Some("explicit-test-token".into()),
                    json: false,
                    watch: false,
                    history: false,
                    varlink: false,
                })
                .unwrap();
                // The recording proxy closes the connection; reaching it is the assertion.
                assert!(client.read(false, None).await.is_err());
            },
        );
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
                    "HTTP/1.1 200 OK\r\n\
                     content-type: application/json\r\n\
                     content-length: {}\r\n\
                     connection: close\r\n\r\n{body}",
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
            assert!(
                !proxied.load(Ordering::SeqCst),
                "the bearer went to the proxy"
            );
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

    /// Output whose reader has gone away: every write fails as a write to a
    /// closed pipe does.
    struct ClosedPipe;

    impl std::io::Write for ClosedPipe {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn a_watch_whose_reader_is_gone_ends_without_an_error() {
        let base = sampled_view().await;
        let script = Script {
            views: std::sync::Mutex::new([view_of(&base, "a", 1..=2)].into()),
            asked: Default::default(),
        };
        let ended = watch(&script, true, std::future::pending(), |view| {
            write_output(&mut ClosedPipe, &output(view, true, true)?)
        })
        .await;
        assert!(
            ended.is_ok(),
            "a closed pipe ended the watch as a failure: {ended:?}"
        );
        // It ended at the write that failed, before another read.
        assert_eq!(*script.asked.lock().unwrap(), [None]);
        // A single read is printed the same way.
        let single = output(&view_of(&base, "a", 1..=2), true, false).unwrap();
        assert!(matches!(write_output(&mut ClosedPipe, &single), Ok(false)));
    }

    /// A source that answers its first read and never its later ones, and
    /// says when one of those is in flight.
    struct Parked {
        first: std::sync::Mutex<Option<View>>,
        reading: tokio::sync::Notify,
    }

    impl Source for Parked {
        async fn read(&self, _history: bool, _since: Option<u64>) -> Result<View> {
            let first = self.first.lock().unwrap().take();
            match first {
                Some(view) => Ok(view),
                None => {
                    self.reading.notify_one();
                    std::future::pending().await
                }
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_cancel_that_arrives_during_a_read_ends_the_watch() {
        let home = tempfile::tempdir().unwrap();
        let view = chan_server::metrics::Runtime::start(home.path().into())
            .unwrap()
            .view(false, None);
        let source = Parked {
            first: std::sync::Mutex::new(Some(view)),
            reading: tokio::sync::Notify::new(),
        };
        let (cancel, cancelled) = tokio::sync::oneshot::channel::<()>();
        let printed = std::cell::Cell::new(0);
        let watching = watch(
            &source,
            false,
            async {
                let _ = cancelled.await;
            },
            |_| {
                printed.set(printed.get() + 1);
                Ok(true)
            },
        );
        tokio::pin!(watching);
        // Run the watch through its first view and its wait, into the read
        // that never answers.
        tokio::select! {
            ended = &mut watching => panic!("the watch ended before its second read: {ended:?}"),
            _ = source.reading.notified() => {}
        }
        assert_eq!(printed.get(), 1);
        cancel.send(()).unwrap();
        let ended = tokio::time::timeout(Duration::from_secs(3600), &mut watching).await;
        assert!(
            matches!(ended, Ok(Ok(()))),
            "a cancel that arrived during a read did not end the watch: {ended:?}"
        );
    }

    #[test]
    fn output_is_written_whole_and_other_write_errors_fail_the_command() {
        struct Full;
        impl std::io::Write for Full {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::StorageFull.into())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut written = Vec::new();
        assert!(matches!(write_output(&mut written, "line\n"), Ok(true)));
        assert_eq!(written, b"line\n");
        let error = write_output(&mut Full, "line\n").unwrap_err();
        assert!(
            format!("{error:#}").contains("cannot write the metrics output"),
            "{error:#}"
        );
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
