use anyhow::{Context, Result};
use chan_server::{EditorPrefs, EditorTheme, LineSpacing, ServerConfig, ThemeChoice};
use serde::{Deserialize, Serialize};

use crate::cli::ConfigAction;

#[derive(Clone, Deserialize, Serialize)]
struct ConfigOutput {
    editor: EditorPrefs,
    server: ServerConfig,
}

#[derive(Clone, Copy)]
enum ConfigValueKind {
    String,
    NonEmptyString,
    Bool,
    U32,
    U32Range(u32, u32),
    U64NonZero,
    UsizeNonZero,
    F64Range(f64, f64),
    Enum(&'static [&'static str]),
    OptionalU32Range(u32, u32),
    OptionalEnum(&'static [&'static str]),
    /// A free-form string whose field skip-serializes away while unset, so
    /// `get` reads it as null rather than failing to find a leaf, and `none`
    /// clears it. `Enum`'s optional form, without a fixed value set.
    OptionalString,
    StringList(usize),
    Color,
    Collection(&'static str),
}

#[derive(Clone, Copy)]
struct ConfigKeySpec {
    key: &'static str,
    kind: ConfigValueKind,
}

const CONFIG_KEYS: &[ConfigKeySpec] = &[
    ConfigKeySpec {
        key: "editor.editor_theme",
        kind: ConfigValueKind::Enum(&["github", "google_docs", "word"]),
    },
    ConfigKeySpec {
        key: "editor.editor_font_size",
        kind: ConfigValueKind::OptionalU32Range(10, 32),
    },
    ConfigKeySpec {
        key: "editor.terminal_colors.mode",
        kind: ConfigValueKind::Enum(&["standard", "custom"]),
    },
    ConfigKeySpec {
        key: "editor.terminal_colors.custom.background",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.terminal_colors.custom.foreground",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.terminal_colors.custom.cursor",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.terminal_colors.custom.contrast",
        kind: ConfigValueKind::Enum(&["auto", "dark", "light"]),
    },
    ConfigKeySpec {
        key: "editor.theme",
        kind: ConfigValueKind::Enum(&["system", "light", "dark"]),
    },
    ConfigKeySpec {
        key: "editor.pane_widths.inspector",
        kind: ConfigValueKind::U32,
    },
    ConfigKeySpec {
        key: "editor.pane_widths.graph",
        kind: ConfigValueKind::U32,
    },
    ConfigKeySpec {
        key: "editor.pane_widths.browser",
        kind: ConfigValueKind::U32,
    },
    ConfigKeySpec {
        key: "editor.pane_widths.search",
        kind: ConfigValueKind::U32,
    },
    ConfigKeySpec {
        key: "editor.pane_widths.outline",
        kind: ConfigValueKind::U32,
    },
    ConfigKeySpec {
        key: "editor.browser_side_panes.left",
        kind: ConfigValueKind::Bool,
    },
    ConfigKeySpec {
        key: "editor.browser_side_panes.right",
        kind: ConfigValueKind::Bool,
    },
    ConfigKeySpec {
        key: "editor.line_spacing",
        kind: ConfigValueKind::Enum(&["standard", "compact"]),
    },
    ConfigKeySpec {
        key: "editor.date_format",
        kind: ConfigValueKind::String,
    },
    ConfigKeySpec {
        key: "editor.strip_trailing_whitespace_on_save",
        kind: ConfigValueKind::Bool,
    },
    ConfigKeySpec {
        key: "editor.bubble_overlay_mode",
        kind: ConfigValueKind::Enum(&["stack", "tray"]),
    },
    ConfigKeySpec {
        key: "editor.hybrid_surface_themes.editor",
        kind: ConfigValueKind::OptionalEnum(&["light", "dark"]),
    },
    ConfigKeySpec {
        key: "editor.hybrid_surface_themes.terminal",
        kind: ConfigValueKind::OptionalEnum(&["light", "dark"]),
    },
    ConfigKeySpec {
        key: "editor.hybrid_surface_themes.browser",
        kind: ConfigValueKind::OptionalEnum(&["light", "dark"]),
    },
    ConfigKeySpec {
        key: "editor.hybrid_surface_themes.graph",
        kind: ConfigValueKind::OptionalEnum(&["light", "dark"]),
    },
    ConfigKeySpec {
        key: "editor.hybrid_surface_themes.dashboard",
        kind: ConfigValueKind::OptionalEnum(&["light", "dark"]),
    },
    ConfigKeySpec {
        key: "editor.graph_colors.mode",
        kind: ConfigValueKind::Enum(&["standard", "custom"]),
    },
    ConfigKeySpec {
        key: "editor.graph_colors.dark.doc",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.dark.source",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.dark.binary",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.dark.img",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.dark.folder",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.dark.tag",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.dark.language",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.dark.contact",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.light.doc",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.light.source",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.light.binary",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.light.img",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.light.folder",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.light.tag",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.light.language",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.graph_colors.light.contact",
        kind: ConfigValueKind::Color,
    },
    ConfigKeySpec {
        key: "editor.empty_pane_carousel_cycling",
        kind: ConfigValueKind::Bool,
    },
    ConfigKeySpec {
        key: "editor.page_width_ratio",
        kind: ConfigValueKind::F64Range(0.25, 1.0),
    },
    ConfigKeySpec {
        key: "editor.overlay_maximized",
        kind: ConfigValueKind::Bool,
    },
    ConfigKeySpec {
        key: "editor.shortcuts",
        kind: ConfigValueKind::Collection(
            "use Settings or PATCH /api/config to edit shortcut overrides",
        ),
    },
    ConfigKeySpec {
        key: "server.attachments_dir",
        kind: ConfigValueKind::NonEmptyString,
    },
    ConfigKeySpec {
        key: "server.search.aggression",
        kind: ConfigValueKind::Enum(&["conservative", "balanced", "aggressive"]),
    },
    ConfigKeySpec {
        key: "server.transfer.stall_timeout_secs",
        kind: ConfigValueKind::U64NonZero,
    },
    ConfigKeySpec {
        key: "server.terminal.idle_timeout_secs",
        kind: ConfigValueKind::U64NonZero,
    },
    ConfigKeySpec {
        key: "server.terminal.session_cap",
        kind: ConfigValueKind::UsizeNonZero,
    },
    ConfigKeySpec {
        key: "server.terminal.ring_bytes",
        kind: ConfigValueKind::UsizeNonZero,
    },
    ConfigKeySpec {
        key: "server.terminal.scrollback_mb",
        kind: ConfigValueKind::U32Range(10, 50),
    },
    ConfigKeySpec {
        key: "server.terminal.default_term",
        kind: ConfigValueKind::NonEmptyString,
    },
    ConfigKeySpec {
        key: "server.terminal.font",
        kind: ConfigValueKind::Enum(&["os-default", "source-code-pro"]),
    },
    ConfigKeySpec {
        key: "server.terminal.font_size",
        kind: ConfigValueKind::U32Range(8, 32),
    },
    ConfigKeySpec {
        key: "server.terminal.mcp_env",
        kind: ConfigValueKind::Bool,
    },
    ConfigKeySpec {
        key: "server.terminal.mouse_capture",
        kind: ConfigValueKind::Bool,
    },
    ConfigKeySpec {
        key: "server.terminal.ghostty",
        kind: ConfigValueKind::Bool,
    },
    ConfigKeySpec {
        key: "server.terminal.secret_masking",
        kind: ConfigValueKind::Bool,
    },
    ConfigKeySpec {
        key: "server.terminal.secret_mask_suffixes",
        kind: ConfigValueKind::StringList(100),
    },
    // Array-of-tables with per-entry optional fields, so it takes the same
    // Collection escape hatch as `editor.shortcuts` rather than a scalar kind:
    // `chan config get` renders it, and editing goes through the file or the
    // Settings pane.
    ConfigKeySpec {
        key: "server.terminal.profiles",
        kind: ConfigValueKind::Collection(
            "edit terminal profiles in server.toml or Settings -> Terminal",
        ),
    },
    ConfigKeySpec {
        key: "server.terminal.default_profile",
        kind: ConfigValueKind::OptionalString,
    },
];

