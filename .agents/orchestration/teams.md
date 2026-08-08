# Team Work

`cs terminal team` provisions a whole agent team into named terminal tabs from one config. The Team Work dialog in the SPA (Cmd+P) drives the same server path.

## Provisioning

`cs terminal team new <dir> --config <file>|--stdin [--brief FILE] [--mcp-env on|off] [--tabs] [--script]` validates the config, materializes the team directory, and spawns the members; `cs terminal team load <dir>` respawns an existing team. `--script` emits the whole flow as a paste-and-run shell script instead of executing it.

The config declares `team_name`, `host_name`, `host_handle`, `tab_group`, and 1 to 9 `[[members]]` with exactly one `is_lead`. Each member has a `handle` (its `$CHAN_TAB_NAME`), a `command`, optional `env`, and an optional `position = { row, col }` grid coordinate (what the dialog's split layout saves). The member's submit agent is derived from the command by whole-word match (claude, codex, gemini, kimi, opencode); a recognized `CHAN_AGENT` value in the member env overrides the sniff (an unrecognized value falls through to it), and no match means a plain shell member with no submit chord and no identity poke.

## The team directory

The team directory lives inside the workspace and is materialized through the `Workspace` write contract, so it is sandboxed, written atomically, and indexed and graphed like any other workspace content:

```text
{dir}/
  config.toml   the team config, hand-editable, revalidated on reload
  bootstrap.md  generated process doc, tool-owned
  tasks/        task-{from}-{to}-{n}.md, owned by the recipient, append-only
  journals/     journal-{member}.md, each member's append-only log
  followups/    followup-{from}-{to}-{n}.md, owned by the recipient
```

`bootstrap.md` is regenerated from `config.toml` on every write and is the authoritative coordination protocol for the team: hold-until-poked, the task-file and journal conventions, queue draining, the survey path to the host, and each member's poke chord. Hand edits to it are lost; round-specific instructions go in `--brief`, which is carried into the generated doc verbatim.

## Spawn flow

Members spawn lead-first, one tab per handle in the team's tab group (a live name collision falls back to `<group>-2`). Each agent receives its identity poke when its own PTY enables bracketed-paste mode; the spawn waits concurrently with a 15 second bound and exits non-zero naming any member that never became ready.

A positioned config surfaces as its pane grid, matching the dialog's split layout: the target window must hold a single pane (the seed the grid carves), or the spawn is refused before anything is written or spawned, naming the ways out (close the extra panes, `--tabs` to stack, or a fresh `--window`). A member-free grid cell receives the seed pane's existing tabs, so the host terminal that ran `cs terminal team` keeps a pane of its own; with no free cell it stays stacked in cell 0. An explicit `--pane` names the seed and skips the single-pane check; a windowless caller spawns unsurfaced as before.

## Conventions that keep a round sane

* Task files are owned by their recipient and append-only; once work starts, new asks become new tasks, not amendments.
* Journals are per-member and append-only.
* Workers route decisions to the lead; the lead aggregates and surveys the host.

The operational lessons behind these rules are in [../playbook.md](../playbook.md); the process-level view (roles, rounds, roadmap and release trees) is [`team/README.md`](../../team/README.md).
