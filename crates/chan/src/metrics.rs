//! CLI diagnostics and the socket-activated Varlink adapter.

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
    /// Repeat every second; JSON mode emits one object per line.
    #[arg(long)]
    pub watch: bool,
    /// Include the server's bounded sample history in JSON output.
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
        Ok(Self {
            args,
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(5))
                .build()?,
        })
    }

    pub(crate) async fn read(&self, history: bool, since: Option<u64>) -> Result<View> {
        // Resolve on every read: the activated adapter can outlive a server
        // restart, port change or token rotation.
        let (mut url, token) = match &self.args.url {
            Some(raw) => explicit_target(raw, self.args.token.as_deref())?,
            None => {
                // Both port and bearer belong to this CHAN_HOME. A systemd
                // unit can describe another home or an inactive older server.
                let port = chan_server::persisted_devserver_port()
                    .context("no local devserver port; start a devserver or use --url")?;
                let token = chan_server::persisted_devserver_token()
                    .context("no local devserver token; start a devserver or use --url")?;
                (
                    reqwest::Url::parse(&format!("http://127.0.0.1:{port}/"))?,
                    Some(token),
                )
            }
        };
        let path = format!("{}/api/metrics", url.path().trim_end_matches('/'));
        url.set_path(&path);
        url.set_query(None);
        url.set_fragment(None);
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

fn explicit_target(raw: &str, token: Option<&str>) -> Result<(reqwest::Url, Option<String>)> {
    let mut url = reqwest::Url::parse(raw).context("invalid metrics URL")?;
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
    url.set_query(None);
    url.set_fragment(None);
    Ok((url, token))
}

pub(crate) async fn cmd_metrics(args: MetricsArgs) -> Result<()> {
    let client = Client::new(args.clone())?;
    if args.varlink {
        #[cfg(unix)]
        return varlink::serve(client, tokio::io::stdin(), tokio::io::stdout()).await;
        #[cfg(not(unix))]
        anyhow::bail!("Varlink socket activation is available on Unix");
    }
    loop {
        let view = client.read(args.history, None).await?;
        if args.json {
            println!(
                "{}",
                if args.watch {
                    serde_json::to_string(&view)?
                } else {
                    serde_json::to_string_pretty(&view)?
                }
            );
        } else {
            print!("{}", render(&view));
        }
        if !args.watch {
            return Ok(());
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
            bytes(process.read_bytes),
            per_second(process.read_bytes_per_second),
            bytes(process.written_bytes),
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
    fn explicit_targets_do_not_inherit_local_credentials_and_strip_launch_secrets() {
        let (url, token) = explicit_target("https://example.test/work?t=secret#x", None).unwrap();
        assert_eq!(url.as_str(), "https://example.test/work");
        assert_eq!(token.as_deref(), Some("secret"));
        assert!(explicit_target("https://example.test/", None)
            .unwrap()
            .1
            .is_none());
        assert!(explicit_target("https://user:secret@example.test/", None).is_err());
        assert!(explicit_target("file:///tmp/x", None).is_err());
    }
}
