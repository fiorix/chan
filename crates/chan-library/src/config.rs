//! Terminal-session tuning carried with the registry.
//!
//! `TerminalConfig` is the terminal subsystem's own configuration: the
//! registry (`terminal_sessions`) reads it for idle pruning, the session
//! cap, the replay-ring budget, and the spawn-time TERM / font / MCP-env
//! defaults. `chan-server` embeds it in its on-disk `ServerConfig`, loads
//! and range-clamps it in the settings route, and surfaces it over
//! `/api/config`; the wire shape lives here so the registry and the route
//! layer agree on one definition.

use serde::{Deserialize, Deserializer, Serialize};

use crate::terminal_sessions::shell_profiles::ShellKind;

/// Maximum number of literal suffixes compiled into the terminal secret
/// assignment matcher.
pub const TERMINAL_SECRET_MASK_SUFFIX_MAX: usize = 100;

// Mirrored in web/packages/workspace-app/src/terminal/secretMasking.ts
// (DEFAULT_SECRET_MASK_SUFFIXES), the SPA fallback for servers that predate
// the field; keep in lockstep. This list is authoritative for current servers.
const DEFAULT_TERMINAL_SECRET_MASK_SUFFIXES: &[&str] = &[
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "PASSPHRASE",
    "API_KEY",
    "ACCESS_KEY",
    "SECRET_KEY",
    "PRIVATE_KEY",
    "SSH_KEY",
    "SIGNING_KEY",
    "KEY_BASE64",
    "CREDENTIALS",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalConfig {
    #[serde(default = "default_terminal_idle_timeout_secs")]
    pub idle_timeout_secs: u64,
    #[serde(default = "default_terminal_session_cap")]
    pub session_cap: usize,
    #[serde(default = "default_terminal_ring_bytes")]
    pub ring_bytes: usize,
    /// Per-terminal scrollback budget in MB. Consumed by the SPA at
    /// xterm.js construction time to compute the scrollback line cap;
    /// the server only persists + range-clamps the value. Spawn-time-
    /// only: existing terminals keep their current scrollback until
    /// the session restarts.
    #[serde(default = "default_terminal_scrollback_mb")]
    pub scrollback_mb: u32,
    /// Default TERM value handed to newly-spawned PTYs. The SPA
    /// surfaces a dropdown of common values plus a free-text "Custom"
    /// path for exotic terminfo entries. Spawn-time-only: existing
    /// terminals keep their original TERM until restart.
    #[serde(default = "default_terminal_default_term")]
    pub default_term: String,
    /// User's terminal-font preference.
    /// Default is `os-default`, which leads the SPA's fontFamily chain
    /// with the OS's native mono: SF Mono on macOS, Cascadia on
    /// Windows, and the bundled Source Code Pro on Linux, which has no
    /// single native mono to name. Opt-in `source-code-pro` promotes
    /// Source Code Pro to the head of that chain on every OS.
    #[serde(default)]
    pub font: TerminalFontChoice,
    /// Renderer font size in pixels. The SPA captures this when it constructs
    /// either terminal backend; existing renderers keep their captured size.
    #[serde(default = "default_terminal_font_size")]
    pub font_size: u32,
    /// The non-team default for whether a newly-spawned terminal
    /// gets the chan MCP discovery env vars (`CHAN_MCP_*`). Off by
    /// default for ALL agents (a stray env descriptor makes codex fail
    /// to start; it wants a file-based config). Plain `cs terminal new`
    /// / server-spawned terminals consult this; the per-request
    /// `?mcp_env=on` query still overrides it, and team spawns use the
    /// team config's own `mcp_env` toggle instead.
    #[serde(default)]
    pub mcp_env: bool,
    /// Whether full-screen TUIs may capture the mouse. Consumed by the
    /// SPA at terminal start time; the server only persists the value.
    /// On by default (today's behavior: mouse-reporting programs own
    /// the pointer). When off the SPA strips the mouse-enable escape
    /// sequences so click-drag keeps selecting text over such programs.
    /// Applies to newly opened terminals.
    #[serde(default = "default_terminal_mouse_capture")]
    pub mouse_capture: bool,
    /// Whether newly opened terminals use the ghostty-web backend
    /// (Ghostty's WASM VT parser) instead of xterm.js. Consumed by the
    /// SPA at terminal start time; the server only persists the value.
    /// Applies to newly opened terminals.
    ///
    /// On by default on Linux, off elsewhere. The Linux desktop ships
    /// xterm.js's DOM renderer, which defers box drawing and block elements
    /// to the font and so leaves one unpainted scanline at every cell
    /// boundary: 96.0% rule continuity and 95.2% block coverage against a
    /// 99.5% bar, measured in the desktop's own webview. Ghostty draws those
    /// characters itself and measures 100% on every arm, including with the
    /// dma-buf renderer disabled, which is the one backend that holds on both
    /// sides of that switch. macOS and Windows ship xterm.js's WebGL
    /// renderer, which also measures 100%, so they stay on the
    /// battle-tested path.
    ///
    /// Keyed on the SERVER's platform, which is where the terminals run. A
    /// Linux server reached from a browser on another OS gets the Linux
    /// default even though that client renders xterm.js correctly; the value
    /// is a default, not a lock, and over-applying it costs nothing but
    /// `secret_masking`, which is xterm-only and off by default.
    #[serde(default = "default_terminal_ghostty")]
    pub ghostty: bool,
    /// Whether xterm.js terminals visually obscure the values of
    /// secret-looking `NAME=value` assignments. The buffer remains
    /// cleartext so selection, copy, replay, and snapshots are unchanged.
    /// Ghostty terminals do not support xterm decorations and ignore this.
    #[serde(default = "default_terminal_secret_masking")]
    pub secret_masking: bool,
    /// Literal, case-insensitive variable-name suffixes that trigger visual
    /// secret masking. Deserialization drops entries outside `[A-Za-z0-9_]+`
    /// with a warning rather than failing the whole config load, dedupes
    /// repeats, and caps the list before the SPA compiles it into its
    /// matcher.
    #[serde(
        default = "default_terminal_secret_mask_suffixes",
        deserialize_with = "deserialize_terminal_secret_mask_suffixes"
    )]
    pub secret_mask_suffixes: Vec<String>,
    /// User-declared terminal profiles, layered over the shells discovered on
    /// the machine (`terminal_sessions::shell_profiles`). An entry whose `id`
    /// matches a discovered profile overrides its fields or hides it; an entry
    /// with a new `id` declares an additional shell.
    ///
    /// Empty by default, and serialized away when empty, so a machine that has
    /// never customized a profile has no `[[terminal.profiles]]` in its
    /// `server.toml` at all. Deserialization drops malformed entries with a
    /// warning rather than failing the load, dedupes by `id`, and caps the
    /// list.
    #[serde(
        default,
        skip_serializing_if = "Vec::is_empty",
        deserialize_with = "deserialize_terminal_profiles"
    )]
    pub profiles: Vec<TerminalProfile>,
    /// Id of the profile new terminals spawn with. `None` keeps the built-in
    /// resolution (`CHAN_SHELL` -> pwsh -> powershell -> cmd on Windows,
    /// `$SHELL` on unix). An id that matches nothing is ignored with a warning
    /// at merge time, so a profile deleted from the list cannot strand the
    /// terminal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_profile: Option<String>,
}

