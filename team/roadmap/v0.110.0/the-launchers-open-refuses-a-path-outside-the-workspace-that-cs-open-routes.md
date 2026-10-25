# The launcher's Open refuses a path outside the workspace that cs open routes

Status: built on 2026-10-25 on v0110/lnopen; the section Shared routing built 2026-10-25 holds the evidence; it closes at the v0.110.0 GA.

## What was seen

The owner read on 2026-10-24: `cs open /path/to/file.md` from a terminal in a workspace window, with the path outside the workspace, opens a standalone window with the file in its editor. The launcher's "Open" with the same path, typed as `open /path/to/file.md`, reports that the file is not in the workspace. The owner's word: "i want the command launcher's 'open {path}' to work just like it does form the 'cs open {path}'".

Read at `840c4f594`.

- `cs open` reaches the server over the control socket. Its handler in `crates/chan-server/src/control_socket.rs` probes the path against the workspace root before anything else, and a path that escapes is treated as a routing fact: `route_open_outside_workspace` hands it to the host (`open_outside_workspace` in `crates/chan-library/src/host.rs`), which reuses a live standalone window or mints one and parks the open for its first attach, and the ack names the window ("open request queued for ... in standalone window ..."). Without a host (a standalone `chan serve`, or a host whose terminal tenant mounted no filesystem) the refusal names `chan serve PATH`.
- The launcher's "Open" (`app.open.path` and `executeOpen` in `web/packages/workspace-app/src/state/commands/global.ts`) posts to `POST /api/open` (`crates/chan-server/src/routes/open.rs`). That route resolves a relative target against the workspace root, passes an absolute one verbatim, and calls `open_path` directly, whose `abs_to_workspace_rel` answers "path escapes workspace root" for a path outside the workspace; the test `escaping_targets_refuse_with_400` pins that answer for `/etc/hosts`. The route never consults the host: the `UnserveScope` that carries the host handle is given to the control socket's context in `crates/chan-server/src/lib.rs` and not to the HTTP `AppState`.
- The route's module comment says the semantics "live in those two control-socket fns and are never reimplemented here, so cs open and the launcher command cannot drift". The routing step sits in the socket handler above those two functions, so the two callers drifted at exactly that step.
- The `cs open` long help in `crates/chan-shell/src/help.rs` still opens with "Workspace windows only, and the path must resolve inside the workspace root" and "The command launcher's Open entry runs the same path", while its CAVEATS say an outside path is routed; the head is stale.

## Desired contract

Typing a path into the launcher's Open does what `cs open` does with it from a terminal in the same window: a path inside the workspace opens in this window, a path outside it opens in the host's standalone window with the same reuse, mint and ack rules, and the status bar names the window the open landed in. Without a host, the refusal is the one `cs open` gives. A relative path still resolves against the workspace root, since the launcher has no working directory.

## What to do

1. Move the escape probe and `route_open_outside_workspace` out of the socket handler into one function both callers share, taking the `UnserveScope`, so the HTTP route and the socket cannot drift at this step again.
2. Give `AppState` the `UnserveScope` (or the host handle it carries) at construction in `crates/chan-server/src/lib.rs`; a standalone tenant keeps `Unsupported`.
3. `api_open` probes the absolutized target first and routes an escape through the shared function; the 200 body carries the ack so `executeOpen` shows "open request queued for ... in standalone window ..." in the status bar, as the socket's caller sees it.
4. Tests, red first: in `routes/open.rs`, the two escaping targets of `escaping_targets_refuse_with_400` route and answer the ack when a host is present, and refuse with the `chan serve` guidance when none is; the control socket's `route_escape` tests keep passing through the shared function. In the SPA, `state/commands/global.open.test.ts` shows the ack for a routed open.
5. The `cs open` help head says what its CAVEATS say.

## Boundaries

`crates/chan-server/src/control_socket.rs` (the shared routing function), `crates/chan-server/src/routes/open.rs`, `crates/chan-server/src/state.rs` and `lib.rs` (the scope on the state), `crates/chan-shell/src/help.rs`, `web/packages/workspace-app/src/state/commands/global.ts` (the ack in the status bar), their tests. Not changed: `open_path`'s semantics, the host's `open_outside_workspace`, and the standalone window's own Open, which resolves client-side.

## Acceptance

1. From a workspace window, Cmd+K, `open /path/outside/file.md` opens the file in the host's standalone window and the status bar names that window; a second open lands in the same window.
2. The same path from `cs open` in a terminal of that window lands in the same window with the same ack.
3. `open notes/plan.md` and `open .` are unchanged.
4. On a standalone `chan serve` the launcher's refusal names `chan serve PATH`.
5. The tests above red first, green after.

## Shared routing built 2026-10-25

The HTTP route and control socket share `route_open_if_outside_workspace`, including the escape probe on the blocking pool and the host's routing acknowledgment. The tenant builder gives both callers the same lifecycle scope. Routed HTTP replies name the destination window, and the workspace command shows their message as a transient status. Local opens keep their existing frame-driven status and resolution. The `cs open` help keeps naming `chan open` as the workspace-serving command beside `cs open`. Hostless guidance names the target as resolved against the canonical workspace root.

### Lead's rulings 2026-10-25

