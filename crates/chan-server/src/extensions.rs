//! Process-wide local extension discovery and supervision.
//!
//! One `<chan-home>/extensions/<id>.toml` file declares one subprocess. The
//! first workspace tenant starts every valid declaration concurrently and
//! waits for a marker-delimited JSON handshake. Successful extensions stay
//! alive until the owning chan process shuts down; failures are logged and do
//! not prevent the workspace from opening.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{bail, Context};
use futures::future::join_all;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdout, Command};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use url::{Host, Url};

/// Prefix for the extension's stdout handshake line. The suffix is one JSON
/// object with `url` and `token` string fields.
pub const EXTENSION_HANDSHAKE_MARKER: &str = "CHAN_EXTENSION_V1=";

/// Capability-scoped reverse-proxy namespace mounted inside every workspace
/// tenant. The browser sees only this path; the extension's loopback address
/// and bearer remain process-private.
pub(crate) const EXTENSION_PROXY_PREFIX: &str = "/_chan/extensions";

const CONFIG_LIMIT_BYTES: u64 = 64 * 1024;
const HANDSHAKE_LINE_LIMIT_BYTES: usize = 8 * 1024;
const HANDSHAKE_LINE_LIMIT: usize = 32;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const CHILD_SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
const SUPERVISOR_SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

#[cfg(unix)]
type ExtensionProcessGroup = rustix::process::Pid;
#[cfg(not(unix))]
type ExtensionProcessGroup = ();

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct ExtensionView {
    pub id: String,
    pub name: String,
    pub entry_path: String,
}

#[derive(Clone, Debug)]
pub(crate) struct ExtensionEntry {
    id: String,
    name: String,
    upstream: Url,
    token: String,
    capability: String,
}

impl ExtensionEntry {
    fn view(&self) -> ExtensionView {
        ExtensionView {
            id: self.id.clone(),
            name: self.name.clone(),
            entry_path: self
                .public_path_for(&self.upstream)
                .expect("an extension entry always shares its own upstream origin"),
        }
    }

    pub(crate) fn public_path_for(&self, upstream: &Url) -> Option<String> {
        if upstream.origin() != self.upstream.origin() {
            return None;
        }
        let mut path = format!(
            "{EXTENSION_PROXY_PREFIX}/{}/{}{}",
            self.id,
            self.capability,
            upstream.path()
        );
        if let Some(query) = upstream.query() {
            path.push('?');
            path.push_str(query);
        }
        if let Some(fragment) = upstream.fragment() {
            path.push('#');
            path.push_str(fragment);
        }
        Some(path)
    }

    pub(crate) fn upstream_url(&self, path: &str, query: Option<&str>) -> Url {
        let mut upstream = self.upstream.clone();
        let rooted;
        let path = if path.starts_with('/') {
            path
        } else {
            // Axum currently retains the wildcard's leading slash. Keep the
            // fallback explicit so a router upgrade cannot accidentally retain
            // the handshake entry path.
            rooted = format!("/{path}");
            &rooted
        };
        upstream.set_path(path);
        upstream.set_query(None);
        upstream.set_fragment(None);
        {
            let mut pairs = upstream.query_pairs_mut();
            if let Some(query) = query {
                pairs.extend_pairs(
                    url::form_urlencoded::parse(query.as_bytes()).filter(|(key, _)| key != "t"),
                );
            }
            pairs.append_pair("t", &self.token);
        }
        upstream
    }

