//! Discovery of the shells a terminal can spawn -- the model behind a
//! Windows-Terminal-style profile picker.
//!
//! [`platform::command_builder`] resolves ONE shell for the whole process
//! ([`platform::windows_shell`]'s `OnceLock`). That stays: it is the *default*
//! profile, and it exists because resolution shells out on the interactive
//! path. This module adds the other half -- an enumeration of every shell
//! present on the machine, so a caller can spawn a named one instead.
//!
//! Shape, mirroring Windows Terminal's dynamic profile generators: one
//! generator per source, each contributing zero or more [`ShellProfile`]s, all
//! resolved once and cached.
//!
//! Discovery shells out (`where`, `reg`, `git`), so it carries the same
//! constraint as [`platform::prime_windows_shell`]: prime it off the async
//! request path or a tokio worker blocks and the SPA freezes. See
//! [`prime_shell_profiles`].
//!
//! Testability: every parser here is a pure `&str -> value` function, split
//! from the process/filesystem calls that feed it, so the interesting logic
//! (the WSL-launcher filter, the UTF-16 trap, the registry shapes) is covered
//! by table-driven tests that run on every CI arm, not only Windows.

use std::path::{Path, PathBuf};

use portable_pty::CommandBuilder;

/// How a shell takes its interactive and one-shot arguments.
///
/// The first three variants reproduce `platform`'s original `WinShellKind`
/// exactly; [`ShellKind::Wsl`] is new and is the reason this cannot be a stem
/// lookup: `wsl.exe -l` means "list distributions", not "login shell", so a
/// `wsl.exe` classified as [`ShellKind::Posix`] would hand it `-l` and spawn a
/// listing instead of a shell.
///
/// Wire shape is `lowercase`, not kebab-case: these are hand-written in a
/// `server.toml`, and `kind = "powershell"` reads better than
/// `kind = "power-shell"`. Matches `SubmitAgent`'s spelling convention.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellKind {
    /// `powershell.exe` / `pwsh.exe`: `-NoLogo` interactive, `-NoLogo -Command`
    /// one-shot. No `-NoProfile` -- we want the user's profile/PATH (the `-l`
    /// analog of the unix login shell).
    PowerShell,
    /// `cmd.exe`: no args interactive, `/C` one-shot.
    Cmd,
    /// A POSIX shell (`sh`, `bash`, `zsh`, a Git BASH): `-l` / `-lc`.
    Posix,
    /// `wsl.exe -d <distro>`: the distro's own login shell. One-shots go
    /// through `-- sh -lc <command>` so the command runs inside the distro
    /// rather than being parsed by `wsl.exe` itself.
    Wsl,
}

impl ShellKind {
    /// Infer the argument convention from a program's file stem.
    ///
    /// Unknown stems fall back to POSIX (`-l` / `-lc`), which is the useful
    /// guess for a `bash`/`sh`/`zsh` a user points at. `wsl` is called out
    /// explicitly and must never reach that fallback: `-l` to `wsl.exe` means
    /// "list distributions", so a POSIX-classified WSL entry prints a distro
    /// list and exits instead of opening a shell.
    ///
    /// Cross-platform and pure so the classification is table-tested on every
    /// CI arm; `platform::classify_windows_shell` delegates here rather than
    /// keeping a second copy of the match.
    pub fn from_program_stem(program: &Path) -> ShellKind {
        // Split on both separators rather than asking `Path`. A program path
        // reaches here as portable text -- from `[[terminal.profiles]]`, or
        // from a `CHAN_SHELL` override -- and off Windows `Path` does not treat
        // `\` as a separator, so `C:\pwsh.exe` keeps its whole spelling as the
        // stem and falls to `Posix`. That is the one classification that must
        // not happen by accident: `-l` to `wsl.exe` lists distributions.
        let raw = program.to_str().unwrap_or("");
        let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
        // `file_stem` semantics: drop the last extension, but a leading dot is
        // part of the name rather than an empty stem.
        let stem = match base.rsplit_once('.') {
            Some((name, _)) if !name.is_empty() => name,
            _ => base,
        }
        .to_ascii_lowercase();
        match stem.as_str() {
            "pwsh" | "powershell" => ShellKind::PowerShell,
            "cmd" => ShellKind::Cmd,
            "wsl" => ShellKind::Wsl,
            _ => ShellKind::Posix,
        }
    }

    /// The interactive arguments a shell of this kind takes by default. Used
    /// when a profile is derived from a bare program path (a `CHAN_SHELL`
    /// override, or the built-in default resolution) rather than from a
    /// generator that knows better.
    ///
    /// `Wsl` gets no args on purpose: a bare `wsl.exe` opens the *default*
    /// distribution's login shell, which is the right thing for an override
    /// that names no distro.
    pub(super) fn default_interactive_args(self) -> Vec<String> {
        match self {
            ShellKind::PowerShell => vec!["-NoLogo".into()],
            ShellKind::Cmd => Vec::new(),
            ShellKind::Posix => vec!["-l".into()],
            ShellKind::Wsl => Vec::new(),
        }
    }

