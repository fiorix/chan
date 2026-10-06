use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use chan_server::ServeConfig;
use chan_workspace::SearchAggression;

use crate::cli::{DevserverSelector, ServeCliArgs};
use crate::desktop::{desktop_handoff_would_engage, maybe_handoff_to_desktop};
use crate::parentage::{chan_control_socket, detect_parentage, Parentage};
use crate::registry::{ensure_workspace_registered, library, missing_workspace_path, same_path};
use crate::remote::cmd_workspace_serve_remote;
use crate::{update, Personality, DEFAULT_PORT};

/// Resolve final listen address from the user's flags.
///
/// `--host` is authoritative when given; `-4` / `-6` only validate
/// its family. With no `--host`, `-4` selects 127.0.0.1, `-6` selects
/// ::1, and neither selects 127.0.0.1.
fn resolve_listen_addr(
    host: Option<IpAddr>,
    ipv4: bool,
    ipv6: bool,
    port: u16,
) -> Result<SocketAddr> {
    let ip = match host {
        Some(ip) => {
            if ipv4 && !ip.is_ipv4() {
                anyhow::bail!("-4 requires an IPv4 --host, got {ip}");
            }
            if ipv6 && !ip.is_ipv6() {
                anyhow::bail!("-6 requires an IPv6 --host, got {ip}");
            }
            ip
        }
        None if ipv6 => IpAddr::V6(Ipv6Addr::LOCALHOST),
        None => IpAddr::V4(Ipv4Addr::LOCALHOST),
    };
    Ok(SocketAddr::new(ip, port))
}

/// Emit the structured `vcs-parent` refusal to stderr. The shape is
/// a contract consumed by chan-desktop (and any other wrapping
/// shell):
///
///   - Exit code `70` (set by the caller after this returns).
///   - One stderr line begins with `chan-error: vcs-parent ` and
///     carries `kind=<git|hg|svn> repo_root=<abs path> path=<abs
///     path>` in that order, single-line, space-separated. Values
///     run to end-of-line so paths with spaces don't break the
///     parse; wrappers split on `key=` boundaries, not on spaces.
///   - The surrounding human-readable lines are advisory and may
///     change wording; the marker is the stable bit.
///
/// Documented in the desktop hand-off; do NOT reshape without
/// bumping the marker prefix (e.g. `chan-error-v2: ...`) so old
/// shells fail closed instead of silently misparsing.
fn print_vcs_parent_error(root: &Path, parent: &chan_workspace::VcsParent) {
    // Canonicalize both paths for the marker so wrappers get
    // absolute, symlink-resolved forms, minus the Windows `\\?\` prefix
    // (the registry's normalization). Falls back to the input when the
    // root does not yet exist on disk.
    let root_abs = chan_workspace::paths::canonicalize_normalized(root);
    let repo_abs = chan_workspace::paths::canonicalize_normalized(&parent.repo_root);
    let kind_human = match parent.kind {
        chan_workspace::VcsKind::Git => "Git",
        chan_workspace::VcsKind::Mercurial => "Mercurial",
        chan_workspace::VcsKind::Subversion => "Subversion",
    };
    eprintln!(
        "error: workspace '{}' is inside a {} repository at '{}'.",
        root_abs.display(),
        kind_human,
        repo_abs.display(),
    );
    eprintln!("       Serving the repository root keeps cross-file links, the graph,");
    eprintln!("       and search aligned with the project boundary.");
    eprintln!(
        "chan-error: vcs-parent kind={} repo_root={} path={}",
        parent.kind.as_str(),
        repo_abs.display(),
        root_abs.display(),
    );
    eprintln!("hint: open repo root:    chan serve {}", repo_abs.display());
    eprintln!(
        "hint: open only subdir:  chan serve --here {}",
        root_abs.display(),
    );
}

/// Resolved `chan serve` invocation: every CLI input after listen-addr
/// and prefix resolution, grouped so the handler takes one argument
/// instead of a 15-parameter tail.
struct ServeArgs {
    addr: SocketAddr,
    prefix: String,
    idle_timeout: Option<Duration>,
    path: Option<PathBuf>,
    here: bool,
    no_token: bool,
    no_browser: bool,
    search_aggression: Option<SearchAggression>,
    no_settings: bool,
    flags: OpenFlags,
    verbose: bool,
}

/// The explicit, mutually exclusive `chan serve` target flags. clap's
/// `conflicts_with_all` rejects more than one at parse time; the routing
/// resolver ([`decide_open_route`]) guards the same invariant.
#[derive(Debug, Clone, Copy)]
struct OpenFlags {
    standalone: bool,
    desktop: bool,
    devserver: Option<DevserverSelector>,
}

/// Where `chan serve` routes a workspace: bind a standalone server here, hand
/// it to chan-desktop, or register it with the local devserver.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpenTarget {
    Standalone,
    Desktop,
    Devserver,
}

/// Why the routing decision could not pick a target.
#[derive(Debug, PartialEq, Eq)]
enum RouteError {
    /// More than one of --standalone / --desktop / --devserver was set.
    /// clap's `conflicts_with_all` normally rejects this first; the resolver
    /// guards it too so the decision stays self-contained.
    MultipleTargets,
    /// An explicit --devserver from inside a devserver shell: nesting one
    /// multi-tenant server in another is unsupported.
    NestedDevserver,
}

/// Side-effect-free liveness snapshot supplied to [`decide_open_route`].
/// The resolver needs only presence/count; concrete devserver selection is a
/// separate pure step after the target kind is chosen.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct LiveInstances {
    desktop: bool,
    devservers: usize,
}

