//! Team Work config, persisted INSIDE the workspace.
//!
//! Backs the Team Work dialog's New/Load flow. The dialog persists
//! its full state under a user-chosen workspace-RELATIVE directory
//! `{dir}/` (e.g. `new-team-1` or `teams/alpha`). The on-disk layout
//! is:
//!
//! ```text
//! {dir}/
//!   config.toml   the TeamConfig (users may hand-edit; revalidated
//!                 on every reload)
//!   bootstrap.md  generated team-wide process doc (tool-owned;
//!                 regenerated from config.toml on every write)
//!   tasks/        task-{from}-{to}-{n}.md  (owned by `to`, append-only)
//!   journals/     journal-{member}.md      (owned by each member)
//!   followups/    followup-{from}-{to}-{n}.md (owned by `to`)
//! ```
//!
//! All file I/O routes through `Workspace::{read_text,write_text,
//! create_dir}`, so the team config lives inside the same sandbox +
//! atomic-write contract as notes content. `config.toml` and the
//! generated `.md` both pass the editable-text gate. This is the
//! reverse of the earlier design, which deliberately wrote the config
//! to a user-chosen ABSOLUTE path outside the sandbox via `std::fs`;
//! that exception is gone. The team's `.md` docs are now indexed +
//! graphed like any other workspace content.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chan_workspace::{Member, TeamConfig};
use serde::Deserialize;

use crate::error::{err, err_state};
use crate::state::AppState;

/// `POST /api/team-config/read` body. `dir` is workspace-relative.
#[derive(Deserialize)]
pub struct ReadTeamConfigPayload {
    pub dir: String,
}

/// `POST /api/team-config/write` body. `dir` is workspace-relative;
/// `config` mirrors the SPA's `TeamConfigWire` shape 1:1 (it IS
/// `chan_workspace::TeamConfig`). `brief_content` is the optional brief
/// folded verbatim into the generated `bootstrap.md` (the dialog reads the
/// file client-side and sends its text, mirroring the CLI's `--brief`).
#[derive(Deserialize)]
pub struct WriteTeamConfigPayload {
    pub dir: String,
    pub config: TeamConfig,
    #[serde(default)]
    pub brief_content: Option<String>,
}

/// Up-front guard so a bad `dir` produces a clean 400 message instead
/// of a sandbox error deeper in the write path. The Workspace sandbox
/// already refuses `..` traversal, so we only reject empty + absolute
/// here. Returns the trimmed dir on success.
fn require_relative_dir(dir: &str) -> Result<String, String> {
    let trimmed = dir.trim();
    if trimmed.is_empty() {
        return Err("team directory is required".into());
    }
    if trimmed.starts_with('/') {
        return Err(format!(
            "team directory must be workspace-relative, not absolute: {trimmed}"
        ));
    }
    Ok(trimmed.to_string())
}

/// Stamp `created_at` with the current time when the input config omitted
/// it. The SPA dialog always sends a timestamp; the CLI `cs terminal team
/// new` lets a hand-written config.toml omit it, so the server fills it in
/// here (RFC 3339 UTC, the survey.rs convention) before the config is
/// written or rendered into a `--script` bootstrap.
pub(crate) fn ensure_created_at(config: &mut TeamConfig) {
    if config.created_at.trim().is_empty() {
        config.created_at = chrono::Utc::now().to_rfc3339();
    }
}

/// Structural validation run on BOTH read and write. Returns the first
/// failure as a human-readable string that becomes the 400 body, so
/// the SPA's New/Load flow can surface it inline.
pub(crate) fn validate_team_config(config: &TeamConfig) -> Result<(), String> {
    if config.members.is_empty() || config.members.len() > 9 {
        return Err("team must have between 1 and 9 members".into());
    }
    let lead_count = config.members.iter().filter(|m| m.is_lead).count();
    if lead_count != 1 {
        return Err("exactly one member must be marked as lead".into());
    }
    if config.team_name.trim().is_empty() {
        return Err("team_name must not be empty".into());
    }
    if config.host_name.trim().is_empty() {
        return Err("host_name must not be empty".into());
    }
    if config.host_handle.trim().is_empty() {
        return Err("host_handle must not be empty".into());
    }
    if config.members.iter().any(|m| m.handle.trim().is_empty()) {
        return Err("every member must have a non-empty handle".into());
    }
    // The submit-encoding agent is no longer a stored field: it is DERIVED
    // from each member's command (+ a `CHAN_AGENT` env override) at use time,
    // so there is nothing to validate here. An unrecognized command simply
    // resolves to a shell member (no chord). See `member_agent`.
    Ok(())
}

/// The submit-encoding agent a member's terminal uses, derived from its
/// spawn command and an optional `CHAN_AGENT` env override. This is the
/// single source of truth (`chan_shell::SubmitAgent::derive`, mirrored by
/// `agentForMember` in the SPA). `None` is a shell member with no submit
/// chord. Returns the lower-case agent name for the roster/script text.
fn member_agent(m: &Member) -> Option<&'static str> {
    chan_shell::SubmitAgent::derive(&m.command, m.env.get("CHAN_AGENT").map(String::as_str))
        .map(chan_shell::SubmitAgent::name)
}

/// The submit chord a member's agent reads as "submit this buffer", as a
/// human-readable escape literal for the bootstrap poke note. Mirrors the
/// shared submit map (`chan_shell::apply_submit_chord` / submitMode.ts;
/// the chord is the agent's DEFAULT template, overridable at runtime):
/// claude uses the xterm
/// modifyOtherKeys Cmd+Enter CSI; gemini submits on a bare CR; codex and
/// opencode use bracketed paste followed by CR in one write
/// (codex coalesces a single `text + CR` write into a paste burst whose
/// trailing CR never submits), so a bare CR alone does NOT submit codex.
fn submit_chord_literal(agent: Option<&str>) -> &'static str {
    match agent {
        // codex and opencode use bracketed paste before the CR.
        Some("codex" | "opencode") => "bracketed-paste + \\r",
        Some("gemini") => "\\r",
        // claude is the default chord for any agent member; a shell member
        // (None) is not poked as an agent, so it falls through to the claude
        // literal only as a harmless default in the note.
        _ => "\\x1b[27;9;13~",
    }
}