/// A user-declared terminal profile.
///
/// Every field except `id` is optional because the common case is a small
/// override of something already discovered -- renaming "Ubuntu (WSL)", or
/// hiding a shell you never use. A wholly new profile supplies `program` (and
/// usually `kind`); one that supplies neither and matches no discovered id is
/// dropped at merge time, since there would be nothing to spawn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalProfile {
    /// Stable key. Matches a discovered profile's id to override it, or names a
    /// new one.
    pub id: String,
    /// Display name override.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Executable to spawn. Required for a profile that matches no discovered
    /// id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub program: Option<String>,
    /// Interactive arguments. Replaces the discovered vector wholesale rather
    /// than appending -- appending cannot express "drop `-NoLogo`".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    /// Argument convention. Defaults to the discovered profile's kind when
    /// overriding, or is inferred from the program stem for a new one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<ShellKind>,
    /// Hide a discovered profile without deleting its entry, so the hiding
    /// survives the generator rediscovering it on the next boot.
    #[serde(default)]
    pub hidden: bool,
}

/// Terminal-font preference. Wire shape kept narrow (string enum)
/// so a future polish task could add a "Custom..." path without
/// breaking existing config files.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalFontChoice {
    /// Per-OS native mono. The default.
    #[default]
    OsDefault,
    /// Source Code Pro Regular, shipped as a hashed asset inside the
    /// SPA bundle, so it is always available with nothing to fetch.
    SourceCodePro,
}