pub(super) fn cmd_config(action: ConfigAction) -> Result<()> {
    match action {
        ConfigAction::Get { key, json } => {
            let editor = EditorPrefs::load().context("loading editor preferences")?;
            let server = ServerConfig::load().context("loading server config")?;
            match key.as_deref() {
                None | Some("") => {
                    let output = ConfigOutput { editor, server };
                    validate_config_dump(&serde_json::to_value(&output)?)?;
                    if json {
                        println!("{}", serde_json::to_string_pretty(&output)?);
                    } else {
                        print!("{}", toml::to_string_pretty(&output)?);
                    }
                }
                Some(k) => {
                    let value = read_config_key(&editor, &server, k)?;
                    if json {
                        println!("{}", serde_json::to_string(&value)?);
                    } else {
                        println!("{}", scalar_to_string(&value));
                    }
                }
            }
            Ok(())
        }
        ConfigAction::Set { key, value } => {
            let (key, raw_value) = split_assignment(&key, value.as_deref())?;
            let key = canonical_config_key(&key);
            if key.starts_with("server.") {
                let mut cfg = ServerConfig::load().context("loading server config")?;
                write_server_config_key(&mut cfg, &key, &raw_value)?;
                cfg.save().context("saving server config")?;
            } else {
                let mut prefs = EditorPrefs::load().context("loading editor preferences")?;
                write_pref_key(&mut prefs, &key, &raw_value)?;
                prefs.save().context("saving editor preferences")?;
            }
            println!("{key} = {raw_value}");
            Ok(())
        }
    }
}

/// Accept both `chan config set k=v` and `chan config set k v`.
/// Returns `(key, value)`. Bails with a clear message on empty values
/// so a typo doesn't silently wipe a preference.
fn split_assignment(key: &str, value: Option<&str>) -> Result<(String, String)> {
    if let Some(v) = value {
        if v.is_empty() {
            anyhow::bail!("value must not be empty (got `{key}=`)");
        }
        return Ok((key.to_owned(), v.to_owned()));
    }
    if let Some((k, v)) = key.split_once('=') {
        let k = k.trim();
        let v = v.trim();
        if k.is_empty() {
            anyhow::bail!("key must not be empty");
        }
        if v.is_empty() {
            anyhow::bail!("value must not be empty (got `{key}`)");
        }
        return Ok((k.to_owned(), v.to_owned()));
    }
    anyhow::bail!("missing value: use `{key}=VALUE` or `{key} VALUE`")
}

fn read_config_key(
    editor: &EditorPrefs,
    server: &ServerConfig,
    key: &str,
) -> Result<serde_json::Value> {
    let key = canonical_config_key(key);
    let spec = config_key_spec(&key)?;
    let config = serde_json::to_value(ConfigOutput {
        editor: editor.clone(),
        server: server.clone(),
    })?;
    if let Some(value) = config_value_at(&config, &key) {
        return Ok(value.clone());
    }
    match spec.kind {
        ConfigValueKind::OptionalU32Range(..)
        | ConfigValueKind::OptionalEnum(..)
        | ConfigValueKind::OptionalString => Ok(serde_json::Value::Null),
        // Color leaves sit under `skip_serializing_if` parents (the graph
        // palettes, the terminal custom colors), so a config that never
        // set them serializes no leaf at all; absent means unset.
        ConfigValueKind::Color => Ok(serde_json::Value::Null),
        ConfigValueKind::Collection(_) if key == "editor.shortcuts" => Ok(serde_json::json!({})),
        // `terminal.profiles` skip-serializes away while empty, so a config
        // that declares none has no leaf to read. Its empty shape is a list,
        // not the map `editor.shortcuts` reads as.
        ConfigValueKind::Collection(_) if key == "server.terminal.profiles" => {
            Ok(serde_json::json!([]))
        }
        _ => {
            // `skip_serializing_if` can erase a whole subtree from the
            // dump: `GraphColorPrefs::is_empty` drops `editor.graph_colors`
            // wholesale, taking its always-serialized `mode` field with
            // it. The schema sample materializes those subtrees for the
            // write path, so it holds the serde default this key reads as.
            let sample = config_schema_sample()?;
            if let Some(value) = config_value_at(&sample, &key) {
                return Ok(value.clone());
            }
            anyhow::bail!("supported config key `{key}` is missing from the serialized schema")
        }
    }
}

