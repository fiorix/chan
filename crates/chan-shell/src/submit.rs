//! The per-agent submit-encoding map plus the command -> agent derivation.
//! A coding agent running inside a chan terminal submits its compose buffer
//! on a different byte sequence depending on which agent it is, so a
//! hands-free completion poke (`cs terminal write --submit=<agent>`) has to
//! append the right one.
//!
//! Two things live here, both shared by the `cs` CLI and chan-server:
//!
//!   - `SubmitAgent::derive`: map a spawn command (+ an optional `CHAN_AGENT`
//!     env override) to the agent whose submit encoding it uses. This is the
//!     single source of truth for "which agent is this", mirrored in
//!     `web/packages/workspace-app/src/state/teamDialog.svelte.ts` (`agentForMember`).
//!   - `apply_submit_chord`: turn a poke into the PTY bytes that submit it.
//!     Each agent has a `{}`-templated chord whose DEFAULT reproduces the
//!     live-probed bytes, but which is overridable at runtime (env var or
//!     `<config>/chan/submit.toml`) so a client changing its submit behavior
//!     does not need a rebuild. See `apply_submit_chord` / `set_chord_overrides`.
//!
//! Rich Prompt sends the agent NAME and the server applies the chord. The SPA's
//! `submitMode.ts` mirrors only the agent union and identity fallback; submit
//! bytes stay server-owned.

use std::collections::HashMap;
use std::sync::RwLock;

#[cfg(feature = "client")]
use clap::ValueEnum;
use serde::{Deserialize, Serialize};

/// A coding agent whose terminal submit encoding chan knows. Selected by
/// `cs terminal write --submit=<agent>`; absent means write pure bytes
/// (no chord), which is the historical default and stays the default.
///
/// The `ValueEnum` parse impl (for the client's `--submit` flag) is
/// `client`-gated so chan-server can read the chord map without linking
/// clap; the chord bytes themselves are clap-free.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "client", derive(ValueEnum))]
#[cfg_attr(feature = "client", value(rename_all = "lower"))]
pub enum SubmitAgent {
    // Submits on the xterm modifyOtherKeys CSI for Cmd+Enter
    // (`\x1b[27;9;13~`), live-probed 2026-05-20.
    /// Claude Code: the Cmd+Enter modifyOtherKeys CSI
    Claude,
    // Reads a plain CR as Enter, but ONLY as a distinct keypress: codex
    // coalesces a single `text + CR` write into a paste burst and treats the
    // trailing CR as a literal newline, so a bare-CR suffix never submits. The
    // default template wraps codex's text in bracketed paste so the trailing CR
    // lands as a real Enter. It ignores both the Claude chord and the kitty
    // CSI-u Enter (`\x1b[13u`) silently. Live-probed 2026-06-02 against
    // codex-cli 0.136.0.
    /// OpenAI codex: bracketed paste, then CR
    Codex,
    // Submits on a CR, but ONLY when the CR arrives as a DISTINCT write.
    // Gemini 0.51 converts a closely following Return into Shift+Return,
    // including after bracketed paste. A 2026-07-20 live sweep on Gemini 0.51
    // found no fixed sub-idle gap safe for 64 KiB input, so the terminal queue
    // keeps the body and chord as separately idle-gated entries.
    /// Google gemini: a CR in its own separate write
    Gemini,
    // Kimi treats a plain CR as an editor newline. Bracketed paste followed
    // by CR submits the compose buffer, including multiline input. Keep this
    // template distinct from codex even though their bytes are identical, so
    // either client can change independently. Live-probed 2026-08-02 against
    // Kimi Code 0.31.0.
    /// Kimi Code: bracketed paste, then CR
    Kimi,
    // Its TUI accepts bracketed paste followed by CR in the same PTY write.
    // The bracketed form is the default because it is proven for multiline,
    // paste-sized input, and chronological notification batches. Live-probed
    // 2026-07-20 against OpenCode 1.18.3.
    /// OpenCode: bracketed paste and CR in one write
    OpenCode,
}

/// Where a resolved submit template came from. Only built-in templates whose
/// multi-message behavior has been live-probed are eligible for batching.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubmitTemplateSource {
    BuiltIn,
    Override,
}

/// The submit metadata carried with logical terminal input until drain time.
/// Resolved where the chord authority lives, in the server: from the derived
/// per-session agent at enqueue (`cs terminal write`) or from the SPA-sent
/// agent name (Rich Prompt), against the server's own env and config.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedSubmit {
    pub agent: SubmitAgent,
    pub template: String,
    pub source: SubmitTemplateSource,
}

impl ResolvedSubmit {
    /// Resolve the effective template using the normal env > config > built-in
    /// precedence and retain whether the winning value is safe to batch.
    pub fn resolve(agent: SubmitAgent) -> Self {
        let guard = CHORD_OVERRIDES.read().expect("CHORD_OVERRIDES poisoned");
        let (template, source) =
            resolve_template_with_source(agent, |key| std::env::var(key).ok(), guard.as_ref());
        Self {
            agent,
            template,
            source,
        }
    }

