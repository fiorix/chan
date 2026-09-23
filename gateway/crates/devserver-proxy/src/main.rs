use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

const SHUTDOWN_DRAIN_TIMEOUT: Duration = Duration::from_secs(30);

use chan_tunnel_server::{serve_tunnel_listener_with_admission, Validator};
use devserver_proxy::{
    config::Config,
    control::{self, ControlRuntime},
    http,
    identity_validator::IdentityValidator,
    registry::Registry,
    session_store::SessionStore,
    throttle_validator::ThrottlingValidator,
};
use tokio::sync::watch;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    if let Err(error) = run().await {
        tracing::error!(error = ?error, "devserver-proxy-service exited with error");
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}

async fn run() -> anyhow::Result<()> {
    let cfg = Arc::new(Config::from_env()?);
    tracing::info!(
        public = %cfg.bind_addr,
        tunnel = %cfg.tunnel_bind_addr,
        controller = %cfg.control_url,
        proxy_id = cfg.proxy_id.as_str(),
        apex = %cfg.apex_host,
        wildcard = %cfg.wildcard_suffix,
        identity = %cfg.identity_url,
        "starting devserver-proxy-service",
    );

    let registry = Registry::new();
    let sessions = SessionStore::new(cfg.session_max_active, cfg.session_lifetime);

    // Validator chain (outermost first):
    //   ThrottlingValidator  per-token-fingerprint rate limit before
    //                        each validation round trip to
    //                        identity-service (tunnel dial and lease
    //                        refresh); the Hello-name announcement is
    //                        not throttled here.
    //   IdentityValidator    upstream PAT lookup.
    let identity = IdentityValidator::new(
        cfg.identity_url.clone(),
        cfg.identity_auth_token.clone(),
        cfg.proxy_id.clone(),
    )?;
    let throttled = ThrottlingValidator::new(identity);
    let validator: Arc<dyn Validator> = Arc::new(throttled);

    let public_listener = tokio::net::TcpListener::bind(cfg.bind_addr).await?;
    let tunnel_listener = tokio::net::TcpListener::bind(cfg.tunnel_bind_addr).await?;
    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    let ControlRuntime {
        admission,
        readiness,
        task: mut control_task,
    } = control::spawn_control_supervisor(
        cfg.clone(),
        registry.clone(),
        sessions.clone(),
        shutdown_rx.clone(),
    );

    let app = http::router(cfg.clone(), registry.clone(), readiness, sessions);
    let mut public_task = tokio::spawn({
        let shutdown = shutdown_rx.clone();
        async move {
            axum::serve(
                public_listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .with_graceful_shutdown(wait_for_shutdown(shutdown))
            .await
        }
    });

    let mut tunnel_task = tokio::spawn({
        let mut shutdown = shutdown_rx;
        let tunnels = registry.tunnels();
        async move {
            tokio::select! {
                result = serve_tunnel_listener_with_admission(
                    tunnel_listener,
                    validator,
                    admission,
                    tunnels,
                    0,
                ) => result,
                _ = wait_for_shutdown_ref(&mut shutdown) => {
                    tracing::info!("tunnel listener received shutdown");
                    Ok(())
                }
            }
        }
    });

    enum FirstExit {
        Signal,
        Public(Result<std::io::Result<()>, tokio::task::JoinError>),
        Tunnel(Result<std::io::Result<()>, tokio::task::JoinError>),
        Control(Result<anyhow::Result<()>, tokio::task::JoinError>),
    }

    let first = tokio::select! {
        _ = gateway_common::shutdown_signal() => FirstExit::Signal,
        result = &mut public_task => FirstExit::Public(result),
        result = &mut tunnel_task => FirstExit::Tunnel(result),
        result = &mut control_task => FirstExit::Control(result),
    };
    let _ = shutdown_tx.send(true);
    let deadline = tokio::time::Instant::now() + SHUTDOWN_DRAIN_TIMEOUT;

    match first {
        FirstExit::Signal => {
            tracing::info!("devserver-proxy-service received shutdown");
            let (public, tunnel, control) = tokio::join!(
                drain_task(&mut public_task, "public listener", deadline),
                drain_task(&mut tunnel_task, "tunnel listener", deadline),
                drain_task(&mut control_task, "control supervisor", deadline),
            );
            public?;
            tunnel?;
            control?;
            Ok(())
        }
        FirstExit::Public(result) => {
            let (tunnel, control) = tokio::join!(
                drain_task(&mut tunnel_task, "tunnel listener", deadline),
                drain_task(&mut control_task, "control supervisor", deadline)
            );
            tunnel?;
            control?;
            Err(unexpected_exit("public listener", result))
        }
        FirstExit::Tunnel(result) => {
            let (public, control) = tokio::join!(
                drain_task(&mut public_task, "public listener", deadline),
                drain_task(&mut control_task, "control supervisor", deadline)
            );
            public?;
            control?;
            Err(unexpected_exit("tunnel listener", result))
        }
        FirstExit::Control(result) => {
            let (public, tunnel) = tokio::join!(
                drain_task(&mut public_task, "public listener", deadline),
                drain_task(&mut tunnel_task, "tunnel listener", deadline)
            );
            public?;
            tunnel?;
            Err(unexpected_exit("control supervisor", result))
        }
    }
}

async fn drain_task<E: std::fmt::Display>(
    task: &mut tokio::task::JoinHandle<Result<(), E>>,
    name: &str,
    deadline: tokio::time::Instant,
) -> anyhow::Result<()> {
    match tokio::time::timeout_at(deadline, &mut *task).await {
        Ok(result) => task_completed(name, result),
        Err(_) => {
            tracing::warn!(name, "shutdown drain deadline reached; aborting task");
            task.abort();
            let _ = task.await;
            Ok(())
        }
    }
}

async fn wait_for_shutdown(mut shutdown: watch::Receiver<bool>) {
    wait_for_shutdown_ref(&mut shutdown).await;
}

async fn wait_for_shutdown_ref(shutdown: &mut watch::Receiver<bool>) {
    while !*shutdown.borrow() {
        if shutdown.changed().await.is_err() {
            break;
        }
    }
}

fn task_completed<E>(
    name: &str,
    result: Result<Result<(), E>, tokio::task::JoinError>,
) -> anyhow::Result<()>
where
    E: std::fmt::Display,
{
    match result {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(anyhow::anyhow!("{name} failed: {error}")),
        Err(error) => Err(anyhow::anyhow!("{name} task failed: {error}")),
    }
}

fn unexpected_exit<E>(
    name: &str,
    result: Result<Result<(), E>, tokio::task::JoinError>,
) -> anyhow::Error
where
    E: std::fmt::Display,
{
    match result {
        Ok(Ok(())) => anyhow::anyhow!("{name} exited unexpectedly"),
        Ok(Err(error)) => anyhow::anyhow!("{name} failed: {error}"),
        Err(error) => anyhow::anyhow!("{name} task failed: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn shutdown_aborts_a_stalled_task_within_the_drain_budget() {
        let mut task = tokio::spawn(std::future::pending::<std::io::Result<()>>());
        let started = tokio::time::Instant::now();
        tokio::time::timeout(
            SHUTDOWN_DRAIN_TIMEOUT * 2,
            drain_task(
                &mut task,
                "stalled listener",
                started + SHUTDOWN_DRAIN_TIMEOUT,
            ),
        )
        .await
        .expect("shutdown must finish within its budget")
        .unwrap();
        assert!(task.is_finished());
        assert_eq!(started.elapsed(), SHUTDOWN_DRAIN_TIMEOUT);
    }

    #[tokio::test]
    async fn shutdown_preserves_listener_failures() {
        let mut task = tokio::spawn(async { Err(std::io::Error::other("listener failed")) });
        let result = drain_task(
            &mut task,
            "listener",
            tokio::time::Instant::now() + SHUTDOWN_DRAIN_TIMEOUT,
        )
        .await;
        assert!(result.unwrap_err().to_string().contains("listener failed"));
    }
}
