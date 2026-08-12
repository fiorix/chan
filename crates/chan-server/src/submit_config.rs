//! Runtime overrides for the per-agent submit chords. The DEFAULT chord
//! bytes live in chan-shell (`SubmitAgent::default_template`); this module
//! lets a user override them without a rebuild by editing
//! `<config>/chan/submit.toml`, so a client
//! (agy/claude/codex/gemini/kimi/opencode) changing its submit behavior is a
//! config edit, not a release. Env
//! `CHAN_SUBMIT_<AGENT>` still takes precedence over the file (resolved in
//! chan-shell at chord-application time).
//!
//! File shape (every table + field optional; omit one to keep its built-in):
//!
//! ```text
//! [agy]
//! template = '\e[200~{}\e[201~\r'
//! [claude]
//! template = '{}\e[27;9;13~'      # {} is the text; \e \xHH \r \n \t escapes
//! [codex]
//! template = '\e[200~{}\e[201~\r'
//! [gemini]
//! template = '{}\r'
//! [kimi]
//! template = '\e[200~{}\e[201~\r'
//! [opencode]
//! template = '\e[200~{}\e[201~\r'
//! ```
//!
//! A template without `{}` is treated as a pure suffix appended after the
//! text (so a bare-chord override works too).

use std::collections::HashMap;

use serde::Deserialize;

#[derive(Debug, Default, Deserialize)]
struct SubmitOverridesFile {
    agy: Option<AgentChord>,
    claude: Option<AgentChord>,
    codex: Option<AgentChord>,
    gemini: Option<AgentChord>,
    kimi: Option<AgentChord>,
    opencode: Option<AgentChord>,
}

#[derive(Debug, Deserialize)]
struct AgentChord {
    template: String,
}

impl SubmitOverridesFile {
    fn into_map(self) -> HashMap<String, String> {
        let mut map = HashMap::new();
        for (name, chord) in [
            ("agy", self.agy),
            ("claude", self.claude),
            ("codex", self.codex),
            ("gemini", self.gemini),
            ("kimi", self.kimi),
            ("opencode", self.opencode),
        ] {
            if let Some(chord) = chord {
                map.insert(name.to_string(), chord.template);
            }
        }
        map
    }
}

/// Load `<config>/chan/submit.toml` (if present) and install any per-agent
/// chord template overrides into chan-shell. Missing file: no-op (the
/// built-in defaults stand). Malformed file: logged and ignored, matching
/// the fall-back-on-malformed policy of the editor/server configs.
pub fn install() {
    let path = chan_workspace::paths::config_dir().join("submit.toml");
    let file: SubmitOverridesFile = match crate::store::load_toml(&path) {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!("malformed submit.toml, ignoring chord overrides: {e}");
            return;
        }
    };
    let map = file.into_map();
    if !map.is_empty() {
        chan_shell::set_chord_overrides(map);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opencode_table_deserializes() {
        let file: SubmitOverridesFile = toml::from_str(
            r#"
[opencode]
template = "\\e[200~{}\\e[201~\\r"
"#,
        )
        .expect("valid submit config");
        assert_eq!(
            file.into_map().get("opencode").map(String::as_str),
            Some("\\e[200~{}\\e[201~\\r")
        );
    }

    #[test]
    fn agy_table_deserializes() {
        let file: SubmitOverridesFile = toml::from_str(
            r#"
[agy]
template = "\\e[200~{}\\e[201~\\r"
"#,
        )
        .expect("valid submit config");
        assert_eq!(
            file.into_map().get("agy").map(String::as_str),
            Some("\\e[200~{}\\e[201~\\r")
        );
    }

    #[test]
    fn kimi_table_deserializes() {
        let file: SubmitOverridesFile = toml::from_str(
            r#"
[kimi]
template = "\\e[200~{}\\e[201~\\r"
"#,
        )
        .expect("valid submit config");
        assert_eq!(
            file.into_map().get("kimi").map(String::as_str),
            Some("\\e[200~{}\\e[201~\\r")
        );
    }
}