    /// Whether this resolved shape is proven for chronological notification
    /// batching. Gemini remains a singleton boundary.
    pub fn is_batchable(&self) -> bool {
        self.source == SubmitTemplateSource::BuiltIn
            && matches!(
                self.agent,
                SubmitAgent::Claude
                    | SubmitAgent::Codex
                    | SubmitAgent::Kimi
                    | SubmitAgent::OpenCode
            )
    }
}

/// An atomic ordered plan for terminal input. Parts must be written and
/// flushed in order without another controller command interleaving.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtyInputPlan {
    pub parts: Vec<Vec<u8>>,
}

impl SubmitAgent {
    /// Resolve an agent NAME ("claude" | "codex" | "gemini" | "kimi" |
    /// "opencode") to its variant without clap's `ValueEnum::from_str` (so a
    /// caller that only has the string does not have to pull clap in). Returns
    /// `None` for an unknown name.
    pub fn from_agent_name(name: &str) -> Option<Self> {
        match name {
            "claude" => Some(SubmitAgent::Claude),
            "codex" => Some(SubmitAgent::Codex),
            "gemini" => Some(SubmitAgent::Gemini),
            "kimi" => Some(SubmitAgent::Kimi),
            "opencode" => Some(SubmitAgent::OpenCode),
            _ => None,
        }
    }

    /// The agent's lower-case name, the inverse of `from_agent_name`.
    pub fn name(self) -> &'static str {
        match self {
            SubmitAgent::Claude => "claude",
            SubmitAgent::Codex => "codex",
            SubmitAgent::Gemini => "gemini",
            SubmitAgent::Kimi => "kimi",
            SubmitAgent::OpenCode => "opencode",
        }
    }

    /// Derive the submit agent from a spawn command and an optional
    /// `CHAN_AGENT` override value. The single source of truth for the
    /// command -> agent mapping, mirrored in `agentForMember`
    /// (teamDialog.svelte.ts).
    ///
    /// `CHAN_AGENT` wins when it names a known agent ("claude"/"codex"/
    /// "gemini"/"kimi"/"opencode") or an explicit shell ("none"/"shell" ->
    /// `None`); an unrecognized value falls through to the command sniff (the
    /// escape hatch is opt-in, a typo should not silently disable submit). The
    /// command match is a LOOSE whole-word sniff:
    /// claude/codex/gemini/kimi/opencode recognized anywhere in the command as
    /// a word, so wrappers like
    /// `my-claude.sh`, `/usr/local/bin/codex-cli`, or `claude --resume` still
    /// resolve, while `claudette` does not. `None` means a shell member with
    /// no submit chord.
    pub fn derive(command: &str, chan_agent: Option<&str>) -> Option<SubmitAgent> {
        if let Some(raw) = chan_agent {
            match raw.trim().to_ascii_lowercase().as_str() {
                "claude" => return Some(SubmitAgent::Claude),
                "codex" => return Some(SubmitAgent::Codex),
                "gemini" => return Some(SubmitAgent::Gemini),
                "kimi" => return Some(SubmitAgent::Kimi),
                "opencode" => return Some(SubmitAgent::OpenCode),
                "none" | "shell" => return None,
                // Unrecognized CHAN_AGENT: ignore it, sniff the command.
                _ => {}
            }
        }
        let c = command.to_ascii_lowercase();
        if word_match(&c, "claude") {
            Some(SubmitAgent::Claude)
        } else if word_match(&c, "codex") {
            Some(SubmitAgent::Codex)
        } else if word_match(&c, "gemini") {
            Some(SubmitAgent::Gemini)
        } else if word_match(&c, "kimi") {
            Some(SubmitAgent::Kimi)
        } else if word_match(&c, "opencode") {
            Some(SubmitAgent::OpenCode)
        } else {
            None
        }
    }

    /// The built-in submit template for this agent: a string with a single
    /// `{}` placeholder for the normalized submit body. These ARE
    /// the live-probed default bytes; an override (env / config file) replaces
    /// the whole template. claude appends the modifyOtherKeys Cmd+Enter CSI;
    /// gemini a bare CR; codex, kimi, and opencode wrap the text in bracketed
    /// paste then CR. Codex needs the wrap to keep its paste-burst coalescing
    /// from eating the submit; kimi and opencode each keep their own measured
    /// template even where the current bytes agree.
    fn default_template(self) -> &'static str {
        match self {
            SubmitAgent::Claude => "{}\x1b[27;9;13~",
            SubmitAgent::Codex => "\x1b[200~{}\x1b[201~\r",
            SubmitAgent::Gemini => "{}\r",
            SubmitAgent::Kimi => "\x1b[200~{}\x1b[201~\r",
            SubmitAgent::OpenCode => "\x1b[200~{}\x1b[201~\r",
        }
    }

    /// Resolve this agent's submit template, applying overrides in priority
    /// order: env `CHAN_SUBMIT_<AGENT>` > the process-global override map
    /// (loaded from `<config>/chan/submit.toml` by the server) > the built-in
    /// default. Override strings are unescaped (`\e`, `\xHH`, `\r`, `\n`,
    /// `\t`, `\\`) so a config/env value can carry control bytes as text.
    fn template(self) -> String {
        ResolvedSubmit::resolve(self).template
    }
}