    #[cfg(test)]
    pub(crate) fn for_test(
        id: &str,
        name: &str,
        upstream: &str,
        token: &str,
        capability: &str,
    ) -> Self {
        Self {
            id: id.to_string(),
            name: name.to_string(),
            upstream: Url::parse(upstream).expect("test upstream URL"),
            token: token.to_string(),
            capability: capability.to_string(),
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct ExtensionCatalog {
    entries: Vec<ExtensionEntry>,
}

impl ExtensionCatalog {
    pub fn views(&self) -> Vec<ExtensionView> {
        self.entries.iter().map(ExtensionEntry::view).collect()
    }

    pub(crate) fn find(&self, id: &str, capability: &str) -> Option<&ExtensionEntry> {
        self.entries
            .iter()
            .find(|entry| entry.id == id && entry.capability == capability)
    }

    fn empty() -> Arc<Self> {
        Arc::new(Self::default())
    }

    #[cfg(test)]
    pub(crate) fn for_test(entries: Vec<ExtensionEntry>) -> Arc<Self> {
        Arc::new(Self { entries })
    }
}

/// Owns every extension supervisor for one chan process.
///
/// The route builder receives only the immutable catalog. Keeping process
/// handles here makes shutdown ownership explicit and prevents a per-tenant
/// mount from spawning another copy of each extension.
pub struct ExtensionRuntime {
    catalog: Arc<ExtensionCatalog>,
    shutdown_tx: watch::Sender<bool>,
    supervisors: Mutex<Vec<JoinHandle<()>>>,
}

impl ExtensionRuntime {
    /// Discover and start extensions under the active chan home. Every
    /// declaration is opt-in local code execution; individual failures warn
    /// and disappear from the returned catalog instead of failing server boot.
    pub async fn start() -> Self {
        Self::start_in(&chan_workspace::paths::config_dir().join("extensions")).await
    }

    async fn start_in(dir: &Path) -> Self {
        let declarations = load_declarations(dir);
        let attempts = join_all(declarations.into_iter().map(start_extension)).await;
        let (shutdown_tx, _) = watch::channel(false);
        let mut entries = Vec::new();
        let mut supervisors = Vec::new();

        for attempt in attempts {
            match attempt {
                Ok(started) => {
                    entries.push(started.entry.clone());
                    supervisors.push(tokio::spawn(supervise_extension(
                        started,
                        shutdown_tx.subscribe(),
                    )));
                }
                Err(error) => {
                    tracing::warn!(error = %error, "extension ignored");
                }
            }
        }

        Self {
            catalog: Arc::new(ExtensionCatalog { entries }),
            shutdown_tx,
            supervisors: Mutex::new(supervisors),
        }
    }

    pub(crate) fn catalog(&self) -> Arc<ExtensionCatalog> {
        self.catalog.clone()
    }

    /// Stop every child process and wait for its supervisor to reap it. Safe to
    /// call more than once; the first caller takes the join handles.
    pub async fn shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
        let supervisors = {
            let mut guard = self
                .supervisors
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            std::mem::take(&mut *guard)
        };
        for mut supervisor in supervisors {
            if timeout(SUPERVISOR_SHUTDOWN_GRACE, &mut supervisor)
                .await
                .is_err()
            {
                supervisor.abort();
                let _ = supervisor.await;
            }
        }
    }
}

impl Drop for ExtensionRuntime {
    fn drop(&mut self) {
        // The normal server paths call `shutdown().await`. This is the early
        // error/runtime-drop backstop; each tokio Child also has kill_on_drop.
        let _ = self.shutdown_tx.send(true);
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExtensionFile {
    name: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
}

#[derive(Debug)]
struct ExtensionDeclaration {
    id: String,
    name: String,
    command: String,
    args: Vec<String>,
    config_path: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExtensionHandshake {
    url: String,
    token: String,
}

struct StartedExtension {
    entry: ExtensionEntry,
    child: Child,
    stdout: BufReader<ChildStdout>,
    process_group: Option<ExtensionProcessGroup>,
}

fn load_declarations(dir: &Path) -> Vec<ExtensionDeclaration> {
    let read_dir = match std::fs::read_dir(dir) {
        Ok(read_dir) => read_dir,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => {
            tracing::warn!(path = %dir.display(), %error, "extension directory unreadable");
            return Vec::new();
        }
    };

    let mut paths = Vec::new();
    for entry in read_dir {
        match entry {
            Ok(entry) => paths.push(entry.path()),
            Err(error) => {
                tracing::warn!(path = %dir.display(), %error, "extension entry unreadable")
            }
        }
    }
    paths.sort();

    let mut declarations = Vec::new();
    for path in paths {
        if path.extension().and_then(|value| value.to_str()) != Some("toml") {
            continue;
        }
        let Some(id) = extension_id(&path) else {
            tracing::warn!(path = %path.display(), "extension filename is not a lowercase id");
            continue;
        };
        let metadata = match std::fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() => metadata,
            Ok(_) => {
                tracing::warn!(path = %path.display(), "extension config is not a regular file");
                continue;
            }
            Err(error) => {
                tracing::warn!(path = %path.display(), %error, "extension config metadata unavailable");
                continue;
            }
        };
        if metadata.len() > CONFIG_LIMIT_BYTES {
            tracing::warn!(
                path = %path.display(),
                bytes = metadata.len(),
                limit = CONFIG_LIMIT_BYTES,
                "extension config is too large"
            );
            continue;
        }
        let raw = match std::fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(error) => {
                tracing::warn!(path = %path.display(), %error, "extension config unreadable");
                continue;
            }
        };
        let file: ExtensionFile = match toml::from_str(&raw) {
            Ok(file) => file,
            Err(error) => {
                tracing::warn!(path = %path.display(), %error, "malformed extension config");
                continue;
            }
        };
        let name = file.name.trim();
        if name.is_empty() || name.chars().count() > 128 {
            tracing::warn!(path = %path.display(), "extension name must contain 1 to 128 characters");
            continue;
        }
        if file.command.trim().is_empty() {
            tracing::warn!(path = %path.display(), "extension command is empty");
            continue;
        }
        declarations.push(ExtensionDeclaration {
            id,
            name: name.to_string(),
            command: file.command,
            args: file.args,
            config_path: path,
        });
    }
    declarations
}

fn extension_id(path: &Path) -> Option<String> {
    let id = path.file_stem()?.to_str()?;
    let mut bytes = id.bytes();
    let first = bytes.next()?;
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return None;
    }
    if id.len() > 64
        || !bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
        })
    {
        return None;
    }
    Some(id.to_string())
}

