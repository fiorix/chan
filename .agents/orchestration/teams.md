# Team Work

`cs terminal team` provisions a whole agent team into named terminal tabs from one config; the Team Work dialog in the workspace app drives the same server path. The config schema is in [`docs/config-reference.md`](../../docs/config-reference.md) and the flags in `cs terminal team new --help`; this page holds the contract an agent relies on.

## Provisioning

`cs terminal team new <dir>` validates the config (`--config <file>` or `--stdin`), materializes the team directory and spawns the members; `cs terminal team load <dir>` respawns a saved team from its `config.toml` and regenerates nothing. `--brief FILE` folds a Markdown file verbatim into the generated bootstrap, `--mcp-env on|off` sets the team's MCP env toggle, and `--tabs` stacks the members in one pane instead of the config's grid. `--script` emits the whole flow as a paste-and-run shell script and mutates nothing: each member's `cs terminal new` line carries its `env` as `--env` entries, validated when the line runs, and the team directory is joined to `$PWD` once at the top, so run a generated script from the workspace root. A `load` script writes `bootstrap.md` only where none exists, so a saved team keeps the brief it was created with and any hand edits.

The config names `team_name`, `host_name`, `host_handle`, `tab_group` and one to nine `[[members]]` with exactly one `is_lead`. A member has a `handle` (its `$CHAN_TAB_NAME`), a `command`, an optional `env` and an optional `position = { row, col }` on a pane grid capped at nine panes. The submit agent is derived from the command by whole-word match (agy, claude, codex, gemini, kimi, muse, opencode); a recognized `CHAN_AGENT` in the member env overrides it, `none` or `shell` forces a plain shell member with no chord and no identity poke, and an unrecognized value falls through to the sniff. A member's `env` cannot set a key chan sets at spawn, except a `CHAN_TAB_NAME` equal to its own handle. That derivation sets the member's chord and what `cs terminal list` reports; `cs terminal write --submit` encodes whatever the sender names.

## The team directory

The directory lives inside the workspace and is written through the `Workspace` contract, so it is sandboxed, atomic, and indexed and graphed like any other content:

```text
{dir}/
  config.toml   the team config, hand-editable, revalidated on load
  bootstrap.md  generated process doc, tool-owned
  tasks/        task-{from}-{to}-{n}.md, owned by the recipient, append-only
  journals/     journal-{member}.md, each member's append-only log
  followups/    followup-{from}-{to}-{n}.md, owned by the recipient
```

`bootstrap.md` is regenerated from `config.toml` on every `new` (a load keeps an existing one) and is the authoritative coordination protocol for the team: hold until poked, the task-file and journal conventions, draining the queue between tasks, the survey path to the host, and each member's chord. Hand edits are lost; round-specific instructions go in `--brief`. Its paths are workspace-relative because the file is committed and shared like any workspace content and `load` respawns without regenerating it, so an absolute path would carry one machine's layout into every copy.

## Spawn flow

Members spawn lead-first, one tab per handle in the team's tab group; a live group collision falls back to a suffixed group name. Each agent receives its identity poke when its own PTY enables bracketed-paste mode; members wait concurrently under a bounded timeout, and a member that never becomes ready is named in the error. The poke names the absolute path of `bootstrap.md` and the directory its relative paths resolve against (the workspace root, where every member's terminal starts), computed on the host the agent runs on; the dialog's lead prompt and the `--script` form carry the same two paths.

A positioned config surfaces as its pane grid, so the target window must hold a single pane, the seed the grid carves; otherwise the spawn is refused before anything is written, naming the ways out (close the extra panes, `--tabs`, or a fresh window). A caller with no window spawns the team unsurfaced.

## Conventions that keep a round sane

- Task files are owned by their recipient and append-only; once work starts, new asks become new tasks, not amendments.
- Journals are per-member and append-only.
- Workers route decisions to the lead; the lead aggregates and surveys the host.

The operational lessons behind these rules are in [../playbook.md](../playbook.md); the process-level view (roles, rounds, the roadmap and release trees) is [`team/README.md`](../../team/README.md).