impl Default for TerminalConfig {
    fn default() -> Self {
        Self {
            idle_timeout_secs: default_terminal_idle_timeout_secs(),
            session_cap: default_terminal_session_cap(),
            ring_bytes: default_terminal_ring_bytes(),
            scrollback_mb: default_terminal_scrollback_mb(),
            default_term: default_terminal_default_term(),
            font: TerminalFontChoice::default(),
            font_size: default_terminal_font_size(),
            mcp_env: false,
            mouse_capture: default_terminal_mouse_capture(),
            ghostty: default_terminal_ghostty(),
            secret_masking: default_terminal_secret_masking(),
            secret_mask_suffixes: default_terminal_secret_mask_suffixes(),
            profiles: Vec::new(),
            default_profile: None,
        }
    }
}

fn default_terminal_idle_timeout_secs() -> u64 {
    30 * 60
}

fn default_terminal_session_cap() -> usize {
    32
}

fn default_terminal_ring_bytes() -> usize {
    2 << 20
}

fn default_terminal_scrollback_mb() -> u32 {
    10
}

fn default_terminal_default_term() -> String {
    "xterm-256color".into()
}

fn default_terminal_font_size() -> u32 {
    14
}

fn default_terminal_mouse_capture() -> bool {
    true
}

fn default_terminal_ghostty() -> bool {
    cfg!(target_os = "linux")
}

fn default_terminal_secret_masking() -> bool {
    false
}

fn default_terminal_secret_mask_suffixes() -> Vec<String> {
    DEFAULT_TERMINAL_SECRET_MASK_SUFFIXES
        .iter()
        .map(|suffix| (*suffix).to_string())
        .collect()
}

fn deserialize_terminal_secret_mask_suffixes<'de, D>(
    deserializer: D,
) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let suffixes = Vec::<String>::deserialize(deserializer)?;
    Ok(normalize_terminal_secret_mask_suffixes(
        suffixes,
        |entries| {
            tracing::warn!(
                entries,
                limit = TERMINAL_SECRET_MASK_SUFFIX_MAX,
                "terminal.secret_mask_suffixes exceeds its limit; ignoring trailing entries"
            );
        },
    ))
}

fn normalize_terminal_secret_mask_suffixes(
    suffixes: Vec<String>,
    warn: impl FnOnce(usize),
) -> Vec<String> {
    // Invalid entries are dropped with a warning, not rejected: an Err here
    // fails the whole ServerConfig load, the server then runs on defaults in
    // memory, and the next /api/config PATCH writes those defaults over
    // every other setting in the user's server.toml. Duplicates are dropped
    // because the Settings pane keys its chip list on the suffix string.
    let (mut valid, invalid): (Vec<String>, Vec<String>) =
        suffixes.into_iter().partition(|suffix| {
            !suffix.is_empty()
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        });
    if !invalid.is_empty() {
        tracing::warn!(
            entries = ?invalid,
            "terminal.secret_mask_suffixes: dropping entries outside [A-Za-z0-9_]+"
        );
    }
    let mut seen = std::collections::HashSet::new();
    valid.retain(|suffix| seen.insert(suffix.clone()));
    if valid.len() > TERMINAL_SECRET_MASK_SUFFIX_MAX {
        warn(valid.len());
        valid.truncate(TERMINAL_SECRET_MASK_SUFFIX_MAX);
    }
    valid
}

/// Cap on `terminal.profiles`. Generous relative to how many shells a machine
/// actually has; it exists so a corrupt or generated file cannot make the
/// picker unusable, not to constrain real use.
pub const TERMINAL_PROFILE_MAX: usize = 50;

/// One entry, or anything at all. A `TerminalProfile` is the only shape with
/// required fields and a closed enum in this table, so it is the only one that
/// can fail to DESERIALIZE rather than merely normalize: a missing `id`, an
/// `args` written as a string, or a `kind` naming a convention that does not
/// exist. Buffering each entry through this untagged pair keeps that failure
/// local to the entry, which is what the posture below promises.
#[derive(Deserialize)]
#[serde(untagged)]
enum MaybeTerminalProfile {
    Valid(TerminalProfile),
    Malformed(serde::de::IgnoredAny),
}