/// `POST /api/team-config/read` - read `{dir}/config.toml`, parse +
/// validate it. 400 on missing file / invalid TOML / failed
/// validation so the Load flow surfaces the message inline.
pub async fn api_team_config_read(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<ReadTeamConfigPayload>,
) -> Response {
    let dir = match require_relative_dir(&payload.dir) {
        Ok(d) => d,
        Err(msg) => return err(StatusCode::BAD_REQUEST, msg),
    };
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    let result = tokio::task::spawn_blocking(move || read_team_config(&workspace, &dir)).await;
    match result {
        Ok(Ok(config)) => Json(config).into_response(),
        Ok(Err(msg)) => err(StatusCode::BAD_REQUEST, msg),
        Err(join) => err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
    }
}

/// `POST /api/team-config/write` - validate, create the `{dir}/` tree,
/// then write `config.toml` + the regenerated `bootstrap.md` through
/// the Workspace sandbox. 200 `{}` on success; 400 on bad dir / failed
/// validation / write failure.
pub async fn api_team_config_write(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<WriteTeamConfigPayload>,
) -> Response {
    let dir = match require_relative_dir(&payload.dir) {
        Ok(d) => d,
        Err(msg) => return err(StatusCode::BAD_REQUEST, msg),
    };
    let config = payload.config;
    let brief = payload.brief_content;
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    let result = tokio::task::spawn_blocking(move || {
        write_team_config(&workspace, &dir, &config, brief.as_deref())
    })
    .await;
    match result {
        Ok(Ok(())) => Json(serde_json::json!({})).into_response(),
        Ok(Err(msg)) => err(StatusCode::BAD_REQUEST, msg),
        Err(join) => err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
    }
}

pub(crate) fn read_team_config(
    workspace: &chan_workspace::Workspace,
    dir: &str,
) -> Result<TeamConfig, String> {
    let rel = format!("{dir}/config.toml");
    let text = workspace
        .read_text(&rel)
        .map_err(|e| format!("cannot read {rel}: {e}"))?;
    let config = toml::from_str::<TeamConfig>(&text)
        .map_err(|e| format!("invalid team config at {rel}: {e}"))?;
    validate_team_config(&config)?;
    Ok(config)
}

pub(crate) fn write_team_config(
    workspace: &chan_workspace::Workspace,
    dir: &str,
    config: &TeamConfig,
    brief: Option<&str>,
) -> Result<(), String> {
    validate_team_config(config)?;
    let toml_text =
        toml::to_string_pretty(config).map_err(|e| format!("cannot serialize team config: {e}"))?;

    // create_dir is create_dir_all, so creating the leaf subdirs also
    // materializes the `{dir}` parent. We still create `{dir}` first
    // for clarity and to fail early with a clean message on a bad path.
    for sub in [
        dir.to_string(),
        format!("{dir}/tasks"),
        format!("{dir}/journals"),
        format!("{dir}/followups"),
    ] {
        workspace
            .create_dir(&sub)
            .map_err(|e| format!("cannot create {sub}: {e}"))?;
    }

    let config_rel = format!("{dir}/config.toml");
    workspace
        .write_text(&config_rel, &toml_text)
        .map_err(|e| format!("cannot write {config_rel}: {e}"))?;

    let bootstrap_rel = format!("{dir}/bootstrap.md");
    let bootstrap = generate_bootstrap_md(dir, config, brief);
    workspace
        .write_text(&bootstrap_rel, &bootstrap)
        .map_err(|e| format!("cannot write {bootstrap_rel}: {e}"))?;

    Ok(())
}

