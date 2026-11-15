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

## Implementation and focused proof, 2026-11-15

The implementation is committed at `e6e38c5be6e2f3d19d56c4c46b6bd3d6351d398f`, over `cbb4fb82117c761b3e7f94f7a78402eefebacd0b`. Both initial Fable reviews accept the range. Its committed Rust and frontend gates are green; the marketing smoke stopped at the host sandbox's loopback-listener refusal after its type checks, 25 tests and build passed. J194 holds the guest marketing check and base/tip browser proof; final acceptance awaits that evidence and confirmation of the review follow-up.

The Load form remains editable: host name, prefix and MCP choices, directory and tab group, agent count, member names, commands, environment and lead, and tabs or split layout with its grid and slots can change before Bootstrap. The brief is shown only for New. A successful Load captures an immutable snapshot after the existing form normalization. Bootstrap in Load mode preserves an existing `config.toml` only when those fields match that snapshot; an edit or New mode writes the dialog's modeled fields and consequently drops comments, custom key order and unmodeled keys. Reverting the fields to the loaded values restores preservation. The snapshot follows the pending session draft through serialization; a Load-mode draft without one reads and normalizes the saved config before comparing. This includes older restored drafts and current drafts whose Load read failed. A failed read at Bootstrap is shown as the read error, and no write is made.

The route's optional `keep_config` flag is independent of `keep_bootstrap`. It validates the submitted team first, then uses the workspace facade's atomic absent-only create for a preserved config: a missing target is created, an existing regular file stays untouched, and non-regular targets are refused. Normal saves retain the existing atomic writer. The CLI's script-generation body is unchanged. The manual's `config.toml` row and the orchestration guide describe these choices.

Focused evidence is retained under `dev/v0131-team/evidence/Core131/dialogload31/proof36/`. `red-server.log` and `red-web.log` record the baseline failures (exit 101 at the byte-preservation assertion, and exit 1 for the missing preservation flag). The red runs used `cbb4fb821`; the five relevant production sources are identical to the acceptance base `a4c7fa631`, checked in `parent-review35.json`. `red-legacy.log` records three assertions for old drafts without a snapshot (exit 1). The restored implementation passed the three route tests in `green-server.log` and all 69 tests across the dialog, orchestrator and lead-restart files in `green-web.log` (both exit 0); `fmt-after-review.log` also returned 0.

All eleven guard mutations reached their intended runtime failures. The four server cases cover preservation, missing-file creation, validation and regular-file refusal (exit 101 each); the seven frontend cases cover the client flag, Load mode, equality, legacy read, legacy normalization, capture and snapshot fields (exit 1 each). `mutation-records-audit.json` records the command, status, patch/log hashes and exact source hashes for each case and verifies restoration of all eight proof-source paths. The missing-file mutant fails when the test reads the absent file; the mode mutant also reports an unrelated fixture TypeError, which is not used as its proof. The equality output groups several FAIL headings; the repaired classifier's positive and negative selftest is retained in `mutation-classifier-grouped-selftest.log`. No completed mutation was rerun to fill a missing parser verdict.

Committed evidence for `e6e38c5be` is retained under `dev/v0131-team/evidence/Core131/dialogload31/gate36/`: fmt, all-target chan-server clippy, rustdoc, 45 team-config tests, three CLI-script tests, 69 focused frontend tests and the full `make web-check` passed. `marketing.log` retains the sandbox `listen EPERM` failure; `gate-tail36/` retains the passing probe syntax and diff checks. J194 uses the frozen `browser36/scripts/` kit for `276-dialog-load-config.mjs` at the base and tip, the tip after check 216, and the remaining marketing check. Browser observations, screenshots and final acceptance remain pending.

The review follow-up makes a preservation refusal identify a non-regular config target, while retaining the same success branches. Its response-body regression fails at the prior generic message and passes with the explicit cause (`dev/v0131-team/evidence/Core131/dialogload31/fix37/rust/red-message.log`, exit 101, and `green-message.log`, exit 0). A mounted-Load test appends a trailing slash to the draft directory and asserts `keep_config: true` in the outgoing request; its initial green, normalization mutation red and restored green are retained in `fix37/web/` (exits 0, 1 and 0). The mutation fails at the missing flag, and the snapshot source is restored to its original hash. The tab-name comment now distinguishes edited Load or New, which save the corrected value, from unchanged Load, which keeps the saved file. J194 remains pinned to the initial implementation because this follow-up changes only the failure message, tests and documentation.