fn deserialize_terminal_profiles<'de, D>(deserializer: D) -> Result<Vec<TerminalProfile>, D::Error>
where
    D: Deserializer<'de>,
{
    let entries = Vec::<MaybeTerminalProfile>::deserialize(deserializer)?;
    let read = entries.len();
    let profiles: Vec<TerminalProfile> = entries
        .into_iter()
        .filter_map(|entry| match entry {
            MaybeTerminalProfile::Valid(profile) => Some(profile),
            MaybeTerminalProfile::Malformed(_) => None,
        })
        .collect();
    if profiles.len() < read {
        tracing::warn!(
            entries = read - profiles.len(),
            "terminal.profiles: dropping entries that do not parse"
        );
    }
    Ok(normalize_terminal_profiles(profiles, |entries| {
        tracing::warn!(
            entries,
            limit = TERMINAL_PROFILE_MAX,
            "terminal.profiles exceeds its limit; ignoring trailing entries"
        );
    }))
}

/// Drop unusable entries, dedupe by id, and cap the list.
///
/// Same posture as [`normalize_terminal_secret_mask_suffixes`] and for the same
/// reason: an `Err` here fails the whole `ServerConfig` load, the server then
/// runs on in-memory defaults, and the next `/api/config` PATCH writes those
/// defaults over every other setting in the user's `server.toml`. A malformed
/// profile costs the user that profile, never the rest of their config.
///
/// Only `id` is validated here. Whether a profile is *spawnable* depends on
/// what discovery found, which this layer cannot see -- that check belongs to
/// the merge.
fn normalize_terminal_profiles(
    profiles: Vec<TerminalProfile>,
    warn: impl FnOnce(usize),
) -> Vec<TerminalProfile> {
    let (mut valid, invalid): (Vec<TerminalProfile>, Vec<TerminalProfile>) = profiles
        .into_iter()
        // Trim first so the stored id is exactly what every later lookup keys
        // on -- the merge, the default resolution, and the SPA all compare it
        // literally, and a stray space would make `"pwsh "` a silently
        // different profile from `"pwsh"`.
        .map(|mut profile| {
            profile.id = profile.id.trim().to_string();
            profile
        })
        .partition(|profile| !profile.id.is_empty());
    if !invalid.is_empty() {
        tracing::warn!(
            entries = invalid.len(),
            "terminal.profiles: dropping entries with an empty id"
        );
    }
    // First wins, matching the file's own reading order.
    let mut seen = std::collections::HashSet::new();
    valid.retain(|profile| seen.insert(profile.id.clone()));
    if valid.len() > TERMINAL_PROFILE_MAX {
        warn(valid.len());
        valid.truncate(TERMINAL_PROFILE_MAX);
    }
    valid
}

/// Inclusive bounds the Settings UI exposes for the scrollback slider.
/// Mirrored in `web/packages/workspace-app/src/terminal/scrollback.ts`; keep in lockstep.
pub const TERMINAL_SCROLLBACK_MB_MIN: u32 = 10;
pub const TERMINAL_SCROLLBACK_MB_MAX: u32 = 50;

/// Inclusive terminal renderer font-size bounds mirrored by Settings.
pub const TERMINAL_FONT_SIZE_MIN: u32 = 8;
pub const TERMINAL_FONT_SIZE_MAX: u32 = 32;

#[cfg(test)]
mod profile_tests {
    use super::*;

    fn entry(id: &str) -> TerminalProfile {
        TerminalProfile {
            id: id.into(),
            name: None,
            program: None,
            args: None,
            kind: None,
            hidden: false,
        }
    }

    /// An older server has no `profiles` key at all, and a machine that never
    /// customized one must not grow an empty array in its file.
    #[test]
    fn profiles_default_empty_and_serialize_away() {
        let config: TerminalConfig = serde_json::from_str("{}").expect("defaults");
        assert!(config.profiles.is_empty());
        assert_eq!(config.default_profile, None);

        let json = serde_json::to_value(&config).expect("serialize");
        assert!(json.get("profiles").is_none());
        assert!(json.get("default_profile").is_none());
    }