    /// The one-shot argument vector, given the profile's interactive `base`
    /// args. Kept beside [`ShellKind`] so a new variant cannot add an
    /// interactive convention while forgetting the one-shot one.
    ///
    /// Note the deliberate asymmetry: `PowerShell` and `Wsl` extend their base
    /// args, `Cmd` and `Posix` replace them (`-lc` is a single combined short
    /// option, not `-l` plus `-c`). This reproduces the pre-existing behaviour
    /// byte for byte.
    fn one_shot_args(self, base: &[String], command: &str) -> Vec<String> {
        match self {
            ShellKind::PowerShell => {
                let mut args = base.to_vec();
                args.push("-Command".into());
                args.push(command.into());
                args
            }
            ShellKind::Cmd => vec!["/C".into(), command.into()],
            ShellKind::Posix => vec!["-lc".into(), command.into()],
            ShellKind::Wsl => {
                let mut args = base.to_vec();
                args.extend(["--".into(), "sh".into(), "-lc".into(), command.into()]);
                args
            }
        }
    }
}

/// Where a profile came from. A user-defined profile always wins over a
/// generated one with the same id, so a hand-authored entry can correct a bad
/// guess without the generator overwriting it on the next boot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProfileSource {
    /// Produced by a generator in this module.
    Discovered,
    /// Declared by the user in config.
    User,
}

/// A named shell a terminal can spawn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellProfile {
    /// Stable key. Survives a display-name change, so a per-tab reference and
    /// any future user override keep pointing at the same profile.
    pub id: String,
    /// Display name, e.g. "Git Bash", "Ubuntu (WSL)".
    pub name: String,
    /// Absolute path to the executable. Absolute deliberately: a bare name
    /// would need a `where` lookup, and that must not happen on the spawn path
    /// (see the module docs).
    pub program: PathBuf,
    /// Interactive arguments. One-shots are derived via
    /// [`ShellKind::one_shot_args`].
    pub args: Vec<String>,
    pub kind: ShellKind,
    /// Extra `PATH` entries the shell needs prepended. Git BASH is the reason
    /// this exists: without `<root>\usr\bin` and `<root>\mingw64\bin`, the
    /// login shell has no coreutils and cannot resolve `cs`.
    pub path_prepend: Vec<PathBuf>,
    pub source: ProfileSource,
}

impl ShellProfile {
    /// Build the spawn command for this profile. `command` is a one-shot to run
    /// inside the shell; `None` spawns it interactively.
    pub fn build(&self, command: Option<&str>) -> CommandBuilder {
        let mut cmd = CommandBuilder::new(&self.program);
        match command {
            None => {
                for arg in &self.args {
                    cmd.arg(arg);
                }
            }
            Some(command) => {
                for arg in self.kind.one_shot_args(&self.args, command) {
                    cmd.arg(arg);
                }
            }
        }
        cmd
    }
}

/// Every shell discovered on this machine, resolved once and cached for the
/// process lifetime.
///
/// Caches the *list*, not a choice -- that is the whole difference from
/// [`platform::windows_shell`], which caches the single resolved default.
pub fn shell_profiles() -> &'static [ShellProfile] {
    static CACHE: std::sync::OnceLock<Vec<ShellProfile>> = std::sync::OnceLock::new();
    CACHE.get_or_init(discover)
}

/// Force the [`shell_profiles`] cache to resolve eagerly, off the async request
/// path. Same rule and same reason as [`platform::prime_windows_shell`]:
/// discovery uses blocking `std::process::Command` (`where`, `reg`, `git`), and
/// a lazy resolve on a tokio worker would freeze the SPA.
pub fn prime_shell_profiles() {
    let _ = shell_profiles();
}

/// Layer the user's declared profiles over the discovered ones.
///
/// Precedence, following Windows Terminal: generators propose, the user
/// disposes. An entry whose `id` matches a discovered profile overrides its
/// fields or hides it; an entry with a new `id` appends a profile of its own,
/// after the discovered ones and in file order.
///
/// Three deliberate choices:
///
/// - `args` **replaces** rather than appends. Appending cannot express "spawn
///   PowerShell without `-NoLogo`", and a user overriding args wants exactly
///   the vector they wrote.
/// - Hiding is honoured even for an id nothing discovered, and costs nothing:
///   it means a machine that temporarily loses a shell (an uninstalled WSL
///   distro) does not silently un-hide it when the shell returns.
/// - A new profile with no `program` is dropped with a warning. There is
///   nothing to spawn, and surfacing it in a picker would produce a profile
///   that fails only when clicked.
pub fn effective_profiles(
    discovered: &[ShellProfile],
    user: &[crate::config::TerminalProfile],
) -> Vec<ShellProfile> {
    let overrides: std::collections::HashMap<&str, &crate::config::TerminalProfile> = user
        .iter()
        .map(|profile| (profile.id.trim(), profile))
        .collect();

    let mut effective: Vec<ShellProfile> = discovered
        .iter()
        .filter_map(|found| match overrides.get(found.id.as_str()) {
            None => Some(found.clone()),
            Some(over) if over.hidden => None,
            Some(over) => Some(apply_override(found.clone(), over)),
        })
        .collect();

    // Additions: user ids that matched nothing discovered, in file order.
    let discovered_ids: std::collections::HashSet<&str> =
        discovered.iter().map(|p| p.id.as_str()).collect();
    for over in user {
        let id = over.id.trim();
        if discovered_ids.contains(id) || over.hidden {
            continue;
        }
        match new_profile_from_override(over) {
            Some(profile) => effective.push(profile),
            None => tracing::warn!(
                id,
                "terminal.profiles: entry matches no discovered shell and declares no program; ignoring"
            ),
        }
    }
    effective
}

