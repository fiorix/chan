//! `chan-gateway-wireguard-agent`: keeps one kernel WireGuard interface's
//! peers equal to the gateway's peer table for this host. See README.md
//! and design.md.

mod config;
mod identity;
mod peers;
mod reconcile;
mod state;
mod wg;

use std::process::ExitCode;

use anyhow::Context;
use tokio::sync::watch;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::identity::{IdentityClient, Poller};
use crate::reconcile::Reconciler;
use crate::state::StateFile;
use crate::wg::WgCommand;

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let result = match Config::from_env() {
        Ok(cfg) => run(cfg, shutdown_on_signal()).await,
        Err(error) => Err(error),
    };
    ExitCode::from(exit_status(&result))
}

/// 0 for a clean shutdown, 1 for every error, which the unit restarts.
fn exit_status(result: &anyhow::Result<()>) -> u8 {
    match result {
        Ok(()) => 0,
        Err(error) => {
            tracing::error!(
                error = format!("{error:#}"),
                "wireguard-agent-service exited with error"
            );
            1
        }
    }
}

/// A flag set on SIGTERM or Ctrl-C. The handler is installed before the
/// first poll, so a signal at any point is seen at the next check instead
/// of killing the process between a `wg` call and its state write.
fn shutdown_on_signal() -> watch::Receiver<bool> {
    let (tx, rx) = watch::channel(false);
    tokio::spawn(async move {
        gateway_common::shutdown_signal().await;
        let _ = tx.send(true);
    });
    rx
}

async fn run(cfg: Config, mut shutdown: watch::Receiver<bool>) -> anyhow::Result<()> {
    tracing::info!(
        interface = %cfg.interface,
        host = cfg.host_id.as_str(),
        identity = %cfg.identity_url,
        poll_secs = cfg.poll.as_secs(),
        state = %cfg.state_dir.display(),
        "starting wireguard-agent-service",
    );
    let state = StateFile::new(&cfg.state_dir, &cfg.interface);
    let mut reconciler = Reconciler::open(
        WgCommand::new(cfg.wg_bin.clone(), cfg.interface.clone()),
        &cfg.interface,
        state,
    )?;
    tracing::info!(
        managed = reconciler.managed().len(),
        "loaded the peers this agent added"
    );
    let mut poller = Poller::new(IdentityClient::new(
        &cfg.identity_url,
        &cfg.token,
        cfg.host_id.clone(),
    )?);
    let mut reconcile_failing = false;

    loop {
        if *shutdown.borrow() {
            break;
        }
        let polled = tokio::select! {
            polled = poller.poll() => polled,
            _ = shutdown.changed() => break,
        };
        polled.map_err(anyhow::Error::from)?;

        // Nothing is reconciled before identity has served a list: an
        // unknown desired set must not read as an empty one.
        if let Some(desired) = poller.desired().cloned() {
            let watcher = shutdown.clone();
            let (back, result) = tokio::task::spawn_blocking(move || {
                let stopped = || *watcher.borrow();
                let result = reconciler.reconcile(&desired, &stopped);
                (reconciler, result)
            })
            .await
            .context("the reconcile pass panicked")?;
            reconciler = back;
            match result {
                Ok(changes) => {
                    if reconcile_failing {
                        tracing::info!(interface = %cfg.interface, "reconciling the interface works again");
                        reconcile_failing = false;
                    }
                    if changes.any() {
                        tracing::debug!(?changes, "reconcile pass done");
                    }
                }
                Err(error) => {
                    let error = format!("{error:#}");
                    if reconcile_failing {
                        tracing::debug!(interface = %cfg.interface, %error, "reconciling the interface still fails");
                    } else {
                        tracing::warn!(interface = %cfg.interface, %error, "reconciling the interface failed; retrying at the next poll");
                        reconcile_failing = true;
                    }
                }
            }
        }

        tokio::select! {
            _ = tokio::time::sleep(cfg.poll) => {}
            _ = shutdown.changed() => break,
        }
    }
    tracing::info!("wireguard-agent-service stopped");
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;
    use crate::state::tests::TempDir;

    fn config(server: &MockServer, state_dir: &std::path::Path) -> Config {
        let uri = server.uri();
        let state_dir = state_dir.display().to_string();
        Config::from_lookup(|name| {
            match name {
                "IDENTITY_URL" => Some(uri.clone()),
                "WIREGUARD_AGENT_TOKEN" => Some("agent-bearer".into()),
                "WIREGUARD_AGENT_HOST_ID" => Some("p1".into()),
                "WIREGUARD_INTERFACE" => Some("wg0".into()),
                "WIREGUARD_AGENT_POLL_SECS" => Some("1".into()),
                // Never run: a 401 ends the loop before any reconcile.
                "WIREGUARD_WG_BIN" => Some("/nonexistent/wg".into()),
                "STATE_DIRECTORY" => Some(state_dir.clone()),
                _ => None,
            }
        })
        .unwrap()
    }

    #[tokio::test]
    async fn a_401_ends_the_agent_with_a_non_zero_status() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(identity::PEERS_PATH))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        let dir = TempDir::new("main-401");
        let (_tx, rx) = watch::channel(false);
        let result =
            tokio::time::timeout(Duration::from_secs(10), run(config(&server, &dir.0), rx))
                .await
                .expect("a 401 must end the agent, not keep it polling");
        let error = format!("{:#}", result.as_ref().unwrap_err());
        assert!(error.contains("WIREGUARD_AGENT_TOKEN"), "{error}");
        assert_eq!(exit_status(&result), 1);
        assert_eq!(exit_status(&Ok(())), 0);
    }

    #[tokio::test]
    async fn a_corrupt_state_file_refuses_startup_before_any_poll() {
        let server = MockServer::start().await;
        let dir = TempDir::new("main-corrupt");
        std::fs::write(dir.0.join(state::STATE_FILE), "{").unwrap();
        let (_tx, rx) = watch::channel(false);
        let error = format!("{:#}", run(config(&server, &dir.0), rx).await.unwrap_err());
        assert!(error.contains("refusing to start"), "{error}");
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_shutdown_ends_the_loop_cleanly() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(502))
            .mount(&server)
            .await;
        let dir = TempDir::new("main-shutdown");
        let (tx, rx) = watch::channel(false);
        let agent = tokio::spawn(run(config(&server, &dir.0), rx));
        tokio::time::sleep(Duration::from_millis(200)).await;
        tx.send(true).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(5), agent)
            .await
            .expect("the loop must end on shutdown")
            .unwrap();
        assert_eq!(exit_status(&result), 0);
    }
}