R1: `AppState` gains `unserve: UnserveScope`, the one value `lib.rs` builds for the socket context, cloned, whatever variant it is; the routing helper treats `Standalone` and `Unsupported` alike (no host, the `chan serve PATH` guidance). R3: a status appears for a ROUTED open only. The 200 body stays `{message}` for a local open and carries `{message, window}` when the open was routed, `window` being the standalone window id from the ack; `executeOpen` shows `message` through `setTransientStatus` when `window` is present and stays silent otherwise. This widens the row's web boundary to `web/packages/workspace-app/src/api/client.ts` for the `open` entry alone (its return type `{ message: string; window?: string }` and its comment). The HTTP route keeps its connected-window admission before routing; the socket keeps its own order.

### Evidence and acceptance

The base is `4e4ba69870a61f85295e4e7629ef60f3347e56e4`. The code and whole-suite evidence below name tip A, `65b543e0f8df0c98175c753561ae02e3852d9608`; the closing amendment adds this section, the server design bullet's placement and the browser check. All runs use `chan-v0110-server` as its non-root build user, with two Cargo jobs and two test threads. The environment record is `dev/v0110-team/reports/environment-Server110.md`. Log paths below are relative to `dev/v0110-team/evidence/Server110/lnopen/`.

1. Acceptance 1: browser check `182-launcher-open-routed.mjs` opens an outside text file through the command launcher, asserts the returned window and exact visible status, and observes the file's text in its standalone editor. A second launcher open names the same window and delivers a fresh `open_file` frame; only one standalone popup exists and the file bytes remain unchanged.
2. Acceptance 2: that check spawns a real PTY bound to the source workspace window, verifies its `CHAN_WINDOW_ID` and `cs open` exit status, and compares the CLI's stderr acknowledgment with the second HTTP reply. Its stdout is empty, as the CLI help specifies. The CLI and repeated launcher open deliver two distinct frames to the same destination.
3. Acceptance 3: the local-open tests and browser checks 80 and 120 pass. Check 80 exercises local file and directory opens and binary reveal/refusal; check 120 exercises contextual opener placement. The SPA's local no-status assertion remains beside the two routed-status assertions.
4. Acceptance 4: the relative escape, portable absolute escape and `/etc/hosts` pins assert the full hostless `chan serve PATH` guidance, with no file or queued frame. Both the ordinary and symlink-TMPDIR whole-server runs pass the relative-path guidance assertion.
5. Acceptance 5: the base plus the new guidance pins fails their exact error assertions (cargo 101), the production-builder hosted pin fails at HTTP 400 versus 200 (cargo 101), and the two SPA routed-status assertions fail at null versus the acknowledgment (vitest 1). See `red-initial.log` and `red-hosted.log`. The committed implementation at `2d28aa1a1167d6bf8bd944bf88e595e709edafee` passes fmt, clippy, 120 filtered open tests, seven routing tests, the path-classifier pin, 163 shell tests and 27 SPA open tests: `gate-commit.log/status`, every `CHECK_RESULT` 0 and `SERVER110_COMMIT_GATE_PASS`.

Four separate mutations fail their assertions and pass after restoration: skipping escape routing gives HTTP 400 versus 200 (101/0); dropping the production scope gives hostless guidance instead of routing (101/0); discarding the SPA reply loses both routed statuses while 25 local controls pass (1/0); omitting the HTTP `window` field fails the exact reply assertion (101/0). `mutants/combined.log/status` ends `SERVER110_MUTATIONS_COMPLETE`, rc 0. These mutations stand at tip A because `amend-a.patch` changes only the help alias line and the canonical-root test expectation. Individual patches and logs are under `guest-export-2/lnopen/mutants/`.

At tip A, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test -p chan-server --all-targets -- --test-threads=2` both normally and with TMPDIR behind a symlink, the whole `chan-shell` and `chan` suites, and `make web-check` all return 0. Server: 2472 passed and one ignored in each arm; shell: 163 passed; chan: 438 passed and one ignored across its targets. Web: 218 shared, 624 launcher, 7724 workspace-app and 20 profile tests pass; all type checks and builds pass. See `tip-a-suites.log/status`, every `SUITE_RESULT` 0 and `SERVER110_TIP_A_SUITES_PASS`. The older whole-suite symlink failure is retained in `whole-suites.log/status`; the expected guidance now uses the same canonical root as the route. The server's ignored child helper is exercised by its parent; the owner-run two-GiB transfer test and the casefold-directory assertion are not run here.

Browser commands use `SMOKE_SKIP_BUILD=1 SMOKE_ONLY=<prefix> SMOKE_OUT_DIR=<separate output> node scripts/e2e/browser-smoke/run.mjs`, with CPU affinity restricted to two CPUs after one binary build per revision. At tip A, 182, 80 and 120 pass alone, then all three pass together in lexical order 120, 182, 80, with no skips. At the base, 80 and 120 pass while 182 exits 1 at its launcher refusal assertion: HTTP 400, `path escapes workspace root`, where 200 is required. Both phase runners return 0 after checking those expected statuses. See `browser-tip-a-v2-tip.log/status`, `browser-tip-a-v2-base.log/status` and every `results.json` under `guest-export-2/lnopen/browser-tip-a-v2-{tip,base}/`. The check's SHA256 is `bbc9d245237a94c781eec910b305696a1052c48630a8ce9224fa7e010402b6a3`. The first tip-A draft read the CLI ack from stdout and failed; `browser-tip-a-tip.log/status` and its exported results retain that harness error. The corrected check reads the documented stderr stream and preserves both streams as a receipt.