/// Generate the team-wide `bootstrap.md` process doc from `config`.
/// Tool-owned artifact, regenerated on every write. ASCII only, no em
/// dashes. `team_dir` is the workspace-relative dir the team lives in.
/// Shared by the HTTP write path, the `cs terminal team` control-socket
/// handler, and the `--script` generator so there is one source of truth
/// for the bootstrap text (never a client-side regeneration).
pub(crate) fn generate_bootstrap_md(
    team_dir: &str,
    config: &TeamConfig,
    brief: Option<&str>,
) -> String {
    let team_name = &config.team_name;
    let host_handle = &config.host_handle;
    let host_name = &config.host_name;
    // Validation guarantees exactly one lead by the time a write
    // reaches here; fall back to the first member defensively so the
    // generator never panics on a hand-built config that skipped the
    // gate (e.g. a future direct caller).
    let lead = config
        .members
        .iter()
        .find(|m| m.is_lead)
        .or_else(|| config.members.first());
    let lead_handle = lead.map(|m| m.handle.as_str()).unwrap_or("@@Lead");

    let mut out = String::new();
    out.push_str(&format!("# {team_name} - team bootstrap\n\n"));
    out.push_str(&format!(
        "Generated for the {team_name} team. created_at: {}.\n\n",
        config.created_at
    ));

    out.push_str("## Who we are\n\n");
    out.push_str(&format!(
        "- Host: {host_handle} ({host_name}). The host sets scope and is the only\n  \
         one who acts outside the team; reach the host through {lead_handle}.\n"
    ));
    out.push_str(&format!(
        "- Lead: {lead_handle}. Distributes tasks, sequences the work, and\n  \
         aggregates requests for the host.\n\n"
    ));

    out.push_str("## Roster\n\n");
    out.push_str(&render_roster(config));
    out.push('\n');

    // The `--brief` file (or the dialog's brief field) folds in verbatim here,
    // after the Roster and before the generated process sections, so a round's
    // custom operating instructions survive a normal `new`/regenerate instead
    // of forcing the hand-author + `load` workaround. Outer whitespace is
    // trimmed so the section sits flush; an absent or blank brief emits
    // nothing (the boilerplate is augmented, never replaced).
    if let Some(brief) = brief {
        let brief = brief.trim();
        if !brief.is_empty() {
            out.push_str("## Brief\n\n");
            out.push_str(brief);
            out.push_str("\n\n");
        }
    }

    out.push_str("## How we work\n\n");
    out.push_str(&format!(
        "- Workers hold and wait for {lead_handle} to distribute tasks. Do not\n  \
         start until you are poked with your task path.\n"
    ));
    out.push_str(&format!(
        "- {lead_handle} cuts a task into {team_dir}/tasks/task-{{from}}-{{to}}-{{n}}.md\n  \
         (owned by the recipient, N is an atomic increment, append-only) and\n  \
         pokes the recipient.\n"
    ));
    out.push_str(&format!(
        "- On completion, cut a task back to {lead_handle} in the same place and\n  \
         format, then poke back.\n"
    ));
    out.push_str(&format!(
        "- Keep a running log in {team_dir}/journals/journal-{{your-name}}.md\n  \
         (owned by you, append-only).\n"
    ));
    out.push_str(&format!(
        "- Worker-to-host communication routes through {lead_handle} (see\n  \
         \"Reaching the host\" below); workers do not contact {host_handle} directly.\n\n"
    ));

    out.push_str("## Between tasks - drain your queue\n\n");
    out.push_str(
        "Pokes QUEUE in your terminal: `cs terminal write` feeds a per-tab FIFO\n\
         (bound 100). When you go idle (finish generating), consecutive\n\
         submitted pokes are delivered together in one chronological batch.\n\
         Read the entire batch before acting: later pokes may update or\n\
         supersede earlier ones. Rich Prompt and unsubmitted input stay\n\
         separate turns and form queue boundaries. There is no poll command -\n\
         the queue delivers to you.\n\n",
    );
    out.push_str(
        "Take real turn breaks to drain input when it is pending, or immediately\n\
         after a poke when a burst may still be arriving. This matters especially\n\
         for the lead, where every lane's pokes converge. At a safe checkpoint,\n\
         finish or park any active command, stop issuing tools, and yield/end the\n\
         turn so queued input can become the next prompt.\n\
         Do not simulate this with a sleep command.\n\
         The queue's idle signal is PTY output silence: stdout/stderr postpones\n\
         the drain, while a silent sleep may let bytes enter the terminal without\n\
         ending the active model turn that needs to consume them.\n\n\
         When nothing is pending and your brief defines a next step, CONTINUE;\n\
         waiting on an empty queue is a stall, not discipline. Never end a turn\n\
         solely to wait for input that may not exist.\n\n",
    );
    out.push_str("BEFORE you start the next task:\n\n");
    out.push_str(
        "1. Drain your queue - process EVERY pending poke that has arrived\n\
        \x20  (read + act/ack each). Don't start new work while pokes are still\n\
        \x20  pending.\n\
         2. Use the pause to reconcile what you're doing against what peers now\n\
        \x20  expect - a queued poke may be a correction, a re-scope, a \"my work\n\
        \x20  landed at sha X\", or a HOLD. Reconcile FIRST.\n\n",
    );
    out.push_str(
        "(To read another member's terminal, use `cs terminal scrollback\n\
         --tab-name=<their-tab>`.)\n\n",
    );

    out.push_str("## Reaching the host\n\n");
    out.push_str(&format!(
        "{lead_handle} reaches {host_handle} with `cs terminal survey` (a blocking\n\
         overlay in the host's window) whenever possible - decisions, status\n\
         checks, smoke requests - not only when a decision is needed. Never use a\n\
         TUI / in-editor survey (AskUserQuestion), and never survey the host from\n\
         a worker: workers cut their question to {lead_handle} (a task, or folded\n\
         into the completion task). {lead_handle} consolidates the open questions,\n\
         keeps each survey focused (one decision, up to 4 options), and batches or\n\
         sequences several pending questions rather than firing many tiny ones:\n\n"
    ));
    out.push_str(&format!(
        "    cs terminal survey --tab-name={host_handle} --title '<topic>' \\\n\
        \x20       --option '<a>' --option '<b>' $'<question / context, markdown>'\n\n"
    ));
    out.push_str(&format!(
        "`--tab-name` must match a live tab the host's WINDOW owns. When\n\
         {host_handle} has no member tab of their own, target the lead's tab\n\
         (`--tab-name={lead_handle}`) or the team's tab group instead; the overlay\n\
         surfaces in the owning window either way.\n\n"
    ));
    out.push_str(&format!(
        "The overlay is keyboard-first for the host: {host_handle} picks an option\n\
         with 1..N (or a click), presses F to follow up (a promise to answer\n\
         later in a separate prompt), or X to dismiss (Escape or the Dismiss\n\
         button do the same). The reply routed back to {lead_handle} says which:\n\
         an answer, a follow-up, or a dismissal (see `cs terminal survey --help`\n\
         for the current flags).\n\n"
    ));
    out.push_str(&format!(
        "IMPORTANT: an [F] follow-up means {host_handle} will follow up later in\n\
         a separate prompt. It is \"more is coming\", NOT an answer and NOT a\n\
         dismissal: do not act on the surveyed question until that follow-up\n\
         arrives.\n\n"
    ));

    out.push_str("## The poke 1-liner\n\n");
    out.push_str(
        "Pokes are one-line pointers, not fat context. The context lives in the\n\
         task file you point to.\n\n",
    );
    out.push_str(
        "    cs terminal write --tab-name=<target> --submit=<target-agent> \\\n\
        \x20       $'poke from <me>: <1-line>; read <path>'\n\n",
    );
    out.push_str(
        "`--submit=<target-agent>` makes the poke SUBMIT instead of parking in the\n\
         compose box. The server derives each target's real agent from that\n\
         session's spawn command and `CHAN_AGENT` spawn env (`CHAN_MODE` is read\n\
         by nothing) and applies THAT chord, so a mismatched name still fires and\n\
         the ack notes the correction; `cs terminal list` shows each session's\n\
         derived agent. The roster above records what each member runs:\n\n",
    );
    out.push_str(&render_poke_chords(config));
    out.push_str(
        "A shell member derives no agent and gets no chord ever: its trailing\n\
         newline is what submits, with or without --submit. Without --submit an\n\
         agent poke parks unsubmitted in the compose box.\n\n",
    );

    out.push_str("## Files\n\n");
    out.push_str(
        "- config.toml    the team config (you may hand-edit; revalidated on reload)\n\
         - bootstrap.md   this file (generated from config.toml)\n\
         - tasks/         task-{from}-{to}-{n}.md, owned by the recipient, append-only\n\
         - journals/      journal-{member}.md, owned by each member, append-only\n\
         - followups/     followup-{from}-{to}-{n}.md, owned by the recipient\n\n",
    );
    out.push_str(
        "Task and followup filenames use the bare name (handle without the @@),\n\
         e.g. tasks/task-Lead-Alice-1.md.\n",
    );

    out
}

