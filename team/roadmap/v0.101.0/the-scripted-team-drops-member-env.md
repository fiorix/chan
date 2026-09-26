# The scripted team form drops every member's env

Status: raised during v0.101.0 on 2026-09-26 by the independent review of the terminal env order (`dev/v0101-team/reviews/review-Runtime-2.md`, finding 4, in the development tree). A source reading against `main` at `cdd266b09`; not reproduced.

## What was seen

`cs terminal team new --script` emits the team's spawn flow as a shell script (`crates/chan-server/src/routes/team_config.rs:629-643`). Each member's line is a `cs terminal new` with the member's command and tab name and no `--env` at all, so every entry in the member's `env` table, `CHAN_AGENT` included, is dropped. The direct form and `cs terminal team load` pass the env through `registry.create` and derive the member's submit agent from it; the scripted form therefore spawns a member whose agent chord may differ from the one the roster records.

## Desired contract

A team spawned from the emitted script gets the same member env as the same config spawned directly.

## What to do

Emit one `--env KEY=VALUE` per member env entry in the script, quoted through the script's existing quoting helper, with a test that renders a member carrying `CHAN_AGENT` and a second key and finds both on its line. The validator's refusal of chan's own keys applies to the script's spawns as it does to the direct form.

## Boundaries

`crates/chan-server/src/routes/team_config.rs` (the script emitter and its tests) and the `--script` paragraph of `.agents/orchestration/teams.md`.