/// Process-global per-agent chord template overrides, keyed by agent name
/// ("claude"/"codex"/"gemini"/"kimi"/"opencode"). The server loads these
/// from `<config>/chan/submit.toml` once at startup via `set_chord_overrides`;
/// env `CHAN_SUBMIT_<AGENT>` still takes precedence at apply time. Default
/// `None` means "no file overrides", which every chan-shell-only caller
/// (the `cs` CLI) sees, so it falls back to env + built-in.
static CHORD_OVERRIDES: RwLock<Option<HashMap<String, String>>> = RwLock::new(None);

/// Install the config-file chord template overrides (agent name -> template
/// string, escapes intact). Called once by the server at startup; a later
/// call replaces the map. Env vars still win over these at apply time.
pub fn set_chord_overrides(overrides: HashMap<String, String>) {
    *CHORD_OVERRIDES.write().expect("CHORD_OVERRIDES poisoned") = Some(overrides);
}

/// Pure resolution of an agent's template from an env lookup + an optional
/// override map, so the precedence logic is testable without touching the
/// process env or the global. env `CHAN_SUBMIT_<AGENT>` > override map >
/// built-in default; an empty/whitespace override value is ignored (falls
/// through), so a blank env var does not blank the chord.
#[cfg(test)]
fn resolve_template(
    agent: SubmitAgent,
    env: impl Fn(&str) -> Option<String>,
    overrides: Option<&HashMap<String, String>>,
) -> String {
    resolve_template_with_source(agent, env, overrides).0
}

fn resolve_template_with_source(
    agent: SubmitAgent,
    env: impl Fn(&str) -> Option<String>,
    overrides: Option<&HashMap<String, String>>,
) -> (String, SubmitTemplateSource) {
    let name = agent.name();
    if let Some(v) = env(&format!("CHAN_SUBMIT_{}", name.to_ascii_uppercase())) {
        if !v.trim().is_empty() {
            return (unescape(&v), SubmitTemplateSource::Override);
        }
    }
    if let Some(v) = overrides.and_then(|m| m.get(name)) {
        if !v.trim().is_empty() {
            return (unescape(v), SubmitTemplateSource::Override);
        }
    }
    (
        agent.default_template().to_string(),
        SubmitTemplateSource::BuiltIn,
    )
}

fn apply_template(text: &str, template: &str) -> String {
    if template.contains("{}") {
        template.replacen("{}", text, 1)
    } else {
        format!("{text}{template}")
    }
}

fn template_without_text(template: &str) -> String {
    if template.contains("{}") {
        template.replacen("{}", "", 1)
    } else {
        template.to_string()
    }
}

/// Normalize one submitted body: trim every trailing newline, then append
/// exactly one newline. An empty body stays empty so a chord-only poke remains
/// chord-only.
fn submitted_body(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let trimmed = text.trim_end_matches('\n');
    let mut body = String::with_capacity(trimmed.len() + 1);
    body.push_str(trimmed);
    body.push('\n');
    body
}

/// The normalized body bytes a submitted message delivers ahead of its chord.
pub fn submitted_body_bytes(text: &str) -> Vec<u8> {
    submitted_body(text).into_bytes()
}

/// The resolved submit chord alone, the template with its text placeholder
/// removed. This is what an agent that rejects a coalesced text+chord write
/// receives as its own PTY write.
pub fn submit_chord_bytes(submit: &ResolvedSubmit) -> Vec<u8> {
    template_without_text(&submit.template).into_bytes()
}

/// Whether `text` submitted under `submit` needs its chord delivered as a
/// SEPARATE PTY write. Gemini 0.51 converts a Return received too soon after
/// inserted text into Shift+Return, including text delivered as bracketed
/// paste, so a Gemini body and its bare CR never share a write. A message
/// missing either half has nothing to split. Cheap enough for the enqueue
/// path: it never renders the template around the payload.
pub fn splits_submit_chord(text: &str, submit: &ResolvedSubmit) -> bool {
    submit.agent == SubmitAgent::Gemini && !text.is_empty() && !chord_is_empty(&submit.template)
}

