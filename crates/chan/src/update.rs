// Self-upgrade for chan. Three pieces:
//
//   1. Banner. On `chan open` startup, [`maybe_print_banner`] reads
//      the cached state file and prints a one-line stderr banner if a
//      newer release is known. No network access; the probe is what
//      populates the cache.
//   2. Probe. [`run_probe`] is spawned as a tokio task at the start
//      of `chan open`. It reads complete-release CLI metadata with
//      a short timeout, writes the result to the state file,
//      and prints the banner inline if the just-fetched version is
//      newer than the running binary's. Throttled to once per
//      [`PROBE_INTERVAL_HOURS`] across `chan open` restarts.
//   3. `chan upgrade`. [`run_upgrade`] resolves the running binary
//      via [`std::env::current_exe`], reads complete-release CLI
//      metadata, downloads the archive for the current target into a
//      sibling temp file, verifies SHA-256 against the metadata,
//      extracts the `chan` binary out of the archive into a second
//      temp file, and atomically renames it over the running
//      executable.
//
// Metadata URLs are hardcoded to chan.app. Release assets may live on
// GitHub Releases or another HTTPS origin chosen by the metadata.
// Self-hosted / mirrored deployments are not supported for the CLI
// upgrade path. Offline / proxy hosts:
// reqwest honors HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY
// from the environment, and probe failures are swallowed (verbose
// only) so an air-gapped `chan open` keeps working.

use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const CLI_METADATA_BASE: &str = "https://chan.app/dl/cli";
const CLI_LATEST_METADATA_URL: &str = "https://chan.app/dl/cli/latest.json";

/// Disable the probe (banner still prints from cached state).
const ENV_DISABLE: &str = "CHAN_UPDATE_CHECK";

/// How often to re-probe across `chan open` restarts.
const PROBE_INTERVAL_HOURS: u64 = 24;

/// Probe timeouts. Short enough that a chan open in a sandbox /
/// no-network environment doesn't stall the banner path.
const PROBE_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const PROBE_TOTAL_TIMEOUT: Duration = Duration::from_secs(5);

/// Upgrade flow timeouts. Generous: a 60 MB binary on a 1 Mbps link
/// is ~8 minutes. The total timeout is the cap on the whole download.
const UPGRADE_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const UPGRADE_TOTAL_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// Safety cap on the downloaded archive (256 MiB). Real artifacts
/// today are ~75 MB on Linux + macOS (with the embedding model
/// bundled).
const MAX_ARCHIVE_SIZE: u64 = 256 * 1024 * 1024;

/// Safety cap on metadata JSON responses (1 MiB).
const MAX_METADATA_SIZE: u64 = 1024 * 1024;

const STATE_FILE: &str = "update-check.json";

/// Where to keep the per-machine update state.
fn state_path() -> PathBuf {
    chan_workspace::paths::config_dir().join(STATE_FILE)
}

/// State recorded after a probe.
#[derive(Debug, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct State {
    /// Unix seconds when the probe last ran (success or failure).
    pub checked_at: u64,
    /// Version of the chan binary at the time of the check.
    pub checked_version: String,
    /// Latest version the probe saw, or `None` on failure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn env_disabled() -> bool {
    matches!(env::var(ENV_DISABLE), Ok(v) if v == "0")
}

/// Build-time marker for builds a package manager owns: the distro source
/// packages export `CHAN_PACKAGED` around `cargo build` (`rpm`, `deb`, `aur`,
/// `nix`), as does the local Arch QA package (`pacman`). When set, the probe
/// and banner stay silent and `chan upgrade` refuses instead of renaming over
/// a package-manager-owned binary. The `.deb`/`.rpm` release downloads are
/// unstamped: no repository serves them, so self-upgrade stays their update
/// path.
pub fn packaged_via() -> Option<&'static str> {
    option_env!("CHAN_PACKAGED")
}

/// The refusal message for a distro-packaged build, or `None` when the
/// build owns its own files and may self-upgrade. Takes the marker as
/// an argument because [`packaged_via`] is a compile-time `option_env!`
/// that a running test binary cannot flip.
pub fn packaged_upgrade_refusal(packaged: Option<&str>) -> Option<String> {
    packaged.map(upgrade_blocked_message)
}

fn upgrade_blocked_message(pm: &str) -> String {
    let hint = match pm {
        "rpm" => "sudo dnf upgrade",
        "deb" => "sudo apt upgrade",
        "aur" => "your AUR helper (for example, paru -Syu or yay -Syu)",
        "nix" => "nix profile upgrade chan-desktop (or update the flake input that provides chan)",
        _ => "your system package manager",
    };
    format!(
        "this build of chan is managed by the system package manager ({pm}); \
         self-upgrade is disabled. Update with {hint}."
    )
}

fn read_state(path: &Path) -> Option<State> {
    let contents = fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

fn write_state(path: &Path, state: &State) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    }
    let body = serde_json::to_vec_pretty(state).context("serializing state")?;
    chan_workspace::fs_ops::atomic_write(path, &body).context("writing state file")
}

/// Match the standalone CLI tarballs published by release.yml and install.sh.
///
/// Returns `(target_triple, archive_extension, binary_filename)`.
pub fn current_target() -> Result<(&'static str, &'static str, &'static str)> {
    release_target_for(env::consts::OS, env::consts::ARCH)
}