async fn start_extension(declaration: ExtensionDeclaration) -> anyhow::Result<StartedExtension> {
    let ExtensionDeclaration {
        id,
        name,
        command,
        args,
        config_path,
    } = declaration;
    let mut command_builder = Command::new(&command);
    command_builder
        .args(&args)
        .current_dir(config_path.parent().unwrap_or_else(|| Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    #[cfg(unix)]
    command_builder.process_group(0);

    let mut child = command_builder.spawn().with_context(|| {
        format!(
            "extension {id} from {}: spawning {command}",
            config_path.display()
        )
    })?;
    let process_group = process_group_for_child(&child);
    let Some(stdout) = child.stdout.take() else {
        terminate_child(&mut child, process_group).await;
        bail!(
            "extension {id} from {}: stdout was not piped",
            config_path.display()
        );
    };
    let mut stdout = BufReader::new(stdout);

    let handshake = match timeout(HANDSHAKE_TIMEOUT, read_handshake(&mut stdout)).await {
        Ok(Ok(handshake)) => handshake,
        Ok(Err(error)) => {
            terminate_child(&mut child, process_group).await;
            return Err(error).with_context(|| {
                format!(
                    "extension {id} from {}: reading handshake",
                    config_path.display()
                )
            });
        }
        Err(_) => {
            terminate_child(&mut child, process_group).await;
            bail!(
                "extension {id} from {}: no handshake within {} seconds",
                config_path.display(),
                HANDSHAKE_TIMEOUT.as_secs()
            );
        }
    };
    let entry = match extension_entry(&id, &name, &handshake) {
        Ok(entry) => entry,
        Err(error) => {
            // `kill_on_drop` covers the direct child, but only the explicit
            // group teardown below covers descendants it may have started
            // before printing a malformed handshake.
            terminate_child(&mut child, process_group).await;
            return Err(error).with_context(|| {
                format!(
                    "extension {id} from {}: invalid handshake",
                    config_path.display()
                )
            });
        }
    };

    Ok(StartedExtension {
        entry,
        child,
        stdout,
        process_group,
    })
}

async fn read_handshake<R>(stdout: &mut R) -> anyhow::Result<ExtensionHandshake>
where
    R: AsyncBufRead + Unpin,
{
    for _ in 0..HANDSHAKE_LINE_LIMIT {
        let Some(line) = read_bounded_line(stdout).await? else {
            bail!("extension stdout closed before the handshake marker");
        };
        let line = std::str::from_utf8(&line).context("extension stdout is not UTF-8")?;
        let Some(marker_at) = line.find(EXTENSION_HANDSHAKE_MARKER) else {
            continue;
        };
        let payload = line[marker_at + EXTENSION_HANDSHAKE_MARKER.len()..].trim();
        return serde_json::from_str(payload).context("handshake JSON is malformed");
    }
    bail!("extension did not print the handshake marker within {HANDSHAKE_LINE_LIMIT} lines")
}

async fn read_bounded_line<R>(reader: &mut R) -> anyhow::Result<Option<Vec<u8>>>
where
    R: AsyncBufRead + Unpin,
{
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Ok(Some(line))
            };
        }
        let take = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |at| at + 1);
        if line.len() + take > HANDSHAKE_LINE_LIMIT_BYTES {
            bail!("extension handshake line exceeds {HANDSHAKE_LINE_LIMIT_BYTES} bytes");
        }
        line.extend_from_slice(&available[..take]);
        reader.consume(take);
        if line.ends_with(b"\n") {
            return Ok(Some(line));
        }
    }
}

