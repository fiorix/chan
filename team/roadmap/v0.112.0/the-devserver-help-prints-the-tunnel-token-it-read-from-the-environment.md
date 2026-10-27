# The devserver help prints the tunnel token it read from the environment

Status: raised on 2026-10-26 by the owner during the v0.112.0 round; accepted into the round by the owner's word in the lead's tab.

## What was seen

The owner's words of 2026-10-26, typed in the lead's tab: "one more item: the `chan devserver run --help` should not leak my PAT from CHAN_TUNNEL_TOKEN: it shows the default value, bad idea".

Read at `3a45475bc`. Confirmed on the installed `chan` 0.111.0 under `env -i` with a sentinel in place of a real token: the `--tunnel-token` entry of `chan devserver run --help` reads `[env: CHAN_TUNNEL_TOKEN=sentinel-not-a-real-token-0123]`.

- `crates/chan/src/cli.rs` declares the argument as `#[arg(long, env = "CHAN_TUNNEL_TOKEN", verbatim_doc_comment)] pub(super) tunnel_token: Option<String>` (line 412 at the base). clap's help renders an env-backed argument as `[env: NAME=value]` with the variable's current value unless the argument sets `hide_env_values = true`; nothing here sets it, so a terminal whose environment carries the token (every terminal a chan devserver spawns, since it exports `CHAN_TUNNEL_TOKEN` for its children) prints the credential on `--help`, into scrollback, logs and any paste.
- The two sibling env-backed arguments, `CHAN_TUNNEL_URL` (lines 177 and 402) and `CHAN_TUNNEL_DEVSERVER_NAME` (line 418), carry no secret; their values in the help are informative.
- The test `assert_tunnel_defaults_off` (line 1572) already names the hazard ("`tunnel_token` can carry a live `chan_pat_` credential") for the parsing path; no test reads the rendered help for the value.

## Desired contract

`chan devserver run --help`, `-h` and every other rendering of the help never print the value of `CHAN_TUNNEL_TOKEN`: the entry says the variable is read (`[env: CHAN_TUNNEL_TOKEN]`) and nothing more, whatever the environment holds. The URL and devserver-name entries keep their values. Parsing is unchanged: the flag and the variable still supply the token.

## What to do

1. `crates/chan/src/cli.rs`: `hide_env_values = true` on the `tunnel_token` argument, with a one-line comment saying why (the value is a credential).
2. A test, red first, in `crates/chan/src/cli.rs` beside `assert_tunnel_defaults_off`: render the `devserver run` subcommand's long help through the clap `Command` (`Cli::command()`, the subcommand found by name, `render_long_help`) with the token argument's env value supplied through clap's own env override where the test harness allows it, or with the process variable set to a sentinel inside the test under the crate's existing serialization for env-touching tests; assert the sentinel is absent from the rendered text and `CHAN_TUNNEL_TOKEN` is present. The test must fail at the base before the attribute lands.
3. `make shortcuts-check` and the help snapshot tests of the `chan` crate stay green; if a snapshot pins the `[env: CHAN_TUNNEL_TOKEN=]` spelling it is updated to the new one in the same commit.

## Boundaries

`crates/chan/src/cli.rs` (the one attribute, the one test). Not changed: the token's parsing precedence, the other env-backed arguments, `docs/`, the gateway.

## Acceptance

1. With `CHAN_TUNNEL_TOKEN` set to any value, `chan devserver run --help` prints no part of that value; the entry still names the variable.
2. The test above red at the base and green at the tip; `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test -p chan` green.

## Implementation and verification

The token argument sets `hide_env_values = true`, with a comment identifying its environment value as a credential. The variable name remains in help. The URL and devserver-name arguments retain their values; token parsing is unchanged.

`devserver_help_hides_tunnel_token_value` sets a sentinel under the existing `ChanTestEnv` serialization and restoration guard, then checks both long and short help. Both must omit the sentinel and include the exact `[env: CHAN_TUNNEL_TOKEN]` entry. The test fails at the base plus test, passes with the attribute, and fails again when only the attribute is removed. The attribute is restored for the full suite.

- Focused red: exit 101, `help must not render the tunnel token value`; focused green: exit 0. The reverted-attribute mutant exits 101 on the same assertion.
- `cargo fmt --check --all --manifest-path <worktree>/Cargo.toml`, all-targets clippy with `RUSTFLAGS=-D warnings` and `-D warnings`, `cargo test -p chan`, and `make shortcuts-check`: each exits 0. The crate suite reports 459 passed, 1 ignored, 0 failed. The manifest-only formatting command reports `Failed to find targets` for this virtual workspace; `--all` selects its members.
- The built binary is invoked under `env -i` with a sentinel token and private chan home/runtime. For both `--help` and `-h`, the sentinel count is 0, the exact token environment entry count is 1, and the URL and devserver-name environment values remain visible. Each help command exits 0.
- Evidence lives under `dev/v0112-team/evidence/Launcher112/hlptok-*`; the hand-back records the committed tip and its final scoped verification. No real credential is used in the controls or failure messages.