fn release_target_for(os: &str, arch: &str) -> Result<(&'static str, &'static str, &'static str)> {
    match (os, arch) {
        // The standalone Linux CLI tarball is musl (fully static) so a too-new
        // build glibc does not gate older machines; self-upgrade resolves the
        // same musl asset install.sh and latest.json publish. macOS is native.
        ("linux", "x86_64") => Ok(("x86_64-unknown-linux-musl", "tar.gz", "chan")),
        ("linux", "aarch64") => Ok(("aarch64-unknown-linux-musl", "tar.gz", "chan")),
        ("macos", "aarch64") => Ok(("aarch64-apple-darwin", "tar.gz", "chan")),
        (os, arch) => bail!(
            "no published standalone chan CLI release for {os}/{arch}. \
             Supported targets: linux x86_64/aarch64, macos aarch64."
        ),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ReleaseVersion {
    /// Public release tag, matching the `vX.Y.Z` contract.
    tag: String,
    /// Bare semver used for comparisons and user-facing messages.
    version: String,
}

#[derive(Debug, Deserialize)]
struct CliReleaseMetadata {
    version: String,
    tag: String,
    #[serde(default)]
    published_at: Option<String>,
    targets: Vec<CliTargetAsset>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
struct CliTargetAsset {
    target: String,
    asset: String,
    url: String,
    sha256: String,
}

fn release_from_tag(tag: &str) -> Result<ReleaseVersion> {
    let tag = tag.trim();
    if tag.is_empty() {
        bail!("release tag cannot be empty");
    }
    let version = tag
        .strip_prefix('v')
        .context("release tag must use the vX.Y.Z form")?
        .to_string();
    validate_version(&version)?;
    Ok(ReleaseVersion {
        tag: tag.to_string(),
        version,
    })
}

fn release_from_version_override(version: &str) -> Result<ReleaseVersion> {
    let version = version.trim();
    if version.is_empty() {
        bail!("--version cannot be empty");
    }
    // Keep the CLI surface clean: users type versions, the release
    // pipeline owns the `v` tag convention.
    if version.starts_with('v') {
        bail!("--version expects a bare version such as 0.14.0");
    }
    validate_version(version)?;
    Ok(ReleaseVersion {
        tag: format!("v{version}"),
        version: version.to_string(),
    })
}

fn validate_version(version: &str) -> Result<()> {
    let (triple, pre) = match version.split_once('-') {
        Some((triple, pre)) => (triple, Some(pre)),
        None => (version, None),
    };
    let mut parts = triple.split('.');
    for name in ["major", "minor", "patch"] {
        let Some(part) = parts.next() else {
            bail!("release version must use X.Y.Z or X.Y.Z-pre: {version:?}");
        };
        if part.is_empty() || !part.chars().all(|c| c.is_ascii_digit()) {
            bail!("release version {name} component must be numeric: {version:?}");
        }
    }
    if parts.next().is_some() {
        bail!("release version must use X.Y.Z or X.Y.Z-pre: {version:?}");
    }
    if let Some(pre) = pre {
        validate_prerelease(pre, version)?;
    }
    Ok(())
}

/// A prerelease suffix is dot-separated identifiers of ASCII
/// alphanumerics and hyphens, none empty. This checks the charset
/// only, deliberately more lenient than full semver validity: a
/// leading-zero numeric identifier ("01") is accepted and orders equal
/// to its zero-stripped form instead of rejecting. Build metadata
/// (`+`) is not accepted; the release pipeline never mints it.
fn validate_prerelease(pre: &str, version: &str) -> Result<()> {
    let valid = !pre.is_empty()
        && pre.split('.').all(|ident| {
            !ident.is_empty() && ident.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        });
    if !valid {
        bail!(
            "release version prerelease suffix must be dot-separated \
             alphanumeric/hyphen identifiers: {version:?}"
        );
    }
    Ok(())
}

fn metadata_url_for_version(version: &str) -> String {
    format!("{CLI_METADATA_BASE}/v{version}.json")
}

fn ensure_https_url(url: &str) -> Result<()> {
    if !url.starts_with("https://") {
        bail!("refusing non-https URL: {url}");
    }
    Ok(())
}

/// A parsed `X.Y.Z` or `X.Y.Z-pre` version, ordered like semver at the
/// triple level: the triple compares first, and a prerelease sorts
/// BELOW its own release triple (0.60.0-rc1 < 0.60.0) and above every
/// lower triple (0.59.1 < 0.60.0-rc1).
///
/// Within one triple, prereleases compare by dot-separated
/// [`Identifier`]: pure-numeric identifiers compare numerically and
/// sort below any alphanumeric identifier (semver's rule), and
/// alphanumeric identifiers compare by their digit / non-digit runs
/// with digit runs compared numerically ("rc2" < "rc10"). The run
/// comparison deviates from strict semver, which compares an undotted
/// alphanumeric identifier as plain ASCII and would sort rc10 before
/// rc2; the release pipeline names prereleases rcN, so numeric-aware
/// ordering is the one that ranks them correctly. A prerelease that
/// extends another sorts after it ("rc1" < "rc1.hotfix").
#[derive(Debug, PartialEq, Eq)]
struct ParsedVersion {
    triple: (u32, u32, u32),
    /// `None` is a release, sorting above every prerelease of the same
    /// triple.
    pre: Option<Vec<Identifier>>,
}

impl Ord for ParsedVersion {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.triple
            .cmp(&other.triple)
            .then_with(|| match (&self.pre, &other.pre) {
                (None, None) => std::cmp::Ordering::Equal,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (Some(_), None) => std::cmp::Ordering::Less,
                (Some(a), Some(b)) => a.cmp(b),
            })
    }
}

impl PartialOrd for ParsedVersion {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// One dot-separated identifier of a prerelease suffix. A pure-numeric
/// identifier always sorts below an alphanumeric one, per semver;
/// numeric values are held with leading zeros stripped, so numeric
/// order is (length, then lexicographic) without any integer-width
/// limit ("01" canonicalizes equal to "1").
#[derive(Debug, PartialEq, Eq)]
enum Identifier {
    Numeric(String),
    Alphanumeric(Vec<IdentRun>),
}

impl Ord for Identifier {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        match (self, other) {
            (Identifier::Numeric(a), Identifier::Numeric(b)) => cmp_canonical_digits(a, b),
            (Identifier::Numeric(_), Identifier::Alphanumeric(_)) => std::cmp::Ordering::Less,
            (Identifier::Alphanumeric(_), Identifier::Numeric(_)) => std::cmp::Ordering::Greater,
            (Identifier::Alphanumeric(a), Identifier::Alphanumeric(b)) => a.cmp(b),
        }
    }
}

impl PartialOrd for Identifier {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

fn canonical_digits(digits: &str) -> String {
    let trimmed = digits.trim_start_matches('0');
    let canonical = if trimmed.is_empty() { "0" } else { trimmed };
    canonical.to_string()
}

fn cmp_canonical_digits(a: &str, b: &str) -> std::cmp::Ordering {
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

/// One maximal digit or non-digit run inside an alphanumeric
/// identifier. At the same run position a digit run sorts below a text
/// run, mirroring the identifier-level numeric-below-alphanumeric rule;
/// digit runs hold their [`canonical_digits`] form and compare
/// numerically.
#[derive(Debug, PartialEq, Eq)]
enum IdentRun {
    Num(String),
    Text(String),
}

impl Ord for IdentRun {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        match (self, other) {
            (IdentRun::Num(a), IdentRun::Num(b)) => cmp_canonical_digits(a, b),
            (IdentRun::Num(_), IdentRun::Text(_)) => std::cmp::Ordering::Less,
            (IdentRun::Text(_), IdentRun::Num(_)) => std::cmp::Ordering::Greater,
            (IdentRun::Text(a), IdentRun::Text(b)) => a.cmp(b),
        }
    }
}

impl PartialOrd for IdentRun {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

fn parse_identifier(ident: &str) -> Identifier {
    if ident.bytes().all(|b| b.is_ascii_digit()) {
        return Identifier::Numeric(canonical_digits(ident));
    }
    let mut runs = Vec::new();
    let bytes = ident.as_bytes();
    let mut start = 0;
    while start < bytes.len() {
        let digits = bytes[start].is_ascii_digit();
        let mut end = start + 1;
        while end < bytes.len() && bytes[end].is_ascii_digit() == digits {
            end += 1;
        }
        let run = &ident[start..end];
        runs.push(if digits {
            IdentRun::Num(canonical_digits(run))
        } else {
            IdentRun::Text(run.to_string())
        });
        start = end;
    }
    Identifier::Alphanumeric(runs)
}

fn parse_semver(s: &str) -> Option<ParsedVersion> {
    let s = s.trim().strip_prefix('v').unwrap_or(s.trim());
    let (triple_raw, pre_raw) = match s.split_once('-') {
        Some((triple, pre)) => (triple, Some(pre)),
        None => (s, None),
    };
    let mut parts = triple_raw.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next()?.parse().ok()?;
    let patch_raw = parts.next()?;
    if parts.next().is_some() || !patch_raw.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let patch: u32 = patch_raw.parse().ok()?;
    let pre = match pre_raw {
        Some(pre) => {
            if pre.is_empty()
                || !pre.split('.').all(|ident| {
                    !ident.is_empty()
                        && ident.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
                })
            {
                return None;
            }
            Some(pre.split('.').map(parse_identifier).collect())
        }
        None => None,
    };
    Some(ParsedVersion {
        triple: (major, minor, patch),
        pre,
    })
}

/// `true` iff `latest` parses strictly greater than `current`.
/// Unparseable inputs are treated as "not newer". Prereleases order
/// per [`ParsedVersion`]: 0.60.0-rc1 is newer than 0.59.1 but older
/// than 0.60.0.
pub fn semver_newer(latest: &str, current: &str) -> bool {
    match (parse_semver(latest), parse_semver(current)) {
        (Some(l), Some(c)) => l > c,
        _ => false,
    }
}

/// Normalize and validate a SHA-256 hex digest from release metadata.
fn normalize_sha256(hash: &str, name: &str) -> Result<String> {
    let hash = hash.trim();
    if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        bail!("malformed SHA256 value for {name}: {hash}");
    }
    Ok(hash.to_ascii_lowercase())
}

fn http_client(connect: Duration, total: Duration) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(connect)
        .timeout(total)
        .user_agent(format!("chan/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .context("building http client")
}

async fn fetch_text(client: &reqwest::Client, url: &str) -> Result<String> {
    ensure_https_url(url)?;
    let resp = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("GET {url}"))?
        .error_for_status()
        .with_context(|| format!("GET {url} returned an HTTP error"))?;
    let bytes = resp
        .bytes()
        .await
        .with_context(|| format!("reading body of {url}"))?;
    if (bytes.len() as u64) > MAX_METADATA_SIZE {
        bail!("metadata response from {url} exceeds {MAX_METADATA_SIZE} byte cap");
    }
    String::from_utf8(bytes.to_vec()).with_context(|| format!("decoding utf-8 body of {url}"))
}

fn parse_cli_metadata(body: &str) -> Result<CliReleaseMetadata> {
    let metadata: CliReleaseMetadata =
        serde_json::from_str(body).context("CLI release metadata is not JSON")?;
    validate_cli_metadata(metadata)
}

fn validate_cli_metadata(metadata: CliReleaseMetadata) -> Result<CliReleaseMetadata> {
    validate_version(&metadata.version).context("CLI metadata has invalid version")?;
    let tag = release_from_tag(&metadata.tag).context("CLI metadata has invalid tag")?;
    if tag.version != metadata.version {
        bail!(
            "CLI metadata tag/version mismatch: tag {} is {}, version is {}",
            metadata.tag,
            tag.version,
            metadata.version
        );
    }
    if metadata
        .published_at
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        bail!("CLI metadata missing published_at");
    }
    if metadata.targets.is_empty() {
        bail!("CLI metadata has no targets");
    }
    let mut seen = BTreeSet::new();
    for target in &metadata.targets {
        if target.target.trim().is_empty() {
            bail!("CLI metadata contains an empty target");
        }
        if !seen.insert(target.target.as_str()) {
            bail!("CLI metadata contains duplicate target {}", target.target);
        }
        if target.asset.trim().is_empty() {
            bail!("CLI metadata target {} has no asset name", target.target);
        }
        ensure_https_url(&target.url)
            .with_context(|| format!("CLI metadata target {} has invalid URL", target.target))?;
        normalize_sha256(&target.sha256, &target.asset)
            .with_context(|| format!("CLI metadata target {} has invalid SHA256", target.target))?;
    }
    Ok(metadata)
}

fn target_asset_for(
    metadata: &CliReleaseMetadata,
    target: &str,
    ext: &str,
) -> Result<CliTargetAsset> {
    let asset = metadata
        .targets
        .iter()
        .find(|asset| asset.target == target)
        .with_context(|| {
            format!(
                "release {} does not include a standalone chan CLI asset for {target}",
                metadata.version
            )
        })?;
    let expected = format!("chan-{target}.{ext}");
    if asset.asset != expected {
        bail!(
            "CLI metadata target {target} points at asset {}, expected {expected}",
            asset.asset
        );
    }
    Ok(asset.clone())
}

/// Fetch and validate complete-release CLI metadata.
async fn fetch_cli_metadata(client: &reqwest::Client, url: &str) -> Result<CliReleaseMetadata> {
    let body = fetch_text(client, url).await?;
    parse_cli_metadata(&body).with_context(|| format!("invalid CLI release metadata at {url}"))
}

async fn fetch_latest_cli_metadata(client: &reqwest::Client) -> Result<CliReleaseMetadata> {
    fetch_cli_metadata(client, CLI_LATEST_METADATA_URL).await
}

/// Print the banner if a newer release is cached. Stderr-only,
/// errors swallowed.
pub fn maybe_print_banner() {
    if packaged_via().is_some() || env_disabled() {
        return;
    }
    let Some(state) = read_state(&state_path()) else {
        return;
    };
    let Some(latest) = state.latest_version.as_deref() else {
        return;
    };
    let current = env!("CARGO_PKG_VERSION");
    if !semver_newer(latest, current) {
        return;
    }
    eprintln!(
        "chan: update available: {latest} (you have {current}). \
         Run `chan upgrade` to update, or set CHAN_UPDATE_CHECK=0 to silence."
    );
}

fn probe_due(state: Option<&State>) -> bool {
    let Some(s) = state else {
        return true;
    };
    let interval = PROBE_INTERVAL_HOURS.saturating_mul(3600);
    now_unix().saturating_sub(s.checked_at) >= interval
}

/// Background probe. Designed to be `tokio::spawn`'d from
/// `chan open` startup. Swallows errors so an offline / proxied
/// host stays silent; failures are logged at `debug` so they're
/// visible under `RUST_LOG=debug` / `chan -vv`.
pub async fn run_probe() {
    if packaged_via().is_some() || env_disabled() {
        return;
    }
    let path = state_path();
    let prior = read_state(&path);
    if !probe_due(prior.as_ref()) {
        return;
    }
    let client = match http_client(PROBE_CONNECT_TIMEOUT, PROBE_TOTAL_TIMEOUT) {
        Ok(c) => c,
        Err(e) => {
            tracing::debug!(error = ?e, "update probe: client build failed");
            return;
        }
    };
    let checked_version = env!("CARGO_PKG_VERSION").to_string();
    let now = now_unix();
    let state = match fetch_latest_cli_metadata(&client).await {
        Ok(latest) => {
            // Print the banner inline so the user sees it on the
            // session that triggered the probe, not just the next
            // restart. Only when strictly newer.
            if semver_newer(&latest.version, &checked_version) {
                eprintln!(
                    "chan: update available: {} (you have {checked_version}). \
                     Run `chan upgrade` to update, or set CHAN_UPDATE_CHECK=0 to silence.",
                    latest.version
                );
            }
            State {
                checked_at: now,
                checked_version,
                latest_version: Some(latest.version),
            }
        }
        Err(e) => {
            tracing::debug!(error = ?e, "update probe: fetch failed");
            // Persist the timestamp so we don't retry every restart
            // on an air-gapped host.
            State {
                checked_at: now,
                checked_version,
                latest_version: None,
            }
        }
    };
    if let Err(e) = write_state(&path, &state) {
        tracing::debug!(error = ?e, "update probe: state write failed");
    }
}

/// Drop-guard that unlinks a path on drop unless disarmed.
struct TempGuard(Option<PathBuf>);

impl TempGuard {
    fn new(path: PathBuf) -> Self {
        Self(Some(path))
    }
    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for TempGuard {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = fs::remove_file(&path);
        }
    }
}

fn action_words(target: &str, current: &str) -> (&'static str, &'static str) {
    if semver_newer(current, target) {
        ("downgrading", "downgraded")
    } else {
        ("upgrading", "upgraded")
    }
}

/// Build the state to record after a successful upgrade.
///
/// The running process is still the **old** binary; the replacement
/// only takes effect on the next launch. If we stored the true
/// latest version here, a subsequent `chan open` launched from the
/// same shell session would not print the "update available"
/// banner, but the running session would, since cached `latest >
/// current` for the still-old in-memory version. We zero out
/// `latest_version` so the next probe repopulates it.
fn post_upgrade_state(installed_version: &str) -> State {
    State {
        checked_at: now_unix(),
        checked_version: installed_version.to_string(),
        latest_version: None,
    }
}

pub struct UpgradeOptions {
    pub assume_yes: bool,
    pub check_only: bool,
    pub version_override: Option<String>,
    pub verbose: bool,
}

/// Execute `chan upgrade`. Async because we share the reqwest
/// client wiring with the serve-time probe.
pub async fn run_upgrade(opts: UpgradeOptions) -> Result<()> {
    if let Some(message) = packaged_upgrade_refusal(packaged_via()) {
        bail!(message);
    }
    let (target, ext, bin_name) = current_target()?;
    let current = env!("CARGO_PKG_VERSION").to_string();

    let client = http_client(UPGRADE_CONNECT_TIMEOUT, UPGRADE_TOTAL_TIMEOUT)?;

    let metadata = match opts.version_override.as_deref() {
        Some(v) => {
            let requested = release_from_version_override(v)?;
            let url = metadata_url_for_version(&requested.version);
            if opts.verbose {
                eprintln!("chan: checking release metadata at {url}");
            }
            let metadata = fetch_cli_metadata(&client, &url).await?;
            if metadata.version != requested.version || metadata.tag != requested.tag {
                bail!(
                    "metadata at {url} describes {} ({}) instead of {} ({})",
                    metadata.version,
                    metadata.tag,
                    requested.version,
                    requested.tag
                );
            }
            metadata
        }
        None => {
            if opts.verbose {
                eprintln!("chan: checking latest release metadata at {CLI_LATEST_METADATA_URL}");
            }
            fetch_latest_cli_metadata(&client).await?
        }
    };
    let target_version = metadata.version.clone();

    if target_version == current {
        println!("chan: already at version {current}");
        return Ok(());
    }

    let asset = target_asset_for(&metadata, target, ext)?;

    if opts.check_only {
        if semver_newer(&target_version, &current) {
            println!("chan: update available: {target_version} (current: {current})");
        } else {
            println!("chan: target version {target_version} is not newer than current {current}");
        }
        return Ok(());
    }

    let exe_path = env::current_exe().context("resolving current executable")?;
    let exe_path = exe_path.canonicalize().unwrap_or(exe_path);
    let binary_dir = exe_path
        .parent()
        .context("current executable has no parent directory")?
        .to_path_buf();

    let archive_name = asset.asset.clone();
    let archive_url = asset.url.clone();

    let (gerund, participle) = action_words(&target_version, &current);
    println!(
        "chan: {gerund} from {current} to {target_version} ({target}) at {}",
        exe_path.display()
    );

    if !opts.assume_yes {
        if !std::io::IsTerminal::is_terminal(&std::io::stdin()) {
            bail!("use -y to confirm upgrade in non-interactive mode");
        }
        let is_downgrade = semver_newer(&current, &target_version);
        let (prompt, default_yes) = if is_downgrade {
            ("proceed? [y/N] ", false)
        } else {
            ("proceed? [Y/n] ", true)
        };
        if !confirm(prompt, default_yes)? {
            bail!("aborted");
        }
    }

    // Pre-flight writability check on the binary's directory.
    // Writing a probe file is more reliable than checking mode bits
    // because of ACLs and bind mounts.
    {
        let probe = binary_dir.join(format!(".chan.upgrade-probe.{}", std::process::id()));
        fs::File::create(&probe).with_context(|| {
            format!("binary directory is not writable: {}", binary_dir.display())
        })?;
        let _ = fs::remove_file(&probe);
    }

    if opts.verbose {
        eprintln!("chan: downloading {archive_url}");
    }

    // Stream archive into a temp file alongside the running binary
    // and SHA-256 it on the fly.
    ensure_https_url(&archive_url)?;
    let archive_path = binary_dir.join(format!(".chan.upgrade-archive.{}", std::process::id()));
    let archive_guard = TempGuard::new(archive_path.clone());

    let mut resp = client
        .get(&archive_url)
        .send()
        .await
        .with_context(|| format!("GET {archive_url}"))?
        .error_for_status()
        .with_context(|| format!("GET {archive_url} returned an HTTP error"))?;
    // Trust the advertised size only up to the safety cap, so a bogus
    // huge Content-Length can't make the percent/ETA meaningless before
    // the byte-cap below trips.
    let advertised = resp.content_length().filter(|n| *n <= MAX_ARCHIVE_SIZE);

    let mut archive_file = fs::File::create(&archive_path)
        .with_context(|| format!("creating {}", archive_path.display()))?;
    let mut hasher = Sha256::new();
    let mut total: u64 = 0;
    let mut progress =
        DownloadProgress::new(advertised, std::io::stderr().is_terminal(), opts.verbose);
    while let Some(chunk) = resp
        .chunk()
        .await
        .with_context(|| format!("reading chunk from {archive_url}"))?
    {
        archive_file
            .write_all(&chunk)
            .with_context(|| format!("writing to {}", archive_path.display()))?;
        hasher.update(&chunk);
        total += chunk.len() as u64;
        if total > MAX_ARCHIVE_SIZE {
            bail!("downloaded archive exceeds safety cap of {MAX_ARCHIVE_SIZE} bytes");
        }
        progress.update(chunk.len());
    }
    progress.finish();
    archive_file.flush()?;
    drop(archive_file);

    let actual_hash = format!("{:x}", hasher.finalize());
    if opts.verbose {
        eprintln!("chan: downloaded {total} bytes, sha256={actual_hash}");
    }

    if opts.verbose {
        eprintln!("chan: verifying {archive_name} against release metadata");
    }
    let expected_hash = normalize_sha256(&asset.sha256, &archive_name)?;
    if actual_hash != expected_hash {
        bail!("SHA256 mismatch for {archive_name}: expected {expected_hash}, got {actual_hash}");
    }

    // Extract the chan binary into a sibling temp file. We never
    // unpack the rest of the archive (LICENSE, README) because the
    // upgrade only swaps the executable.
    let bin_temp = binary_dir.join(format!(".chan.upgrade-bin.{}", std::process::id()));
    let mut bin_guard = TempGuard::new(bin_temp.clone());
    extract_binary(&archive_path, &bin_temp, bin_name, ext, opts.verbose)?;

    set_executable_mode(&bin_temp)?;

    install_replacement(&bin_temp, &exe_path)?;
    bin_guard.disarm();
    drop(archive_guard);

    let _ = write_state(&state_path(), &post_upgrade_state(&target_version));

    println!("chan: {participle} to {target_version}");
    Ok(())
}

/// Plain-text download progress for `chan upgrade`, modeled on sdme's
/// terminal output. On a TTY it rewrites a single line in place (`\r`):
/// percent, downloaded / total size, elapsed, and ETA. On a pipe (no
/// TTY) it stays quiet unless `--verbose`, then logs decile milestones
/// (10%, 20%, …) as plain lines so a captured log still shows motion.
/// Degrades gracefully when the server sends no Content-Length: shows
/// bytes, elapsed, and average rate without a percent or ETA. No TUI,
/// no extra deps -- just stderr writes.
struct DownloadProgress {
    /// Advertised total from Content-Length, if any (already capped).
    total: Option<u64>,
    downloaded: u64,
    start: Instant,
    /// Last on-screen refresh; throttles TTY redraws to ~10 Hz.
    last_render: Option<Instant>,
    tty: bool,
    verbose: bool,
    /// Next decile milestone to log in non-TTY verbose mode.
    next_decile: u64,
    /// Whether an unterminated `\r` line is currently on screen.
    line_open: bool,
}

impl DownloadProgress {
    fn new(total: Option<u64>, tty: bool, verbose: bool) -> Self {
        Self {
            total,
            downloaded: 0,
            start: Instant::now(),
            last_render: None,
            tty,
            verbose,
            next_decile: 10,
            line_open: false,
        }
    }

    /// Account for `n` freshly written bytes and refresh the display,
    /// throttled to ~10 Hz on a TTY.
    fn update(&mut self, n: usize) {
        self.downloaded += n as u64;
        if self.tty {
            let due = self
                .last_render
                .is_none_or(|t| t.elapsed() >= Duration::from_millis(100));
            if due {
                self.render_tty();
            }
        } else if self.verbose {
            self.log_deciles();
        }
    }

    /// Final refresh: draw the finished state and close the line with a
    /// newline so later output starts clean. Idempotent.
    fn finish(&mut self) {
        if self.tty {
            self.render_tty();
            if self.line_open {
                let _ = writeln!(std::io::stderr());
                self.line_open = false;
            }
        } else if self.verbose {
            // downloaded == total by now, so this flushes the 100% line.
            self.log_deciles();
        }
    }

    fn render_tty(&mut self) {
        self.last_render = Some(Instant::now());
        let elapsed = self.start.elapsed().as_secs();
        let line = match self.total {
            Some(total) if total > 0 => {
                let pct = (self.downloaded.min(total) * 100 / total).min(100);
                let eta = self
                    .eta_secs(total)
                    .map(|s| format!("  ETA {}", fmt_secs(s)))
                    .unwrap_or_default();
                format!(
                    "chan: downloading {pct:>3}%  {} / {}  {}{eta}",
                    fmt_bytes(self.downloaded),
                    fmt_bytes(total),
                    fmt_secs(elapsed),
                )
            }
            _ => {
                let rate = self.downloaded.checked_div(elapsed).unwrap_or(0);
                format!(
                    "chan: downloading {}  {}  {}/s",
                    fmt_bytes(self.downloaded),
                    fmt_secs(elapsed),
                    fmt_bytes(rate),
                )
            }
        };
        let mut err = std::io::stderr().lock();
        // Pad to clear any residue from a longer previous line.
        let _ = write!(err, "\r{line:<60}");
        let _ = err.flush();
        self.line_open = true;
    }

    fn log_deciles(&mut self) {
        let Some(total) = self.total.filter(|t| *t > 0) else {
            return;
        };
        let pct = (self.downloaded.min(total) * 100 / total).min(100);
        while self.next_decile <= pct && self.next_decile <= 100 {
            eprintln!(
                "chan: downloading {}%  {} / {}",
                self.next_decile,
                fmt_bytes(self.downloaded),
                fmt_bytes(total),
            );
            self.next_decile += 10;
        }
    }

    /// Linear-extrapolation ETA in seconds from the average rate so
    /// far. `None` until there is enough to estimate, or once complete.
    fn eta_secs(&self, total: u64) -> Option<u64> {
        let elapsed = self.start.elapsed().as_secs_f64();
        if self.downloaded == 0 || self.downloaded >= total || elapsed <= 0.0 {
            return None;
        }
        let rate = self.downloaded as f64 / elapsed;
        if rate <= 0.0 {
            return None;
        }
        Some(((total - self.downloaded) as f64 / rate).ceil() as u64)
    }
}

impl Drop for DownloadProgress {
    fn drop(&mut self) {
        // Close an in-place line so an early return (e.g. the size-cap
        // bail) never leaves the cursor parked mid-line.
        if self.line_open {
            let _ = writeln!(std::io::stderr());
        }
    }
}

/// Human-readable byte count (1024-base), matching the `humanize_bytes`
/// style used elsewhere in the CLI.
fn fmt_bytes(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    let b = bytes as f64;
    if b >= MB {
        format!("{:.1} MB", b / MB)
    } else if b >= KB {
        format!("{:.1} KB", b / KB)
    } else {
        format!("{bytes} B")
    }
}

/// `m:ss` elapsed/ETA formatting (sdme-style, minutes uncapped).
fn fmt_secs(secs: u64) -> String {
    format!("{}:{:02}", secs / 60, secs % 60)
}

fn extract_binary(
    archive: &Path,
    out: &Path,
    bin_name: &str,
    ext: &str,
    verbose: bool,
) -> Result<()> {
    if verbose {
        eprintln!("chan: extracting {bin_name} from {}", archive.display());
    }
    match ext {
        "tar.gz" => extract_tar_gz(archive, out, bin_name),
        other => bail!("unsupported archive extension: {other}"),
    }
}

fn install_replacement(new_bin: &Path, exe_path: &Path) -> Result<()> {
    fs::rename(new_bin, exe_path).with_context(|| {
        format!(
            "replacing {} with {}",
            exe_path.display(),
            new_bin.display()
        )
    })
}

#[cfg(not(target_os = "windows"))]
fn extract_tar_gz(archive: &Path, out: &Path, bin_name: &str) -> Result<()> {
    let f = fs::File::open(archive).with_context(|| format!("opening {}", archive.display()))?;
    let gz = flate2::read::GzDecoder::new(f);
    let mut tar = tar::Archive::new(gz);
    for entry in tar
        .entries()
        .with_context(|| format!("reading entries from {}", archive.display()))?
    {
        let mut entry = entry.context("reading tar entry")?;
        let path = entry.path().context("decoding tar entry path")?;
        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if name != bin_name {
            continue;
        }
        let mut out_file =
            fs::File::create(out).with_context(|| format!("creating {}", out.display()))?;
        std::io::copy(&mut entry, &mut out_file)
            .with_context(|| format!("extracting {bin_name}"))?;
        out_file.flush()?;
        return Ok(());
    }
    bail!("archive {} does not contain {bin_name}", archive.display())
}

#[cfg(target_os = "windows")]
fn extract_tar_gz(_archive: &Path, _out: &Path, _bin_name: &str) -> Result<()> {
    bail!("chan upgrade is not published for Windows")
}

#[cfg(unix)]
fn set_executable_mode(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
        .with_context(|| format!("chmod 755 {}", path.display()))
}

#[cfg(not(unix))]
fn set_executable_mode(_path: &Path) -> Result<()> {
    Ok(())
}

fn confirm(prompt: &str, default_yes: bool) -> Result<bool> {
    use std::io::Write as _;
    print!("{prompt}");
    std::io::stdout().flush().ok();
    let mut buf = String::new();
    std::io::stdin()
        .read_line(&mut buf)
        .context("reading confirmation")?;
    let answer = buf.trim().to_ascii_lowercase();
    if answer.is_empty() {
        return Ok(default_yes);
    }
    Ok(matches!(answer.as_str(), "y" | "yes"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_cli_metadata() -> &'static str {
        r#"{
  "version":"0.14.0",
  "tag":"v0.14.0",
  "published_at":"2026-05-27T00:00:00Z",
  "targets":[
    {
      "target":"x86_64-unknown-linux-musl",
      "asset":"chan-x86_64-unknown-linux-musl.tar.gz",
      "url":"https://github.com/fiorix/chan/releases/download/v0.14.0/chan-x86_64-unknown-linux-musl.tar.gz",
      "sha256":"DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF"
    },
    {
      "target":"aarch64-apple-darwin",
      "asset":"chan-aarch64-apple-darwin.tar.gz",
      "url":"https://github.com/fiorix/chan/releases/download/v0.14.0/chan-aarch64-apple-darwin.tar.gz",
      "sha256":"cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe"
    }
  ]
}"#
    }

    #[test]
    fn test_semver_newer() {
        assert!(semver_newer("0.7.0", "0.6.11"));
        assert!(semver_newer("1.0.0", "0.99.99"));
        assert!(semver_newer("0.6.12", "0.6.11"));
        assert!(!semver_newer("0.6.11", "0.6.11"));
        assert!(!semver_newer("0.6.10", "0.6.11"));
        assert!(!semver_newer("garbage", "0.6.11"));
        assert!(!semver_newer("0.7.0", "garbage"));
        assert!(semver_newer("v0.7.0", "0.6.11"));
        assert!(!semver_newer("0.7.0-alpha", "0.7.0"));
    }

    #[test]
    fn test_semver_newer_orders_prereleases() {
        // A prerelease is newer than every lower triple...
        assert!(semver_newer("0.60.0-rc1", "0.59.1"));
        // ...older than its own release triple...
        assert!(semver_newer("0.60.0", "0.60.0-rc1"));
        assert!(!semver_newer("0.60.0-rc1", "0.60.0"));
        // ...and equal prereleases are not newer either way.
        assert!(!semver_newer("0.60.0-rc1", "0.60.0-rc1"));
        // Within one triple, rcN ranks numerically, including rc10 > rc2.
        assert!(semver_newer("0.60.0-rc2", "0.60.0-rc1"));
        assert!(semver_newer("0.60.0-rc10", "0.60.0-rc2"));
        assert!(!semver_newer("0.60.0-rc2", "0.60.0-rc10"));
        // An identifier that extends another sorts after it.
        assert!(semver_newer("0.60.0-rc1.hotfix", "0.60.0-rc1"));
        // A pure-numeric identifier sorts below ANY alphanumeric one,
        // even when its digits compare higher.
        assert!(semver_newer("0.60.0-rc1", "0.60.0-1"));
        assert!(semver_newer("0.60.0-1a", "0.60.0-2"));
        assert!(!semver_newer("0.60.0-2", "0.60.0-1a"));
        assert!(semver_newer("0.60.0-a", "0.60.0-1"));
        // Pure-numeric identifiers compare numerically.
        assert!(semver_newer("0.60.0-10", "0.60.0-2"));
        // Leading-zero numeric identifiers order equal to their
        // zero-stripped form (lenient parse; strict semver rejects).
        assert!(!semver_newer("0.60.0-01", "0.60.0-1"));
        assert!(!semver_newer("0.60.0-1", "0.60.0-01"));
        // Garbage prerelease suffixes stay "not newer" in either slot.
        assert!(!semver_newer("0.60.0-", "0.59.1"));
        assert!(!semver_newer("0.60.0-rc..1", "0.59.1"));
        assert!(!semver_newer("0.60.0", "0.60.0-rc_1"));
    }

    #[test]
    fn test_validate_version_accepts_x_y_z_and_prerelease() {
        assert!(validate_version("0.60.0").is_ok());
        assert!(validate_version("0.60.0-rc1").is_ok());
        assert!(validate_version("0.60.0-rc1.hotfix-2").is_ok());
        assert!(validate_version("0.60").is_err());
        assert!(validate_version("0.60.0.1").is_err());
        assert!(validate_version("0.60.0-").is_err());
        assert!(validate_version("0.60.0-rc..1").is_err());
        assert!(validate_version("0.60.0-rc_1").is_err());
        assert!(validate_version("0.60.0-rc1+build").is_err());
    }

    #[test]
    fn test_normalize_sha256() {
        assert_eq!(
            normalize_sha256(
                "DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF",
                "chan-x86_64-unknown-linux-musl.tar.gz"
            )
            .unwrap(),
            "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
        );
        assert!(normalize_sha256("NOT_HEX", "chan-x86_64-unknown-linux-musl.tar.gz").is_err());
    }

    #[test]
    fn test_metadata_url_shape() {
        assert_eq!(
            metadata_url_for_version("0.14.0"),
            "https://chan.app/dl/cli/v0.14.0.json"
        );
    }

    #[test]
    fn test_release_tag_requires_public_v_shape() {
        let release = release_from_tag("v0.14.0").unwrap();
        assert_eq!(
            release,
            ReleaseVersion {
                tag: "v0.14.0".into(),
                version: "0.14.0".into(),
            }
        );
        assert!(release_from_tag("0.14.0").is_err());
        assert!(release_from_tag("v0.14").is_err());
        // Prerelease tags are the shape the pipeline mints for an rc.
        let rc = release_from_tag("v0.60.0-rc1").unwrap();
        assert_eq!(
            rc,
            ReleaseVersion {
                tag: "v0.60.0-rc1".into(),
                version: "0.60.0-rc1".into(),
            }
        );
    }

    #[test]
    fn test_version_override_renders_fresh_release_tag() {
        let release = release_from_version_override("0.14.0").unwrap();
        assert_eq!(
            release,
            ReleaseVersion {
                tag: "v0.14.0".into(),
                version: "0.14.0".into(),
            }
        );
        assert!(release_from_version_override("v0.14.0").is_err());
        assert!(release_from_version_override("0.14").is_err());
        // `chan upgrade --version 0.60.0-rc2` must be expressible.
        let rc = release_from_version_override("0.60.0-rc2").unwrap();
        assert_eq!(
            rc,
            ReleaseVersion {
                tag: "v0.60.0-rc2".into(),
                version: "0.60.0-rc2".into(),
            }
        );
    }

    #[test]
    fn test_parse_cli_metadata_selects_target_asset() {
        let metadata = parse_cli_metadata(sample_cli_metadata()).unwrap();
        assert_eq!(metadata.version, "0.14.0");
        assert_eq!(metadata.tag, "v0.14.0");

        let asset = target_asset_for(&metadata, "x86_64-unknown-linux-musl", "tar.gz").unwrap();
        assert_eq!(
            asset,
            CliTargetAsset {
                target: "x86_64-unknown-linux-musl".into(),
                asset: "chan-x86_64-unknown-linux-musl.tar.gz".into(),
                url: "https://github.com/fiorix/chan/releases/download/v0.14.0/chan-x86_64-unknown-linux-musl.tar.gz".into(),
                sha256: "DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF".into(),
            }
        );
    }

    #[test]
    fn test_parse_cli_metadata_rejects_bad_contracts() {
        let tag_mismatch =
            sample_cli_metadata().replace(r#""tag":"v0.14.0""#, r#""tag":"v0.15.0""#);
        assert!(parse_cli_metadata(&tag_mismatch).is_err());

        let malformed_tag =
            sample_cli_metadata().replace(r#""tag":"v0.14.0""#, r#""tag":"release-0.14.0""#);
        assert!(parse_cli_metadata(&malformed_tag).is_err());

        let bad_hash = sample_cli_metadata().replace(
            "DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF",
            "NOT_HEX",
        );
        assert!(parse_cli_metadata(&bad_hash).is_err());
    }

    #[test]
    fn test_target_asset_for_rejects_unsupported_target() {
        let metadata = parse_cli_metadata(sample_cli_metadata()).unwrap();
        let err = target_asset_for(&metadata, "x86_64-pc-windows-msvc", "zip")
            .unwrap_err()
            .to_string();
        assert!(err.contains("does not include a standalone chan CLI asset"));
    }

    #[test]
    fn test_ensure_https_url_rejects_plain_http() {
        assert!(ensure_https_url(CLI_LATEST_METADATA_URL).is_ok());
        assert!(ensure_https_url("http://chan.app/dl/cli/latest.json").is_err());
    }

    #[test]
    fn test_install_replacement_renames() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("chan");
        let new_bin = dir.path().join(".chan.upgrade-bin.test");
        fs::write(&exe, b"old").unwrap();
        fs::write(&new_bin, b"new").unwrap();

        install_replacement(&new_bin, &exe).unwrap();

        assert_eq!(fs::read(&exe).unwrap(), b"new");
        assert!(!new_bin.exists());
    }

    #[test]
    fn test_upgrade_blocked_message_names_the_manager() {
        let rpm = upgrade_blocked_message("rpm");
        assert!(rpm.contains("(rpm)"));
        assert!(rpm.contains("dnf upgrade"));
        let deb = upgrade_blocked_message("deb");
        assert!(deb.contains("(deb)"));
        assert!(deb.contains("apt upgrade"));
        let aur = upgrade_blocked_message("aur");
        assert!(aur.contains("(aur)"));
        assert!(aur.contains("AUR helper"));
        assert!(aur.contains("paru -Syu"));
        let nix = upgrade_blocked_message("nix");
        assert!(nix.contains("(nix)"));
        assert!(nix.contains("nix profile upgrade chan-desktop"));
        assert!(nix.contains("flake input"));
    }

    #[test]
    fn test_packaged_upgrade_refusal_only_fires_for_packaged_builds() {
        // packaged_via() is a compile-time option_env!, so the decision
        // takes the marker as an argument to cover both builds from one
        // test binary.
        assert!(packaged_upgrade_refusal(None).is_none());

        let rpm = packaged_upgrade_refusal(Some("rpm")).expect("packaged build refuses");
        assert!(rpm.contains("(rpm)"), "{rpm}");
        assert!(rpm.contains("dnf upgrade"), "{rpm}");

        let aur = packaged_upgrade_refusal(Some("aur")).expect("packaged build refuses");
        assert!(aur.contains("(aur)"), "{aur}");
        assert!(aur.contains("self-upgrade is disabled"), "{aur}");

        let nix = packaged_upgrade_refusal(Some("nix")).expect("packaged build refuses");
        assert!(nix.contains("(nix)"), "{nix}");
        assert!(nix.contains("nix profile upgrade chan-desktop"), "{nix}");
    }

    #[test]
    fn test_action_words() {
        assert_eq!(action_words("0.8.0", "0.7.3"), ("upgrading", "upgraded"));
        assert_eq!(
            action_words("0.7.0", "0.7.3"),
            ("downgrading", "downgraded")
        );
        assert_eq!(action_words("nonsense", "0.7.0"), ("upgrading", "upgraded"));
    }

    #[test]
    fn test_post_upgrade_state_suppresses_banner() {
        // Regression: chan upgrade on the running (old) binary must
        // leave the cached state in a shape where maybe_print_banner
        // takes the early-exit (latest_version == None) path.
        let state = post_upgrade_state("0.7.3");
        assert_eq!(state.checked_version, "0.7.3");
        assert!(state.latest_version.is_none());
        assert!(state.checked_at > 0);
    }

    #[test]
    fn test_probe_due() {
        // No state -> always due.
        assert!(probe_due(None));
        // Recent state -> not due.
        let recent = State {
            checked_at: now_unix(),
            checked_version: "0.6.0".into(),
            latest_version: Some("0.6.0".into()),
        };
        assert!(!probe_due(Some(&recent)));
        // Old state -> due.
        let old = State {
            checked_at: now_unix() - PROBE_INTERVAL_HOURS * 3600 - 60,
            checked_version: "0.6.0".into(),
            latest_version: Some("0.6.0".into()),
        };
        assert!(probe_due(Some(&old)));
    }

    #[test]
    fn test_release_target_for_active_public_artifacts() {
        assert_eq!(
            release_target_for("linux", "x86_64").unwrap(),
            ("x86_64-unknown-linux-musl", "tar.gz", "chan")
        );
        assert_eq!(
            release_target_for("linux", "aarch64").unwrap(),
            ("aarch64-unknown-linux-musl", "tar.gz", "chan")
        );
        assert_eq!(
            release_target_for("macos", "aarch64").unwrap(),
            ("aarch64-apple-darwin", "tar.gz", "chan")
        );
    }

    #[test]
    fn test_release_target_for_inactive_public_artifacts() {
        let windows = release_target_for("windows", "x86_64")
            .unwrap_err()
            .to_string();
        assert!(windows.contains("no published standalone chan CLI release for windows/x86_64"));
        assert!(windows.contains("linux x86_64/aarch64, macos aarch64"));
        assert!(!windows.contains("windows x86_64/aarch64"));

        let mac_intel = release_target_for("macos", "x86_64")
            .unwrap_err()
            .to_string();
        assert!(mac_intel.contains("no published standalone chan CLI release for macos/x86_64"));
    }

    #[test]
    fn test_current_target_supported_pair() {
        // Only assert the running build's target resolves; the public
        // release matrix is tested above.
        let _ = current_target().expect("target supported");
    }

    #[test]
    fn fmt_bytes_units() {
        assert_eq!(fmt_bytes(0), "0 B");
        assert_eq!(fmt_bytes(512), "512 B");
        assert_eq!(fmt_bytes(1536), "1.5 KB");
        assert_eq!(fmt_bytes(5 * 1024 * 1024), "5.0 MB");
    }

    #[test]
    fn fmt_secs_mmss() {
        assert_eq!(fmt_secs(0), "0:00");
        assert_eq!(fmt_secs(8), "0:08");
        assert_eq!(fmt_secs(83), "1:23");
        assert_eq!(fmt_secs(605), "10:05");
    }

    #[test]
    fn eta_guards_are_deterministic() {
        // No ETA before any bytes land, or once the download is
        // complete -- the timing-dependent middle is intentionally not
        // asserted (wall-clock).
        let mut p = DownloadProgress::new(Some(1000), false, false);
        assert_eq!(p.eta_secs(1000), None);
        p.downloaded = 1000;
        assert_eq!(p.eta_secs(1000), None);
        p.downloaded = 2000; // past total (over-read) also yields None
        assert_eq!(p.eta_secs(1000), None);
    }

    #[test]
    fn deciles_log_each_threshold_once() {
        // Non-TTY verbose mode advances the milestone past every decile
        // it has reached and never repeats one.
        let mut p = DownloadProgress::new(Some(100), false, true);
        p.downloaded = 25;
        p.log_deciles();
        assert_eq!(p.next_decile, 30); // logged 10, 20
        p.downloaded = 100;
        p.log_deciles();
        assert_eq!(p.next_decile, 110); // logged 30..=100
    }
}