fn extension_entry(
    id: &str,
    name: &str,
    handshake: &ExtensionHandshake,
) -> anyhow::Result<ExtensionEntry> {
    if handshake.token.trim().is_empty() {
        bail!("handshake token is empty");
    }
    if handshake.token.len() > 4096 {
        bail!("handshake token exceeds 4096 bytes");
    }
    let mut upstream = Url::parse(&handshake.url).context("handshake URL is malformed")?;
    if upstream.scheme() != "http" {
        bail!("handshake URL must use http");
    }
    if !upstream.username().is_empty() || upstream.password().is_some() {
        bail!("handshake URL must not contain userinfo");
    }
    let local = match upstream.host() {
        Some(Host::Ipv4(address)) => address == std::net::Ipv4Addr::LOCALHOST,
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        _ => false,
    };
    if !local {
        bail!("handshake URL must use 127.0.0.1 or localhost");
    }
    if upstream
        .port_or_known_default()
        .is_none_or(|port| port == 0)
    {
        bail!("handshake URL must have a usable port");
    }
    if upstream.query_pairs().any(|(key, _)| key == "t") {
        bail!("handshake URL must not already contain a t query parameter");
    }
    // Pin `localhost` to IPv4 after validation. The extension contract is
    // explicitly 127.0.0.1-only, and proxy resolution must not consult a
    // mutable hosts file after accepting the handshake.
    upstream
        .set_host(Some("127.0.0.1"))
        .map_err(|_| anyhow::anyhow!("handshake URL host is invalid"))?;
    Ok(ExtensionEntry {
        id: id.to_string(),
        name: name.to_string(),
        upstream,
        token: handshake.token.clone(),
        capability: random_proxy_capability(),
    })
}

fn random_proxy_capability() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let mut capability = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut capability, "{byte:02x}").expect("writing to a String cannot fail");
    }
    capability
}

async fn supervise_extension(started: StartedExtension, mut shutdown_rx: watch::Receiver<bool>) {
    let StartedExtension {
        entry,
        mut child,
        stdout,
        process_group,
    } = started;
    let id = entry.id;
    let mut stdout = stdout;
    let mut drain = tokio::spawn(async move {
        let _ = tokio::io::copy(&mut stdout, &mut tokio::io::sink()).await;
    });

    tokio::select! {
        status = child.wait() => {
            cleanup_process_group(process_group);
            match status {
                Ok(status) => tracing::warn!(extension_id = %id, %status, "extension exited; restart chan to relaunch it"),
                Err(error) => tracing::warn!(extension_id = %id, %error, "extension wait failed"),
            }
        }
        _ = shutdown_rx.changed() => {
            terminate_child(&mut child, process_group).await;
        }
    }

    if timeout(Duration::from_millis(250), &mut drain)
        .await
        .is_err()
    {
        drain.abort();
        let _ = drain.await;
    }
}

#[cfg(unix)]
fn process_group_for_child(child: &Child) -> Option<ExtensionProcessGroup> {
    child
        .id()
        .and_then(|pid| i32::try_from(pid).ok())
        .and_then(rustix::process::Pid::from_raw)
}

#[cfg(not(unix))]
fn process_group_for_child(_child: &Child) -> Option<ExtensionProcessGroup> {
    None
}