/// Apply a user override onto a discovered profile. Absent fields keep the
/// discovered value.
fn apply_override(mut base: ShellProfile, over: &crate::config::TerminalProfile) -> ShellProfile {
    if let Some(name) = over
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
    {
        base.name = name.to_string();
    }
    if let Some(program) = over
        .program
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        base.program = PathBuf::from(program);
    }
    if let Some(args) = over.args.as_ref() {
        base.args = args.clone();
    }
    if let Some(kind) = over.kind {
        base.kind = kind;
    }
    base.source = ProfileSource::User;
    base
}

/// Build a wholly new profile from a user entry, or `None` when it names no
/// program to spawn.
fn new_profile_from_override(over: &crate::config::TerminalProfile) -> Option<ShellProfile> {
    let program = over
        .program
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())?;
    let program = PathBuf::from(program);
    let kind = over
        .kind
        .unwrap_or_else(|| ShellKind::from_program_stem(&program));
    let id = over.id.trim().to_string();
    Some(ShellProfile {
        name: over
            .name
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .unwrap_or(&id)
            .to_string(),
        args: over
            .args
            .clone()
            .unwrap_or_else(|| kind.default_interactive_args()),
        id,
        program,
        kind,
        path_prepend: Vec::new(),
        source: ProfileSource::User,
    })
}

/// The profile new terminals should spawn, given the configured default id.
///
/// `None` -- either unset, or naming a profile that no longer exists -- means
/// the caller falls back to the built-in resolution. A configured id that
/// matches nothing warns rather than failing: deleting a profile must not
/// strand the terminal with an unspawnable default.
pub fn resolve_default<'a>(
    profiles: &'a [ShellProfile],
    default_id: Option<&str>,
) -> Option<&'a ShellProfile> {
    let id = default_id.map(str::trim).filter(|id| !id.is_empty())?;
    let found = profiles.iter().find(|profile| profile.id == id);
    if found.is_none() {
        tracing::warn!(
            id,
            "terminal.default_profile names no known profile; using the built-in default shell"
        );
    }
    found
}

/// Run every generator for this platform, in display order.
///
/// Windows only, by design. Windows has no single system-wide answer to "the
/// user's shell" -- PowerShell 7, Windows PowerShell, cmd, Git BASH and each
/// WSL distribution are all plausible, and they do not share an argument
/// convention -- so chan discovers them and offers the choice, following
/// Windows Terminal.
///
/// macOS and Linux already have that answer: the login shell, which the user
/// sets once with `chsh` and every terminal emulator honours. Enumerating
/// `/etc/shells` there produced a picker listing shells the user had never
/// chosen and did not want, in place of a system setting that already worked.
/// So unix discovers nothing and the built-in `$SHELL` resolution stands.
///
/// This is discovery only. `[[terminal.profiles]]` still works on every
/// platform: a user who does want named shells on unix declares them, and
/// with nothing discovered to layer over, each declared entry simply appears.
fn discover() -> Vec<ShellProfile> {
    #[cfg(windows)]
    let profiles = discover_windows();
    #[cfg(not(windows))]
    let profiles: Vec<ShellProfile> = Vec::new();
    dedupe_by_id(profiles)
}

/// Drop later duplicates by id, preserving first-wins order. Generators can
/// legitimately collide -- `where pwsh` and the well-known Program Files probe
/// find the same `pwsh.exe` -- and a picker showing it twice is a bug.
fn dedupe_by_id(profiles: Vec<ShellProfile>) -> Vec<ShellProfile> {
    let mut seen = std::collections::HashSet::new();
    profiles
        .into_iter()
        .filter(|p| seen.insert(p.id.clone()))
        .collect()
}

// ---------------------------------------------------------------------------
// Windows generators
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn discover_windows() -> Vec<ShellProfile> {
    let mut profiles = Vec::new();
    profiles.extend(discover_powershell_core());
    profiles.extend(discover_windows_powershell());
    profiles.extend(discover_cmd());
    profiles.extend(discover_git_bash());
    profiles.extend(discover_wsl());
    profiles
}