/// Whether a template's chord half (everything outside `{}`) is empty, the
/// allocation-free form of `template_without_text(t).is_empty()`.
fn chord_is_empty(template: &str) -> bool {
    template == "{}" || template.is_empty()
}

/// Build the ordered PTY input for one logical message, encoding only after
/// an optional batch body has been formed. A plan always has at least one
/// part; two parts mean the chord must land as its own write, which happens
/// for Gemini and for the proven batched Claude built-in.
pub fn plan_submitted_input(
    text: String,
    submit: Option<&ResolvedSubmit>,
    batched: bool,
) -> PtyInputPlan {
    let Some(submit) = submit else {
        return PtyInputPlan {
            parts: vec![text.into_bytes()],
        };
    };

    let claude_batch = submit.agent == SubmitAgent::Claude
        && batched
        && submit.source == SubmitTemplateSource::BuiltIn;
    let parts = if claude_batch || splits_submit_chord(&text, submit) {
        vec![submitted_body_bytes(&text), submit_chord_bytes(submit)]
    } else {
        vec![apply_template(&submitted_body(&text), &submit.template).into_bytes()]
    };

    PtyInputPlan { parts }
}

/// `cs terminal write --submit=<agent>`: encode `data` into the PTY bytes
/// that make a running agent submit it hands-free (the completion poke).
/// `None` writes the bytes verbatim. A non-empty submitted body is normalized
/// to exactly one trailing newline before the chord; an empty body stays
/// chord-only.
///
/// The agent's resolved template (default or overridden) drives the bytes. A
/// template with a `{}` placeholder substitutes the text there (the codex and
/// opencode bracketed-paste wraps are expressed this way); a template WITHOUT
/// `{}` is treated as a pure suffix appended after the text, so a bare-chord override
/// like `CHAN_SUBMIT_GEMINI=$'\r'` still works.
///
/// Defaults mirror the live-probed bytes. The SPA sends only the agent name;
/// the server applies this encoding.
pub fn apply_submit_chord(data: String, submit: Option<SubmitAgent>) -> String {
    let Some(agent) = submit else {
        return data;
    };
    apply_template(&submitted_body(&data), &agent.template())
}

/// The ordered PTY writes that deliver `data` to an agent and submit it. Most
/// agents need ONE write (the chord is part of it, via `apply_submit_chord`),
/// so a caller can write/enqueue the single element verbatim.
///
/// gemini is the exception. gemini 0.51 converts a closely following Return
/// into Shift+Return, including after bracketed paste. Only a CR delivered as
/// its OWN later write submits gemini, so for gemini this
/// returns TWO writes (the text body, then the submit chord alone) which the
/// caller MUST deliver as separate events: separate write-queue items, whose
/// drainer idle-gates between them, or separate PTY writes with a caller-owned
/// conservative gap. A
/// message missing either half collapses to one write, so the list is never
/// empty.
pub fn submit_writes(data: String, submit: Option<SubmitAgent>) -> Vec<String> {
    let resolved = submit.map(ResolvedSubmit::resolve);
    plan_submitted_input(data, resolved.as_ref(), false)
        .parts
        .into_iter()
        .map(|part| String::from_utf8(part).expect("submit templates are UTF-8 strings"))
        .collect()
}