    /// Malformed entries cost the user that profile, never the rest of the
    /// config -- an Err here would fail the whole ServerConfig load and the
    /// next PATCH would write defaults over everything else.
    #[test]
    fn normalize_drops_blank_ids_trims_and_dedupes() {
        let out = normalize_terminal_profiles(
            vec![
                entry("  pwsh  "),
                entry(""),
                entry("   "),
                entry("pwsh"),
                entry("cmd"),
            ],
            |_| panic!("cap warning not expected"),
        );
        let ids: Vec<&str> = out.iter().map(|p| p.id.as_str()).collect();
        // Trimmed, blank-dropped, first-wins on the duplicate.
        assert_eq!(ids, vec!["pwsh", "cmd"]);
    }

    #[test]
    fn normalize_caps_the_list_and_warns_once() {
        let many: Vec<TerminalProfile> = (0..TERMINAL_PROFILE_MAX + 5)
            .map(|i| entry(&format!("p{i}")))
            .collect();
        let seen = std::cell::Cell::new(0usize);
        let out = normalize_terminal_profiles(many, |n| seen.set(n));
        assert_eq!(out.len(), TERMINAL_PROFILE_MAX);
        assert_eq!(seen.get(), TERMINAL_PROFILE_MAX + 5);
    }

    /// The normalizer runs on the deserialize path, not just when called
    /// directly, so a hand-edited server.toml is cleaned on load.
    #[test]
    fn deserialization_applies_the_normalizer() {
        let toml = r#"
            [[profiles]]
            id = "  git-bash  "
            name = "Git BASH"

            [[profiles]]
            id = ""

            [[profiles]]
            id = "git-bash"
            name = "duplicate, ignored"
        "#;
        let config: TerminalConfig = toml::from_str(toml).expect("load");
        assert_eq!(config.profiles.len(), 1);
        assert_eq!(config.profiles[0].id, "git-bash");
        assert_eq!(config.profiles[0].name.as_deref(), Some("Git BASH"));
    }

    #[test]
    fn a_malformed_entry_costs_that_entry_and_not_the_file() {
        // Each of the three ways an entry can fail to PARSE rather than
        // normalize, alongside a good one. Before these were buffered per
        // entry, any one of them failed the whole `ServerConfig` load, the
        // server ran on in-memory defaults, and the next settings write
        // persisted those defaults over the rest of the user's server.toml.
        let toml = r#"
            scrollback_mb = 42

            [[profiles]]
            id = "keeper"
            name = "Keeper"

            [[profiles]]
            name = "no id at all"

            [[profiles]]
            id = "args-as-a-string"
            args = "-l"

            [[profiles]]
            id = "unknown-kind"
            kind = "fish"
        "#;
        let config: TerminalConfig =
            toml::from_str(toml).expect("a bad entry never fails the load");
        assert_eq!(
            config.profiles.len(),
            1,
            "only the parseable entry survives: {:?}",
            config.profiles
        );
        assert_eq!(config.profiles[0].id, "keeper");
        assert_eq!(
            config.scrollback_mb, 42,
            "every other setting in the file is untouched"
        );
    }

