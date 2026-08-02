//! Trusted native command-launcher overlay.
//!
//! Workspace webviews contribute only bounded, serializable command
//! descriptors. The desktop owns the reusable `command-launcher` window, the
//! aggregate Computers bearer, and per-source drafts. Selecting a contextual
//! row routes its opaque id back to the source webview, which revalidates the
//! id against its live command catalog before running it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tokio::sync::oneshot;

use crate::{serve, AppState, LAUNCHER_RELOAD_BRIDGE_JS};

// Keep this outside the `main-*` launcher-window family. Those windows receive
// a different remote capability; an exact label prevents either authority set
// from bleeding into the other through a broad glob.
const OVERLAY_LABEL: &str = "command-launcher";
const UPDATED_EVENT: &str = "command-launcher-updated";
const EXECUTION_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_COMMANDS: usize = 256;
const MAX_DRAFT_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryMode {
    Contextual,
    Computers,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandScope {
    Tab,
    Pane,
    Window,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandDescriptorInput {
    id: String,
    title: String,
    category: String,
    #[serde(default)]
    keywords: Vec<String>,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    shortcut: Option<String>,
    #[serde(default)]
    accepts_arg: bool,
    #[serde(default)]
    confirm: Option<CommandConfirmInput>,
    scope: CommandScope,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommandConfirmInput {
    title: String,
    message: String,
    action_label: String,
    #[serde(default)]
    danger: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandConfirm {
    title: String,
    message: String,
    action_label: String,
    danger: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandDescriptor {
    id: String,
    title: String,
    category: String,
    keywords: Vec<String>,
    icon: Option<String>,
    shortcut: Option<String>,
    accepts_arg: bool,
    confirm: Option<CommandConfirm>,
    scope: CommandScope,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LauncherContextInput {
    commands: Vec<CommandDescriptorInput>,
    theme: String,
    #[serde(default)]
    accent: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherContext {
    commands: Vec<CommandDescriptor>,
    theme: String,
    accent: Option<String>,
    source_title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherSnapshot {
    entry_mode: EntryMode,
    draft: Value,
    draft_revision: u64,
    context: Option<LauncherContext>,
    source_alive: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct DraftKey {
    source_label: String,
    entry_mode: EntryMode,
}

#[derive(Debug, Clone)]
struct StoredDraft {
    revision: u64,
    value: Value,
}

#[derive(Debug, Clone)]
struct CurrentSession {
    source_label: String,
    entry_mode: EntryMode,
    request_id: String,
    context: Option<LauncherContext>,
    visible: bool,
}

struct PendingExecution {
    source_label: String,
    draft_key: DraftKey,
    item_id: String,
    title: String,
    reply: oneshot::Sender<Result<(), String>>,
}

#[derive(Default)]
struct HostInner {
    drafts: HashMap<DraftKey, StoredDraft>,
    current: Option<CurrentSession>,
    pending: HashMap<String, PendingExecution>,
}

#[derive(Default)]
pub struct CommandLauncherHost {
    inner: Mutex<HostInner>,
}

fn source_allowed(label: &str) -> bool {
    label == "main"
        || label.starts_with("control-terminal-")
        || serve::is_workspace_webview_label(label)
}

fn require_source(window: &WebviewWindow) -> Result<(), String> {
    if source_allowed(window.label()) && window.label() != OVERLAY_LABEL {
        Ok(())
    } else {
        Err("command launcher source is not an app window".into())
    }
}

fn require_overlay(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == OVERLAY_LABEL {
        Ok(())
    } else {
        Err("command is restricted to the trusted command overlay".into())
    }
}

fn draft_key(session: &CurrentSession) -> DraftKey {
    DraftKey {
        source_label: session.source_label.clone(),
        entry_mode: session.entry_mode,
    }
}

fn default_draft(mode: EntryMode) -> Value {
    json!({
        "version": 1,
        "visible": false,
        "query": "",
        "path": [],
        "selectedId": Value::Null,
        "scope": if mode == EntryMode::Computers { Value::String("computers".into()) } else { Value::Null },
        "operation": Value::Null,
        "contextChanged": false,
    })
}

fn set_visible(value: &mut Value, visible: bool) {
    if let Some(object) = value.as_object_mut() {
        object.insert("visible".into(), Value::Bool(visible));
    }
}

fn snapshot_locked(app: &AppHandle, inner: &mut HostInner) -> Result<LauncherSnapshot, String> {
    let session = inner
        .current
        .clone()
        .ok_or_else(|| "command launcher has no invoking window".to_string())?;
    let key = draft_key(&session);
    let stored = inner.drafts.entry(key).or_insert_with(|| StoredDraft {
        revision: 0,
        value: default_draft(session.entry_mode),
    });
    set_visible(&mut stored.value, session.visible);
    Ok(LauncherSnapshot {
        entry_mode: session.entry_mode,
        draft: stored.value.clone(),
        draft_revision: stored.revision,
        context: session.context,
        source_alive: app.get_webview_window(&session.source_label).is_some(),
    })
}

fn emit_snapshot(app: &AppHandle, host: &CommandLauncherHost) {
    let snapshot = {
        let mut inner = host.inner.lock().unwrap();
        snapshot_locked(app, &mut inner)
    };
    if let Ok(snapshot) = snapshot {
        let _ = app.emit_to(OVERLAY_LABEL, UPDATED_EVENT, snapshot);
    }
}

fn hide_current(app: &AppHandle, host: &CommandLauncherHost) {
    {
        let mut inner = host.inner.lock().unwrap();
        let key = inner.current.as_mut().map(|session| {
            session.visible = false;
            draft_key(session)
        });
        if let Some(key) = key {
            if let Some(stored) = inner.drafts.get_mut(&key) {
                set_visible(&mut stored.value, false);
                stored.revision = stored.revision.saturating_add(1);
            }
        }
    }
    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = overlay.hide();
    }
    emit_snapshot(app, host);
}

fn settle_background_draft(
    inner: &mut HostInner,
    key: &DraftKey,
    item_id: &str,
    title: &str,
    result: &Result<(), String>,
) {
    let current_is_visible = inner.current.as_ref().is_some_and(|session| {
        session.visible
            && session.source_label == key.source_label
            && session.entry_mode == key.entry_mode
    });
    if current_is_visible {
        return;
    }
    let stored = inner
        .drafts
        .entry(key.clone())
        .or_insert_with(|| StoredDraft {
            revision: 0,
            value: default_draft(key.entry_mode),
        });
    stored.revision = stored.revision.saturating_add(1);
    match result {
        Ok(()) => stored.value = default_draft(key.entry_mode),
        Err(message) => {
            set_visible(&mut stored.value, false);
            if let Some(object) = stored.value.as_object_mut() {
                object.insert(
                    "operation".into(),
                    json!({
                        "kind": "error",
                        "itemId": item_id,
                        "title": title,
                        "message": message,
                        "selected": "back",
                    }),
                );
            }
        }
    }
}

fn position_over_source(overlay: &WebviewWindow, source: &WebviewWindow) -> Result<(), String> {
    let position = source
        .outer_position()
        .map_err(|e| format!("reading invoking-window position: {e}"))?;
    let size = source
        .outer_size()
        .map_err(|e| format!("reading invoking-window size: {e}"))?;
    overlay
        .set_position(PhysicalPosition::new(position.x, position.y))
        .map_err(|e| format!("positioning command overlay: {e}"))?;
    overlay
        .set_size(PhysicalSize::new(size.width, size.height))
        .map_err(|e| format!("sizing command overlay: {e}"))?;
    Ok(())
}

fn ensure_overlay(
    app: &AppHandle,
    app_state: &AppState,
    source: &WebviewWindow,
) -> Result<WebviewWindow, String> {
    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        position_over_source(&overlay, source)?;
        return Ok(overlay);
    }
    let embedded = app_state
        .embedded()
        .ok_or_else(|| "embedded launcher server is not ready".to_string())?;
    let raw_url = format!(
        "http://{}/?t={}&command=1",
        embedded.addr(),
        embedded.launcher_token()
    );
    let url = raw_url
        .parse::<tauri::Url>()
        .map_err(|e| format!("building command overlay URL: {e}"))?;
    let overlay = WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::External(url))
        .title("Command Launcher")
        .initialization_script(LAUNCHER_RELOAD_BRIDGE_JS)
        .visible(false)
        .focused(true)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .resizable(false)
        .build()
        .map_err(|e| format!("building command overlay: {e}"))?;
    position_over_source(&overlay, source)?;

    let app_for_event = app.clone();
    let overlay_for_event = overlay.clone();
    overlay.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let host = app_for_event.state::<Arc<CommandLauncherHost>>();
            hide_current(&app_for_event, &host);
        }
        WindowEvent::Focused(false) => {
            let host = app_for_event.state::<Arc<CommandLauncherHost>>();
            hide_current(&app_for_event, &host);
        }
        WindowEvent::Destroyed => {
            let host = app_for_event.state::<Arc<CommandLauncherHost>>();
            let mut inner = host.inner.lock().unwrap();
            if let Some(session) = inner.current.as_mut() {
                session.visible = false;
            }
        }
        _ => {}
    });
    // Keep the clone captured above alive for the event callback on backends
    // that release the original handle immediately after this function.
    let _ = overlay_for_event;
    Ok(overlay)
}

fn request_context(source: &WebviewWindow, request_id: &str) {
    let id = serde_json::to_string(request_id).unwrap_or_else(|_| "\"\"".into());
    let js = format!(
        "window.dispatchEvent(new CustomEvent('chan:launcher-request', {{detail: {{requestId: {id}}}}}));"
    );
    let _ = source.eval(&js);
}

fn clean_text(raw: String, max_chars: usize, field: &str) -> Result<String, String> {
    let value = raw.trim().to_string();
    if value.is_empty() || value.chars().count() > max_chars || value.chars().any(char::is_control)
    {
        return Err(format!("invalid command {field}"));
    }
    Ok(value)
}

fn clean_optional(
    raw: Option<String>,
    max_chars: usize,
    field: &str,
) -> Result<Option<String>, String> {
    raw.map(|value| clean_text(value, max_chars, field))
        .transpose()
}

fn clean_accent(raw: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = raw else { return Ok(None) };
    let bytes = value.as_bytes();
    if bytes.len() != 7 || bytes[0] != b'#' || !bytes[1..].iter().all(u8::is_ascii_hexdigit) {
        return Err("invalid launcher accent".into());
    }
    Ok(Some(value.to_ascii_lowercase()))
}

fn clean_descriptor(input: CommandDescriptorInput) -> Result<CommandDescriptor, String> {
    if input.keywords.len() > 16 {
        return Err("too many command keywords".into());
    }
    let keywords = input
        .keywords
        .into_iter()
        .map(|word| clean_text(word, 64, "keyword"))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(CommandDescriptor {
        id: clean_text(input.id, 256, "id")?,
        title: clean_text(input.title, 160, "title")?,
        category: clean_text(input.category, 48, "category")?,
        keywords,
        icon: clean_optional(input.icon, 32, "icon")?,
        shortcut: clean_optional(input.shortcut, 48, "shortcut")?,
        accepts_arg: input.accepts_arg,
        confirm: input
            .confirm
            .map(|confirm| -> Result<CommandConfirm, String> {
                Ok(CommandConfirm {
                    title: clean_text(confirm.title, 256, "confirmation title")?,
                    message: clean_text(confirm.message, 1024, "confirmation message")?,
                    action_label: clean_text(confirm.action_label, 128, "confirmation action")?,
                    danger: confirm.danger,
                })
            })
            .transpose()?,
        scope: input.scope,
    })
}

fn clean_context(
    source_title: String,
    input: LauncherContextInput,
) -> Result<LauncherContext, String> {
    if input.commands.len() > MAX_COMMANDS {
        return Err("too many launcher commands".into());
    }
    let theme = match input.theme.as_str() {
        "light" | "dark" => input.theme,
        _ => return Err("invalid launcher theme".into()),
    };
    let commands = input
        .commands
        .into_iter()
        .map(clean_descriptor)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(LauncherContext {
        commands,
        theme,
        accent: clean_accent(input.accent)?,
        source_title: clean_text(source_title, 160, "source title")?,
    })
}

fn validate_draft(value: &Value) -> Result<(), String> {
    let bytes =
        serde_json::to_vec(value).map_err(|e| format!("serializing launcher draft: {e}"))?;
    if bytes.len() > MAX_DRAFT_BYTES {
        return Err("launcher draft is too large".into());
    }
    let object = value
        .as_object()
        .ok_or_else(|| "launcher draft must be an object".to_string())?;
    if object.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("unsupported launcher draft version".into());
    }
    if object
        .get("query")
        .and_then(Value::as_str)
        .map(|query| query.chars().count() > 2048)
        .unwrap_or(true)
    {
        return Err("invalid launcher query".into());
    }
    Ok(())
}

#[tauri::command]
pub fn open_command_launcher(
    entry_mode: EntryMode,
    app: AppHandle,
    window: WebviewWindow,
    app_state: State<'_, Arc<AppState>>,
    host: State<'_, Arc<CommandLauncherHost>>,
) -> Result<(), String> {
    require_source(&window)?;
    let request_id = uuid::Uuid::new_v4().to_string();
    {
        let mut inner = host.inner.lock().unwrap();
        let previous_context = inner.current.as_ref().and_then(|session| {
            (session.source_label == window.label())
                .then(|| session.context.clone())
                .flatten()
        });
        let session = CurrentSession {
            source_label: window.label().to_string(),
            entry_mode,
            request_id: request_id.clone(),
            context: previous_context,
            visible: true,
        };
        let key = draft_key(&session);
        let stored = inner.drafts.entry(key).or_insert_with(|| StoredDraft {
            revision: 0,
            value: default_draft(entry_mode),
        });
        set_visible(&mut stored.value, true);
        stored.revision = stored.revision.saturating_add(1);
        inner.current = Some(session);
    }

    let overlay = ensure_overlay(&app, &app_state, &window)?;
    overlay
        .show()
        .map_err(|e| format!("showing command overlay: {e}"))?;
    overlay
        .set_focus()
        .map_err(|e| format!("focusing command overlay: {e}"))?;
    emit_snapshot(&app, &host);
    if entry_mode == EntryMode::Contextual && window.label() != "main" {
        request_context(&window, &request_id);
    }
    Ok(())
}

#[tauri::command]
pub fn command_launcher_source_ready(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, Arc<CommandLauncherHost>>,
) -> Result<(), String> {
    require_source(&window)?;
    let request_id = host
        .inner
        .lock()
        .unwrap()
        .current
        .as_ref()
        .and_then(|session| {
            (session.source_label == window.label() && session.entry_mode == EntryMode::Contextual)
                .then(|| session.request_id.clone())
        });
    if let Some(request_id) = request_id {
        if let Some(source) = app.get_webview_window(window.label()) {
            request_context(&source, &request_id);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn submit_command_launcher_context(
    request_id: String,
    context: LauncherContextInput,
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, Arc<CommandLauncherHost>>,
) -> Result<(), String> {
    require_source(&window)?;
    let source_title = window.title().unwrap_or_else(|_| "Chan".into());
    let context = clean_context(source_title, context)?;
    {
        let mut inner = host.inner.lock().unwrap();
        let session = inner
            .current
            .as_mut()
            .ok_or_else(|| "command launcher is not active".to_string())?;
        if session.source_label != window.label() || session.request_id != request_id {
            return Err("stale command launcher context".into());
        }
        session.context = Some(context);
    }
    emit_snapshot(&app, &host);
    Ok(())
}

#[tauri::command]
pub fn command_launcher_snapshot(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, Arc<CommandLauncherHost>>,
) -> Result<LauncherSnapshot, String> {
    require_overlay(&window)?;
    snapshot_locked(&app, &mut host.inner.lock().unwrap())
}

#[tauri::command]
pub fn save_command_launcher_draft(
    revision: u64,
    mut draft: Value,
    window: WebviewWindow,
    host: State<'_, Arc<CommandLauncherHost>>,
) -> Result<(), String> {
    require_overlay(&window)?;
    validate_draft(&draft)?;
    let mut inner = host.inner.lock().unwrap();
    let session = inner
        .current
        .clone()
        .ok_or_else(|| "command launcher has no invoking window".to_string())?;
    set_visible(&mut draft, session.visible);
    let stored = inner
        .drafts
        .entry(draft_key(&session))
        .or_insert_with(|| StoredDraft {
            revision: 0,
            value: default_draft(session.entry_mode),
        });
    if revision >= stored.revision {
        stored.revision = revision;
        stored.value = draft;
    }
    Ok(())
}

#[tauri::command]
pub fn hide_command_launcher(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, Arc<CommandLauncherHost>>,
) -> Result<(), String> {
    require_overlay(&window)?;
    hide_current(&app, &host);
    Ok(())
}

#[tauri::command]
pub async fn execute_command_launcher_item(
    command_id: String,
    arg: Option<String>,
    item_id: String,
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, Arc<CommandLauncherHost>>,
) -> Result<(), String> {
    require_overlay(&window)?;
    if arg
        .as_ref()
        .is_some_and(|value| value.chars().count() > 2048)
    {
        return Err("command argument is too long".into());
    }
    let item_id = clean_text(item_id, 512, "deck item id")?;
    let (session, descriptor) = {
        let inner = host.inner.lock().unwrap();
        let session = inner
            .current
            .clone()
            .ok_or_else(|| "command launcher has no invoking window".to_string())?;
        let descriptor = session
            .context
            .as_ref()
            .and_then(|context| {
                context
                    .commands
                    .iter()
                    .find(|command| command.id == command_id)
            })
            .cloned()
            .ok_or_else(|| "command is no longer available in the invoking window".to_string())?;
        (session, descriptor)
    };
    if arg.is_some() && !descriptor.accepts_arg {
        return Err("this command does not accept an argument".into());
    }
    let source = app
        .get_webview_window(&session.source_label)
        .ok_or_else(|| "the invoking window is no longer open".to_string())?;
    let execution_id = uuid::Uuid::new_v4().to_string();
    let execution_key = draft_key(&session);
    let (reply, result) = oneshot::channel();
    host.inner.lock().unwrap().pending.insert(
        execution_id.clone(),
        PendingExecution {
            source_label: session.source_label.clone(),
            draft_key: execution_key.clone(),
            item_id: item_id.clone(),
            title: descriptor.title.clone(),
            reply,
        },
    );
    let detail = json!({
        "requestId": session.request_id,
        "executionId": execution_id,
        "commandId": command_id,
        "arg": arg,
    });
    let js = format!(
        "window.dispatchEvent(new CustomEvent('chan:launcher-execute', {{detail: {detail}}}));"
    );
    if let Err(error) = source.eval(&js) {
        host.inner.lock().unwrap().pending.remove(&execution_id);
        let result = Err(format!("routing command to invoking window: {error}"));
        settle_background_draft(
            &mut host.inner.lock().unwrap(),
            &execution_key,
            &item_id,
            &descriptor.title,
            &result,
        );
        return result;
    }
    match tokio::time::timeout(EXECUTION_TIMEOUT, result).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("the invoking window closed before completing the command".into()),
        Err(_) => {
            host.inner.lock().unwrap().pending.remove(&execution_id);
            let result = Err("the invoking window did not acknowledge the command".into());
            settle_background_draft(
                &mut host.inner.lock().unwrap(),
                &execution_key,
                &item_id,
                &descriptor.title,
                &result,
            );
            result
        }
    }
}

#[tauri::command]
pub fn finish_command_launcher_execution(
    execution_id: String,
    error: Option<String>,
    window: WebviewWindow,
    host: State<'_, Arc<CommandLauncherHost>>,
) -> Result<(), String> {
    require_source(&window)?;
    let pending = host
        .inner
        .lock()
        .unwrap()
        .pending
        .remove(&execution_id)
        .ok_or_else(|| "unknown command launcher execution".to_string())?;
    if pending.source_label != window.label() {
        return Err("command launcher execution source changed".into());
    }
    let result = match error {
        Some(message) => Err(clean_text(message, 512, "execution error")?),
        None => Ok(()),
    };
    settle_background_draft(
        &mut host.inner.lock().unwrap(),
        &pending.draft_key,
        &pending.item_id,
        &pending.title,
        &result,
    );
    let _ = pending.reply.send(result);
    Ok(())
}

/// Drop app-local drafts when a logical source window really closes. Watcher
/// hide/reopen destroys and recreates a native window, so its caller invokes
/// this only after confirming the record was not merely buried.
pub fn source_destroyed(app: &AppHandle, label: &str) {
    let host = app.state::<Arc<CommandLauncherHost>>();
    let mut replies = Vec::new();
    let was_current = {
        let mut inner = host.inner.lock().unwrap();
        inner.drafts.retain(|key, _| key.source_label != label);
        let execution_ids: Vec<String> = inner
            .pending
            .iter()
            .filter(|(_, pending)| pending.source_label == label)
            .map(|(id, _)| id.clone())
            .collect();
        for id in execution_ids {
            if let Some(pending) = inner.pending.remove(&id) {
                replies.push(pending.reply);
            }
        }
        let current = inner
            .current
            .as_ref()
            .is_some_and(|session| session.source_label == label);
        if current {
            inner.current = None;
        }
        current
    };
    for reply in replies {
        let _ = reply.send(Err("the invoking window closed".into()));
    }
    if was_current {
        if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
            let _ = overlay.hide();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_rejects_computers_scope_by_type_and_bad_accent() {
        let input = LauncherContextInput {
            commands: vec![],
            theme: "dark".into(),
            accent: Some("red".into()),
        };
        assert!(clean_context("Window".into(), input).is_err());
    }

    #[test]
    fn draft_is_bounded_and_versioned() {
        assert!(validate_draft(&json!({"version": 1, "query": "ok"})).is_ok());
        assert!(validate_draft(&json!({"version": 2, "query": "ok"})).is_err());
        assert!(validate_draft(&json!({"version": 1, "query": "x".repeat(2049)})).is_err());
    }

    #[test]
    fn source_labels_exclude_the_trusted_overlay() {
        assert!(source_allowed("workspace-abc-1"));
        assert!(source_allowed("control-terminal-dev"));
        assert!(!source_allowed(OVERLAY_LABEL));
    }
}
