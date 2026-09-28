# The scripted team form drops every member's env

Status: accepted for v0.101.0 by the owner on 2026-09-26; raised during v0.101.0 on 2026-09-26 by the independent review of the terminal env order (`dev/v0101-team/reviews/review-Runtime-2.md`, finding 4, in the development tree). A source reading against `main` at `cdd266b09`; not reproduced.

## Owner ruling

Accepted on 2026-09-26 as the lead recommended, as a small order on the runtime or services lane: the `--script` team form passes each member's env to the spawn as the dialog form does, pinned by a test that provisions a scripted team with a member env and reads it in the child.

## What was seen

`cs terminal team new --script` emits the team's spawn flow as a shell script (`crates/chan-server/src/routes/team_config.rs:629-643`). Each member's line is a `cs terminal new` with the member's command and tab name and no `--env` at all, so every entry in the member's `env` table, `CHAN_AGENT` included, is dropped. The direct form and `cs terminal team load` pass the env through `registry.create` and derive the member's submit agent from it; the scripted form therefore spawns a member whose agent chord may differ from the one the roster records.

## Desired contract

A team spawned from the emitted script gets the same member env as the same config spawned directly.

## What to do

Emit one `--env KEY=VALUE` per member env entry in the script, quoted through the script's existing quoting helper, with a test that renders a member carrying `CHAN_AGENT` and a second key and finds both on its line. The validator's refusal of chan's own keys applies to the script's spawns as it does to the direct form.

## Boundaries

`crates/chan-server/src/routes/team_config.rs` (the script emitter and its tests) and the `--script` paragraph of `.agents/orchestration/teams.md`.

## What shipped

Landed on 2026-09-28; lines at `b39274a1a`. The builder's report is `dev/v0101-team/reports/report-Services-31.md` in the development tree, to the order `dev/v0101-team/tasks/task-Lead-Services-30.md`; the lead read the production diff whole and verified it at the blob, with no independent review (`dev/v0101-team/journals/journal-Lead.md`, the entry of 2026-09-28 12:03Z, "the three small fixes in and ready").

- **Each member's `cs terminal new` line carries its env**, one `--env` word per entry in the map's order, each entry quoted as one word through the script's quoting helper, so a value with spaces or quotes arrives whole (`generate_bootstrap_script`, `crates/chan-server/src/routes/team_config.rs:674-687`; `sh_squote`, `:823`). `cs` splits each at its first `=` (`parse_terminal_env`, `crates/chan-shell/src/cli.rs:852-860`), which a key the validator accepts cannot hold (`validate_terminal_env`, `crates/chan-server/src/routes/terminal.rs:719`).
- **The validator applies as for the direct form, with no second check.** The script is generated only from a config that `validate_team_config` accepted, which checks each member's env (`team_config.rs:111-114`): a new team's config is validated before its script (`crates/chan-server/src/control_socket.rs:2023-2028`), and a loaded one is read through `read_team_config`, which validates it (`team_config.rs:237-248`; `control_socket.rs:2086-2094`). When the line runs, the control socket checks the env again with the same validator before it opens the tab (`control_socket.rs:1403`, through `terminal_spawn_overrides`, `:4539-4553`, in `crates/chan-server/src/`).
- The `--script` paragraph of `.agents/orchestration/teams.md` says so (`:7`), and the changelog records it (`CHANGELOG.md:31`).

Pinned, both red first at the base in the report: the worker's rendered line, with `CHAN_AGENT` and a value that holds a space, a single quote and `$HOME` (`script_passes_each_member_env_on_its_spawn_line`, `team_config.rs:1838`); and, on Unix, the whole script run by bash with a stand-in `cs` on its path that records the words each call receives, so each member's spawn is shown to receive its env as `--env KEY=VALUE` words, the lead first (`a_shell_hands_each_member_env_entry_to_cs_as_one_word`, `:1909`). Two mutations red both pins at their own assertions, and the own gate was green.

**The owner's ruling asked for the env read in the child; no one test reads it there.** chan-server's tests cannot run the CLI's parser, which is behind a feature of `chan-shell` that chan-server does not enable (the report, "What joins the emitted line to the child's env"), so the pin ends at the words `cs` receives, and the words reach the child through five hops, each pinned where it lives but one:

1. The words to the control request: `cs` parses `--env` into the request's env (`cli.rs:852-860`), pinned with a value that holds `=` (`terminal_new_and_restart_parse_spawn_overrides`, `cli.rs:3401`).
2. The request to the window: the control socket checks the env and forwards it on the window command (`control_socket.rs:1388-1405`), pinned (`open_term_new_on_a_terminal_tenant_opens_without_workspace`, `:6464`, its assertion at `:6506`).
3. The window command to the tab: the workspace app copies the frame's env into the new tab's `spawnEnv` (`web/packages/workspace-app/src/state/store.svelte.ts:1875-1889`), pinned (`src/state/windowPlacement.test.ts:112-118`, `:156-159`).
4. The tab to the terminal socket: a fresh spawn passes `tab.spawnEnv` to the socket's URL (`src/components/TerminalTab.svelte:1411`), which puts it in the `env` parameter (`terminalWsPath`, `src/terminal/session.ts:83-85`). The URL builder is pinned (`src/terminal/session.test.ts:174`); the tab's hand-off of `spawnEnv` has no pin that this reading found. The report says the whole hop has none; the URL builder's pin corrects that in part.
5. The socket to the child: the server reads and checks the query's env (`terminal_query_spawn_overrides`, `crates/chan-server/src/routes/terminal.rs:759-787`, pinned at `:1908`), and the registry's spawn gives the child the caller's entries over chan's defaults, pinned in a real child's shell (`spawn_env_overrides_win_over_the_spawn_defaults`, `crates/chan-library/src/terminal_sessions.rs:10187`).

The emitted script was not run against a live devserver. A key that begins with `-` passes the validator and, as a separate word after `--env`, might be read by the CLI's parser as a flag; untested, and a POSIX shell cannot export such a key (the report, "Residuals").