/// The team's terminal group base: the explicit `tab_group`, else the team
/// name (matching the dialog's `defaultTabGroupFromPath` fallback intent).
/// Shared by the `--script` generator and the server-side spawner so both
/// agree on the base group; the spawner additionally resolves a live
/// collision by appending `-N`.
pub(crate) fn team_base_group(config: &TeamConfig) -> &str {
    if config.tab_group.trim().is_empty() {
        config.team_name.as_str()
    } else {
        config.tab_group.as_str()
    }
}

/// The lead-first spawn order: the lead, then the remaining members in roster
/// order, mirroring `teamOrchestrator.svelte.ts runTeamBootstrap`. Shared by
/// the `--script` generator (renders each member to shell) and the
/// server-side spawner (brings each up via the terminal registry) so both
/// reproduce the same team. Falls back to plain roster order when no member
/// is flagged lead (validation guarantees exactly one, but a direct caller
/// that skipped the gate must not panic).
pub(crate) fn lead_first_order(config: &TeamConfig) -> Vec<&Member> {
    let lead_idx = config.members.iter().position(|m| m.is_lead);
    let mut order: Vec<&Member> = Vec::with_capacity(config.members.len());
    if let Some(i) = lead_idx {
        order.push(&config.members[i]);
    }
    for (i, m) in config.members.iter().enumerate() {
        if Some(i) != lead_idx {
            order.push(m);
        }
    }
    order
}

/// Generate a paste-and-run bootstrap shell script for `config`, rooted at
/// the workspace-relative `team_dir`. This is the `--script` form of the
/// team bootstrap: run from a chan terminal at the workspace root it
/// recreates the WHOLE team using only the public `cs` surface plus plain
/// shell:
///
///   1. the `{dir}/{tasks,journals,followups}` tree,
///   2. `{dir}/config.toml` (the validated config),
///   3. `{dir}/bootstrap.md` (the server-generated process doc),
///   4. the lead-first agent spawn (`cs terminal new` + launch), then
///   5. an identity poke per agent (`cs terminal write --submit=<agent>`).
///
/// The config.toml + bootstrap.md bodies are generated here, server-side,
/// and emitted verbatim into quoted heredocs; the script only writes them,
/// so the bootstrap text is never regenerated client-side. The spawn order
/// mirrors `teamOrchestrator.svelte.ts runTeamBootstrap` (lead first).
/// ASCII only, no em dashes.
pub(crate) fn generate_bootstrap_script(
    team_dir: &str,
    config: &TeamConfig,
    brief: Option<&str>,
) -> String {
    let dir = team_dir.trim_end_matches('/');
    // The team's terminal group base. The `--script` form uses it verbatim
    // (a shell script cannot cheaply query the live registry); the
    // server-side spawner resolves collisions against it (-N). Shared so the
    // two paths agree on the base group.
    let group = team_base_group(config);
    let config_toml = toml::to_string_pretty(config)
        .unwrap_or_else(|e| format!("# failed to serialize team config: {e}\n"));
    let bootstrap_md = generate_bootstrap_md(dir, config, brief);

    let mut out = String::new();
    out.push_str("#!/usr/bin/env bash\n");
    out.push_str(&format!(
        "# Team bootstrap for {:?} ({dir}).\n",
        config.team_name
    ));
    out.push_str(
        "# Generated by `cs terminal team ... --script`. Paste-and-run from a chan\n\
         # terminal (one with $CHAN_CONTROL_SOCKET + $CHAN_WINDOW_ID set), at the\n\
         # workspace root so the relative paths resolve.\n",
    );
    out.push_str("set -euo pipefail\n\n");

    out.push_str("# 1. Team directory tree (workspace-relative).\n");
    out.push_str(&format!(
        "mkdir -p {0}/tasks {0}/journals {0}/followups\n\n",
        sh_squote(dir)
    ));

    out.push_str("# 2. config.toml (the validated team config).\n");
    out.push_str(&format!(
        "cat <<'CHAN_TEAM_CONFIG_EOF' > {}/config.toml\n",
        sh_squote(dir)
    ));
    out.push_str(&config_toml);
    if !config_toml.ends_with('\n') {
        out.push('\n');
    }
    out.push_str("CHAN_TEAM_CONFIG_EOF\n\n");

    out.push_str("# 3. bootstrap.md (server-generated team process doc).\n");
    out.push_str(&format!(
        "cat <<'CHAN_TEAM_BOOTSTRAP_EOF' > {}/bootstrap.md\n",
        sh_squote(dir)
    ));
    out.push_str(&bootstrap_md);
    if !bootstrap_md.ends_with('\n') {
        out.push('\n');
    }
    out.push_str("CHAN_TEAM_BOOTSTRAP_EOF\n\n");

    // Spawn order: lead first, then the rest in roster order, mirroring
    // runTeamBootstrap (the lead's pane is never momentarily empty in the
    // UI; the CLI just spawns fresh tabs in the same order). Shared with the
    // server-side spawner so both bring the team up in the same order.
    let order = lead_first_order(config);

    out.push_str("# 4. Spawn the team, lead first. Each tab's $CHAN_TAB_NAME is its handle.\n");
    for &m in &order {
        let role = if m.is_lead { "lead" } else { "worker" };
        let agent = member_agent(m).unwrap_or("shell");
        out.push_str(&format!("# --- {} ({role}, {agent}) ---\n", m.handle));
        out.push_str(&format!(
            "cs terminal new --tab-name={} --tab-group={}\n",
            sh_squote(&m.handle),
            sh_squote(group),
        ));
        if !m.command.trim().is_empty() {
            // Launch the member's command in the fresh tab; the agent (or
            // shell program) inherits $CHAN_TAB_NAME from the tab's env.
            out.push_str(&format!(
                "cs terminal write --tab-name={} $'{}\\n'\n",
                sh_squote(&m.handle),
                ansi_c_escape(&m.command),
            ));
        }
        out.push('\n');
    }

    out.push_str("# Approximate the server path's per-agent bracketed-paste readiness gate.\n");
    out.push_str("# This standalone script cannot observe server-owned PTY output.\n");
    out.push_str("sleep 3\n\n");

    out.push_str("# 5. Poke each agent its identity + the team process pointer. A shell\n");
    out.push_str("#    member has no compose box, so it gets no identity poke.\n");
    for &m in &order {
        let Some(agent) = member_agent(m) else {
            continue;
        };
        let prompt = identity_prompt(config, dir, m);
        // --submit makes the poke fire instead of parking in the compose
        // box; the server derives the target's chord at enqueue, and the
        // <agent> named here is the same derived roster value.
        out.push_str(&format!(
            "cs terminal write --tab-name={} --submit={agent} $'{}'\n",
            sh_squote(&m.handle),
            ansi_c_escape(&prompt),
        ));
    }

    out
}