fn write_pref_key(prefs: &mut EditorPrefs, key: &str, value: &str) -> Result<()> {
    let key = canonical_config_key(key);
    if !key.starts_with("editor.") {
        anyhow::bail!("`{key}` is a server config key, not an editor preference");
    }
    let updated = write_config_key(
        ConfigOutput {
            editor: prefs.clone(),
            server: ServerConfig::default(),
        },
        &key,
        value,
    )?;
    *prefs = updated.editor;
    Ok(())
}

fn write_server_config_key(cfg: &mut ServerConfig, key: &str, value: &str) -> Result<()> {
    let key = canonical_config_key(key);
    if !key.starts_with("server.") {
        anyhow::bail!("`{key}` is an editor preference, not a server config key");
    }
    let updated = write_config_key(
        ConfigOutput {
            editor: EditorPrefs::default(),
            server: cfg.clone(),
        },
        &key,
        value,
    )?;
    *cfg = updated.server;
    Ok(())
}

fn canonical_config_key(key: &str) -> String {
    key.strip_prefix("terminal.")
        .map(|suffix| format!("server.terminal.{suffix}"))
        .unwrap_or_else(|| key.to_owned())
}

fn config_key_spec(key: &str) -> Result<ConfigKeySpec> {
    if key.starts_with("editor.shortcuts.") {
        anyhow::bail!(
            "`editor.shortcuts` is a collection; use Settings or PATCH /api/config to edit shortcut overrides"
        );
    }
    CONFIG_KEYS
        .iter()
        .copied()
        .find(|spec| spec.key == key)
        .ok_or_else(|| {
            let settable = CONFIG_KEYS
                .iter()
                .filter(|spec| !matches!(spec.kind, ConfigValueKind::Collection(_)))
                .map(|spec| spec.key)
                .collect::<Vec<_>>()
                .join(", ");
            anyhow::anyhow!("unknown key `{key}`; supported settable keys: {settable}")
        })
}

fn config_value_at<'a>(root: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    key.split('.')
        .try_fold(root, |value, segment| value.get(segment))
}

fn config_schema_sample() -> Result<serde_json::Value> {
    let mut editor = EditorPrefs {
        editor_font_size: Some(10),
        terminal_colors: chan_server::TerminalColorPrefs {
            custom: Some(chan_server::TerminalCustomColors {
                background: "#000000".into(),
                foreground: "#ffffff".into(),
                cursor: "#ffffff".into(),
                contrast: chan_server::TerminalContrast::Auto,
            }),
            ..Default::default()
        },
        ..Default::default()
    };
    editor.hybrid_surface_themes.editor = Some(chan_server::SurfaceThemeChoice::Light);
    editor.hybrid_surface_themes.terminal = Some(chan_server::SurfaceThemeChoice::Light);
    editor.hybrid_surface_themes.browser = Some(chan_server::SurfaceThemeChoice::Light);
    editor.hybrid_surface_themes.graph = Some(chan_server::SurfaceThemeChoice::Light);
    editor.hybrid_surface_themes.dashboard = Some(chan_server::SurfaceThemeChoice::Light);
    // Empty per-mode tables: enough schema for `set_config_value` to
    // materialize `editor.graph_colors.<mode>.<kind>` on a default
    // config without pre-populating any hue.
    editor.graph_colors.dark = Some(chan_server::GraphPalette::default());
    editor.graph_colors.light = Some(chan_server::GraphPalette::default());
    Ok(serde_json::to_value(ConfigOutput {
        editor,
        server: ServerConfig::default(),
    })?)
}

fn write_config_key(config: ConfigOutput, key: &str, raw: &str) -> Result<ConfigOutput> {
    let spec = config_key_spec(key)?;
    let value = parse_config_scalar(spec, raw)?;
    let mut serialized = serde_json::to_value(&config)?;
    let sample = config_schema_sample()?;
    set_config_value(&mut serialized, &sample, key, value)?;
    if key == "editor.terminal_colors.mode"
        && config_value_at(&serialized, key) == Some(&serde_json::json!("custom"))
        && config_value_at(&serialized, "editor.terminal_colors.custom").is_none()
    {
        anyhow::bail!(
            "editor.terminal_colors.mode=custom needs the custom color fields; set those first"
        );
    }
    serde_json::from_value(serialized)
        .with_context(|| format!("invalid value for config key `{key}`"))
}

fn set_config_value(
    root: &mut serde_json::Value,
    sample: &serde_json::Value,
    key: &str,
    value: serde_json::Value,
) -> Result<()> {
    let segments: Vec<&str> = key.split('.').collect();
    let mut current = root;
    let mut sample_current = sample;
    for segment in &segments[..segments.len() - 1] {
        sample_current = sample_current
            .get(*segment)
            .ok_or_else(|| anyhow::anyhow!("config schema has no `{key}` leaf"))?;
        let object = current
            .as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("`{key}` crosses a scalar config value"))?;
        current = object
            .entry((*segment).to_owned())
            .or_insert_with(|| sample_current.clone());
    }
    let leaf = segments.last().expect("config keys are non-empty");
    current
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("`{key}` parent is not a config section"))?
        .insert((*leaf).to_owned(), value);
    Ok(())
}