#[cfg(unix)]
fn cleanup_process_group(process_group: Option<ExtensionProcessGroup>) {
    if let Some(process_group) = process_group {
        let _ = rustix::process::kill_process_group(process_group, rustix::process::Signal::KILL);
    }
}

#[cfg(not(unix))]
fn cleanup_process_group(_process_group: Option<ExtensionProcessGroup>) {}

#[cfg(unix)]
async fn terminate_child(child: &mut Child, process_group: Option<ExtensionProcessGroup>) {
    if let Some(process_group) = process_group {
        let _ = rustix::process::kill_process_group(process_group, rustix::process::Signal::TERM);
    } else {
        let _ = child.start_kill();
    }
    if timeout(CHILD_SHUTDOWN_GRACE, child.wait()).await.is_err() {
        if let Some(process_group) = process_group {
            let _ =
                rustix::process::kill_process_group(process_group, rustix::process::Signal::KILL);
        }
        let _ = child.start_kill();
        let _ = child.wait().await;
    } else {
        cleanup_process_group(process_group);
    }
}

#[cfg(not(unix))]
async fn terminate_child(child: &mut Child, _process_group: Option<ExtensionProcessGroup>) {
    let _ = child.kill().await;
    let _ = child.wait().await;
}

pub(crate) fn empty_catalog() -> Arc<ExtensionCatalog> {
    ExtensionCatalog::empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_is_sorted_and_ignores_invalid_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("z-last.toml"),
            "name = \"Last\"\ncommand = \"last\"\n",
        )
        .expect("write valid config");
        std::fs::write(
            dir.path().join("a-first.toml"),
            "name = \"First\"\ncommand = \"first\"\nargs = [\"one\"]\n",
        )
        .expect("write valid config");
        std::fs::write(
            dir.path().join("Bad.toml"),
            "name = \"Bad id\"\ncommand = \"bad\"\n",
        )
        .expect("write invalid-id config");
        std::fs::write(
            dir.path().join("unknown.toml"),
            "name = \"Unknown field\"\ncommand = \"bad\"\nextra = true\n",
        )
        .expect("write unknown-field config");
        std::fs::write(dir.path().join("ignored.txt"), "not TOML").expect("write ignored file");

        let declarations = load_declarations(dir.path());
        let ids: Vec<_> = declarations.iter().map(|entry| entry.id.as_str()).collect();
        assert_eq!(ids, ["a-first", "z-last"]);
        assert_eq!(declarations[0].args, ["one"]);
    }

    #[test]
    fn extension_ids_are_lowercase_filename_slugs() {
        assert_eq!(
            extension_id(Path::new("/tmp/echo-test.toml")).as_deref(),
            Some("echo-test")
        );
        assert_eq!(
            extension_id(Path::new("/tmp/a_2.toml")).as_deref(),
            Some("a_2")
        );
        assert_eq!(extension_id(Path::new("/tmp/Echo.toml")), None);
        assert_eq!(extension_id(Path::new("/tmp/-echo.toml")), None);
    }

    #[test]
    fn handshake_builds_a_capability_path_and_keeps_upstream_auth_private() {
        let entry = extension_entry(
            "echo",
            "Echo",
            &ExtensionHandshake {
                url: "http://127.0.0.1:4567/echo?mode=test#app".to_string(),
                token: "a token/+".to_string(),
            },
        )
        .expect("valid handshake");
        let view = entry.view();
        assert!(view
            .entry_path
            .starts_with(&format!("{EXTENSION_PROXY_PREFIX}/echo/")));
        assert!(view.entry_path.ends_with("/echo?mode=test#app"));
        assert!(!view.entry_path.contains("a%20token"));
        assert!(!view.entry_path.contains("4567"));

        let upstream = entry.upstream_url("/echo", Some("mode=test"));
        assert_eq!(upstream.host_str(), Some("127.0.0.1"));
        assert!(upstream
            .query_pairs()
            .any(|(key, value)| key == "t" && value == "a token/+"));
    }

    #[test]
    fn handshake_refuses_nonlocal_or_ambiguous_auth_urls() {
        for url in [
            "https://127.0.0.1:4567/",
            "http://example.com:4567/",
            "http://[::1]:4567/",
            "http://127.0.0.1:4567/?t=already",
            "http://127.0.0.1:4567/?%74=encoded",
            "http://127.0.0.1:0/",
        ] {
            assert!(
                extension_entry(
                    "echo",
                    "Echo",
                    &ExtensionHandshake {
                        url: url.to_string(),
                        token: "secret".to_string(),
                    }
                )
                .is_err(),
                "accepted {url}"
            );
        }
        for token in ["", "   "] {
            assert!(extension_entry(
                "echo",
                "Echo",
                &ExtensionHandshake {
                    url: "http://127.0.0.1:4567/".to_string(),
                    token: token.to_string(),
                }
            )
            .is_err());
        }
    }

    #[tokio::test]
    async fn handshake_line_is_bounded_and_marker_delimited() {
        let input = format!(
            "extension booting\nnoise {EXTENSION_HANDSHAKE_MARKER}{{\"url\":\"http://localhost:9/\",\"token\":\"x\"}}\n"
        );
        let mut input = BufReader::new(input.as_bytes());
        let handshake = read_handshake(&mut input).await.expect("handshake");
        assert_eq!(handshake.url, "http://localhost:9/");
        assert_eq!(handshake.token, "x");

        let oversized = vec![b'x'; HANDSHAKE_LINE_LIMIT_BYTES + 1];
        let mut oversized = BufReader::new(oversized.as_slice());
        assert!(read_handshake(&mut oversized).await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runtime_starts_and_reaps_a_declared_process() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("echo.toml"),
            "name = \"Echo\"\ncommand = \"/bin/sh\"\nargs = [\"extension.sh\"]\n",
        )
        .expect("write config");
        std::fs::write(
            dir.path().join("extension.sh"),
            format!(
                "printf '%s' \"$$\" > extension.pid\nprintf '%s\\n' '{}'\nwhile :; do sleep 60; done\n",
                r#"CHAN_EXTENSION_V1={"url":"http://127.0.0.1:9/","token":"test"}"#,
            ),
        )
        .expect("write extension script");

        let runtime = ExtensionRuntime::start_in(dir.path()).await;
        assert_eq!(runtime.catalog.views().len(), 1);
        assert_eq!(runtime.catalog.views()[0].id, "echo");
        let raw_pid = std::fs::read_to_string(dir.path().join("extension.pid"))
            .expect("extension pid")
            .parse::<i32>()
            .expect("numeric extension pid");
        let pid = rustix::process::Pid::from_raw(raw_pid).expect("positive extension pid");
        assert!(rustix::process::test_kill_process(pid).is_ok());

        runtime.shutdown().await;
        let gone = tokio::time::timeout(Duration::from_secs(1), async {
            while rustix::process::test_kill_process(pid).is_ok() {
                tokio::task::yield_now().await;
            }
        })
        .await;
        assert!(gone.is_ok(), "extension process survived runtime shutdown");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn invalid_handshake_reaps_the_declared_process_group() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("bad.toml"),
            "name = \"Bad\"\ncommand = \"/bin/sh\"\nargs = [\"extension.sh\"]\n",
        )
        .expect("write config");
        std::fs::write(
            dir.path().join("extension.sh"),
            format!(
                "sleep 60 &\nprintf '%s' \"$!\" > descendant.pid\nprintf '%s\\n' '{}'\nwait\n",
                r#"CHAN_EXTENSION_V1={"url":"https://example.com/","token":"test"}"#,
            ),
        )
        .expect("write extension script");

        let runtime = ExtensionRuntime::start_in(dir.path()).await;
        assert!(runtime.catalog.views().is_empty());
        let raw_pid = std::fs::read_to_string(dir.path().join("descendant.pid"))
            .expect("descendant pid")
            .parse::<i32>()
            .expect("numeric descendant pid");
        let pid = rustix::process::Pid::from_raw(raw_pid).expect("positive descendant pid");
        let gone = tokio::time::timeout(Duration::from_secs(1), async {
            while rustix::process::test_kill_process(pid).is_ok() {
                tokio::task::yield_now().await;
            }
        })
        .await;
        assert!(gone.is_ok(), "invalid extension left a descendant running");

        runtime.shutdown().await;
    }
}
