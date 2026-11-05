# The gateway admin help prints the admin tokens it read from the environment

Status: shipped in [v0.124.0](../../release/release-v0.124.0.md).

Record before the release: raised by the owner on 2026-11-04 ("we already fixed that problem in chan's codebase, about the env: $VALUE leaking the token.. where is this new leak?"). [the-devserver-help-prints-the-tunnel-token-it-read-from-the-environment](the-devserver-help-prints-the-tunnel-token-it-read-from-the-environment.md) closed the same hazard for `CHAN_TUNNEL_TOKEN` in v0.112.0 (`8663d313b`) and did not touch the gateway admin CLI. Built in another of the owner's sessions on `fix/gateway-admin-help-hides-tokens` off `main` at `720b543c0` and merged into `v0124/int` as `3171aa86c`.

## What was seen

On 2026-11-04, `chan-gateway-admin --help` and `chan-gateway-admin flag --help` were run inside a deployed gateway container on v0.123.0 with its admin environment set. Both printed `[env: CHAN_ADMIN_PROFILE_TOKEN=<value>]`, `[env: CHAN_ADMIN_IDENTITY_TOKEN=<value>]` and `[env: CHAN_ADMIN_OPERATOR_TOKEN=<value>]` with the live bearers in place of `<value>`. Those three tokens count as exposed on that host; rotating them is the operator's work and outside this item.

## Evidence

Read at `main` `720b543c0`, gateway workspace 0.123.0. `gateway/crates/admin/src/main.rs` declares `profile_token`, `identity_token` and `operator_token` (the last with `visible_alias = "token"`) on `Cli` as `#[arg(long, global = true, env = "CHAN_ADMIN_*_TOKEN")]`, and none sets `hide_env_values = true`, so clap renders each as `[env: NAME=value]` with the variable's current value. All three are `global = true`, so every subcommand's help at any depth prints all three (`user --help`, `flag grant --help`, `help fleet`). The three URL arguments (`profile_url`, `workspace_url`, `identity_url`) carry no secret and their values in the help are informative. A `git grep -E 'env\s*=\s*"'` over the tree finds no other secret-carrying clap `env` argument; `CHAN_TUNNEL_TOKEN` is already hidden. The existing tests `legacy_token_flag_is_only_an_operator_alias` and `scoped_token_flags_remain_distinct` cover parsing only.

## Desired contract

No rendering of `chan-gateway-admin` help prints the value of `CHAN_ADMIN_PROFILE_TOKEN`, `CHAN_ADMIN_IDENTITY_TOKEN` or `CHAN_ADMIN_OPERATOR_TOKEN`, whatever the environment holds: `-h` and `--help` at the top level and on every subcommand at any depth, and the `help <subcommand>` form. Each entry still names its variable (`[env: CHAN_ADMIN_PROFILE_TOKEN]` and so on). The URL entries keep their values. Parsing is unchanged: the flags, the `--token` alias and the variables supply the bearers with the same precedence.

## Boundaries

The three attributes, their comment and one new test file, all in `gateway/crates/admin/`. Not changed: token parsing and precedence, the `--token` alias, the URL arguments, the admin `README.md` and `design.md` (they name the variables, not the rendering), the `chan` crate and the other gateway crates.

## Acceptance

1. With the three token variables set to any value, no help invocation prints any part of them, and each entry names its variable.
2. An integration test runs the built binary with a cleared environment holding sentinel tokens over `--help`, `-h`, `flag --help`, `flag grant --help`, `user create --help` and `help fleet`: red at the base, green at the tip, and red on that variable alone when any one attribute is removed. Its failure messages name the variable, never a sentinel.
3. `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test -p admin` green for the gateway workspace.
4. The built binary under `env -i` with sentinel tokens prints no sentinel for `--help` or `-h` and names each `[env: CHAN_ADMIN_*_TOKEN]` entry once; both exit 0.
5. The fix ships in the next gateway release.

## Built

`4987e655a`, fix(gateway-admin): hide the admin token values in help. `hide_env_values = true` on the three token arguments under one comment that their environment values are credentials, and `gateway/crates/admin/tests/help_hides_tokens.rs` (`help_names_token_variables_without_their_values`), which runs `CARGO_BIN_EXE_chan-gateway-admin` through `std::process::Command` with `env_clear()`, so no test mutates the process environment.

Verification recorded in the commit: red at the base on every invocation and variable, green with the fix, red on only that variable when any one attribute is removed; `make gateway-lint` (fmt, all-targets clippy with warnings denied, packaging pins) and `cargo test -p admin` green; the built binary under `env -i` prints no sentinel and names each variable once. On the integration branch, Gateway CI run 41927497248 at `038d82f42` ran the test green (`help_names_token_variables_without_their_values ... ok`) and finished green, and Gateway CI run 41962616428 at `3633e28d1` finished green with the whole gateway suite, its Postgres integration tests included.

Open: `make gateway-test` runs `--workspace --lib`, `-p devserver-proxy` and `--workspace --bins`, so the pre-push gate does not run the admin crate's integration tests; only Gateway CI's `cargo test --locked` does. A `cargo test --locked -p admin --tests` line in `gateway-test` would close that and is not made here.
