//! One host lookup at a time. A deadline bounds waiting, not the OS call:
//! `getaddrinfo` cannot be cancelled, so a timed-out task stays owned until
//! it returns and no replacement lookup runs beside it.

use std::future::{pending, Future};
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use tokio::task::JoinHandle;

use crate::clock::Instant;
use crate::config::Endpoint;
use crate::noise::REKEY_TIMEOUT;

pub(crate) const RESOLVE_TIMEOUT: Duration = Duration::from_secs(10);
type LookupFuture = Pin<Box<dyn Future<Output = io::Result<SocketAddr>> + Send>>;
pub(crate) type Lookup = Arc<dyn Fn(Endpoint) -> LookupFuture + Send + Sync>;
type Answer = (io::Result<SocketAddr>, Instant);

pub(crate) struct Resolver {
    name: Endpoint,
    lookup: Lookup,
    task: Option<JoinHandle<Answer>>,
    last_attempt: Option<Instant>,
    pub(crate) deadline: Option<tokio::time::Instant>,
}

impl Resolver {
    pub(crate) fn new(name: Endpoint) -> Self {
        Self::with_lookup(name, Arc::new(|name| Box::pin(resolve(name))))
    }

    pub(crate) fn with_lookup(name: Endpoint, lookup: Lookup) -> Self {
        Self {
            name,
            lookup,
            task: None,
            last_attempt: None,
            deadline: None,
        }
    }

    pub(crate) fn start(&mut self) {
        if self.task.is_some()
            || self
                .last_attempt
                .is_some_and(|at| at.elapsed() < REKEY_TIMEOUT)
        {
            return;
        }
        self.last_attempt = Some(Instant::now());
        self.deadline = Some(tokio::time::Instant::now() + RESOLVE_TIMEOUT);
        let lookup = self.lookup.clone();
        let name = self.name.clone();
        self.task = Some(tokio::spawn(async move {
            let result = lookup(name).await;
            (result, Instant::now())
        }));
    }

    pub(crate) async fn completed(&mut self) -> Answer {
        let Some(task) = &mut self.task else {
            return pending().await;
        };
        let result = task.await;
        self.task = None;
        self.deadline = None;
        result.unwrap_or_else(|e| (Err(io::Error::other(e)), Instant::now()))
    }
}

impl Drop for Resolver {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

pub(crate) async fn deadline(at: Option<tokio::time::Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => pending().await,
    }
}

async fn resolve(endpoint: Endpoint) -> io::Result<SocketAddr> {
    tokio::net::lookup_host((endpoint.host.as_str(), endpoint.port))
        .await?
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no usable address"))
}
