# chan-desktop has a setting for its client session name

Status: shipped at [v0.110.0](../../release/release-v0.110.0.md); the section Built and verified holds the evidence.

Record before the release: built on 2026-10-25 on v0110/dsknam; the section Built and verified holds the evidence; it closes at the v0.110.0 GA.

## What was asked

The owner's words of 2026-10-23, on how a client's session name is set: "i dont know if we already do have a config for setting the chan-desktop name but we could add one too, with a default value empty resulting in auto-naming as of today", then "let's do the cs session self --name X part and leave the desktop setting alone, we can add that as an item in the roadmap for the next version". v0.109.0 ships `cs session self --name X`, which names the calling client and its window's participant for the server process's life; chan-desktop has no name setting (`desktop/src-tauri/src/config.rs`).

## Desired contract

A chan-desktop setting names the desktop's client session; empty, the default, keeps the generated name as today. The desktop presents the name when it connects, so it holds across a server restart; `cs session self --name` and `--reset` still override it for the server process's life, and the name passes the same refusals as `cs session self --name`.

## What to do

First step, a short design: the setting's key and place in the desktop config, how the name reaches the server at connect (a socket query, a header or a request), and its order against a `cs session self --name` already made; then the change with its tests.

## Acceptance

1. A named desktop appears under that name in `cs session list` after connecting and after the server restarts.
2. An empty setting keeps the generated name; an invalid one is refused with the same message as `cs session self --name`.

## Built and verified 2026-10-25

The desktop config stores `client_session_name`, empty by default. Native target URLs carry a nonempty value beside the desktop holder, and the workspace app presents it on every event-socket connection. The library applies the shared syntax and live-client collision checks after admission. Successful command names and resets retain precedence while the client record lives; a refused presentation preserves the current name and connection and displays the server's exact sentence. Target URLs without an inherited `client_name` preserve their existing query bytes. The library, server, desktop and workspace-app design documents describe these boundaries.

### Lead's rulings