/// The per-agent identity poke: a short prompt naming the team, the host,
/// and the lead, telling the agent who it is, and pointing it at the
/// generated `bootstrap.md` for the full roster + process. Personalized per
/// member (the CLI pokes each tab individually, unlike the SPA's single
/// lead-editor prompt). ASCII only. Shared by the `--script` generator and
/// the server-side spawner (the latter appends the agent's submit chord via
/// `apply_submit_chord`, the same bytes the script's `--submit` produces).
pub(crate) fn identity_prompt(config: &TeamConfig, team_dir: &str, member: &Member) -> String {
    let lead_handle = config
        .members
        .iter()
        .find(|m| m.is_lead)
        .map(|m| m.handle.as_str())
        .unwrap_or("@@Lead");
    let size = config.members.len();
    let mut out = String::new();
    out.push_str("# Team work\n");
    out.push_str(&format!(
        "You are {} on team {:?} (a team of {size}; host {}, lead {lead_handle}).\n",
        member.handle, config.team_name, config.host_handle,
    ));
    if member.is_lead {
        out.push_str(&format!(
            "Read the team process at {team_dir}/bootstrap.md, identify yourself, then \
             distribute the work and coordinate with {}.",
            config.host_handle,
        ));
    } else {
        out.push_str(&format!(
            "Read the team process at {team_dir}/bootstrap.md, identify yourself, then \
             wait for {lead_handle} to assign your task.",
        ));
    }
    out
}

/// Wrap `s` for a POSIX shell single-quoted context, escaping embedded
/// single quotes the standard `'\''` way so a handle/dir/command with odd
/// characters cannot break out of the quoting in the generated script.
fn sh_squote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// Escape `s` for a bash ANSI-C `$'...'` quoted context (the identity poke,
/// which carries newlines). Only backslash, single quote, and the
/// whitespace controls need escaping; `$` stays literal inside `$'...'`
/// (bash does no parameter expansion there), so a literal `$CHAN_TAB_NAME`
/// in a prompt survives to the agent.
fn ansi_c_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            _ => out.push(ch),
        }
    }
    out
}

