# The team dialog's Load rewrites a hand-edited config

Status: accepted for v0.131.0 by the owner on 2026-11-15, by survey on the round's second batch of candidates ("Take all my recommendations", item 1 of `dev/v0131-team/reports/owner-candidates-2.md`); not started.

Record: found by the teamload row's review (note 3) and again by the round's documentation audit (item 8). The teamload row stopped `cs terminal team load --script` from rewriting `config.toml`; the dialog's Load is the same loss by another route.

## What is there now

Read at `a4c7fa631`.

- The workspace dialog's Load calls `api.writeTeamConfig(config.teamDir, wire, brief, config.configMode === "load")` (`web/packages/workspace-app/src/state/teamOrchestrator.svelte.ts`, about line 422). The last argument keeps an existing `bootstrap.md`; nothing keeps `config.toml`.
- `write_team_files` (`crates/chan-server/src/routes/team_config.rs:303-331`) serializes the parsed struct with `toml::to_string_pretty` and writes `{dir}/config.toml` on every call, so comments, key order and any key the struct does not model are dropped on each Load.
- The manual's teams page (`web/packages/marketing/src/pages/manual/teams.html`, the `config.toml` row near line 57) says the file "is checked again on every load" and does not say a dialog Load rewrites it.

## Desired contract

1. A Load from the dialog that does not change the team leaves an existing `config.toml` byte for byte.
2. Where the dialog lets the user change the team before a Load, what is written and what a hand edit loses is the build's to read and decide, and the manual says it in the code's words.
3. Creating a new team from the dialog writes `config.toml` as today.

## Boundaries

- The team config route and the orchestrator's call; the script path the teamload row fixed is not changed.
- Read first whether the dialog's Load can change any field of a loaded team, and say so in the closing section.

## Acceptance

1. A server test: a Load over a `config.toml` holding a comment, a custom key order and a key the struct does not model leaves the file byte for byte; red on `a4c7fa631`.
2. The orchestrator's test pins what it asks the route for on a Load and on a create.
3. The manual's `config.toml` row matches the code.