fn parse_config_scalar(spec: ConfigKeySpec, raw: &str) -> Result<serde_json::Value> {
    use serde_json::{Number, Value};

    let invalid_enum = |values: &[&str]| {
        anyhow::anyhow!("{}: expected {}, got `{raw}`", spec.key, values.join("|"))
    };
    let value = match spec.kind {
        ConfigValueKind::String => Value::String(raw.to_owned()),
        ConfigValueKind::NonEmptyString => {
            if raw.is_empty() {
                anyhow::bail!("{} must be non-empty", spec.key);
            }
            Value::String(raw.to_owned())
        }
        ConfigValueKind::Bool => Value::Bool(
            raw.parse::<bool>()
                .with_context(|| format!("{}: expected true|false, got `{raw}`", spec.key))?,
        ),
        ConfigValueKind::U32 => Value::Number(Number::from(parse_u32(spec.key, raw)?)),
        ConfigValueKind::U32Range(min, max) => {
            let parsed = parse_u32(spec.key, raw)?;
            if !(min..=max).contains(&parsed) {
                anyhow::bail!("{} must be in {min}..={max}, got `{raw}`", spec.key);
            }
            Value::Number(Number::from(parsed))
        }
        ConfigValueKind::U64NonZero => {
            Value::Number(Number::from(parse_nonzero_u64(spec.key, raw)?))
        }
        ConfigValueKind::UsizeNonZero => {
            let parsed = parse_nonzero_usize(spec.key, raw)?;
            Value::Number(Number::from(parsed as u64))
        }
        ConfigValueKind::F64Range(min, max) => {
            let parsed = raw
                .parse::<f64>()
                .with_context(|| format!("{}: expected a number, got `{raw}`", spec.key))?;
            if !parsed.is_finite() || !(min..=max).contains(&parsed) {
                anyhow::bail!("{} must be in {min}..={max}, got `{raw}`", spec.key);
            }
            Value::Number(Number::from_f64(parsed).expect("finite f64 has a JSON number"))
        }
        ConfigValueKind::Enum(values) => {
            let normalized = match spec.key {
                "editor.theme" => theme_choice_label(parse_theme_choice(raw)?).to_owned(),
                "editor.editor_theme" => editor_theme_label(parse_editor_theme(raw)?).to_owned(),
                "editor.line_spacing" => line_spacing_label(parse_line_spacing(raw)?).to_owned(),
                _ => raw.to_owned(),
            };
            if !values.contains(&normalized.as_str()) {
                return Err(invalid_enum(values));
            }
            Value::String(normalized)
        }
        ConfigValueKind::OptionalU32Range(min, max) => {
            if matches!(raw, "none" | "null") {
                Value::Null
            } else {
                let parsed = parse_u32(spec.key, raw)?;
                if !(min..=max).contains(&parsed) {
                    anyhow::bail!("{} must be in {min}..={max}, got `{raw}`", spec.key);
                }
                Value::Number(Number::from(parsed))
            }
        }
        ConfigValueKind::OptionalEnum(values) => {
            if matches!(raw, "none" | "null") {
                Value::Null
            } else {
                if !values.contains(&raw) {
                    return Err(invalid_enum(values));
                }
                Value::String(raw.to_owned())
            }
        }
        ConfigValueKind::OptionalString => {
            if matches!(raw, "none" | "null") {
                Value::Null
            } else {
                Value::String(raw.to_owned())
            }
        }
        ConfigValueKind::StringList(max) => {
            let entries: Vec<String> = serde_json::from_str(raw).with_context(|| {
                format!(
                    "{}: expected a JSON string array, for example [\"TOKEN\",\"SECRET\"]",
                    spec.key
                )
            })?;
            if entries.len() > max {
                anyhow::bail!("{} accepts at most {max} entries", spec.key);
            }
            if let Some(invalid) = entries.iter().find(|entry| {
                entry.is_empty()
                    || !entry
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            }) {
                anyhow::bail!("{}: `{invalid}` is outside [A-Za-z0-9_]+", spec.key);
            }
            let mut seen = std::collections::HashSet::new();
            if let Some(duplicate) = entries.iter().find(|entry| !seen.insert((*entry).clone())) {
                anyhow::bail!("{}: duplicate entry `{duplicate}`", spec.key);
            }
            serde_json::to_value(entries)?
        }
        ConfigValueKind::Color => Value::String(normalize_config_color(spec.key, raw)?),
        ConfigValueKind::Collection(route) => {
            anyhow::bail!("{} is a collection; {route}", spec.key)
        }
    };
    Ok(value)
}

fn normalize_config_color(key: &str, raw: &str) -> Result<String> {
    let hex = raw
        .strip_prefix('#')
        .filter(|hex| matches!(hex.len(), 3 | 6) && hex.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| anyhow::anyhow!("{key}: expected #rgb or #rrggbb, got `{raw}`"))?;
    let expanded = if hex.len() == 3 {
        hex.chars().flat_map(|c| [c, c]).collect::<String>()
    } else {
        hex.to_owned()
    };
    Ok(format!("#{}", expanded.to_ascii_lowercase()))
}

fn validate_config_dump(config: &serde_json::Value) -> Result<()> {
    fn walk(value: &serde_json::Value, path: &mut Vec<String>) -> Result<()> {
        if let serde_json::Value::Object(fields) = value {
            for (name, value) in fields {
                path.push(name.clone());
                walk(value, path)?;
                path.pop();
            }
            return Ok(());
        }
        let key = path.join(".");
        if key.starts_with("editor.shortcuts.") {
            return Ok(());
        }
        config_key_spec(&key)
            .with_context(|| format!("serialized config leaf `{key}` has no CLI policy"))?;
        Ok(())
    }
    walk(config, &mut Vec::new())
}