/// Render the roster as a pure-ASCII table (handle | command | agent | role),
/// columns padded to content width, targeting <=80 cols. One row per member;
/// role is "lead" or "worker"; agent is the submit-encoding type ("shell" when
/// the member carries no agent) so members know which chord pokes each peer.
fn render_roster(config: &TeamConfig) -> String {
    const H_HANDLE: &str = "handle";
    const H_COMMAND: &str = "command";
    const H_AGENT: &str = "agent";
    const H_ROLE: &str = "role";

    let rows: Vec<(String, String, String, &'static str)> = config
        .members
        .iter()
        .map(|m| {
            let role = if m.is_lead { "lead" } else { "worker" };
            let agent = member_agent(m).unwrap_or("shell").to_string();
            (m.handle.clone(), m.command.clone(), agent, role)
        })
        .collect();

    let w_handle = rows
        .iter()
        .map(|(h, _, _, _)| h.len())
        .chain(std::iter::once(H_HANDLE.len()))
        .max()
        .unwrap_or(H_HANDLE.len());
    let w_command = rows
        .iter()
        .map(|(_, c, _, _)| c.len())
        .chain(std::iter::once(H_COMMAND.len()))
        .max()
        .unwrap_or(H_COMMAND.len());
    let w_agent = rows
        .iter()
        .map(|(_, _, a, _)| a.len())
        .chain(std::iter::once(H_AGENT.len()))
        .max()
        .unwrap_or(H_AGENT.len());
    let w_role = rows
        .iter()
        .map(|(_, _, _, r)| r.len())
        .chain(std::iter::once(H_ROLE.len()))
        .max()
        .unwrap_or(H_ROLE.len());

    let border = format!(
        "+{}+{}+{}+{}+\n",
        "-".repeat(w_handle + 2),
        "-".repeat(w_command + 2),
        "-".repeat(w_agent + 2),
        "-".repeat(w_role + 2),
    );

    let mut out = String::new();
    out.push_str(&border);
    out.push_str(&format!(
        "| {H_HANDLE:<w_handle$} | {H_COMMAND:<w_command$} | {H_AGENT:<w_agent$} | {H_ROLE:<w_role$} |\n"
    ));
    out.push_str(&border);
    for (handle, command, agent, role) in &rows {
        out.push_str(&format!(
            "| {handle:<w_handle$} | {command:<w_command$} | {agent:<w_agent$} | {role:<w_role$} |\n"
        ));
    }
    out.push_str(&border);
    out
}

/// Bullet list of `--submit=<agent>` -> chord for each distinct agent on the
/// roster, so a poker knows which encoding the target reads. Only the agent
/// types actually present are listed (a shell-only team gets the claude
/// default line so the doc still names the common chord).
fn render_poke_chords(config: &TeamConfig) -> String {
    let mut agents: Vec<&str> = config.members.iter().filter_map(member_agent).collect();
    agents.sort_unstable();
    agents.dedup();
    if agents.is_empty() {
        agents.push("claude");
    }
    let mut out = String::new();
    for agent in agents {
        out.push_str(&format!(
            "- {agent}: --submit={agent} (chord {})\n",
            submit_chord_literal(Some(agent))
        ));
    }
    out.push('\n');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chan_workspace::teams::Member;

    fn sample_config() -> TeamConfig {
        TeamConfig {
            team_name: "alpha".into(),
            host_name: "Neo".into(),
            host_handle: "@@Neo".into(),
            tab_group: "alpha".into(),
            auto_prefix_at: true,
            mcp_env: false,
            created_at: "2026-05-29T00:00:00Z".into(),
            members: vec![
                Member {
                    handle: "@@Lead".into(),
                    command: "claude".into(),
                    env: std::collections::BTreeMap::from([(
                        "CHAN_TAB_NAME".to_string(),
                        "@@Lead".to_string(),
                    )]),
                    is_lead: true,
                    position: None,
                },
                Member {
                    handle: "@@Alice".into(),
                    command: "codex".into(),
                    env: std::collections::BTreeMap::new(),
                    is_lead: false,
                    position: None,
                },
            ],
        }
    }

    fn test_workspace() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        Arc<chan_workspace::Workspace>,
    ) {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        // Keep the TempDirs alive for the duration of the test by
        // returning them alongside the workspace.
        (cfg, root, workspace)
    }

    #[test]
    fn write_then_read_round_trips_including_tab_group() {
        let (_cfg, _root, workspace) = test_workspace();
        let config = sample_config();

        write_team_config(&workspace, "new-team-1", &config, None).unwrap();
        let read = read_team_config(&workspace, "new-team-1").unwrap();

        assert_eq!(read, config, "read config must equal written config");
        assert_eq!(read.tab_group, "alpha", "tab_group must round-trip");
    }

    #[test]
    fn write_creates_config_bootstrap_and_subdirs() {
        let (_cfg, _root, workspace) = test_workspace();
        write_team_config(&workspace, "teams/alpha", &sample_config(), None).unwrap();

        assert!(workspace.exists("teams/alpha/config.toml"));
        assert!(workspace.exists("teams/alpha/bootstrap.md"));
        assert!(workspace.stat("teams/alpha/tasks").unwrap().is_dir);
        assert!(workspace.stat("teams/alpha/journals").unwrap().is_dir);
        assert!(workspace.stat("teams/alpha/followups").unwrap().is_dir);
    }

    #[test]
    fn bootstrap_contains_team_host_lead_and_poke_chord() {
        let (_cfg, _root, workspace) = test_workspace();
        write_team_config(&workspace, "new-team-1", &sample_config(), None).unwrap();
        let bootstrap = workspace.read_text("new-team-1/bootstrap.md").unwrap();

        assert!(bootstrap.contains("alpha"), "team name present");
        assert!(bootstrap.contains("@@Neo"), "host handle present");
        assert!(bootstrap.contains("@@Lead"), "lead handle present");
        assert!(
            bootstrap.contains("\\x1b[27;9;13~"),
            "poke submit chord literal present"
        );
        // Survey-first host comms: the lead surveys whenever possible,
        // not only on decisions, and the host's keys are documented.
        assert!(
            bootstrap.contains("whenever possible"),
            "survey-first 'whenever possible' language"
        );
        assert!(
            bootstrap.contains("picks an option\nwith 1..N"),
            "host 1..N pick documented"
        );
        assert!(
            bootstrap.contains("presses F to follow up"),
            "host F follow-up key documented"
        );
        assert!(
            bootstrap.contains("X to dismiss"),
            "host X dismiss key documented"
        );
        // The no-member-tab fallback: target a tab the host's window owns.
        assert!(
            bootstrap.contains("target the lead's tab"),
            "--tab-name fallback guidance present"
        );
        // The between-tasks queue-drain discipline is baked into every team.
        assert!(
            bootstrap.contains("## Between tasks - drain your queue"),
            "queue-drain section present"
        );
        assert!(
            bootstrap.contains("Drain your queue - process EVERY pending poke"),
            "queue-drain step 1 present"
        );
        assert!(
            bootstrap.contains("submitted pokes are delivered together"),
            "pending pokes are batched at idle"
        );
        assert!(
            bootstrap.contains("Read the entire batch before acting"),
            "batch reconciliation guidance present"
        );
        assert!(
            bootstrap.contains("Take real turn breaks to drain input when it is pending"),
            "conditional real turn-break guidance present"
        );
        assert!(
            bootstrap.contains("Do not simulate this with a sleep command"),
            "sleep is distinguished from yielding the active turn"
        );
        assert!(
            bootstrap.contains("queue's idle signal is PTY output silence"),
            "the implemented output-quiescence signal is documented"
        );
        // No em dashes; ASCII only.
        assert!(!bootstrap.contains('\u{2014}'), "no em dashes");
        assert!(bootstrap.is_ascii(), "bootstrap must be pure ASCII");
    }

    #[test]
    fn bootstrap_queue_guidance_continues_when_nothing_is_pending() {
        let bootstrap = generate_bootstrap_md("teams/alpha", &sample_config(), None);
        let queue_guidance = bootstrap
            .split_once("## Between tasks - drain your queue")
            .expect("queue guidance section")
            .1
            .split_once("## Reaching the host")
            .expect("queue guidance terminator")
            .0;
        let queue_guidance = queue_guidance
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");

        assert!(
            queue_guidance.contains("when it is pending")
                && queue_guidance.contains("immediately after a poke"),
            "turn breaks must be conditional on pending or newly arriving input"
        );
        assert!(
            !queue_guidance.contains("Take real turn breaks whenever a safe checkpoint permits"),
            "queue guidance must reject an unconditional turn-break directive"
        );
        assert!(
            queue_guidance.contains("for the lead, where every lane's pokes converge"),
            "queue guidance must retain the lead's converging traffic"
        );
        assert!(
            queue_guidance.contains("nothing is pending")
                && queue_guidance.contains("brief defines a next step")
                && queue_guidance.contains("CONTINUE")
                && queue_guidance.contains("empty queue is a stall"),
            "an empty queue must explicitly continue the brief instead of stalling"
        );
    }

    #[test]
    fn bootstrap_folds_brief_verbatim_after_roster() {
        let config = sample_config();
        let brief = "# Round 7\n\nRepro-first. Do NOT touch cli.rs.";
        let bootstrap = generate_bootstrap_md("teams/alpha", &config, Some(brief));
        // The brief is its own section with a stable heading, content verbatim.
        assert!(bootstrap.contains("## Brief\n\n"), "brief heading present");
        assert!(
            bootstrap.contains("Repro-first. Do NOT touch cli.rs."),
            "brief body folded verbatim"
        );
        // It lands AFTER the Roster and BEFORE the generated process sections,
        // augmenting (not replacing) them.
        let brief_at = bootstrap.find("## Brief").expect("brief section");
        let roster_at = bootstrap.find("## Roster").expect("roster section");
        let how_at = bootstrap
            .find("## How we work")
            .expect("how-we-work section");
        assert!(roster_at < brief_at, "brief after roster");
        assert!(brief_at < how_at, "brief before how-we-work");
        assert!(bootstrap.contains("## How we work"), "boilerplate retained");
    }

    #[test]
    fn bootstrap_omits_brief_section_when_absent_or_blank() {
        let config = sample_config();
        // No brief at all: no heading.
        let none = generate_bootstrap_md("teams/alpha", &config, None);
        assert!(
            !none.contains("## Brief"),
            "no brief section without a brief"
        );
        // A whitespace-only brief is treated as absent, not an empty section.
        let blank = generate_bootstrap_md("teams/alpha", &config, Some("   \n\n"));
        assert!(!blank.contains("## Brief"), "blank brief emits nothing");
    }

    #[test]
    fn write_team_config_persists_the_brief_into_bootstrap() {
        let (_cfg, _root, workspace) = test_workspace();
        write_team_config(
            &workspace,
            "new-team-1",
            &sample_config(),
            Some("Custom round instructions."),
        )
        .unwrap();
        let bootstrap = workspace.read_text("new-team-1/bootstrap.md").unwrap();
        assert!(bootstrap.contains("## Brief"), "brief section written");
        assert!(
            bootstrap.contains("Custom round instructions."),
            "brief body written verbatim"
        );
    }

    #[test]
    fn validate_rejects_zero_members() {
        let mut config = sample_config();
        config.members.clear();
        let err = validate_team_config(&config).unwrap_err();
        assert!(err.contains("between 1 and 9"), "got: {err}");
    }

    #[test]
    fn validate_rejects_ten_members() {
        let mut config = sample_config();
        // 10 members, exactly one lead, all handles non-empty.
        config.members = (0..10)
            .map(|i| Member {
                handle: format!("@@M{i}"),
                command: "claude".into(),
                env: std::collections::BTreeMap::new(),
                is_lead: i == 0,
                position: None,
            })
            .collect();
        let err = validate_team_config(&config).unwrap_err();
        assert!(err.contains("between 1 and 9"), "got: {err}");
    }

    #[test]
    fn agent_is_derived_from_command_in_roster_and_pokes() {
        // No stored agent field: a "claude"/"codex" command derives the agent.
        let mut config = sample_config();
        assert_eq!(member_agent(&config.members[0]), Some("claude"));
        assert_eq!(member_agent(&config.members[1]), Some("codex"));
        // CHAN_AGENT in the env overrides the command sniff.
        config.members[1]
            .env
            .insert("CHAN_AGENT".into(), "gemini".into());
        assert_eq!(member_agent(&config.members[1]), Some("gemini"));
        config.members[1]
            .env
            .insert("CHAN_AGENT".into(), "opencode".into());
        assert_eq!(member_agent(&config.members[1]), Some("opencode"));
        // A shell command derives no agent.
        config.members[1].command = "bash".into();
        config.members[1].env.remove("CHAN_AGENT");
        assert_eq!(member_agent(&config.members[1]), None);
    }

    #[test]
    fn bootstrap_roster_shows_agent_and_per_agent_poke_chords() {
        let (_cfg, _root, workspace) = test_workspace();
        write_team_config(&workspace, "new-team-1", &sample_config(), None).unwrap();
        let bootstrap = workspace.read_text("new-team-1/bootstrap.md").unwrap();

        // Roster carries the agent column + each member's agent value.
        assert!(bootstrap.contains("agent"), "roster agent column header");
        assert!(bootstrap.contains("codex"), "codex member agent in roster");

        // The poke section teaches the agent-correct --submit form with the
        // chord per the two distinct agents on the sample roster.
        assert!(
            bootstrap.contains("--submit=<target-agent>"),
            "poke uses --submit"
        );
        assert!(
            bootstrap.contains("--submit=claude (chord \\x1b[27;9;13~)"),
            "claude chord line"
        );
        assert!(
            bootstrap.contains("--submit=codex (chord bracketed-paste + \\r)"),
            "codex chord line reflects the bracketed-paste wrap"
        );
        // Still pure ASCII, no em dashes.
        assert!(bootstrap.is_ascii(), "bootstrap must be pure ASCII");
        assert!(!bootstrap.contains('\u{2014}'), "no em dashes");
    }

    #[test]
    fn bootstrap_describes_opencode_submit_encoding() {
        let mut config = sample_config();
        config.members[1].command = "opencode".into();
        let bootstrap = generate_bootstrap_md("new-team-1", &config, None);
        assert!(bootstrap.contains("opencode"), "opencode member in roster");
        assert!(
            bootstrap.contains("--submit=opencode (chord bracketed-paste + \\r)"),
            "opencode chord line reflects the bracketed-paste wrap"
        );
    }

    #[test]
    fn validate_rejects_zero_leads() {
        let mut config = sample_config();
        for m in &mut config.members {
            m.is_lead = false;
        }
        let err = validate_team_config(&config).unwrap_err();
        assert!(err.contains("exactly one member"), "got: {err}");
    }

    #[test]
    fn validate_rejects_two_leads() {
        let mut config = sample_config();
        for m in &mut config.members {
            m.is_lead = true;
        }
        let err = validate_team_config(&config).unwrap_err();
        assert!(err.contains("exactly one member"), "got: {err}");
    }

    #[test]
    fn read_errors_on_missing_config() {
        let (_cfg, _root, workspace) = test_workspace();
        let err = read_team_config(&workspace, "no-such-team").unwrap_err();
        assert!(
            err.contains("cannot read"),
            "expected read-failure message, got {err}"
        );
    }

    #[test]
    fn require_relative_dir_rejects_empty_and_absolute() {
        assert!(require_relative_dir("   ").is_err());
        assert!(require_relative_dir("/tmp/new-team-1").is_err());
        assert_eq!(require_relative_dir(" new-team-1 ").unwrap(), "new-team-1");
        assert_eq!(require_relative_dir("teams/alpha").unwrap(), "teams/alpha");
    }

    #[test]
    fn ensure_created_at_stamps_when_empty_and_preserves_otherwise() {
        let mut config = sample_config();
        config.created_at = String::new();
        ensure_created_at(&mut config);
        assert!(
            !config.created_at.trim().is_empty(),
            "an empty created_at gets stamped"
        );
        config.created_at = "2020-01-01T00:00:00Z".into();
        ensure_created_at(&mut config);
        assert_eq!(
            config.created_at, "2020-01-01T00:00:00Z",
            "a present created_at is left untouched"
        );
    }

    #[test]
    fn script_writes_tree_config_bootstrap_and_spawns_lead_first() {
        let script = generate_bootstrap_script("new-team-1", &sample_config(), None);
        assert!(script.starts_with("#!/usr/bin/env bash"), "shebang");
        assert!(script.contains("set -euo pipefail"), "fail-fast");
        // The dir tree.
        assert!(
            script.contains(
                "mkdir -p 'new-team-1'/tasks 'new-team-1'/journals 'new-team-1'/followups"
            ),
            "subdir tree: {script}"
        );
        // Both artifacts land via quoted heredocs (server-generated, no
        // client-side regeneration).
        assert!(
            script.contains("> 'new-team-1'/config.toml"),
            "config write"
        );
        assert!(
            script.contains("> 'new-team-1'/bootstrap.md"),
            "bootstrap write"
        );
        assert!(script.contains("CHAN_TEAM_CONFIG_EOF"), "config heredoc");
        assert!(
            script.contains("CHAN_TEAM_BOOTSTRAP_EOF"),
            "bootstrap heredoc"
        );
        // The config heredoc carries the serialized config; the bootstrap
        // heredoc carries the generated doc.
        assert!(
            script.contains("team_name = \"alpha\""),
            "serialized config"
        );
        assert!(script.contains("## Roster"), "generated bootstrap body");
        // Lead spawns before the worker.
        let lead_pos = script.find("--tab-name='@@Lead'").expect("lead spawn");
        let worker_pos = script.find("--tab-name='@@Alice'").expect("worker spawn");
        assert!(lead_pos < worker_pos, "lead spawns before the worker");
        // Each agent is spawned into the team group, its command launched,
        // and poked with its own submit chord.
        assert!(
            script.contains("cs terminal new --tab-name='@@Lead' --tab-group='alpha'"),
            "lead spawn line"
        );
        assert!(
            script.contains("cs terminal write --tab-name='@@Lead' $'claude\\n'"),
            "lead command launch"
        );
        assert!(script.contains("--submit=claude"), "claude submit chord");
        assert!(script.contains("--submit=codex"), "codex submit chord");
        assert!(
            script.contains(
                "# Approximate the server path's per-agent bracketed-paste readiness gate.\n\
# This standalone script cannot observe server-owned PTY output.\n\
sleep 3"
            ),
            "script labels its fixed wait as an approximation: {script}"
        );
    }

    #[test]
    fn script_is_pure_ascii_no_em_dashes() {
        let script = generate_bootstrap_script("teams/alpha", &sample_config(), None);
        assert!(script.is_ascii(), "script must be pure ASCII");
        assert!(!script.contains('\u{2014}'), "no em dashes");
    }

    #[test]
    fn script_skips_identity_poke_for_a_shell_member() {
        let mut config = sample_config();
        // Make the worker a shell member: a "bash" command derives no agent,
        // so it is launched but never poked an identity prompt (no compose
        // box / submit chord).
        config.members[1].handle = "@@Shell".into();
        config.members[1].command = "bash".into();
        let script = generate_bootstrap_script("new-team-1", &config, None);
        assert!(
            script.contains("--tab-name='@@Shell'"),
            "shell member spawned"
        );
        assert!(
            script.contains("cs terminal write --tab-name='@@Shell' $'bash\\n'"),
            "shell command launched"
        );
        assert!(
            !script.contains("--tab-name='@@Shell' --submit="),
            "a shell member must not get an identity poke: {script}"
        );
    }

    #[test]
    fn identity_prompt_addresses_the_member_and_points_at_bootstrap() {
        let config = sample_config();
        let lead_prompt = identity_prompt(&config, "new-team-1", &config.members[0]);
        assert!(lead_prompt.contains("You are @@Lead"), "names the member");
        assert!(
            lead_prompt.contains("new-team-1/bootstrap.md"),
            "points at bootstrap"
        );
        assert!(
            lead_prompt.contains("distribute the work"),
            "lead-specific guidance"
        );
        let worker_prompt = identity_prompt(&config, "new-team-1", &config.members[1]);
        assert!(worker_prompt.contains("You are @@Alice"));
        assert!(
            worker_prompt.contains("wait for @@Lead"),
            "worker waits for the lead"
        );
    }

    #[test]
    fn team_base_group_prefers_tab_group_then_team_name() {
        let mut config = sample_config();
        assert_eq!(team_base_group(&config), "alpha", "explicit tab_group wins");
        config.tab_group = "   ".into();
        assert_eq!(
            team_base_group(&config),
            "alpha",
            "blank tab_group falls back to team_name"
        );
        config.team_name = "squad".into();
        assert_eq!(team_base_group(&config), "squad");
    }

    #[test]
    fn lead_first_order_puts_the_lead_first() {
        // After the reverse below, @@Alice (worker) is first by index but
        // @@Lead is the lead, so the lead must come out front.
        let mut config = sample_config();
        config.members.reverse(); // worker now at index 0, lead at index 1
        let order = lead_first_order(&config);
        assert_eq!(order[0].handle, "@@Lead", "lead first regardless of index");
        assert_eq!(order[1].handle, "@@Alice");
        assert_eq!(order.len(), config.members.len());
    }

    #[test]
    fn sh_squote_escapes_embedded_single_quote() {
        assert_eq!(sh_squote("a'b"), "'a'\\''b'");
        assert_eq!(sh_squote("@@Lead"), "'@@Lead'");
    }

    #[test]
    fn ansi_c_escape_keeps_dollar_literal_and_encodes_controls() {
        // `$` stays literal (no bash expansion in $'...'); newline -> \n.
        assert_eq!(
            ansi_c_escape("You are $CHAN_TAB_NAME\nok"),
            "You are $CHAN_TAB_NAME\\nok"
        );
        // Backslash + single quote are escaped.
        assert_eq!(ansi_c_escape("a'b\\c"), "a\\'b\\\\c");
    }
}