- R8 (what the setting names): the desktop's client session alone, through the connecting page's target URL (one `client_name` query value, present only for a native target carrying this desktop's holder with a nonempty setting; the SPA copies it onto every event-socket dial, reconnects included; `/ws` applies it after admission and before its `session_client` receipt). Participant naming stays with `cs session self --name`, which names the client and the calling participant together: a setting applied to every participant would refuse a desktop's second window in the same workspace, since participant names are per window. "The same refusals" in the row are the shared syntax validator's and the live-client collision's, in their exact messages; the participant collision does not arise because no participant is renamed.
- R9 (the setting's home): `Config.client_session_name: String`, `#[serde(default)]`, empty by default, serialized as `client_session_name` beside `devservers` and `gateways` in the desktop config; no launcher screen in this row (the launcher has Computers and Gateways alone at the base); a graphical setting is a row of its own if Alex wants one.
- R10 (a refused name): the client keeps its current name (a new client its generated one), the socket stays usable, and the `session_client` receipt carries `name_error` with the validator's exact sentence, which the workspace app shows through its existing transient status writer. Declined: closing the socket, a fallback name, a new HTTP route.
- R11 (precedence and retention): a name-source state in the client record (generated, presented, command named or reset); a successful command, reset included, wins for the server process's life and a later valid presentation is ignored; a malformed presentation is still refused; the presented name applies under the client lock; the bounded roster's 4096-record eviction keeps its documented meaning, so a holder back after eviction is a new client and takes its presented name; a server restart builds fresh records and takes the configured name again without a desktop reload.

### Verification

The base is `4e4ba69870a61f85295e4e7629ef60f3347e56e4`. The mutation, whole-suite, web, initial browser and native runs below used code-stage tip `7b2fd661f84bc8c98b77210d1f6a1edbf023560b`. Evidence paths here are relative to `dev/v0110-team/evidence/Server110/dsknam/`; guest originals are under `/home/ubuntu/evidence/dsknam/`. The environment is recorded in `dev/v0110-team/reports/environment-Server110.md`: the owning sdme guest, non-root build user, two Cargo jobs and test threads, 8 GiB memory cap and disk-backed temporary/build directories. The lead's `evidence/Lead110/cgroup/server-dsknam-task9-{before,after}.txt` readings bound the verification stage; the functional counts carry no timing claim and were collected beside the integration and Tests110 gates.

Six mutations exercised five guards, with the two reset setters changed separately. Every command returned Cargo status 101 at its named assertion, then restored the source; no mutation survived and no red was merely a compilation error. `mutants.sandbox.log` and its status file record the successful wrapper (0); `mutants.refused.log` preserves the initial sudo sandbox refusal. Individual patches, logs and statuses are included in `verification-export-1.log` under `FILE mutants/`.

| Mutation | Named pin | Exit |
| --- | --- | --- |
| Single-client reset source | A | 101 |
| Combined reset source | A | 101 |
| Command precedence | A | 101 |
| Live-client collision | B | 101 |
| URL projection | C | 101 |
| Refusal delivery | D | 101 |

A is `presented_name_yields_to_command_names_and_resets_in_both_orders`; B is `presented_name_collision_uses_full_folding_and_only_live_clients`; C is `client_session_name_projects_only_onto_native_targets`; D is `client_name_on_event_socket_refuses_without_closing_or_renaming`. Registry and socket pins also cover concurrent command/presentation order, two racing folded names, atomic refusal, retained and evicted records, fresh registries, independent participants and detached or untagged sockets.

`cargo test -p <crate> --all-targets -- --test-threads=2` returned 0 for each whole suite: chan-library 748 passed/1 ignored; chan-server 2475 passed/1 ignored plus the example target with zero tests; chan-shell 163 passed; chan-desktop 651 passed. `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` with `RUSTFLAGS=-D warnings` each returned 0. `whole.log`, `whole.status` and the `FILE whole/` entries in `verification-export-1.log` hold the commands and results. The two ignored tests remain ignored, not passed.

`make web-check` returned 0: web-shared 218 tests in 7 files, launcher 624 in 57, workspace-app 7733 in 600, profile 20 in 5; all Svelte checks reported zero errors and warnings, and the launcher and workspace builds passed. This is 8595 tests. The log is `whole/web.log` in the export, with its own status file.

Browser check `183-client-session-name.mjs` uses real SPA event sockets and `cs session list`. Its unchanged SHA256 is `5562b2d73c0e871b53d83523406958b27569e9b53f20b157694a47d4b5ffe082`. It covers a configured name with special characters, reconnect, command naming and reset across reconnects, empty and absent settings, and the exact visible whitespace refusal shared with the command while the window remains live. The check passed alone at the code-stage tip (run 0, one passed, none skipped); at the base it failed with run 1 at the configured-name assertion, observing a generated name; beside checks 107, 123 and 164 at the tip all four passed with run 0 and none skipped. Successful expected-outcome wrappers returned 0. Results are `browser-{tip,base,combined}/results/results.json`, with timelines, command logs and statuses; `verification-export-1.log` preserves their text. Constructed reader inputs and exit-7/exit-0 wrapper controls ran before the real attempts.

The Linux native run under Xvfb loaded a disposable desktop config containing `client_session_name="Native configured desktop"`, registered and connected an owned devserver, and read the live event client through `cs session list` before and after restarting that server. Both reads returned the configured name and holder `d9b976406b8d0b3c20cf74ef851f0efe`. The server PID changed from 254529 to 254730 while desktop PID 254539 remained; the fresh registry assigned a new client id as expected. The driver controls, desktop build, real run and wrapper each returned 0, with cleanup in `finally`. `native/run/result.json`, the before/after reads, logs and statuses are in the guest and the export; `native.log` ends with `SERVER110_DSKNAM_NATIVE_STAGE_PASS`. Constructed controls refuse missing, duplicate, wrongly named, disconnected or event-less clients and a changed holder. This run does not claim macOS or Windows native coverage.

The final fold adds the browser check to the commit, gives the server design entry its bold subject, and confines query reconstruction to URLs carrying an inherited `client_name`. The new `client_session_name_preserves_unrelated_query_bytes` case fails on the preceding code at the exact query comparison (Cargo 101), distinguishing a bare flag, lowercase percent escapes, tilde and duplicate keys. `f5-red.log` records that assertion; the first green attempt stopped at rustfmt's requested string wrapping (`f5-green.log`, exit 1), before tests ran. The corrected run returned 0 for formatting and all five `client_session_name_` tests, with `SERVER110_DSKNAM_F5_GREEN_PASS` in `f5-green2.log`. The existing two-inherited-name projection case remains in place.

The hand-back `dev/v0110-team/tasks/task-Server110-Lead110-6.md` records the amended tip and its separate committed checks: formatting, clippy, the five filtered naming groups, the whole desktop suite and check 183 alone again, with `final.log` and `browser-final.log` and their genuine statuses. The earlier library/server/shell whole suites, web, base/combined browser and native runs establish the unchanged code-stage content; they are not relabeled as executions at the amended tip. The lead owns the full gate and final acceptance at that tip.

Acceptance point 1 is covered by the native connection/server-restart reads and the browser named/reconnect cases. Point 2 is covered by the empty-setting config and URL pins, the exact-refusal command/socket comparisons and the browser's empty/absent and visible-refusal cases. No version pin, changelog, release report or done-row move is part of this change.
