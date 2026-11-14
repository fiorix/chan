# cs terminal team load --script overwrites a hand-edited team config

Status: accepted for v0.131.0 by the owner on 2026-11-14 (`dev/v0131/decisions.md`, point 11: "as you recommend"); not started.

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