fn parse_theme_choice(value: &str) -> Result<ThemeChoice> {
    match value {
        "system" => Ok(ThemeChoice::System),
        "light" => Ok(ThemeChoice::Light),
        "dark" => Ok(ThemeChoice::Dark),
        _ => anyhow::bail!("expected system|light|dark, got `{value}`"),
    }
}

fn parse_editor_theme(value: &str) -> Result<EditorTheme> {
    match value {
        "github" => Ok(EditorTheme::Github),
        "google_docs" => Ok(EditorTheme::GoogleDocs),
        "word" => Ok(EditorTheme::Word),
        _ => anyhow::bail!("expected github|google_docs|word, got `{value}`"),
    }
}

fn parse_line_spacing(value: &str) -> Result<LineSpacing> {
    match value {
        "standard" => Ok(LineSpacing::Standard),
        "compact" => Ok(LineSpacing::Compact),
        // `tight` is an accepted legacy alias for `compact` (same
        // density target), so muscle memory and existing
        // scripts keep working; the canonical reader (`config get`)
        // echoes back `compact` so the user is nudged toward the new
        // spelling without losing their preference.
        "tight" => Ok(LineSpacing::Compact),
        _ => anyhow::bail!("expected standard|compact, got `{value}`"),
    }
}

fn parse_u32(key: &str, value: &str) -> Result<u32> {
    value
        .parse::<u32>()
        .with_context(|| format!("{key}: expected non-negative integer, got `{value}`"))
}

fn parse_nonzero_u64(key: &str, value: &str) -> Result<u64> {
    let parsed = value
        .parse::<u64>()
        .with_context(|| format!("{key} must be a positive integer"))?;
    if parsed == 0 {
        anyhow::bail!("{key} must be greater than 0");
    }
    Ok(parsed)
}

fn parse_nonzero_usize(key: &str, value: &str) -> Result<usize> {
    let parsed = value
        .parse::<usize>()
        .with_context(|| format!("{key} must be a positive integer"))?;
    if parsed == 0 {
        anyhow::bail!("{key} must be greater than 0");
    }
    Ok(parsed)
}

fn theme_choice_label(t: ThemeChoice) -> &'static str {
    match t {
        ThemeChoice::System => "system",
        ThemeChoice::Light => "light",
        ThemeChoice::Dark => "dark",
    }
}

fn editor_theme_label(t: EditorTheme) -> &'static str {
    match t {
        EditorTheme::Github => "github",
        EditorTheme::GoogleDocs => "google_docs",
        EditorTheme::Word => "word",
    }
}

fn line_spacing_label(s: LineSpacing) -> &'static str {
    match s {
        LineSpacing::Standard => "standard",
        LineSpacing::Compact => "compact",
    }
}