    #[test]
    fn a_full_profile_round_trips_through_toml() {
        let toml = r#"
            default_profile = "git-bash"

            [[profiles]]
            id = "git-bash"
            name = "Git Bash"
            program = "C:\\Program Files\\Git\\bin\\bash.exe"
            args = ["-l"]
            kind = "posix"

            [[profiles]]
            id = "cmd"
            hidden = true
        "#;
        let config: TerminalConfig = toml::from_str(toml).expect("load");
        assert_eq!(config.default_profile.as_deref(), Some("git-bash"));
        assert_eq!(config.profiles[0].kind, Some(ShellKind::Posix));
        assert_eq!(
            config.profiles[0].args.as_deref(),
            Some(&["-l".to_string()][..])
        );
        assert!(config.profiles[1].hidden);
        assert!(!config.profiles[0].hidden);

        // Lowercase on the wire, so every kind is spellable by hand.
        for (spelling, expected) in [
            ("powershell", ShellKind::PowerShell),
            ("cmd", ShellKind::Cmd),
            ("posix", ShellKind::Posix),
            ("wsl", ShellKind::Wsl),
        ] {
            let parsed: TerminalProfile =
                toml::from_str(&format!("id = \"w\"\nkind = \"{spelling}\"\n"))
                    .unwrap_or_else(|e| panic!("kind {spelling} should parse: {e}"));
            assert_eq!(parsed.kind, Some(expected));
            // And round-trips back to the same spelling.
            assert_eq!(
                serde_json::to_value(expected).unwrap(),
                serde_json::Value::String(spelling.to_string()),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::Cell;

    #[test]
    fn secret_masking_defaults_off_and_preserves_explicit_true() {
        let config = TerminalConfig::default();
        assert!(!config.secret_masking);
        assert_eq!(
            config.secret_mask_suffixes,
            DEFAULT_TERMINAL_SECRET_MASK_SUFFIXES
        );

        let missing: TerminalConfig = serde_json::from_value(json!({})).unwrap();
        assert!(!missing.secret_masking);

        let configured: TerminalConfig = serde_json::from_value(json!({
            "secret_masking": true
        }))
        .unwrap();
        assert!(configured.secret_masking);
    }

    #[test]
    fn font_size_defaults_to_fourteen_and_round_trips() {
        let default = TerminalConfig::default();
        assert_eq!(default.font_size, 14);

        let missing: TerminalConfig = serde_json::from_value(json!({})).unwrap();
        assert_eq!(missing.font_size, 14);

        let configured: TerminalConfig = serde_json::from_value(json!({
            "font_size": 20
        }))
        .unwrap();
        assert_eq!(configured.font_size, 20);
        assert_eq!(
            serde_json::to_value(configured).unwrap()["font_size"],
            json!(20)
        );
    }

    #[test]
    fn secret_mask_suffixes_drop_invalid_entries_and_keep_the_rest() {
        // A bad entry must not fail deserialization: an Err here fails the
        // whole ServerConfig load, the server runs on defaults in memory,
        // and the next /api/config PATCH persists those defaults over every
        // other setting in the file.
        let config: TerminalConfig = serde_json::from_value(json!({
            "idle_timeout_secs": 5,
            "secret_mask_suffixes": ["TOKEN", "SECRET.*", "API-KEY", ""]
        }))
        .expect("one bad suffix entry must not fail deserialization");
        assert_eq!(config.idle_timeout_secs, 5);
        assert_eq!(config.secret_mask_suffixes, vec!["TOKEN".to_string()]);
    }

    #[test]
    fn secret_mask_suffixes_dedupe_repeated_entries() {
        // The Settings pane keys its chip list on the suffix string, so a
        // repeated entry would throw a duplicate-key render error there.
        let config: TerminalConfig = serde_json::from_value(json!({
            "secret_mask_suffixes": ["TOKEN", "SECRET", "TOKEN"]
        }))
        .expect("deserialize");
        assert_eq!(
            config.secret_mask_suffixes,
            vec!["TOKEN".to_string(), "SECRET".to_string()]
        );
    }

    #[test]
    fn the_terminal_backend_default_follows_the_platform() {
        // Linux ships xterm.js's DOM renderer, which cannot draw box drawing
        // or block elements to the cell edge; ghostty is the backend that
        // measures 100% there. Everywhere else xterm.js gets its WebGL
        // renderer and stays the default.
        assert_eq!(TerminalConfig::default().ghostty, cfg!(target_os = "linux"));
    }

    #[test]
    fn an_absent_backend_field_takes_the_platform_default() {
        // The field is `#[serde(default = ...)]`, not bare `#[serde(default)]`:
        // a bare one resolves to `bool::default()` and would silently pin
        // every existing config file to xterm.js whatever the platform.
        let config: TerminalConfig = serde_json::from_value(json!({})).expect("deserialize");
        assert_eq!(config.ghostty, cfg!(target_os = "linux"));
    }

    #[test]
    fn an_explicit_backend_choice_survives_the_default() {
        let config: TerminalConfig =
            serde_json::from_value(json!({ "ghostty": false })).expect("deserialize");
        assert!(!config.ghostty);
    }

    #[test]
    fn secret_mask_suffixes_clamp_and_warn_once() {
        let suffixes = (0..=TERMINAL_SECRET_MASK_SUFFIX_MAX)
            .map(|index| format!("TOKEN_{index}"))
            .collect::<Vec<_>>();
        let warning_count = Cell::new(0);
        let suffixes = normalize_terminal_secret_mask_suffixes(suffixes, |_| {
            warning_count.set(warning_count.get() + 1);
        });
        assert_eq!(suffixes.len(), TERMINAL_SECRET_MASK_SUFFIX_MAX);
        assert_eq!(suffixes.last().unwrap(), "TOKEN_99");
        assert_eq!(warning_count.get(), 1);
    }
}
