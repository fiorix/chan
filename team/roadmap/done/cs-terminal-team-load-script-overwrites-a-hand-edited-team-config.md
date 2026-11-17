# cs terminal team load --script overwrites a hand-edited team config

Status: shipped in [v0.131.0](../../release/release-v0.131.0.md): `cs terminal team load --script` writes `config.toml` only where it is missing, as it does `bootstrap.md`, so a hand-edited config is left byte for byte, while a new team's script still writes the validated config (`v0131/teamload` at `9e21b6402` and `bacbf5917`, merged as `23e8ab515` and `5c36df56c`). Read by chan-server tests that run the generated script, with `cs` and `sleep` stubbed, over a hand-edited config and an empty destination, red at the base, with three mutations; `cargo test -p chan-server team` selects all three. A script run against a live team was not read.

Record before the release: accepted for v0.131.0 by the owner on 2026-11-14 (`dev/v0131/decisions.md`, point 11: "as you recommend"); not started.

Record: a follow-up of v0.130.0 with no row (its release record, "Follow-ups", the team load; `dev/v0130/reports/teamfix-1-handback.md`): `cs terminal team load --script` still rewrites `config.toml` from the parsed config, dropping its comments and formatting, and the new test's name is missed by a `cargo test team` filter. The decisions document for v0.131.0 sorted it as a row of its own; the owner took that recommendation.

## What is there now

Read at `f7457becb`, by reading.

- The load script's builder (`crates/chan-server/src/routes/team_config.rs`, around lines 630 to 680) serializes the validated config with `toml::to_string_pretty` and writes it into the script as an unconditional `cat <<'...' > "$chan_team_dir"/config.toml`. Comments, key order and any key the struct does not model are lost when the script runs over a hand-edited file.
- `bootstrap.md` already has a keep path (`keep_bootstrap`): v0.130.0 made the script write it only where it is missing.

## Desired contract

1. The load script writes `config.toml` only where it is missing, as it does `bootstrap.md`; an existing file is left byte for byte as it is.
2. A team created by the script from nothing still gets the validated config, and the load's validation is unchanged.
3. The test that pins this carries a name a `cargo test team` filter selects.

## Boundaries

- The script builder in `team_config.rs` and its tests.
- Not here: the interactive load, which writes no config, and the config's schema.

## Acceptance

1. Tests over the generated script, run in a temporary directory: with a hand-edited `config.toml` (a comment, a reordered key, an unmodelled key) the file is unchanged after the script; with none it is written. Red on today's code.
2. `cargo test -p chan-server team` selects the test.

## Built, 2026-11-14

The generated load script guards the `config.toml` heredoc with the same missing-file check as `bootstrap.md`. The guard uses `keep_bootstrap`, which distinguishes load from new: load keeps both existing files byte for byte, while new writes the config for the roster it starts. The dialog's separate re-save path still writes its config and preserves an existing bootstrap. Config parsing, validation, schema and the interactive load path are unchanged.

`team_load_script_keeps_a_hand_edited_config` executes the generated script over a config with a comment, reordered keys and an unmodelled key, then compares every byte. It also proves that a new script replaces that config. `team_load_script_writes_the_validated_config_where_none_exists` runs a load script in an empty destination and compares the written config with the validated source's serialization. Both use the existing shell runner with stubbed `cs` and `sleep`; directory names contain spaces. The existing bootstrap test is renamed `a_team_load_script_keeps_an_existing_bootstrap_and_writes_a_missing_one` so all three are selected by the `team` filter.

Before the fix, the preservation assertion failed with exit 101 while the other two tests passed. With the fix all three passed. Removing the config guard fails byte preservation; inverting it fails the missing-file assertion; applying it to new as well fails the replacement assertion. Each mutation exits 101 at the intended assertion, and each exact source restoration returns all three tests to green. Evidence is under `dev/v0131-team/evidence/Core131/teamload/`: `red.log` and `.rc`, `green.log` and `.rc`, the three mutation and restored logs/statuses, and `mutations.json` with source hashes. The first driver attempt is retained in `mutation-attempt1/`: the test failed as intended but Node's synchronous process API also reported `EPERM`; the corrected asynchronous driver preserves process-error checks.

The module and function docs, CLI load help, Team Work contract and manual team page describe the load/new file-writing distinction. The scoped committed-SHA gate is fmt, all-target server clippy, warning-denied server rustdoc, `cargo test --locked -p chan-server team`, and the control socket script tests by name. Its exact commands, statuses and cleanliness records are under the evidence directory's `gate/`. The full server suite and full web gate are left to the next integrated milestone gate.