/// Resolve a `chan serve` routing decision from explicit flags, shell parentage,
/// binary personality, chan-context presence, and a live-instance snapshot.
/// PURE: every probe and the actual handoff/registration live in the caller.
///
/// Precedence: an explicit flag wins (subject to the nested-devserver
/// refusal); otherwise a devserver parentage registers with that devserver
/// (a stronger signal than a forced-desktop env var inherited into the
/// shell), and desktop parentage hands off. With no identified parent, one live
/// kind wins; with both kinds live, the desktop personality chooses desktop and
/// the standalone personality chooses a devserver. With neither live, the
/// desktop personality chooses desktop and the standalone personality chooses
/// standalone. A present but unidentified control socket preserves the
/// conservative standalone fallback only when no live instance supplies a
/// stronger signal.
fn decide_open_route(
    flags: OpenFlags,
    parentage: Parentage,
    forced_desktop: bool,
    chan_context_present: bool,
    live: LiveInstances,
) -> Result<OpenTarget, RouteError> {
    let explicit = match (flags.standalone, flags.desktop, flags.devserver.is_some()) {
        (false, false, false) => None,
        (true, false, false) => Some(OpenTarget::Standalone),
        (false, true, false) => Some(OpenTarget::Desktop),
        (false, false, true) => Some(OpenTarget::Devserver),
        _ => return Err(RouteError::MultipleTargets),
    };

    if let Some(target) = explicit {
        if target == OpenTarget::Devserver && matches!(parentage, Parentage::Devserver { .. }) {
            return Err(RouteError::NestedDevserver);
        }
        return Ok(target);
    }

    Ok(match parentage {
        // In a devserver shell: register with the current devserver. This
        // beats a forced-desktop env var that leaked into the session, so the
        // leaked variable cannot route a devserver shell to chan-desktop.
        Parentage::Devserver { .. } => OpenTarget::Devserver,
        Parentage::Desktop => OpenTarget::Desktop,
        // No identified parent. A sole live instance wins regardless of binary
        // personality. With both kinds live, the standalone personality prefers
        // a devserver and the desktop personality preserves its desktop contract.
        // With neither live, the desktop personality may launch the GUI. A
        // present-but-unidentified chan socket retains the conservative
        // standalone fallback only when no live target can correct the guess.
        Parentage::None => match (live.desktop, live.devservers > 0) {
            (true, false) => OpenTarget::Desktop,
            (false, true) => OpenTarget::Devserver,
            (true, true) if forced_desktop => OpenTarget::Desktop,
            (true, true) => OpenTarget::Devserver,
            (false, false) if chan_context_present => OpenTarget::Standalone,
            (false, false) if forced_desktop => OpenTarget::Desktop,
            (false, false) => OpenTarget::Standalone,
        },
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DevserverSelectionError {
    NotFound {
        port: u16,
    },
    /// The shell's parent devserver is not among the live candidates (a
    /// pre-discovery instance, or a discovery bind that failed non-fatally).
    /// Registering anywhere else would mount the workspace on an instance
    /// the user did not mean, so selection refuses instead of guessing.
    ParentNotFound {
        pid: u32,
    },
    Ambiguous,
}

/// CLI-owned snapshot of a discovered instance. Keeping selection on this
/// value type makes the resolver independent of the transport handle carried
/// by `chan-server`'s discovery result.
#[derive(Debug, Clone, PartialEq, Eq)]
struct DevserverCandidate {
    instance_index: usize,
    pid: u32,
    library_root: PathBuf,
    port: u16,
    version: String,
}

fn devserver_candidates(
    instances: &[chan_server::devserver_handoff::Instance],
) -> Vec<DevserverCandidate> {
    instances
        .iter()
        .enumerate()
        .map(|(instance_index, instance)| DevserverCandidate {
            instance_index,
            pid: instance.pid,
            library_root: instance.library_root.clone(),
            port: instance.port,
            version: instance.version.clone(),
        })
        .collect()
}

/// Resolve one concrete devserver without guessing. An explicit selector wins;
/// otherwise a devserver parent pid is stronger than the CLI's library root,
/// which is stronger than an arbitrary candidate order.
fn select_devserver<'a>(
    instances: &'a [DevserverCandidate],
    selector: Option<DevserverSelector>,
    parent_pid: Option<u32>,
    library_root: &Path,
) -> std::result::Result<Option<&'a DevserverCandidate>, DevserverSelectionError> {
    if let Some(DevserverSelector::Port(port)) = selector {
        let mut matches = instances.iter().filter(|instance| instance.port == port);
        let selected = matches.next();
        return match (selected, matches.next()) {
            (None, _) => Err(DevserverSelectionError::NotFound { port }),
            (Some(_), Some(_)) => Err(DevserverSelectionError::Ambiguous),
            (Some(instance), None) => Ok(Some(instance)),
        };
    }

    if instances.is_empty() {
        return Ok(None);
    }

    // Parentage binds BEFORE the sole-candidate short-circuit: a shell
    // spawned by devserver A must never be adopted by the only-visible
    // devserver B just because A's discovery socket is gone.
    if let Some(pid) = parent_pid {
        let mut matches = instances.iter().filter(|instance| instance.pid == pid);
        return match (matches.next(), matches.next()) {
            (Some(instance), None) => Ok(Some(instance)),
            (Some(_), Some(_)) => Err(DevserverSelectionError::Ambiguous),
            (None, _) => Err(DevserverSelectionError::ParentNotFound { pid }),
        };
    }

    if let [instance] = instances {
        return Ok(Some(instance));
    }

    let mut matches = instances
        .iter()
        .filter(|instance| same_path(&instance.library_root, library_root));
    match (matches.next(), matches.next()) {
        (Some(instance), None) => Ok(Some(instance)),
        _ => Err(DevserverSelectionError::Ambiguous),
    }
}

fn sorted_devservers(instances: &[DevserverCandidate]) -> Vec<&DevserverCandidate> {
    let mut sorted: Vec<_> = instances.iter().collect();
    sorted.sort_by(|a, b| {
        a.port
            .cmp(&b.port)
            .then_with(|| a.library_root.cmp(&b.library_root))
            .then_with(|| a.version.cmp(&b.version))
            .then_with(|| a.pid.cmp(&b.pid))
    });
    sorted
}

fn devserver_candidates_text(instances: &[DevserverCandidate]) -> String {
    let mut text = String::new();
    for instance in sorted_devservers(instances) {
        use std::fmt::Write as _;
        let _ = write!(
            text,
            "\n  port {}  library {}  chan {}",
            instance.port,
            instance.library_root.display(),
            instance.version,
        );
    }
    text
}

fn devserver_window_opened_message(root: &Path, instance: &DevserverCandidate) -> String {
    format!(
        "chan: opened a window for {} with local devserver on port {} (library {}, chan {})",
        root.display(),
        instance.port,
        instance.library_root.display(),
        instance.version,
    )
}

/// Make a serve root absolute against the process cwd. `canonicalize`
/// resolves symlinks for an existing dir; `std::path::absolute` makes a
/// not-yet-created path absolute lexically (so `chan serve new-dir` still
/// lands under the cwd); the final fallback returns the input unchanged
/// (only reachable if both fail, e.g. an unreadable cwd). The result must
/// be absolute so the desktop handoff -- which runs with cwd "/" -- and the
/// canonical-path-keyed registry both see the directory the user ran in.
///
/// The Windows `\\?\` verbatim prefix is stripped from whichever branch wins.
/// `std::fs::canonicalize` emits it, and this root is user-visible: it is
/// printed by `chan serve` and handed to chan-desktop. The desktop titles a
/// window from its stored record path, which may differ from this input.
/// `strip_verbatim_prefix` is the same normalization the registry keys on.
fn absolutize_serve_root(root: PathBuf) -> PathBuf {
    let absolute = std::fs::canonicalize(&root)
        .or_else(|_| std::path::absolute(&root))
        .unwrap_or(root);
    chan_workspace::paths::strip_verbatim_prefix(&absolute)
}

/// Recognize a devserver-URL-shaped value: `scheme://host…`. `chan serve`
/// uses it to refuse a pasted URL (with a pointer at `chan devserver
/// register`) instead of reading it as a relative directory; the register
/// verb uses it in reverse. We don't pull a URL crate for the check -- the
/// desktop parses and validates the full URL when it dials. Requiring `://`
/// with a non-empty scheme and authority keeps a Windows path (`C:\…`) or a
/// bare `host:port` (no `//`) from misfiring as a URL.
fn looks_like_devserver_url(target: &str) -> bool {
    match target.split_once("://") {
        Some((scheme, rest)) => {
            !scheme.is_empty()
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
                && !rest.is_empty()
        }
        None => false,
    }
}

/// Translate the `chan serve` surface into [`ServeArgs`] and run it. A
/// URL-shaped argument is refused with a pointer at `chan devserver
/// register`: serve takes a workspace PATH only, and treating a pasted
/// URL as a relative directory would "succeed" at serving nothing.
pub(super) async fn cmd_serve_cli(
    args: ServeCliArgs,
    personality: Personality,
    verbose: bool,
) -> Result<()> {
    if let Some(target) = args.path.as_deref() {
        if looks_like_devserver_url(target) {
            anyhow::bail!(
                "{target} is a URL; `chan serve` takes a workspace PATH. Register a \
                 devserver with `chan devserver register {target}`."
            );
        }
    }
    // The remote arm branches before any local route logic, so without
    // `--on` the serve path below is untouched.
    if let Some(target) = args.on.as_deref() {
        return cmd_workspace_serve_remote(args.path, target).await;
    }
    let addr = resolve_listen_addr(args.host, args.ipv4, args.ipv6, args.port)?;
    let prefix = chan_server::sanitize_prefix(args.prefix.as_deref().unwrap_or(""))
        .map_err(|e| anyhow::anyhow!("invalid --prefix: {e}"))?;
    cmd_serve(
        ServeArgs {
            addr,
            prefix,
            idle_timeout: args.timeout,
            path: args.path.map(PathBuf::from),
            here: args.here,
            no_token: args.no_token,
            no_browser: args.no_browser,
            search_aggression: args.search_aggression,
            no_settings: args.no_settings,
            flags: OpenFlags {
                standalone: args.standalone,
                desktop: args.desktop,
                devserver: args.devserver,
            },
            verbose,
        },
        personality,
    )
    .await
}

#[derive(Debug)]
enum DevserverRegistrationAction {
    Registered,
    Standalone(Option<String>),
}

/// A registration ends the serve; version skew and definite mount errors fall
/// back, as does no candidate unless an explicit port was selected. A sent
/// request with no reliable answer refuses standalone because the mount may
/// still finish. A lock refusal from this library ends the command because
/// its standalone open would meet the same writer lock. A mount that a
/// turn-off or a forget overtook in this library's devserver ends it too: a
/// standalone server would serve the folder that was just turned off, or
/// register again the one that was just forgotten.
fn devserver_registration_action(
    outcome: chan_server::devserver_handoff::Outcome,
    selector: Option<&DevserverSelector>,
    root: &Path,
    same_library: bool,
) -> Result<DevserverRegistrationAction> {
    use chan_server::devserver_handoff::Outcome;
    let message = match outcome {
        Outcome::Registered { .. } => return Ok(DevserverRegistrationAction::Registered),
        Outcome::VersionSkew => Some(
            "chan: a local devserver is running a different version; \
             cannot register. Starting a standalone server."
                .to_string(),
        ),
        Outcome::Error(message)
            if same_library
                && (message == chan_server::WORKSPACE_OPEN_ELSEWHERE
                    || message == chan_server::devserver_handoff::MOUNT_OVERTAKEN) =>
        {
            anyhow::bail!("{message}");
        }
        Outcome::Error(message) => Some(format!(
            "chan: the local devserver could not mount this workspace \
             ({message}); starting a standalone server."
        )),
        Outcome::NoDevserver => {
            if let Some(DevserverSelector::Port(port)) = selector {
                anyhow::bail!("local devserver selected by --devserver={port} is no longer live");
            }
            None
        }
        Outcome::ReplyTimedOut => anyhow::bail!(
            "the devserver did not answer within 75 s; it may still be mounting {}; \
             check `chan ps` or retry with `--standalone`",
            root.display()
        ),
        Outcome::ReplyLost => anyhow::bail!(
            "the devserver sent no valid reply to the registration; it may still be \
             mounting {} or may have died; check `chan ps` or retry with `--standalone`",
            root.display()
        ),
    };
    Ok(DevserverRegistrationAction::Standalone(message))
}

async fn cmd_serve(args: ServeArgs, personality: Personality) -> Result<()> {
    let ServeArgs {
        addr,
        prefix,
        idle_timeout,
        path,
        here,
        no_token,
        no_browser,
        search_aggression,
        no_settings,
        flags,
        verbose,
    } = args;
    let lib = library()?;
    // `chan serve {path}` requires an explicit workspace root; with no path it
    // is a clear error. An explicit path auto-registers, so `chan serve
    // /some/dir` works without a prior `chan workspace add`.
    let root = path.ok_or_else(|| missing_workspace_path("serve", "chan serve ."))?;
    // Resolve to an absolute path against the CLI's cwd before anything
    // downstream consumes it. The macOS desktop handoff opens the
    // workspace in a process whose cwd is "/", and the workspace registry
    // is keyed by the canonical path, so a bare `chan serve .` must not
    // leak a relative root (the desktop would resolve it against "/" and
    // open the filesystem root).
    let root = absolutize_serve_root(root);
    // VCS-parent gate. If `root` is inside a Git / Mercurial /
    // Subversion working tree, refuse with a structured error so a
    // wrapping shell (chan-desktop) can parse the marker line and
    // offer the user a choice between repo root and the subdir.
    // Runs before any state mutation: no directory creation, no
    // registry write. `--here` opts the caller out for the case
    // where serving the subdir is the genuine intent.
    if !here {
        if let Some(parent) = chan_workspace::detect_parent_vcs(&root) {
            print_vcs_parent_error(&root, &parent);
            std::process::exit(70);
        }
    }
    // Resolve parentage and live local instances before choosing one target.
    // Explicit standalone/desktop skips probes it does not need; discovery is
    // lazy on their eventual bind-collision path. Selection refusal happens
    // before the workspace root or registry is mutated.
    let forced_desktop =
        personality == Personality::Desktop || chan_server::handoff::handoff_forced();
    let chan_context_present = chan_control_socket().is_some();
    let parentage = if flags.standalone || flags.desktop {
        Parentage::None
    } else {
        detect_parentage().await
    };
    let no_explicit_target = !flags.standalone && !flags.desktop && flags.devserver.is_none();
    let devserver_opt_out = chan_server::devserver_handoff::devserver_handoff_opt_out();
    // A VALUED selector names a specific devserver; silently serving
    // standalone instead would be the wrong-instance outcome this flag exists
    // to prevent. Under the opt-out, a route that resolves to a devserver
    // skips selection and serves standalone: a bare `--devserver` outside a
    // devserver shell, or no target flag inside one. Parentage is detected
    // under the opt-out too, so a bare `--devserver` inside a devserver shell
    // is refused as nested (`RouteError::NestedDevserver`).
    if devserver_opt_out {
        if let Some(DevserverSelector::Port(port)) = flags.devserver {
            anyhow::bail!(
                "--devserver={port} conflicts with CHAN_NO_DEVSERVER_HANDOFF: the flag names \
                 a devserver to register with, but the environment opts this command out of \
                 devserver handoff. Unset CHAN_NO_DEVSERVER_HANDOFF, or drop --devserver={port}."
            );
        }
    }
    let desktop_opt_out = chan_server::handoff::handoff_opt_out();
    let need_devservers = !devserver_opt_out
        && (flags.devserver.is_some()
            || no_explicit_target
                && matches!(parentage, Parentage::None | Parentage::Devserver { .. }));
    let mut devservers = if need_devservers {
        Some(chan_server::devserver_handoff::discover_devservers().await)
    } else {
        None
    };
    let mut candidates = devservers
        .as_deref()
        .map(devserver_candidates)
        .unwrap_or_default();
    let desktop_live = !desktop_opt_out
        && no_explicit_target
        && parentage == Parentage::None
        && chan_server::handoff::desktop_is_live().await;
    let live = LiveInstances {
        desktop: desktop_live,
        devservers: candidates.len(),
    };
    let target =
        match decide_open_route(flags, parentage, forced_desktop, chan_context_present, live) {
            Ok(target) => target,
            Err(RouteError::NestedDevserver) => anyhow::bail!(
                "you are already in a devserver; omit --devserver to register with \
             it, or use --standalone / --desktop"
            ),
            // clap's `conflicts_with_all` rejects this at parse time; bail with the
            // same intent if it ever reaches here.
            Err(RouteError::MultipleTargets) => {
                anyhow::bail!("choose at most one of --standalone, --desktop, --devserver")
            }
        };

    let parent_pid = match parentage {
        Parentage::Devserver { pid } => Some(pid),
        Parentage::Desktop | Parentage::None => None,
    };
    let library_root = lib
        .config_path()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(chan_workspace::paths::config_dir);
    let library_root = absolutize_serve_root(library_root);
    let selected_devserver = if target == OpenTarget::Devserver && !devserver_opt_out {
        match select_devserver(&candidates, flags.devserver, parent_pid, &library_root) {
            Ok(instance) => instance.map(|instance| instance.instance_index),
            Err(DevserverSelectionError::NotFound { port }) => anyhow::bail!(
                "no live local devserver matches --devserver={port}.{}\nUse `chan serve \
                 --devserver` to select automatically, or start the requested instance.",
                devserver_candidates_text(&candidates),
            ),
            Err(DevserverSelectionError::ParentNotFound { pid }) => anyhow::bail!(
                "this shell was spawned by a devserver (pid {pid}) that is not among the \
                 live discovered devservers.{}\nExpected the spawning instance; refusing to \
                 register with a different one. Choose one explicitly with \
                 --devserver=<port|url>, or use --standalone.",
                devserver_candidates_text(&candidates),
            ),
            Err(DevserverSelectionError::Ambiguous) => anyhow::bail!(
                "multiple local devservers are live and no unique target was found for library \
                 {}.{}\nChoose one with --devserver=<port|url>.",
                library_root.display(),
                devserver_candidates_text(&candidates),
            ),
        }
    } else {
        None
    };

    // The server this command binds is what enforces --no-settings: neither
    // handoff request carries the flag, so chan-desktop or a devserver would
    // open the workspace with settings writes allowed. A route that would
    // reach one is refused while nothing has been created, registered or
    // sent. A route with nothing to hand to keeps its standalone fallback,
    // and takes it here rather than in its arm, so a desktop that starts
    // after the liveness probe is not sent the request either.
    let desktop_known_live = desktop_live || parentage == Parentage::Desktop;
    let target = if no_settings {
        let receiver = match target {
            OpenTarget::Standalone => None,
            OpenTarget::Desktop => desktop_handoff_would_engage(forced_desktop, desktop_known_live)
                .await
                .then(|| "chan-desktop".to_string()),
            OpenTarget::Devserver => selected_devserver
                .map(|index| format!("the local devserver on port {}", candidates[index].port)),
        };
        if let Some(receiver) = receiver {
            anyhow::bail!(
                "--no-settings is enforced only by a server this command binds, and this \
                 serve would hand {} to {receiver}, which would open it with settings writes \
                 allowed. Serve it with --standalone to bind the restricted server here, or \
                 drop --no-settings to hand the workspace off.",
                root.display()
            );
        }
        OpenTarget::Standalone
    } else {
        target
    };

    // Create the workspace root only AFTER the route is settled, so a refused
    // route (nested devserver, conflicting flags) leaves no empty directory.
    if !root.exists() {
        std::fs::create_dir_all(&root)
            .with_context(|| format!("creating workspace root {}", root.display()))?;
    }

    match target {
        // CLI-to-desktop handoff. When a same-user chan-desktop is running in a
        // GUI session, ask it to open this workspace in a native window and
        // EXIT; the desktop then owns the flock. Launch-if-absent is gated on
        // `forced_desktop` so only a `Personality::Desktop` binary (whose
        // `current_exe` IS the desktop) launches the GUI; a standalone binary
        // that reached this target via a live desktop parentage falls through
        // instead. Every fallback (no desktop, refused, skew, GUI-absent,
        // CHAN_NO_DESKTOP_HANDOFF) drops through to the standalone path below.
        OpenTarget::Desktop => {
            if let Some(outcome) =
                maybe_handoff_to_desktop(&root, forced_desktop, desktop_known_live).await
            {
                if outcome.is_ok()
                    && forced_desktop
                    && parentage == Parentage::None
                    && live.desktop
                    && live.devservers > 0
                    && !candidates.is_empty()
                {
                    for instance in sorted_devservers(&candidates) {
                        println!(
                            "chan: local devserver on port {} (library {}, chan {}) was not \
                                 selected; use --devserver={} to choose it.",
                            instance.port,
                            instance.library_root.display(),
                            instance.version,
                            instance.port,
                        );
                    }
                }
                return outcome;
            }
        }
        // CLI-to-devserver registration. A running same-user devserver mounts
        // this workspace, mints one window, and owns its flock, so the CLI
        // prints a note and exits. CHAN_NO_DEVSERVER_HANDOFF opts out (skip the
        // attempt, serve standalone). A sent request whose reply times out,
        // never arrives or is invalid leaves the mount uncertain, so those
        // outcomes must refuse a standalone open. A lock refusal from this
        // library ends the command too: a local serve would meet the same lock.
        // So does a mount a turn-off or a forget overtook there.
        OpenTarget::Devserver => {
            if let Some(instance_index) = selected_devserver {
                let candidate = &candidates[instance_index];
                let instance = &devservers
                    .as_ref()
                    .expect("selected devserver came from discovery")[instance_index];
                let registration =
                    chan_server::devserver_handoff::try_register_devserver(instance, &root);
                tokio::pin!(registration);
                let outcome = tokio::select! {
                    outcome = &mut registration => outcome,
                    _ = tokio::time::sleep(Duration::from_secs(3)) => {
                        eprintln!("chan: waiting for the devserver to mount {}", root.display());
                        registration.await
                    }
                };
                match devserver_registration_action(
                    outcome,
                    flags.devserver.as_ref(),
                    &root,
                    same_path(&candidate.library_root, &library_root),
                )? {
                    DevserverRegistrationAction::Registered => {
                        let message = devserver_window_opened_message(&root, candidate);
                        println!("{message}");
                        return Ok(());
                    }
                    DevserverRegistrationAction::Standalone(message) => {
                        if let Some(message) = message {
                            eprintln!("{message}");
                        }
                    }
                }
            }
        }
        // Bind a standalone server here -- the direct path below.
        OpenTarget::Standalone => {}
    }

    ensure_workspace_registered(&lib, &root)?;
    let workspace = match lib.open_workspace(&root) {
        Ok(workspace) => workspace,
        // A live foreign writer holds the flock -- often a local devserver that
        // already serves this workspace. Point the user at --devserver to
        // register with it instead of fighting for the lock. Worded as a
        // possibility: we have not confirmed the holder IS a devserver.
        Err(chan_workspace::ChanError::WorkspaceLocked) => anyhow::bail!(
            "the workspace is held by another process; if a local devserver \
             owns it, run `chan serve --devserver` to register with it."
        ),
        Err(e) => return Err(e.into()),
    };

    // Best-effort update notice. The banner reads cached state
    // (no network) so an air-gapped host pays zero startup cost.
    // The probe runs as a detached tokio task with short timeouts;
    // its failures are swallowed at `debug` level. Honors
    // CHAN_UPDATE_CHECK=0 and the standard *_PROXY env vars
    // (reqwest reads them automatically).
    update::maybe_print_banner();
    tokio::spawn(update::run_probe());

    // Loud warning: the auth model assumes loopback. No TLS, only a
    // bearer token. Binding off-loopback exposes the workspace in the
    // clear to anyone on that network, including unauthenticated
    // probes if --no-token is also set.
    let host = addr.ip();
    if !host.is_loopback() {
        eprintln!(
            "WARNING: binding to {host} exposes chan on a non-loopback \
             interface. There is no TLS; the bearer token is sent in \
             plaintext. Do not use this on an untrusted network."
        );
        if no_token {
            eprintln!(
                "WARNING: --no-token + non-loopback host = open read/write \
                 access to your workspace for anyone who can reach this port."
            );
        }
    }

    if no_settings {
        eprintln!(
            "chan: --no-settings is set; this server answers 403 on its settings-write routes."
        );
    }
    let config = ServeConfig {
        addr,
        no_token,
        prefix,
        idle_timeout,
        // Default: open the browser on bind. --no-browser opts out
        // (desktop shells that host the UI in their own window,
        // headless / scripted invocations). Honored in both local
        // and tunnel mode.
        open_browser: !no_browser,
        search_aggression,
        verbose,
        // Local serve trusts the operator by default; --no-settings opts
        // into the server's 403 on settings writes for kiosk /
        // shared-workstation deployments where the operator is not the
        // workspace owner.
        settings_disabled: no_settings,
    };
    // A standalone `chan serve` and a devserver share DEFAULT_PORT. On collision,
    // use the discovery snapshot to distinguish one of this user's devservers
    // from an unrelated holder. Explicit standalone/desktop routes discover
    // lazily here so their healthy startup path pays no probe cost.
    let serve_result = chan_server::serve(lib, workspace, config).await;
    if let Err(err) = &serve_result {
        if devserver_port_collision_hint(addr.port(), err, &[]).is_some() && devservers.is_none() {
            devservers = Some(chan_server::devserver_handoff::discover_devservers().await);
            candidates = devservers
                .as_deref()
                .map(devserver_candidates)
                .unwrap_or_default();
        }
        if let Some(hint) = devserver_port_collision_hint(addr.port(), err, &candidates) {
            return Err(anyhow::anyhow!(hint));
        }
    }
    serve_result.with_context(|| format!("running server on {addr}"))
}

/// Actionable hint for the one bind failure a user is most likely to hit and
/// least likely to diagnose: `chan serve` falling through to a standalone bind
/// on `DEFAULT_PORT`. Returns `Some` only for an `AddrInUse` on exactly that
/// port; every other error keeps the generic server context. A discovered
/// same-user devserver is named only when it reports the collided port.
fn devserver_port_collision_hint(
    port: u16,
    err: &chan_server::Error,
    instances: &[DevserverCandidate],
) -> Option<String> {
    if port != DEFAULT_PORT {
        return None;
    }
    let chan_server::Error::Io(io_err) = err else {
        return None;
    };
    if io_err.kind() != std::io::ErrorKind::AddrInUse {
        return None;
    }
    if let Some(instance) = instances.iter().find(|instance| instance.port == port) {
        return Some(format!(
            "port {DEFAULT_PORT} is already in use, and your local devserver on that port \
             (library {}, chan {}) did not mount this workspace. Re-run with \
             `--devserver={DEFAULT_PORT}` to register there, or `--port N` to bind a \
             standalone server elsewhere.",
            instance.library_root.display(),
            instance.version,
        ));
    }
    Some(format!(
        "port {DEFAULT_PORT} is already in use, but no devserver of yours was discovered \
         on that port. The holder may be another process, another user's devserver, or \
         your own devserver from an older chan version (pre-discovery instances are \
         invisible here). Re-run with `--port N` to bind a standalone server elsewhere."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Cli, Command};
    use clap::Parser;

    #[test]
    fn devserver_collision_hint_only_on_default_port_addr_in_use() {
        use std::io::{Error as IoError, ErrorKind};
        let in_use = || chan_server::Error::Io(IoError::from(ErrorKind::AddrInUse));
        let matching = DevserverCandidate {
            instance_index: 0,
            pid: 41,
            library_root: PathBuf::from("/home/me/.chan"),
            port: DEFAULT_PORT,
            version: "0.74.0".into(),
        };
        let other_port = DevserverCandidate {
            port: 9999,
            ..matching.clone()
        };

        let hint =
            devserver_port_collision_hint(DEFAULT_PORT, &in_use(), &[matching]).expect("hint");
        assert!(hint.contains(&DEFAULT_PORT.to_string()), "{hint}");
        assert!(hint.contains("your local devserver"), "{hint}");
        assert!(hint.contains("/home/me/.chan"), "{hint}");
        assert!(hint.contains("--devserver=8787"), "{hint}");
        assert!(hint.contains("--port"), "{hint}");

        // A live devserver on another port does not explain this collision.
        let hint =
            devserver_port_collision_hint(DEFAULT_PORT, &in_use(), &[other_port]).expect("hint");
        assert!(hint.contains("no devserver of yours"), "{hint}");
        assert!(hint.contains("another user's"), "{hint}");
        // The holder can also be the user's own pre-discovery devserver;
        // the hint must not imply only foreign processes qualify.
        assert!(hint.contains("older chan version"), "{hint}");
        assert!(!hint.contains("did not mount"), "{hint}");

        assert!(devserver_port_collision_hint(9999, &in_use(), &[]).is_none());

        let denied = chan_server::Error::Io(IoError::from(ErrorKind::PermissionDenied));
        assert!(devserver_port_collision_hint(DEFAULT_PORT, &denied, &[]).is_none());

        let cfg = chan_server::Error::Config("nope".into());
        assert!(devserver_port_collision_hint(DEFAULT_PORT, &cfg, &[]).is_none());
    }

    #[test]
    fn devserver_url_discriminator() {
        // scheme://host shapes are devserver URLs.
        assert!(looks_like_devserver_url("https://box.example.com:8787"));
        assert!(looks_like_devserver_url("http://127.0.0.1:8787"));
        assert!(looks_like_devserver_url(
            "https://alice--1a2b3c4d5e6f.p1.proxy.chan.app"
        ));
        // Everything else is a local path: bare host:port (no `//`), a
        // relative or absolute path, `.`, a Windows drive path, and an empty
        // authority.
        assert!(!looks_like_devserver_url("box.example.com:8787"));
        assert!(!looks_like_devserver_url("."));
        assert!(!looks_like_devserver_url("./notes"));
        assert!(!looks_like_devserver_url("/home/u/notes"));
        assert!(!looks_like_devserver_url("notes"));
        assert!(!looks_like_devserver_url(r"C:\Users\u\notes"));
        assert!(!looks_like_devserver_url("://nohost"));
        assert!(!looks_like_devserver_url("https://"));
    }

    /// No-flag triple, for the parentage-default cases.
    const NO_FLAGS: OpenFlags = OpenFlags {
        standalone: false,
        desktop: false,
        devserver: None,
    };

    fn route(
        flags: OpenFlags,
        parentage: Parentage,
        forced_desktop: bool,
        live: LiveInstances,
    ) -> Result<OpenTarget, RouteError> {
        let present = parentage != Parentage::None;
        decide_open_route(flags, parentage, forced_desktop, present, live)
    }

    #[test]
    fn route_explicit_flag_forces_its_target() {
        for parentage in [
            Parentage::Desktop,
            Parentage::Devserver { pid: 42 },
            Parentage::None,
        ] {
            let standalone = OpenFlags {
                standalone: true,
                ..NO_FLAGS
            };
            assert_eq!(
                route(standalone, parentage, false, LiveInstances::default()),
                Ok(OpenTarget::Standalone)
            );
            let desktop = OpenFlags {
                desktop: true,
                ..NO_FLAGS
            };
            assert_eq!(
                route(desktop, parentage, false, LiveInstances::default()),
                Ok(OpenTarget::Desktop)
            );
        }
        let devserver = OpenFlags {
            devserver: Some(DevserverSelector::Auto),
            ..NO_FLAGS
        };
        assert_eq!(
            route(
                devserver,
                Parentage::Desktop,
                false,
                LiveInstances::default()
            ),
            Ok(OpenTarget::Devserver)
        );
        assert_eq!(
            route(devserver, Parentage::None, false, LiveInstances::default()),
            Ok(OpenTarget::Devserver)
        );
    }

    #[test]
    fn route_explicit_standalone_overrides_forced_desktop() {
        // --standalone wins even when the desktop handoff is forced (the
        // Windows shim's CHAN_DESKTOP_HANDOFF / Personality::Desktop).
        let standalone = OpenFlags {
            standalone: true,
            ..NO_FLAGS
        };
        assert_eq!(
            route(standalone, Parentage::None, true, LiveInstances::default()),
            Ok(OpenTarget::Standalone)
        );
        assert_eq!(
            route(
                standalone,
                Parentage::Desktop,
                true,
                LiveInstances::default()
            ),
            Ok(OpenTarget::Standalone)
        );
    }

    #[test]
    fn route_live_instance_matrix() {
        let sets = [
            (
                LiveInstances::default(),
                OpenTarget::Standalone,
                OpenTarget::Desktop,
            ),
            (
                LiveInstances {
                    desktop: true,
                    devservers: 0,
                },
                OpenTarget::Desktop,
                OpenTarget::Desktop,
            ),
            (
                LiveInstances {
                    desktop: false,
                    devservers: 1,
                },
                OpenTarget::Devserver,
                OpenTarget::Devserver,
            ),
            (
                LiveInstances {
                    desktop: true,
                    devservers: 2,
                },
                OpenTarget::Devserver,
                OpenTarget::Desktop,
            ),
        ];
        for (live, standalone_want, desktop_want) in sets {
            assert_eq!(
                route(NO_FLAGS, Parentage::None, false, live),
                Ok(standalone_want),
                "standalone personality, live={live:?}"
            );
            assert_eq!(
                route(NO_FLAGS, Parentage::None, true, live),
                Ok(desktop_want),
                "desktop personality, live={live:?}"
            );
            for forced_desktop in [false, true] {
                assert_eq!(
                    route(NO_FLAGS, Parentage::Desktop, forced_desktop, live),
                    Ok(OpenTarget::Desktop),
                    "desktop parent, forced={forced_desktop}, live={live:?}"
                );
                assert_eq!(
                    route(
                        NO_FLAGS,
                        Parentage::Devserver { pid: 42 },
                        forced_desktop,
                        live,
                    ),
                    Ok(OpenTarget::Devserver),
                    "devserver parent, forced={forced_desktop}, live={live:?}"
                );
            }
        }
    }

    #[test]
    fn route_present_unidentified_prefers_standalone() {
        // A control socket IS present but its kind did not resolve (a wedged or
        // timed-out probe -> Parentage::None). Even with a leaked
        // CHAN_DESKTOP_HANDOFF, prefer standalone over misrouting to desktop.
        assert_eq!(
            decide_open_route(
                NO_FLAGS,
                Parentage::None,
                true,
                true,
                LiveInstances::default()
            ),
            Ok(OpenTarget::Standalone)
        );
        assert_eq!(
            decide_open_route(
                NO_FLAGS,
                Parentage::None,
                true,
                true,
                LiveInstances {
                    desktop: false,
                    devservers: 1,
                }
            ),
            Ok(OpenTarget::Devserver)
        );
        assert_eq!(
            decide_open_route(
                NO_FLAGS,
                Parentage::None,
                true,
                false,
                LiveInstances::default()
            ),
            Ok(OpenTarget::Desktop)
        );
    }

    #[test]
    fn route_nested_devserver_refused() {
        // Explicit --devserver from inside a devserver shell is refused; the
        // no-flag default in the same shell registers transparently.
        let devserver = OpenFlags {
            devserver: Some(DevserverSelector::Auto),
            ..NO_FLAGS
        };
        assert_eq!(
            route(
                devserver,
                Parentage::Devserver { pid: 42 },
                false,
                LiveInstances::default()
            ),
            Err(RouteError::NestedDevserver)
        );
        assert_eq!(
            route(
                NO_FLAGS,
                Parentage::Devserver { pid: 42 },
                false,
                LiveInstances::default()
            ),
            Ok(OpenTarget::Devserver)
        );
    }

    #[test]
    fn route_multiple_targets_rejected() {
        // The resolver guards mutual exclusion even though clap rejects it
        // first (see `serve_target_flags_are_mutually_exclusive`).
        let two = OpenFlags {
            standalone: true,
            desktop: true,
            devserver: None,
        };
        assert_eq!(
            route(two, Parentage::None, false, LiveInstances::default()),
            Err(RouteError::MultipleTargets)
        );
    }

    fn candidate(index: usize, pid: u32, root: &str, port: u16) -> DevserverCandidate {
        DevserverCandidate {
            instance_index: index,
            pid,
            library_root: PathBuf::from(root),
            port,
            version: format!("0.74.{index}"),
        }
    }

    #[test]
    fn devserver_serve_note_says_a_window_opened() {
        let instance = candidate(0, 10, "/library/a", 8787);
        assert_eq!(
            devserver_window_opened_message(Path::new("/tmp/notes"), &instance),
            "chan: opened a window for /tmp/notes with local devserver on port 8787 \
             (library /library/a, chan 0.74.0)",
        );
    }

    #[test]
    fn devserver_selection_is_deterministic() {
        let a = candidate(0, 10, "/library/a", 8787);
        let b = candidate(1, 20, "/library/b", 9999);

        assert_eq!(
            select_devserver(&[], None, None, Path::new("/library/a")),
            Ok(None)
        );
        assert_eq!(
            select_devserver(std::slice::from_ref(&a), None, None, Path::new("/other"))
                .unwrap()
                .map(|candidate| candidate.port),
            Some(8787)
        );
        assert_eq!(
            select_devserver(&[a.clone(), b.clone()], None, None, Path::new("/library/b"))
                .unwrap()
                .map(|candidate| candidate.port),
            Some(9999)
        );
        assert_eq!(
            select_devserver(&[a.clone(), b.clone()], None, None, Path::new("/other")),
            Err(DevserverSelectionError::Ambiguous)
        );
        // Parentage is stronger than CHAN_HOME: this preserves "the current
        // devserver" even if two live processes share one library root.
        assert_eq!(
            select_devserver(
                &[a.clone(), b.clone()],
                None,
                Some(10),
                Path::new("/library/b")
            )
            .unwrap()
            .map(|candidate| candidate.port),
            Some(8787)
        );
        assert_eq!(
            select_devserver(
                &[a.clone(), b.clone()],
                Some(DevserverSelector::Port(9999)),
                None,
                Path::new("/library/a"),
            )
            .unwrap()
            .map(|candidate| candidate.port),
            Some(9999)
        );
        assert_eq!(
            select_devserver(
                &[a, b],
                Some(DevserverSelector::Port(7777)),
                None,
                Path::new("/library/a"),
            ),
            Err(DevserverSelectionError::NotFound { port: 7777 })
        );
    }

    #[test]
    fn parentage_refuses_when_the_parent_is_not_discovered() {
        let a = candidate(0, 10, "/library/a", 8787);
        let b = candidate(1, 20, "/library/b", 9999);

        // A matching parent pid still selects, even as the sole candidate.
        assert_eq!(
            select_devserver(
                std::slice::from_ref(&a),
                None,
                Some(10),
                Path::new("/other")
            )
            .unwrap()
            .map(|candidate| candidate.port),
            Some(8787)
        );
        // The spawning devserver is invisible to discovery: adopting the sole
        // survivor would mount the workspace on the wrong instance, so
        // selection refuses. (No-parent sole-candidate adoption is pinned by
        // `devserver_selection_is_deterministic`.)
        assert_eq!(
            select_devserver(
                std::slice::from_ref(&a),
                None,
                Some(99),
                Path::new("/other")
            ),
            Err(DevserverSelectionError::ParentNotFound { pid: 99 })
        );
        // Same with several candidates: parentage never falls through to the
        // CHAN_HOME preference when it names a pid that is not live.
        assert_eq!(
            select_devserver(&[a, b], None, Some(99), Path::new("/library/b")),
            Err(DevserverSelectionError::ParentNotFound { pid: 99 })
        );
    }

    #[tokio::test]
    async fn open_alias_refuses_urls_like_serve() {
        let mut errors = Vec::new();
        for verb in ["serve", "open"] {
            let Command::Serve { args } =
                Cli::try_parse_from(["chan", verb, "https://example.test/notes"])
                    .unwrap()
                    .command
            else {
                panic!("not serve")
            };
            errors.push(
                cmd_serve_cli(args, Personality::Standalone, false)
                    .await
                    .unwrap_err()
                    .to_string(),
            );
        }
        assert_eq!(errors[0], errors[1]);
        assert!(errors[0].contains("is a URL; `chan serve` takes a workspace PATH"));
    }

    #[test]
    fn devserver_registration_timeout_refuses_standalone() {
        use chan_server::devserver_handoff::Outcome;
        let root = Path::new("notes");
        for (selector, same_library) in [(None, false), (Some(DevserverSelector::Port(8787)), true)]
        {
            let error = devserver_registration_action(
                Outcome::ReplyTimedOut,
                selector.as_ref(),
                root,
                same_library,
            )
            .expect_err("timeout must not open a standalone server");
            assert_eq!(error.to_string(),
                "the devserver did not answer within 75 s; it may still be mounting notes; check `chan ps` or retry with `--standalone`");
        }
        assert!(matches!(
            devserver_registration_action(Outcome::NoDevserver, None, root, false).unwrap(),
            DevserverRegistrationAction::Standalone(None)
        ));
        assert!(devserver_registration_action(
            Outcome::NoDevserver,
            Some(&DevserverSelector::Port(8787)),
            root,
            false,
        )
        .is_err());
        assert!(matches!(
            devserver_registration_action(
                Outcome::Registered {
                    prefix: "/notes".into()
                },
                None,
                root,
                true,
            )
            .unwrap(),
            DevserverRegistrationAction::Registered
        ));
    }

    #[test]
    fn devserver_registration_lost_reply_refuses_standalone() {
        use chan_server::devserver_handoff::Outcome;
        let root = Path::new("notes");
        for (selector, same_library) in [(None, false), (Some(DevserverSelector::Port(8787)), true)]
        {
            let error = devserver_registration_action(
                Outcome::ReplyLost,
                selector.as_ref(),
                root,
                same_library,
            )
            .expect_err("a lost reply must not open a standalone server");
            assert_eq!(error.to_string(),
                "the devserver sent no valid reply to the registration; it may still be mounting notes or may have died; check `chan ps` or retry with `--standalone`");
        }
        let action =
            devserver_registration_action(Outcome::Error("mount failed".into()), None, root, true);
        assert!(
            matches!(
                action,
                Ok(DevserverRegistrationAction::Standalone(Some(message)))
                    if message.contains("mount failed")
            ),
            "a definitive mount failure did not fall back"
        );
    }

    /// A mount that a later request overtook in the devserver the command
    /// handed its folder to ends the serve on the devserver's sentence, with
    /// no standalone server, whichever library that devserver is of: the
    /// request that overtook it is the later word on the folder there, and a
    /// library of its own would let the command serve the folder all the
    /// same. The sentence an older devserver answers for the same refusal
    /// falls back, since this command does not tell it from any other mount
    /// failure.
    #[test]
    fn a_mount_overtaken_in_a_devserver_is_the_serve_error() {
        use chan_server::devserver_handoff::{Outcome, MOUNT_OVERTAKEN};
        let root = Path::new("notes");
        let action =
            devserver_registration_action(Outcome::Error(MOUNT_OVERTAKEN.into()), None, root, true);
        assert_eq!(
            action.err().map(|error| error.to_string()),
            Some(MOUNT_OVERTAKEN.to_string()),
            "an overtaken mount in this library's devserver did not end the serve"
        );
        let other_library = devserver_registration_action(
            Outcome::Error(MOUNT_OVERTAKEN.into()),
            None,
            root,
            false,
        );
        assert_eq!(
            other_library.err().map(|error| error.to_string()),
            Some(MOUNT_OVERTAKEN.to_string()),
            "an overtaken mount in another library's devserver did not end the serve"
        );
        let older_sentence =
            "chan-workspace: workspace is already open in this process; drop the existing handle first";
        let older =
            devserver_registration_action(Outcome::Error(older_sentence.into()), None, root, true);
        assert!(
            matches!(
                older,
                Ok(DevserverRegistrationAction::Standalone(Some(message)))
                    if message.contains(older_sentence)
            ),
            "the sentence an older devserver answers did not fall back"
        );
    }

    /// The words of the overtaken sentence. A command and a devserver of
    /// different versions compare them by equality, so one changed letter
    /// makes a command of the other version fall back to a standalone
    /// server on this answer.
    #[test]
    fn the_overtaken_sentence_keeps_its_words() {
        assert_eq!(
            chan_server::devserver_handoff::MOUNT_OVERTAKEN,
            "a later request for this workspace overtook its mount in the devserver; run the command again"
        );
    }

    #[test]
    fn a_refusal_over_another_process_lock_from_this_library_is_the_serve_error() {
        use chan_server::devserver_handoff::Outcome;
        let root = Path::new("notes");
        let action = devserver_registration_action(
            Outcome::Error(chan_server::WORKSPACE_OPEN_ELSEWHERE.into()),
            None,
            root,
            true,
        );
        assert_eq!(
            action.err().map(|error| error.to_string()),
            Some(chan_server::WORKSPACE_OPEN_ELSEWHERE.to_string()),
            "the sentence from this library's devserver did not end the serve"
        );
        let other_library = devserver_registration_action(
            Outcome::Error(chan_server::WORKSPACE_OPEN_ELSEWHERE.into()),
            None,
            root,
            false,
        );
        assert!(
            matches!(
                other_library,
                Ok(DevserverRegistrationAction::Standalone(Some(message)))
                    if message.contains(chan_server::WORKSPACE_OPEN_ELSEWHERE)
            ),
            "a devserver of another library did not fall back"
        );
        let older = devserver_registration_action(
            Outcome::Error("chan-workspace: workspace is locked by another process".into()),
            None,
            root,
            true,
        );
        assert!(
            matches!(
                older,
                Ok(DevserverRegistrationAction::Standalone(Some(message)))
                    if message.contains("chan-workspace: workspace is locked by another process")
            ),
            "the older lock text did not fall back"
        );
    }

    #[test]
    fn absolutize_serve_root_is_always_absolute() {
        // The bug: a relative root (`.`) handed to the desktop made it
        // open "/". The invariant that fixes it is simply that the serve
        // root is always absolute before the handoff -- regardless of
        // whether the dir exists yet.
        assert!(absolutize_serve_root(PathBuf::from(".")).is_absolute());
        assert!(absolutize_serve_root(PathBuf::from("does/not/exist/yet")).is_absolute());
        assert!(absolutize_serve_root(PathBuf::from("/tmp")).is_absolute());
        // A relative path lands under the cwd, not the filesystem root.
        let cwd = std::env::current_dir().unwrap();
        assert!(absolutize_serve_root(PathBuf::from("sub/dir")).starts_with(&cwd));
    }

    /// This root is user-visible: `chan serve` prints it and hands it to
    /// chan-desktop. `std::fs::canonicalize` emits the Windows verbatim
    /// prefix, which must be stripped from the printed and handed-off path.
    /// This pure string assertion runs on every arm.
    #[test]
    fn absolutize_serve_root_strips_the_windows_verbatim_prefix() {
        let out = absolutize_serve_root(PathBuf::from("."));
        let shown = out.to_string_lossy();
        assert!(
            !shown.starts_with(r"\\?\"),
            "serve root must not carry the verbatim prefix, got {shown}",
        );

        // And the stripping itself, independent of what this host's
        // canonicalize returns.
        assert_eq!(
            chan_workspace::paths::strip_verbatim_prefix(std::path::Path::new(r"\\?\C:\notes")),
            PathBuf::from(r"C:\notes"),
        );
    }

    fn ipv4(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    fn ipv6(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn default_is_v4_loopback() {
        let addr = resolve_listen_addr(None, false, false, 8787).unwrap();
        assert_eq!(addr, SocketAddr::new(ipv4("127.0.0.1"), 8787));
    }

    #[test]
    fn ipv4_flag_with_no_host_gives_v4_loopback() {
        let addr = resolve_listen_addr(None, true, false, 8787).unwrap();
        assert_eq!(addr, SocketAddr::new(ipv4("127.0.0.1"), 8787));
    }

    #[test]
    fn ipv6_flag_with_no_host_gives_v6_loopback() {
        let addr = resolve_listen_addr(None, false, true, 8787).unwrap();
        assert_eq!(addr, SocketAddr::new(ipv6("::1"), 8787));
    }

    #[test]
    fn explicit_host_overrides_default() {
        let addr = resolve_listen_addr(Some(ipv4("0.0.0.0")), false, false, 9000).unwrap();
        assert_eq!(addr, SocketAddr::new(ipv4("0.0.0.0"), 9000));
    }

    #[test]
    fn ipv4_flag_rejects_v6_host() {
        let err = resolve_listen_addr(Some(ipv6("::1")), true, false, 8787).unwrap_err();
        assert!(err.to_string().contains("-4"));
    }

    #[test]
    fn ipv6_flag_rejects_v4_host() {
        let err = resolve_listen_addr(Some(ipv4("127.0.0.1")), false, true, 8787).unwrap_err();
        assert!(err.to_string().contains("-6"));
    }

    #[test]
    fn ipv4_flag_accepts_matching_v4_host() {
        let addr = resolve_listen_addr(Some(ipv4("0.0.0.0")), true, false, 8787).unwrap();
        assert_eq!(addr, SocketAddr::new(ipv4("0.0.0.0"), 8787));
    }

    #[test]
    fn ipv6_flag_accepts_matching_v6_host() {
        let addr = resolve_listen_addr(Some(ipv6("::")), false, true, 8787).unwrap();
        assert_eq!(addr, SocketAddr::new(ipv6("::"), 8787));
    }
}