/// Render a single-value response without the JSON quotes / braces.
/// Strings unquote, numbers stringify, everything else falls back to
/// the JSON shape.
fn scalar_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_env;
    use chan_workspace::SearchAggression;

    #[test]
    fn config_split_assignment_accepts_equals_form() {
        let (k, v) = split_assignment("editor.theme=dark", None).unwrap();
        assert_eq!(k, "editor.theme");
        assert_eq!(v, "dark");
    }

    #[test]
    fn config_split_assignment_accepts_two_args() {
        let (k, v) = split_assignment("editor.theme", Some("dark")).unwrap();
        assert_eq!(k, "editor.theme");
        assert_eq!(v, "dark");
    }

    #[test]
    fn config_split_assignment_rejects_empty_value() {
        // `chan config set editor.theme=` is the typo-with-trailing-`=`
        // form. We must refuse it so a bad invocation never wipes a
        // preference to "".
        let err = split_assignment("editor.theme=", None).unwrap_err();
        assert!(err.to_string().contains("must not be empty"));

        let err = split_assignment("editor.theme", Some("")).unwrap_err();
        assert!(err.to_string().contains("must not be empty"));
    }

    #[test]
    fn config_split_assignment_demands_a_value() {
        let err = split_assignment("editor.theme", None).unwrap_err();
        assert!(err.to_string().contains("missing value"));
    }

    #[test]
    fn config_read_then_write_round_trips_theme() {
        let mut prefs = EditorPrefs::default();
        write_pref_key(&mut prefs, "editor.theme", "dark").unwrap();
        assert_eq!(prefs.theme, ThemeChoice::Dark);
        let server = ServerConfig::default();
        let v = read_config_key(&prefs, &server, "editor.theme").unwrap();
        assert_eq!(v, serde_json::json!("dark"));
    }

    #[test]
    fn config_pane_width_round_trips_u32() {
        let mut prefs = EditorPrefs::default();
        write_pref_key(&mut prefs, "editor.pane_widths.search", "320").unwrap();
        assert_eq!(prefs.pane_widths.search, 320);
        let server = ServerConfig::default();
        let v = read_config_key(&prefs, &server, "editor.pane_widths.search").unwrap();
        assert_eq!(v, serde_json::json!(320));
    }

    #[test]
    fn config_server_paths_round_trip() {
        let editor = EditorPrefs::default();
        let mut server = ServerConfig::default();
        write_server_config_key(&mut server, "server.attachments_dir", "media/2026").unwrap();
        assert_eq!(server.attachments_dir, "media/2026");
        assert_eq!(
            read_config_key(&editor, &server, "server.attachments_dir").unwrap(),
            serde_json::json!("media/2026")
        );
    }

    #[test]
    fn config_search_aggression_round_trips() {
        let editor = EditorPrefs::default();
        let mut server = ServerConfig::default();
        write_server_config_key(&mut server, "server.search.aggression", "aggressive").unwrap();
        assert_eq!(server.search.aggression, SearchAggression::Aggressive);
        assert_eq!(
            read_config_key(&editor, &server, "server.search.aggression").unwrap(),
            serde_json::json!("aggressive")
        );
        let err =
            write_server_config_key(&mut server, "server.search.aggression", "turbo").unwrap_err();
        assert!(err
            .to_string()
            .contains("expected conservative|balanced|aggressive"));
    }

    #[test]
    fn config_transfer_stall_timeout_is_typed_and_nonzero() {
        let editor = EditorPrefs::default();
        let mut server = ServerConfig::default();
        let key = "server.transfer.stall_timeout_secs";
        assert_eq!(
            read_config_key(&editor, &server, key).unwrap(),
            serde_json::json!(300)
        );

        for timeout in [1, 42, u64::from(u32::MAX) + 1] {
            write_server_config_key(&mut server, key, &timeout.to_string()).unwrap();
            assert_eq!(server.transfer.stall_timeout_secs, timeout);
            assert_eq!(
                read_config_key(&editor, &server, key).unwrap(),
                serde_json::json!(timeout)
            );
        }

        let timeout = server.transfer.stall_timeout_secs;
        for invalid in ["0", "-1", "1.5", "not-a-number"] {
            let err = write_server_config_key(&mut server, key, invalid).unwrap_err();
            assert!(err.to_string().contains(key));
            if invalid == "0" {
                assert!(err.to_string().contains("greater than 0"));
            }
            assert_eq!(server.transfer.stall_timeout_secs, timeout);
        }
    }

    #[test]
    fn config_server_paths_reject_empty_values() {
        let mut server = ServerConfig::default();
        let err = write_server_config_key(&mut server, "server.attachments_dir", "").unwrap_err();
        assert!(err.to_string().contains("non-empty"));
    }

    #[test]
    fn config_write_rejects_bad_theme_value() {
        let mut prefs = EditorPrefs::default();
        let err = write_pref_key(&mut prefs, "editor.theme", "neon").unwrap_err();
        assert!(err.to_string().contains("system|light|dark"));
    }

    #[test]
    fn config_line_spacing_accepts_canonical_tokens() {
        let mut prefs = EditorPrefs::default();
        write_pref_key(&mut prefs, "editor.line_spacing", "standard").unwrap();
        assert_eq!(prefs.line_spacing, LineSpacing::Standard);
        write_pref_key(&mut prefs, "editor.line_spacing", "compact").unwrap();
        assert_eq!(prefs.line_spacing, LineSpacing::Compact);
    }

    #[test]
    fn config_line_spacing_accepts_legacy_tight_alias() {
        // Older CLI scripts and muscle memory may still pass
        // `tight`; treat it as `compact` rather than erroring so
        // `chan config set` doesn't break those callers. The read
        // path normalizes the value back to `compact` (see
        // `line_spacing_label`).
        let mut prefs = EditorPrefs::default();
        write_pref_key(&mut prefs, "editor.line_spacing", "tight").unwrap();
        assert_eq!(prefs.line_spacing, LineSpacing::Compact);
        assert_eq!(line_spacing_label(prefs.line_spacing), "compact");
    }

    #[test]
    fn config_line_spacing_rejects_unknown_value() {
        let mut prefs = EditorPrefs::default();
        let err = write_pref_key(&mut prefs, "editor.line_spacing", "sparse").unwrap_err();
        assert!(err.to_string().contains("standard|compact"));
    }

    #[test]
    fn config_line_spacing_label_round_trips() {
        // Read path: `chan config get editor.line_spacing` echoes
        // the canonical lowercase token, not the legacy `tight`.
        assert_eq!(line_spacing_label(LineSpacing::Standard), "standard");
        assert_eq!(line_spacing_label(LineSpacing::Compact), "compact");
    }

    #[test]
    fn config_write_rejects_bad_pane_width_value() {
        let mut prefs = EditorPrefs::default();
        let err = write_pref_key(&mut prefs, "editor.pane_widths.search", "-1").unwrap_err();
        let msg = format!("{err:#}");
        assert!(
            msg.contains("non-negative integer"),
            "expected validation error, got: {msg}"
        );
    }

    #[test]
    fn config_unknown_key_is_rejected() {
        let prefs = EditorPrefs::default();
        let server = ServerConfig::default();
        let err = read_config_key(&prefs, &server, "editor.nope").unwrap_err();
        assert!(err.to_string().contains("unknown key"));
        assert!(err.to_string().contains("server.terminal.secret_masking"));

        let mut prefs = EditorPrefs::default();
        let err = write_pref_key(&mut prefs, "editor.nope", "x").unwrap_err();
        assert!(err.to_string().contains("unknown key"));

        let mut server = ServerConfig::default();
        let err = write_server_config_key(&mut server, "server.nope", "x").unwrap_err();
        assert!(err.to_string().contains("unknown key"));
    }

    fn config_leaf_paths(value: &serde_json::Value) -> Vec<(String, serde_json::Value)> {
        fn walk(
            value: &serde_json::Value,
            prefix: &mut Vec<String>,
            leaves: &mut Vec<(String, serde_json::Value)>,
        ) {
            if let serde_json::Value::Object(fields) = value {
                for (name, value) in fields {
                    prefix.push(name.clone());
                    walk(value, prefix, leaves);
                    prefix.pop();
                }
            } else {
                leaves.push((prefix.join("."), value.clone()));
            }
        }

        let mut leaves = Vec::new();
        walk(value, &mut Vec::new(), &mut leaves);
        leaves
    }

    fn populated_config_for_coverage() -> (EditorPrefs, ServerConfig) {
        let mut shortcuts = std::collections::BTreeMap::new();
        shortcuts.insert(
            "workspace.open".into(),
            chan_server::ShortcutOverride {
                web: Some("Mod+O".into()),
                ..Default::default()
            },
        );
        let editor = EditorPrefs {
            editor_font_size: Some(20),
            terminal_colors: chan_server::TerminalColorPrefs {
                mode: chan_server::TerminalColorMode::Custom,
                custom: Some(chan_server::TerminalCustomColors {
                    background: "#112233".into(),
                    foreground: "#ddeeff".into(),
                    cursor: "#abcdef".into(),
                    contrast: chan_server::TerminalContrast::Auto,
                }),
            },
            hybrid_surface_themes: chan_server::HybridSurfaceThemes {
                editor: Some(chan_server::SurfaceThemeChoice::Dark),
                terminal: Some(chan_server::SurfaceThemeChoice::Light),
                browser: Some(chan_server::SurfaceThemeChoice::Dark),
                graph: Some(chan_server::SurfaceThemeChoice::Light),
                dashboard: Some(chan_server::SurfaceThemeChoice::Dark),
            },
            // Every palette leaf populated: an optional field left None
            // never reaches the dump and the coverage walk would skip it.
            graph_colors: chan_server::GraphColorPrefs {
                mode: chan_server::GraphColorMode::Custom,
                dark: Some(chan_server::GraphPalette {
                    doc: Some("#ff8a3d".into()),
                    source: Some("#4169e1".into()),
                    binary: Some("#5e5e62".into()),
                    img: Some("#b07dff".into()),
                    folder: Some("#8e8e93".into()),
                    tag: Some("#6cd07a".into()),
                    language: Some("#ff4db8".into()),
                    contact: Some("#e3b341".into()),
                }),
                light: Some(chan_server::GraphPalette {
                    doc: Some("#c25a1f".into()),
                    source: Some("#2851c4".into()),
                    binary: Some("#4e4e54".into()),
                    img: Some("#7a4cd8".into()),
                    folder: Some("#6c6c70".into()),
                    tag: Some("#2f9444".into()),
                    language: Some("#c71585".into()),
                    contact: Some("#9a6700".into()),
                }),
            },
            shortcuts,
            ..Default::default()
        };
        (editor, ServerConfig::default())
    }

    #[test]
    fn config_serialized_leafs_have_get_set_coverage() {
        let (editor, server) = populated_config_for_coverage();
        let dump = serde_json::to_value(ConfigOutput {
            editor: editor.clone(),
            server: server.clone(),
        })
        .unwrap();
        for (key, expected) in config_leaf_paths(&dump) {
            if key.starts_with("editor.shortcuts.") {
                continue;
            }
            let actual = read_config_key(&editor, &server, &key)
                .unwrap_or_else(|error| panic!("{key} is printed but not readable: {error}"));
            assert_eq!(actual, expected, "{key} read changed the serialized value");
            let raw = scalar_to_string(&expected);
            if key.starts_with("server.") {
                let mut updated = server.clone();
                write_server_config_key(&mut updated, &key, &raw)
                    .unwrap_or_else(|error| panic!("{key} is printed but not writable: {error}"));
            } else {
                let mut updated = editor.clone();
                write_pref_key(&mut updated, &key, &raw)
                    .unwrap_or_else(|error| panic!("{key} is printed but not writable: {error}"));
            }
        }

        assert_eq!(
            read_config_key(&editor, &server, "editor.shortcuts").unwrap(),
            dump["editor"]["shortcuts"]
        );
        let mut updated = editor.clone();
        let error = write_pref_key(&mut updated, "editor.shortcuts.workspace.open.web", "Mod+K")
            .unwrap_err();
        assert!(error.to_string().contains("collection"), "{error:#}");

        let mut updated = server;
        let error = write_server_config_key(
            &mut updated,
            "server.terminal.secret_mask_suffixes",
            "TOKEN",
        )
        .unwrap_err();
        assert!(error.to_string().contains("JSON string array"), "{error:#}");
    }

    #[test]
    fn config_schema_audit_rejects_an_unowned_serialized_leaf() {
        let (editor, server) = populated_config_for_coverage();
        let mut dump = serde_json::to_value(ConfigOutput { editor, server }).unwrap();
        dump["editor"]["future_leaf"] = serde_json::json!(true);
        let error = validate_config_dump(&dump).unwrap_err();
        let message = format!("{error:#}");
        assert!(message.contains("future_leaf"), "{message}");
        assert!(message.contains("no CLI policy"), "{message}");
    }

    #[test]
    fn config_terminal_alias_and_validation_are_typed() {
        let mut editor = EditorPrefs::default();
        let mut server = ServerConfig::default();
        write_server_config_key(&mut server, "terminal.secret_masking", "true").unwrap();
        assert!(server.terminal.secret_masking);
        assert_eq!(
            read_config_key(&editor, &server, "terminal.secret_masking").unwrap(),
            serde_json::json!(true)
        );

        let error =
            write_server_config_key(&mut server, "server.terminal.scrollback_mb", "9").unwrap_err();
        assert!(error.to_string().contains("10..=50"), "{error:#}");
        let error = write_server_config_key(&mut server, "server.terminal.secret_masking", "yes")
            .unwrap_err();
        assert!(error.to_string().contains("true|false"), "{error:#}");
        let error =
            write_server_config_key(&mut server, "server.terminal.session_cap", "0").unwrap_err();
        assert!(error.to_string().contains("greater than 0"), "{error:#}");
        let error = write_server_config_key(
            &mut server,
            "server.terminal.secret_mask_suffixes",
            "[\"TOKEN\",\"TOKEN\"]",
        )
        .unwrap_err();
        assert!(error.to_string().contains("duplicate"), "{error:#}");

        let error = write_pref_key(&mut editor, "editor.editor_font_size", "9").unwrap_err();
        assert!(error.to_string().contains("10..=32"), "{error:#}");
        let error = write_pref_key(
            &mut editor,
            "editor.terminal_colors.custom.background",
            "black",
        )
        .unwrap_err();
        assert!(error.to_string().contains("#rgb or #rrggbb"), "{error:#}");
    }

    #[test]
    fn config_graph_colors_set_from_default_materializes_the_subtree() {
        let mut editor = EditorPrefs::default();
        // The palette subtree does not exist in a default config; the
        // schema sample must carry enough of it for the write to land.
        write_pref_key(&mut editor, "editor.graph_colors.dark.doc", "#FF0000").unwrap();
        let dark = editor.graph_colors.dark.as_ref().unwrap();
        assert_eq!(dark.doc.as_deref(), Some("#ff0000"), "hex is normalized");
        assert_eq!(dark.source, None, "untouched hues stay absent");
        assert_eq!(
            editor.graph_colors.mode,
            chan_server::GraphColorMode::Standard
        );

        // The leaf reads back through the same key set the dump walks.
        let server = ServerConfig::default();
        let value = read_config_key(&editor, &server, "editor.graph_colors.dark.doc").unwrap();
        assert_eq!(value, serde_json::json!("#ff0000"));

        write_pref_key(&mut editor, "editor.graph_colors.mode", "custom").unwrap();
        assert_eq!(
            editor.graph_colors.mode,
            chan_server::GraphColorMode::Custom
        );
        let error = write_pref_key(&mut editor, "editor.graph_colors.mode", "bogus").unwrap_err();
        assert!(error.to_string().contains("standard|custom"), "{error:#}");
        let error =
            write_pref_key(&mut editor, "editor.graph_colors.light.tag", "chartreuse").unwrap_err();
        assert!(error.to_string().contains("#rgb or #rrggbb"), "{error:#}");
    }

    #[test]
    fn config_read_from_default_covers_skip_serialized_subtrees() {
        // A never-configured palette serializes no graph_colors subtree
        // at all (GraphColorPrefs::is_empty skips it wholesale), so the
        // read path must supply the serde defaults itself: standard mode,
        // null for every unset hue.
        let editor = EditorPrefs::default();
        let server = ServerConfig::default();
        for spec in CONFIG_KEYS
            .iter()
            .filter(|spec| spec.key.starts_with("editor.graph_colors."))
        {
            let value = read_config_key(&editor, &server, spec.key).unwrap();
            let expected = match spec.kind {
                ConfigValueKind::Enum(..) => serde_json::json!("standard"),
                _ => serde_json::Value::Null,
            };
            assert_eq!(value, expected, "{}", spec.key);
        }
        // Terminal custom colors ride the same fallback: the `custom`
        // table is skipped while unset, so its color leaves read null and
        // its contrast reads the serde default.
        let value =
            read_config_key(&editor, &server, "editor.terminal_colors.custom.background").unwrap();
        assert_eq!(value, serde_json::Value::Null);
        let value =
            read_config_key(&editor, &server, "editor.terminal_colors.custom.contrast").unwrap();
        assert_eq!(value, serde_json::json!("auto"));
    }

    #[test]
    fn terminal_profile_keys_read_empty_rather_than_erroring() {
        // Both skip-serialize while unset, so on a default config neither has
        // a leaf in the dump and both fell through to the schema sample, which
        // does not materialize them either. `chan config get` then failed on
        // two keys the CLI table and the config reference both advertise.
        let editor = EditorPrefs::default();
        let server = ServerConfig::default();
        assert_eq!(
            read_config_key(&editor, &server, "server.terminal.profiles").unwrap(),
            serde_json::json!([]),
            "an unset profile list reads as the empty list"
        );
        assert_eq!(
            read_config_key(&editor, &server, "server.terminal.default_profile").unwrap(),
            serde_json::Value::Null,
            "an unchosen default reads as null"
        );
    }

    #[test]
    fn config_no_key_dump_validates_with_a_custom_graph_palette() {
        // `chan config get` with no key runs validate_config_dump on the
        // live path: a palette leaf without a CONFIG_KEYS row breaks the
        // command for every user, not only the suite.
        let (editor, server) = populated_config_for_coverage();
        assert!(editor.graph_colors.dark.is_some());
        let dump = serde_json::to_value(ConfigOutput {
            editor: editor.clone(),
            server: server.clone(),
        })
        .unwrap();
        validate_config_dump(&dump).unwrap();
        // The populated fixture must exercise every palette key: count
        // the leaves under graph_colors so a new hue row can't silently
        // go uncovered.
        let palette_leaves = config_leaf_paths(&dump)
            .into_iter()
            .filter(|(key, _)| key.starts_with("editor.graph_colors."))
            .count();
        assert_eq!(palette_leaves, 17, "mode + 8 hues x 2 modes");
    }

    #[test]
    fn config_secret_masking_reads_null_until_it_is_set_and_none_clears_it() {
        let editor = EditorPrefs::default();
        let mut server = ServerConfig::default();
        assert_eq!(
            read_config_key(&editor, &server, "terminal.secret_masking").unwrap(),
            serde_json::Value::Null,
            "a config that never set terminal.secret_masking reads a choice for it"
        );

        write_server_config_key(&mut server, "terminal.secret_masking", "false").unwrap();
        assert_eq!(
            read_config_key(&editor, &server, "terminal.secret_masking").unwrap(),
            serde_json::json!(false)
        );

        let cleared = write_server_config_key(&mut server, "terminal.secret_masking", "none");
        assert!(cleared.is_ok(), "{cleared:?}");
        assert_eq!(
            read_config_key(&editor, &server, "terminal.secret_masking").unwrap(),
            serde_json::Value::Null
        );
    }

    #[test]
    fn config_secret_masking_false_and_true_persist_in_isolated_home() {
        let env = test_env::ChanTestEnv::new();
        assert!(!ServerConfig::default().terminal.secret_masking);

        cmd_config(ConfigAction::Set {
            key: "terminal.secret_masking".into(),
            value: Some("false".into()),
        })
        .unwrap();
        let path = env.home().join("server.toml");
        let saved = ServerConfig::load_from(&path).unwrap();
        assert!(!saved.terminal.secret_masking);

        cmd_config(ConfigAction::Set {
            key: "server.terminal.secret_masking".into(),
            value: Some("true".into()),
        })
        .unwrap();
        let saved = ServerConfig::load_from(&path).unwrap();
        assert!(saved.terminal.secret_masking);
    }
}