/// PowerShell 7 (`pwsh.exe`): the well-known install roots first, then `where`.
#[cfg(windows)]
fn discover_powershell_core() -> Option<ShellProfile> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    for var in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
        if let Some(dir) = std::env::var_os(var) {
            candidates.push(PathBuf::from(dir).join(r"PowerShell\7\pwsh.exe"));
        }
    }
    if let Some(local) = std::env::var_os("LocalAppData") {
        candidates.push(PathBuf::from(local).join(r"Microsoft\WindowsApps\pwsh.exe"));
    }
    candidates.extend(where_lines("pwsh"));
    let program = candidates.into_iter().find(|p| p.is_file())?;
    Some(ShellProfile {
        id: "pwsh".into(),
        name: "PowerShell".into(),
        program,
        args: vec!["-NoLogo".into()],
        kind: ShellKind::PowerShell,
        path_prepend: Vec::new(),
        source: ProfileSource::Discovered,
    })
}

/// Windows PowerShell 5, in-box on every supported Windows. Resolved by full
/// System32 path so a modified `PATH` cannot shadow it -- the same reasoning as
/// `platform::resolve_windows_shell`.
#[cfg(windows)]
fn discover_windows_powershell() -> Option<ShellProfile> {
    let program = std::env::var_os("SystemRoot")
        .or_else(|| std::env::var_os("windir"))
        .map(|root| PathBuf::from(root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe"))
        .filter(|p| p.is_file())?;
    Some(ShellProfile {
        id: "windows-powershell".into(),
        name: "Windows PowerShell".into(),
        program,
        args: vec!["-NoLogo".into()],
        kind: ShellKind::PowerShell,
        path_prepend: Vec::new(),
        source: ProfileSource::Discovered,
    })
}

#[cfg(windows)]
fn discover_cmd() -> Option<ShellProfile> {
    let program = std::env::var_os("ComSpec")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows\System32\cmd.exe"));
    if !program.is_file() {
        return None;
    }
    Some(ShellProfile {
        id: "cmd".into(),
        name: "Command Prompt".into(),
        program,
        args: Vec::new(),
        kind: ShellKind::Cmd,
        path_prepend: Vec::new(),
        source: ProfileSource::Discovered,
    })
}

/// Git for Windows BASH.
///
/// Recovered from the pre-`4e8893ed` Git-BASH-only terminal, which resolved it
/// four ways for good reasons that still hold. Order matters: `git --exec-path`
/// first because it cannot be fooled by the WSL `bash.exe`, and the `where`
/// fallback last precisely *because* it can -- hence [`is_wsl_bash_launcher`].
#[cfg(windows)]
fn discover_git_bash() -> Option<ShellProfile> {
    // 1. Derive the root from `git --exec-path`
    //    (`<root>\mingw64\libexec\git-core`): walk ancestors for `bin\bash.exe`.
    if let Some(exec_path) = command_stdout("git", &["--exec-path"]) {
        let exec_path = normalize_separators(Path::new(exec_path.trim()));
        for root in exec_path.ancestors() {
            if let Some(profile) = git_bash_from_root(root) {
                return Some(profile);
            }
        }
    }

    // 2. Well-known install roots.
    let mut roots: Vec<PathBuf> = Vec::new();
    for var in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
        if let Some(dir) = std::env::var_os(var) {
            roots.push(PathBuf::from(dir).join("Git"));
        }
    }
    if let Some(local) = std::env::var_os("LocalAppData") {
        roots.push(PathBuf::from(local).join("Programs").join("Git"));
    }
    for root in &roots {
        if let Some(profile) = git_bash_from_root(root) {
            return Some(profile);
        }
    }

    // 3. Registry InstallPath (64- and 32-bit views).
    for key in [
        r"HKLM\SOFTWARE\GitForWindows",
        r"HKLM\SOFTWARE\WOW6432Node\GitForWindows",
    ] {
        if let Some(out) = command_stdout("reg", &reg_query_args(key, &["/v", "InstallPath"])) {
            if let Some(root) = parse_reg_sz_value(&out) {
                if let Some(profile) = git_bash_from_root(Path::new(&root)) {
                    return Some(profile);
                }
            }
        }
    }

    // 4. `where bash`, skipping the WSL launcher.
    for line in where_lines("bash") {
        if is_wsl_bash_launcher(&line) {
            continue;
        }
        // `where bash` points at `<root>\bin\bash.exe`, so the root is two up.
        if let Some(root) = line.parent().and_then(Path::parent) {
            if let Some(profile) = git_bash_from_root(root) {
                return Some(profile);
            }
        }
    }

    None
}

/// Build a Git BASH profile from a candidate install root, or `None` when it
/// has no `bin\bash.exe`.
#[cfg(any(windows, test))]
fn git_bash_from_root(root: &Path) -> Option<ShellProfile> {
    let program = root.join("bin").join("bash.exe");
    if !program.is_file() {
        return None;
    }
    // Without these the login shell has no coreutils and cannot resolve `cs`.
    let path_prepend = [["usr", "bin"], ["mingw64", "bin"], ["mingw32", "bin"]]
        .iter()
        .map(|sub| root.join(sub[0]).join(sub[1]))
        .filter(|dir| dir.is_dir())
        .collect();
    Some(ShellProfile {
        id: "git-bash".into(),
        name: "Git Bash".into(),
        program,
        args: vec!["-l".into()],
        kind: ShellKind::Posix,
        path_prepend,
        source: ProfileSource::Discovered,
    })
}

/// Rewrite POSIX separators to Windows ones.
///
/// `git --exec-path` reports `C:/Program Files/Git/mingw64/libexec/git-core`,
/// and joining onto that yields `C:/Program Files/Git\bin\bash.exe`. Both forms
/// resolve, so this is cosmetic -- but the mixed form is what a picker would
/// display, and it reads as a bug to whoever sees it.
#[cfg(any(windows, test))]
fn normalize_separators(path: &Path) -> PathBuf {
    PathBuf::from(path.to_string_lossy().replace('/', "\\"))
}

/// True for the `bash.exe` that is really the WSL launcher rather than a POSIX
/// shell. `C:\Windows\System32\bash.exe` and the `WindowsApps` alias both run
/// WSL; handing either the Git BASH treatment spawns the wrong thing entirely.
///
/// Pure and separately tested because this is the single most load-bearing line
/// in Git BASH discovery -- and the exact trap that makes a bare `bash` on a
/// developer's `PATH` open WSL instead of Git BASH.
#[cfg(any(windows, test))]
fn is_wsl_bash_launcher(path: &Path) -> bool {
    let lower = path.to_string_lossy().to_ascii_lowercase();
    lower.contains(r"\system32\") || lower.contains(r"\windowsapps\")
}

/// WSL distributions, from the `Lxss` registry rather than `wsl.exe --list`.
///
/// `wsl.exe --list --quiet` emits **UTF-16LE**; decoded as UTF-8 it yields
/// `U b u n t u` with interleaved NULs. The registry is plain `REG_SZ`, needs
/// no subprocess, and also names the default distribution.
#[cfg(windows)]
fn discover_wsl() -> Vec<ShellProfile> {
    const LXSS: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss";
    let Some(program) = std::env::var_os("SystemRoot")
        .map(|root| PathBuf::from(root).join(r"System32\wsl.exe"))
        .filter(|p| p.is_file())
    else {
        return Vec::new();
    };
    let Some(out) = command_stdout(
        "reg",
        &reg_query_args(LXSS, &["/s", "/v", "DistributionName"]),
    ) else {
        return Vec::new();
    };
    parse_wsl_distros(&out)
        .into_iter()
        .map(|distro| wsl_profile(&program, &distro))
        .collect()
}

#[cfg(any(windows, test))]
fn wsl_profile(program: &Path, distro: &str) -> ShellProfile {
    ShellProfile {
        id: format!("wsl:{distro}"),
        name: format!("{distro} (WSL)"),
        program: program.to_path_buf(),
        args: vec!["-d".into(), distro.into()],
        kind: ShellKind::Wsl,
        path_prepend: Vec::new(),
        source: ProfileSource::Discovered,
    }
}

/// Extract distribution names from `reg query ... /s /v DistributionName`.
/// Each match is a line of the form `    DistributionName    REG_SZ    Ubuntu`.
#[cfg(any(windows, test))]
fn parse_wsl_distros(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|line| {
            let rest = line.trim_start().strip_prefix("DistributionName")?;
            if !rest.starts_with(char::is_whitespace) {
                return None;
            }
            parse_reg_sz_tail(rest)
        })
        .collect()
}

/// Argument vector for a `reg query`.
///
/// The `query` subcommand is **mandatory**: `reg <key> /v <name>` prints a
/// usage message and exits 1. The pre-`4e8893ed` Git BASH discoverer this
/// module recovers omitted it, so its registry tier could never have matched --
/// a latent bug masked by the `git --exec-path` and Program Files tiers always
/// resolving first. Built here, and asserted by a test, so it cannot regress
/// back into a silently-dead code path.
#[cfg(any(windows, test))]
fn reg_query_args<'a>(key: &'a str, extra: &[&'a str]) -> Vec<&'a str> {
    let mut args = vec!["query", key];
    args.extend_from_slice(extra);
    args
}

/// Value half of a `reg query` data line, given everything after the value
/// name: `    REG_SZ    C:\Program Files\Git` -> `C:\Program Files\Git`.
/// Splits on the type token rather than on whitespace, because the value may
/// contain spaces.
#[cfg(any(windows, test))]
fn parse_reg_sz_tail(rest: &str) -> Option<String> {
    let value = rest.split("REG_SZ").nth(1)?.trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// Whole-output form of [`parse_reg_sz_tail`]: the first `REG_SZ` value in a
/// `reg query` result.
#[cfg(any(windows, test))]
fn parse_reg_sz_value(output: &str) -> Option<String> {
    output.lines().find_map(parse_reg_sz_tail)
}

// ---------------------------------------------------------------------------
// Process helpers (the impure half, kept thin so the parsers stay testable)
// ---------------------------------------------------------------------------

/// Captured stdout of a successful command, or `None` when it fails to run or
/// exits non-zero.
#[cfg(windows)]
fn command_stdout(program: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new(program)
        .args(args)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Non-empty lines of `where <name>`, as paths.
#[cfg(windows)]
fn where_lines(name: &str) -> Vec<PathBuf> {
    command_stdout("where", &[name])
        .map(|out| {
            out.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(PathBuf::from)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(kind: ShellKind, args: &[&str]) -> ShellProfile {
        ShellProfile {
            id: "t".into(),
            name: "t".into(),
            program: PathBuf::from("prog"),
            args: args.iter().map(|a| a.to_string()).collect(),
            kind,
            path_prepend: Vec::new(),
            source: ProfileSource::Discovered,
        }
    }

    /// The three pre-existing kinds must keep their exact argument conventions;
    /// this is the regression guard for the `platform` refactor.
    #[test]
    fn one_shot_args_match_the_pre_refactor_conventions() {
        assert_eq!(
            profile(ShellKind::PowerShell, &["-NoLogo"])
                .kind
                .one_shot_args(&["-NoLogo".into()], "echo hi"),
            vec!["-NoLogo", "-Command", "echo hi"],
        );
        assert_eq!(
            ShellKind::Cmd.one_shot_args(&[], "echo hi"),
            vec!["/C", "echo hi"],
        );
        // `-lc` is one combined option, NOT `-l` plus `-c`.
        assert_eq!(
            ShellKind::Posix.one_shot_args(&["-l".into()], "echo hi"),
            vec!["-lc", "echo hi"],
        );
    }

    /// A WSL one-shot must run inside the distro, not be parsed by `wsl.exe`.
    #[test]
    fn wsl_one_shot_runs_inside_the_distro() {
        assert_eq!(
            ShellKind::Wsl.one_shot_args(&["-d".into(), "Ubuntu".into()], "echo hi"),
            vec!["-d", "Ubuntu", "--", "sh", "-lc", "echo hi"],
        );
    }

    /// `wsl.exe -l` lists distributions. Classifying WSL as POSIX would hand it
    /// exactly that and spawn a listing instead of a shell.
    #[test]
    fn wsl_interactive_args_are_not_dash_l() {
        let p = wsl_profile(Path::new(r"C:\Windows\System32\wsl.exe"), "Ubuntu");
        assert_eq!(p.args, vec!["-d", "Ubuntu"]);
        assert!(!p.args.contains(&"-l".to_string()));
        assert_eq!(p.kind, ShellKind::Wsl);
        assert_eq!(p.id, "wsl:Ubuntu");
        assert_eq!(p.name, "Ubuntu (WSL)");
    }

    #[test]
    fn wsl_distros_parse_from_reg_query_output() {
        // Verified shape of `reg query <Lxss> /s /v DistributionName`.
        let out = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{c0b96af8-1b99-477c-b758-efffa6fe0334}\r\n    \
             DistributionName    REG_SZ    Ubuntu\r\n\r\nEnd of search: 1 match(es) found.\r\n";
        assert_eq!(parse_wsl_distros(out), vec!["Ubuntu"]);

        // Several distros, including one with a space in the name.
        let multi = "    DistributionName    REG_SZ    Ubuntu\r\n    \
             DistributionName    REG_SZ    Arch Linux\r\n";
        assert_eq!(parse_wsl_distros(multi), vec!["Ubuntu", "Arch Linux"]);

        // No matches -> no distros, not a panic.
        assert!(parse_wsl_distros("End of search: 0 match(es) found.").is_empty());
        // A different value name starting with the same prefix is not a match.
        assert!(parse_wsl_distros("    DistributionNameX    REG_SZ    No\r\n").is_empty());
    }

    /// `reg` without the `query` subcommand exits 1 with a usage message, so an
    /// argv missing it makes the whole registry tier silently dead. The
    /// recovered pre-`4e8893ed` discoverer had exactly that bug; this pins the
    /// fix.
    #[test]
    fn reg_args_always_lead_with_the_query_subcommand() {
        assert_eq!(
            reg_query_args(r"HKLM\SOFTWARE\GitForWindows", &["/v", "InstallPath"]),
            vec!["query", r"HKLM\SOFTWARE\GitForWindows", "/v", "InstallPath"],
        );
        assert_eq!(
            reg_query_args("K", &["/s", "/v", "DistributionName"]),
            vec!["query", "K", "/s", "/v", "DistributionName"],
        );
        // No extras is still a valid query.
        assert_eq!(reg_query_args("K", &[]), vec!["query", "K"]);
    }

    #[test]
    fn reg_sz_value_keeps_spaces_in_the_path() {
        let out = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\GitForWindows\r\n    \
             InstallPath    REG_SZ    C:\\Program Files\\Git\r\n";
        assert_eq!(
            parse_reg_sz_value(out).as_deref(),
            Some(r"C:\Program Files\Git"),
        );
        assert_eq!(parse_reg_sz_value("no value here"), None);
    }

    /// `git --exec-path` reports POSIX separators, and joining onto that
    /// produces a mixed path a picker would display verbatim.
    #[test]
    fn separators_are_normalized_for_display() {
        assert_eq!(
            normalize_separators(Path::new("C:/Program Files/Git/mingw64/libexec/git-core")),
            PathBuf::from(r"C:\Program Files\Git\mingw64\libexec\git-core"),
        );
        // Already-normalized input is left alone (idempotent).
        assert_eq!(
            normalize_separators(Path::new(r"C:\Program Files\Git")),
            PathBuf::from(r"C:\Program Files\Git"),
        );
    }

    /// The load-bearing filter: a bare `bash` on PATH is usually the WSL
    /// launcher, not Git BASH.
    #[test]
    fn wsl_bash_launcher_is_rejected_git_bash_is_not() {
        assert!(is_wsl_bash_launcher(Path::new(
            r"C:\WINDOWS\system32\bash.exe"
        )));
        assert!(is_wsl_bash_launcher(Path::new(
            r"C:\Users\me\AppData\Local\Microsoft\WindowsApps\bash.exe"
        )));
        // Case-insensitive, as Windows paths are.
        assert!(is_wsl_bash_launcher(Path::new(
            r"C:\Windows\System32\BASH.EXE"
        )));
        // The real thing survives.
        assert!(!is_wsl_bash_launcher(Path::new(
            r"C:\Program Files\Git\bin\bash.exe"
        )));
    }

    #[test]
    fn git_bash_from_root_requires_bash_and_collects_path_prepend() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        // No bin\bash.exe yet -> not a Git install.
        assert!(git_bash_from_root(root).is_none());

        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::write(root.join("bin").join("bash.exe"), b"").unwrap();
        std::fs::create_dir_all(root.join("usr").join("bin")).unwrap();
        std::fs::create_dir_all(root.join("mingw64").join("bin")).unwrap();

        let p = git_bash_from_root(root).expect("git bash");
        assert_eq!(p.id, "git-bash");
        assert_eq!(p.kind, ShellKind::Posix);
        assert_eq!(p.args, vec!["-l"]);
        // Only the dirs that exist; mingw32 is absent here.
        assert_eq!(
            p.path_prepend,
            vec![
                root.join("usr").join("bin"),
                root.join("mingw64").join("bin")
            ],
        );
    }

    #[test]
    fn discovery_is_empty_off_windows() {
        // macOS and Linux answer "which shell" with the login shell, so chan
        // proposes nothing there and the built-in `$SHELL` resolution stands.
        // A declared profile is unaffected: see
        // `a_declared_profile_stands_alone_with_nothing_discovered`.
        #[cfg(not(windows))]
        assert!(discover().is_empty());
    }

    #[test]
    fn a_declared_profile_stands_alone_with_nothing_discovered() {
        // The feature still exists off Windows; it is only unseeded. With no
        // discovered profiles to layer over, a declared entry is the whole
        // list rather than being dropped.
        let declared = crate::config::TerminalProfile {
            id: "work".into(),
            name: Some("work".into()),
            program: Some("/bin/zsh".into()),
            args: Some(vec!["-l".into()]),
            kind: None,
            hidden: false,
        };
        let effective = effective_profiles(&[], std::slice::from_ref(&declared));
        assert_eq!(effective.len(), 1);
        assert_eq!(effective[0].id, "work");
        assert_eq!(effective[0].program, PathBuf::from("/bin/zsh"));
    }

    fn discovered(id: &str, name: &str, program: &str, kind: ShellKind) -> ShellProfile {
        ShellProfile {
            id: id.into(),
            name: name.into(),
            program: PathBuf::from(program),
            args: kind.default_interactive_args(),
            kind,
            path_prepend: Vec::new(),
            source: ProfileSource::Discovered,
        }
    }

    fn user(id: &str) -> crate::config::TerminalProfile {
        crate::config::TerminalProfile {
            id: id.into(),
            name: None,
            program: None,
            args: None,
            kind: None,
            hidden: false,
        }
    }

    fn sample() -> Vec<ShellProfile> {
        vec![
            discovered("pwsh", "PowerShell", r"C:\pwsh.exe", ShellKind::PowerShell),
            discovered("cmd", "Command Prompt", r"C:\cmd.exe", ShellKind::Cmd),
        ]
    }

    #[test]
    fn stem_classification_covers_every_kind() {
        assert_eq!(
            ShellKind::from_program_stem(Path::new(r"C:\pwsh.exe")),
            ShellKind::PowerShell,
        );
        assert_eq!(
            ShellKind::from_program_stem(Path::new(
                r"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe"
            )),
            ShellKind::PowerShell,
        );
        assert_eq!(
            ShellKind::from_program_stem(Path::new(r"C:\WINDOWS\system32\cmd.exe")),
            ShellKind::Cmd,
        );
        // The one that must not fall through to Posix.
        assert_eq!(
            ShellKind::from_program_stem(Path::new(r"C:\WINDOWS\System32\wsl.exe")),
            ShellKind::Wsl,
        );
        assert_eq!(
            ShellKind::from_program_stem(Path::new("/usr/bin/zsh")),
            ShellKind::Posix,
        );
        // Unknown stem, and no stem at all.
        assert_eq!(
            ShellKind::from_program_stem(Path::new("/opt/weird")),
            ShellKind::Posix,
        );
        assert_eq!(
            ShellKind::from_program_stem(Path::new("")),
            ShellKind::Posix
        );
        // A bare name, either spelling of separator, and a dotted name whose
        // leading dot is part of it rather than an empty stem. These pin the
        // hand-rolled split against `Path::file_stem`, which answers
        // differently per host for the backslash cases above.
        assert_eq!(
            ShellKind::from_program_stem(Path::new("pwsh.exe")),
            ShellKind::PowerShell,
        );
        assert_eq!(
            ShellKind::from_program_stem(Path::new("wsl")),
            ShellKind::Wsl
        );
        assert_eq!(
            ShellKind::from_program_stem(Path::new("/opt/tools/wsl.exe")),
            ShellKind::Wsl,
        );
        assert_eq!(
            ShellKind::from_program_stem(Path::new("/home/u/.local/bin/bash")),
            ShellKind::Posix,
        );
    }

    #[test]
    fn user_override_renames_and_marks_the_profile_as_users() {
        let mut over = user("pwsh");
        over.name = Some("My Shell".into());
        let out = effective_profiles(&sample(), &[over]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].name, "My Shell");
        assert_eq!(out[0].source, ProfileSource::User);
        // Untouched fields survive.
        assert_eq!(out[0].program, PathBuf::from(r"C:\pwsh.exe"));
        assert_eq!(out[0].args, vec!["-NoLogo"]);
        // The profile it did not name is untouched.
        assert_eq!(out[1].source, ProfileSource::Discovered);
    }

    #[test]
    fn hidden_removes_a_discovered_profile() {
        let mut over = user("cmd");
        over.hidden = true;
        let out = effective_profiles(&sample(), &[over]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "pwsh");
    }

    /// Args replace wholesale: appending could never express "drop -NoLogo".
    #[test]
    fn user_args_replace_rather_than_append() {
        let mut over = user("pwsh");
        over.args = Some(vec!["-NoProfile".into()]);
        let out = effective_profiles(&sample(), &[over]);
        assert_eq!(out[0].args, vec!["-NoProfile"]);
    }

    #[test]
    fn a_new_id_appends_a_profile_and_infers_its_kind() {
        let mut over = user("my-wsl");
        over.program = Some(r"C:\WINDOWS\System32\wsl.exe".into());
        let out = effective_profiles(&sample(), &[over]);
        assert_eq!(out.len(), 3);
        let added = &out[2];
        assert_eq!(added.id, "my-wsl");
        // No name given -> falls back to the id rather than being blank.
        assert_eq!(added.name, "my-wsl");
        // Kind inferred from the stem, and WSL does not get `-l`.
        assert_eq!(added.kind, ShellKind::Wsl);
        assert!(added.args.is_empty());
        assert_eq!(added.source, ProfileSource::User);
    }

    #[test]
    fn a_new_entry_without_a_program_is_dropped() {
        // Nothing to spawn: surfacing it would make a picker entry that fails
        // only once clicked.
        let out = effective_profiles(&sample(), &[user("ghost")]);
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|p| p.id != "ghost"));
    }

    #[test]
    fn hiding_an_unknown_id_is_harmless_and_adds_nothing() {
        let mut over = user("not-installed-right-now");
        over.hidden = true;
        over.program = Some(r"C:\somewhere.exe".into());
        let out = effective_profiles(&sample(), &[over]);
        // Still hidden even though discovery did not find it this boot.
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn default_resolves_by_id_and_tolerates_a_stale_one() {
        let profiles = sample();
        assert_eq!(
            resolve_default(&profiles, Some("cmd")).map(|p| p.id.as_str()),
            Some("cmd"),
        );
        // Unset, blank, and stale all fall back to the built-in default.
        assert!(resolve_default(&profiles, None).is_none());
        assert!(resolve_default(&profiles, Some("  ")).is_none());
        assert!(resolve_default(&profiles, Some("deleted")).is_none());
    }

    #[test]
    fn dedupe_keeps_the_first_of_each_id() {
        let mut a = profile(ShellKind::Posix, &["-l"]);
        a.id = "dup".into();
        a.name = "first".into();
        let mut b = profile(ShellKind::Posix, &["-l"]);
        b.id = "dup".into();
        b.name = "second".into();
        let mut c = profile(ShellKind::Cmd, &[]);
        c.id = "other".into();

        let out = dedupe_by_id(vec![a, b, c]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].name, "first");
        assert_eq!(out[1].id, "other");
    }

    /// Not a correctness assertion -- a hand-runnable inventory of what this
    /// machine actually has. `cargo test -p chan-library shell_profiles --
    /// --ignored --nocapture`.
    #[test]
    #[ignore = "prints host state; run manually with --nocapture"]
    fn print_discovered_profiles() {
        let profiles = shell_profiles();
        println!("discovered {} shell profile(s):", profiles.len());
        for p in profiles {
            println!(
                "  {:<20} {:<22} {} {:?}",
                p.id,
                p.name,
                p.program.display(),
                p.args
            );
            for dir in &p.path_prepend {
                println!("  {:<20} PATH+= {}", "", dir.display());
            }
        }
    }
}