/// Whether `word` (ASCII) occurs in `haystack` bounded by non-word chars on
/// both sides, the `\b<word>\b` of `agentForCommand`. Word chars are ASCII
/// alphanumerics + `_`; anything else (including non-ASCII bytes and string
/// edges) is a boundary. `haystack` is expected pre-lowercased.
fn word_match(haystack: &str, word: &str) -> bool {
    let bytes = haystack.as_bytes();
    let mut from = 0;
    while let Some(pos) = haystack[from..].find(word) {
        let start = from + pos;
        let end = start + word.len();
        let before_ok = start == 0 || !is_word_byte(bytes[start - 1]);
        let after_ok = end == bytes.len() || !is_word_byte(bytes[end]);
        if before_ok && after_ok {
            return true;
        }
        from = start + 1;
        if from >= bytes.len() {
            break;
        }
    }
    false
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Decode the backslash escapes a config/env override string may carry so a
/// template can express control bytes as plain text: `\e` (ESC), `\xHH` (a
/// hex byte, intended for ASCII/control), `\r`, `\n`, `\t`, `\0`, `\\`. An
/// unrecognized escape keeps both the backslash and the following char, so a
/// literal `\d` survives rather than being silently dropped.
fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('e') => out.push('\x1b'),
            Some('r') => out.push('\r'),
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('0') => out.push('\0'),
            Some('\\') => out.push('\\'),
            Some('x') => {
                let h1 = chars.next();
                let h2 = chars.next();
                match (h1, h2) {
                    (Some(a), Some(b)) => {
                        let hex: String = [a, b].iter().collect();
                        if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                            out.push(byte as char);
                        } else {
                            out.push('\\');
                            out.push('x');
                            out.push(a);
                            out.push(b);
                        }
                    }
                    (Some(a), None) => {
                        out.push('\\');
                        out.push('x');
                        out.push(a);
                    }
                    _ => {
                        out.push('\\');
                        out.push('x');
                    }
                }
            }
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn built_in(agent: SubmitAgent) -> ResolvedSubmit {
        let (template, source) = resolve_template_with_source(agent, |_| None, None);
        ResolvedSubmit {
            agent,
            template,
            source,
        }
    }

    #[test]
    fn submit_metadata_uses_pinned_wire_names() {
        assert_eq!(
            serde_json::to_string(&SubmitAgent::OpenCode).unwrap(),
            r#""opencode""#
        );
        assert_eq!(
            serde_json::to_string(&SubmitTemplateSource::BuiltIn).unwrap(),
            r#""built_in""#
        );
        assert_eq!(
            serde_json::from_str::<SubmitAgent>(r#""claude""#).unwrap(),
            SubmitAgent::Claude
        );
    }

    #[test]
    fn kimi_is_a_first_class_batchable_submit_agent() {
        let kimi = SubmitAgent::from_agent_name("kimi").expect("kimi agent");
        assert_eq!(kimi.name(), "kimi");
        assert_eq!(serde_json::to_string(&kimi).unwrap(), r#""kimi""#);
        assert_eq!(
            apply_submit_chord("poke\n".into(), Some(kimi)),
            "\x1b[200~poke\n\x1b[201~\r"
        );
        assert!(built_in(kimi).is_batchable());
    }

    #[test]
    fn input_plan_pins_singleton_and_batch_parts() {
        let claude = built_in(SubmitAgent::Claude);
        assert_eq!(
            plan_submitted_input("poke\n".into(), Some(&claude), false).parts,
            vec![b"poke\n\x1b[27;9;13~".to_vec()]
        );
        assert_eq!(
            plan_submitted_input("batch\n".into(), Some(&claude), true).parts,
            vec![b"batch\n".to_vec(), b"\x1b[27;9;13~".to_vec()]
        );

        let codex = built_in(SubmitAgent::Codex);
        assert_eq!(
            plan_submitted_input("batch\n".into(), Some(&codex), true).parts,
            vec![b"\x1b[200~batch\n\x1b[201~\r".to_vec()]
        );

        let kimi = built_in(SubmitAgent::Kimi);
        assert_eq!(
            plan_submitted_input("batch\n".into(), Some(&kimi), true).parts,
            vec![b"\x1b[200~batch\n\x1b[201~\r".to_vec()]
        );

        let opencode = built_in(SubmitAgent::OpenCode);
        assert_eq!(
            plan_submitted_input("batch\n".into(), Some(&opencode), true).parts,
            vec![b"\x1b[200~batch\n\x1b[201~\r".to_vec()]
        );

        let gemini = built_in(SubmitAgent::Gemini);
        assert_eq!(
            plan_submitted_input("poke\n".into(), Some(&gemini), false).parts,
            vec![b"poke\n".to_vec(), b"\r".to_vec()]
        );
        assert_eq!(
            plan_submitted_input("raw\n".into(), None, false).parts,
            vec![b"raw\n".to_vec()]
        );
    }

    #[test]
    fn built_in_batchable_agents_are_pinned() {
        for agent in [
            SubmitAgent::Claude,
            SubmitAgent::Codex,
            SubmitAgent::Kimi,
            SubmitAgent::OpenCode,
        ] {
            assert!(built_in(agent).is_batchable(), "{}", agent.name());
        }
        assert!(!built_in(SubmitAgent::Gemini).is_batchable());
    }

    #[test]
    fn resolved_source_distinguishes_built_in_and_overrides() {
        let (template, source) = resolve_template_with_source(SubmitAgent::Claude, |_| None, None);
        assert_eq!(template, "{}\x1b[27;9;13~");
        assert_eq!(source, SubmitTemplateSource::BuiltIn);

        let (template, source) = resolve_template_with_source(
            SubmitAgent::Claude,
            |key| (key == "CHAN_SUBMIT_CLAUDE").then(|| r"\e[custom{}\r".to_string()),
            None,
        );
        assert_eq!(template, "\x1b[custom{}\r");
        assert_eq!(source, SubmitTemplateSource::Override);
    }

    #[test]
    fn config_map_override_is_marked_override() {
        // A `<config>/chan/submit.toml` value (the process-global map) is an
        // override just like the env var: it disables batching for that agent
        // and its exact unescaped bytes are what reaches the PTY.
        let mut file = HashMap::new();
        file.insert("codex".to_string(), r"\e[200~{}\e[201~\n".to_string());
        let (template, source) =
            resolve_template_with_source(SubmitAgent::Codex, |_| None, Some(&file));
        assert_eq!(template, "\x1b[200~{}\x1b[201~\n");
        assert_eq!(source, SubmitTemplateSource::Override);

        let resolved = ResolvedSubmit {
            agent: SubmitAgent::Codex,
            template,
            source,
        };
        assert!(!resolved.is_batchable(), "an override is never batchable");
        assert_eq!(
            plan_submitted_input("poke\n".into(), Some(&resolved), true).parts,
            vec![b"\x1b[200~poke\n\x1b[201~\n".to_vec()],
            "an override keeps its exact single-message expansion"
        );
    }

    #[test]
    fn an_input_plan_always_has_at_least_one_part() {
        // A `{}`-only gemini override has no chord bytes; with empty data both
        // halves are empty, and the message must still occupy one write rather
        // than vanishing from the queue.
        let mut file = HashMap::new();
        file.insert("gemini".to_string(), "{}".to_string());
        let (template, source) =
            resolve_template_with_source(SubmitAgent::Gemini, |_| None, Some(&file));
        let resolved = ResolvedSubmit {
            agent: SubmitAgent::Gemini,
            template,
            source,
        };
        assert!(!splits_submit_chord("", &resolved));
        assert_eq!(
            plan_submitted_input(String::new(), Some(&resolved), false).parts,
            vec![Vec::<u8>::new()]
        );
        // A chordless template with a body is one write, not a split pair.
        assert!(!splits_submit_chord("body\n", &resolved));
        assert_eq!(
            plan_submitted_input("body\n".into(), Some(&resolved), false).parts,
            vec![b"body\n".to_vec()]
        );
        // The built-in gemini template does split, on both halves being present.
        let gemini = built_in(SubmitAgent::Gemini);
        assert!(splits_submit_chord("body", &gemini));
        assert!(splits_submit_chord("\n\n", &gemini));
        assert_eq!(
            plan_submitted_input("\n\n".into(), Some(&gemini), false).parts,
            vec![b"\n".to_vec(), b"\r".to_vec()]
        );
        assert!(!splits_submit_chord("", &gemini));
    }

    #[test]
    fn submit_chord_normalizes_one_newline_before_each_agent_chord() {
        // claude -> the modifyOtherKeys Cmd+Enter chord.
        assert_eq!(
            apply_submit_chord("poke\n\n".into(), Some(SubmitAgent::Claude)),
            "poke\n\x1b[27;9;13~"
        );
        // codex -> bracketed-paste wrap, then CR. The wrap defeats codex's
        // paste-burst coalescing of a bare text+CR write (which would land
        // the CR as a literal newline and never submit).
        assert_eq!(
            apply_submit_chord("poke\n".into(), Some(SubmitAgent::Codex)),
            "\x1b[200~poke\n\x1b[201~\r"
        );
        // gemini -> a plain CR suffix.
        assert_eq!(
            apply_submit_chord("poke".into(), Some(SubmitAgent::Gemini)),
            "poke\n\r"
        );
        // kimi -> its own bracketed-paste and CR template.
        assert_eq!(
            apply_submit_chord("poke\n".into(), Some(SubmitAgent::Kimi)),
            "\x1b[200~poke\n\x1b[201~\r"
        );
        // opencode -> bracketed paste and CR in the same PTY write.
        assert_eq!(
            apply_submit_chord("poke\n".into(), Some(SubmitAgent::OpenCode)),
            "\x1b[200~poke\n\x1b[201~\r"
        );
        // codex keeps interior newlines inside the paste (a multi-line poke is
        // one message) and trims only the trailing ones before the wrap.
        assert_eq!(
            apply_submit_chord("line one\nline two\n\n".into(), Some(SubmitAgent::Codex)),
            "\x1b[200~line one\nline two\n\x1b[201~\r"
        );
        // Empty stays chord-only.
        assert_eq!(
            apply_submit_chord(String::new(), Some(SubmitAgent::Claude)),
            "\x1b[27;9;13~"
        );
        // A newline-only body is non-empty: it normalizes to one newline.
        assert_eq!(
            apply_submit_chord("\n\n".into(), Some(SubmitAgent::Claude)),
            "\n\x1b[27;9;13~"
        );
        // Unset -> bytes verbatim (no chord, trailing newline kept).
        assert_eq!(apply_submit_chord("poke\n".into(), None), "poke\n");
    }

    #[test]
    fn submit_writes_is_one_write_except_gemini() {
        // claude/codex/kimi/opencode/none: one write, identical to
        // apply_submit_chord.
        assert_eq!(
            submit_writes("poke\n".into(), Some(SubmitAgent::Claude)),
            vec!["poke\n\x1b[27;9;13~".to_string()]
        );
        assert_eq!(
            submit_writes("poke".into(), Some(SubmitAgent::Codex)),
            vec!["\x1b[200~poke\n\x1b[201~\r".to_string()]
        );
        assert_eq!(
            submit_writes("poke".into(), Some(SubmitAgent::Kimi)),
            vec!["\x1b[200~poke\n\x1b[201~\r".to_string()]
        );
        assert_eq!(
            submit_writes("poke".into(), Some(SubmitAgent::OpenCode)),
            vec!["\x1b[200~poke\n\x1b[201~\r".to_string()]
        );
        assert_eq!(submit_writes("raw".into(), None), vec!["raw".to_string()]);
        // gemini: TWO writes - the text body, then the bare submit chord -
        // so Return is not converted to Shift+Return with the insertion.
        assert_eq!(
            submit_writes("poke\n".into(), Some(SubmitAgent::Gemini)),
            vec!["poke\n".to_string(), "\r".to_string()]
        );
        // A text-only gemini body still splits off the chord write.
        assert_eq!(
            submit_writes("hi there".into(), Some(SubmitAgent::Gemini)),
            vec!["hi there\n".to_string(), "\r".to_string()]
        );
    }

    #[test]
    fn derive_sniffs_the_command_loosely() {
        let d = |c: &str| SubmitAgent::derive(c, None);
        assert_eq!(d("claude"), Some(SubmitAgent::Claude));
        assert_eq!(d("codex"), Some(SubmitAgent::Codex));
        assert_eq!(d("gemini"), Some(SubmitAgent::Gemini));
        assert_eq!(d("kimi").map(SubmitAgent::name), Some("kimi"));
        assert_eq!(d("opencode"), Some(SubmitAgent::OpenCode));
        // past the first token / through a path / a wrapper
        assert_eq!(d("claude --resume"), Some(SubmitAgent::Claude));
        assert_eq!(d("/usr/local/bin/codex-cli"), Some(SubmitAgent::Codex));
        assert_eq!(d("my-claude.sh --flag"), Some(SubmitAgent::Claude));
        assert_eq!(d("env FOO=1 gemini chat"), Some(SubmitAgent::Gemini));
        assert_eq!(d("/usr/local/bin/opencode-ai"), Some(SubmitAgent::OpenCode));
        assert_eq!(
            d("/home/fiorix/.kimi-code/bin/kimi").map(SubmitAgent::name),
            Some("kimi")
        );
        assert_eq!(d("kimi --yolo").map(SubmitAgent::name), Some("kimi"));
        // case-insensitive
        assert_eq!(d("OPENCODE"), Some(SubmitAgent::OpenCode));
        assert_eq!(d("CLAUDE"), Some(SubmitAgent::Claude));
        assert_eq!(d("KIMI").map(SubmitAgent::name), Some("kimi"));
        // word boundaries keep near-misses out
        assert_eq!(d("claudette"), None);
        assert_eq!(d("codexterous"), None);
        assert_eq!(d("myopencode"), None);
        assert_eq!(d("opencoded"), None);
        assert_eq!(d("kimiko"), None);
        // a plain shell -> no chord
        assert_eq!(d("bash"), None);
        assert_eq!(d(""), None);
    }

    #[test]
    fn derive_honors_chan_agent_override() {
        // CHAN_AGENT wins over the command sniff
        assert_eq!(
            SubmitAgent::derive("codex", Some("claude")),
            Some(SubmitAgent::Claude)
        );
        assert_eq!(
            SubmitAgent::derive("./run-my-agent.sh", Some("gemini")),
            Some(SubmitAgent::Gemini)
        );
        assert_eq!(
            SubmitAgent::derive("bash", Some("kimi")).map(SubmitAgent::name),
            Some("kimi")
        );
        assert_eq!(
            SubmitAgent::derive("kimi", Some("codex")),
            Some(SubmitAgent::Codex)
        );
        // explicit shell forces None despite an agent command
        assert_eq!(SubmitAgent::derive("claude", Some("none")), None);
        assert_eq!(SubmitAgent::derive("claude", Some("shell")), None);
        // an unrecognized value falls through to the command sniff
        assert_eq!(
            SubmitAgent::derive("claude", Some("banana")),
            Some(SubmitAgent::Claude)
        );
        assert_eq!(SubmitAgent::derive("bash", Some("banana")), None);
        // whitespace / case tolerated
        assert_eq!(
            SubmitAgent::derive("bash", Some("  Codex ")),
            Some(SubmitAgent::Codex)
        );
        assert_eq!(
            SubmitAgent::derive("claude", Some(" OpenCode ")),
            Some(SubmitAgent::OpenCode)
        );
    }

    #[test]
    fn resolve_template_precedence_env_over_file_over_default() {
        let none = |_: &str| None;
        // default when nothing is set
        assert_eq!(
            resolve_template(SubmitAgent::Claude, none, None),
            "{}\x1b[27;9;13~"
        );
        // file override (the process-global map), escapes decoded
        let mut file = HashMap::new();
        file.insert("claude".to_string(), "{}\\r".to_string());
        assert_eq!(
            resolve_template(SubmitAgent::Claude, none, Some(&file)),
            "{}\r"
        );
        // env beats the file
        let env = |k: &str| (k == "CHAN_SUBMIT_CLAUDE").then(|| "{}\\x0d".to_string());
        assert_eq!(
            resolve_template(SubmitAgent::Claude, env, Some(&file)),
            "{}\r"
        );
        // a blank env value is ignored (falls through to the file)
        let blank = |k: &str| (k == "CHAN_SUBMIT_CLAUDE").then(|| "  ".to_string());
        assert_eq!(
            resolve_template(SubmitAgent::Claude, blank, Some(&file)),
            "{}\r"
        );
    }

    #[test]
    fn template_without_placeholder_is_a_suffix() {
        // A bare-chord override (no `{}`) appends after the text.
        let mut file = HashMap::new();
        file.insert("gemini".to_string(), "\\r".to_string());
        let tmpl = resolve_template(SubmitAgent::Gemini, |_| None, Some(&file));
        // Mimic apply_submit_chord's suffix branch with a normalized body.
        let out = if tmpl.contains("{}") {
            tmpl.replacen("{}", "poke\n", 1)
        } else {
            format!("poke\n{tmpl}")
        };
        assert_eq!(out, "poke\n\r");
    }

    #[test]
    fn opencode_template_precedence_env_over_file_over_default() {
        let none = |_: &str| None;
        assert_eq!(
            resolve_template(SubmitAgent::OpenCode, none, None),
            "\x1b[200~{}\x1b[201~\r"
        );
        let mut file = HashMap::new();
        file.insert("opencode".to_string(), "{}\\r".to_string());
        assert_eq!(
            resolve_template(SubmitAgent::OpenCode, none, Some(&file)),
            "{}\r"
        );
        let env = |key: &str| {
            (key == "CHAN_SUBMIT_OPENCODE").then(|| "\\e[200~{}\\e[201~\\r".to_string())
        };
        assert_eq!(
            resolve_template(SubmitAgent::OpenCode, env, Some(&file)),
            "\x1b[200~{}\x1b[201~\r"
        );
    }

    #[test]
    fn opencode_encoding_pins_multiline_trimming_and_paste_sized_bytes() {
        assert_eq!(
            apply_submit_chord("one\ntwo\n\n".into(), Some(SubmitAgent::OpenCode)),
            "\x1b[200~one\ntwo\n\x1b[201~\r"
        );
        let body = format!("HEAD{}TAIL", "x".repeat(20 * 1024));
        let encoded = apply_submit_chord(body.clone(), Some(SubmitAgent::OpenCode));
        assert_eq!(
            encoded,
            format!("\x1b[200~{body}\n\x1b[201~\r"),
            "paste-sized input must remain one exact bracketed PTY write"
        );
    }

    #[test]
    fn unescape_decodes_control_escapes() {
        assert_eq!(unescape("\\e[27;9;13~"), "\x1b[27;9;13~");
        assert_eq!(unescape("\\x1b[200~"), "\x1b[200~");
        assert_eq!(unescape("a\\rb\\nc\\t"), "a\rb\nc\t");
        assert_eq!(unescape("\\\\"), "\\");
        // unknown escape keeps both chars
        assert_eq!(unescape("\\d"), "\\d");
    }

    // ValueEnum parsing only exists with the `client` feature (the
    // `--submit` flag); the chord map below is tested unconditionally.
    #[cfg(feature = "client")]
    #[test]
    fn submit_agent_value_enum_parses_lowercase() {
        // The flag accepts the lower-case agent names the docs use.
        assert_eq!(
            SubmitAgent::from_str("claude", true).unwrap(),
            SubmitAgent::Claude
        );
        assert_eq!(
            SubmitAgent::from_str("codex", true).unwrap(),
            SubmitAgent::Codex
        );
        assert_eq!(
            SubmitAgent::from_str("gemini", true).unwrap(),
            SubmitAgent::Gemini
        );
        assert_eq!(
            SubmitAgent::from_str("kimi", true).unwrap(),
            SubmitAgent::Kimi
        );
        assert_eq!(
            SubmitAgent::from_str("opencode", true).unwrap(),
            SubmitAgent::OpenCode
        );
        assert!(SubmitAgent::from_str("turbo", true).is_err());
    }

    #[test]
    fn from_agent_name_round_trips_with_name() {
        for a in [
            SubmitAgent::Claude,
            SubmitAgent::Codex,
            SubmitAgent::Gemini,
            SubmitAgent::Kimi,
            SubmitAgent::OpenCode,
        ] {
            assert_eq!(SubmitAgent::from_agent_name(a.name()), Some(a));
        }
        assert_eq!(SubmitAgent::from_agent_name("turbo"), None);
    }
}
