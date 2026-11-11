# Small findings of the v0.127.0 second reading are still open

Status: raised on 2026-11-10 by the second reading of v0.127.0's merged code ([its item](../done/a-second-reading-of-the-releases-merged-code-finds-small-defects.md)) and by the fixes made from it, which listed what they saw nearby and left alone. The owner closed v0.127.0 to new work that day ("no more new features at this point, just close off the current in-flight items and the rest moves to v128"), so everything not already fixed or given a row of its own is collected here. Not started. Each line is a reading of the code unless it says it was run. Partly built on 2026-11-11: the CI and gateway bullets (below); the rest follow.

## What is there now

CI and the gateway's database roles:

- `.github/workflows/ci.yml` declares no `permissions`, so its jobs run with the default token; five other workflows declare theirs, and `gateway-ci.yml` does since v0.127.0. It names no token of its own, so `contents: read` is the likely whole of it.
- Both gateway application roles hold `TEMPORARY` on the database through `PUBLIC` (run in the roles suite's guest: `has_database_privilege` answers true for it). `prepare-database-roles.sh` revokes the database's privileges from the two roles and grants `CONNECT`, which leaves PostgreSQL's default grant to `PUBLIC` in reach. The roles suite covers no database-level privilege. A fix revokes from `PUBLIC` on live gateway databases at an upgrade, so it needs a gateway run of its own.
- The roles suite's three "reconcile must refuse" checks and its readiness refusal pass on any non-zero exit; the sdme driver's suite run has no timeout; and the reconcile script inventories `pg_tables`, so a view in `public` is outside what it reconciles.
- `scripts/e2e/gateway-zone.sh` holds three copies of one service-stop helper and two loopback curls without `--noproxy`, and the tunnel end-to-end stub (`stub-identity.py`) admits a grantee at the root landing that no run presents.

The Dashboard and privacy mode (the check 114 label and the About slide's 4 px overhang that were listed here closed with the Dashboard slides row):

- The Metrics slide prints sizes as KiB and MiB with its own formatter (`components/MetricsSlide.svelte` in the workspace app) while the file browser prints KB and MB for the same divisor (`state/format.ts`): one window shows two spellings of one unit, and which one stays is the owner's choice.
- The slide's transfers line omits the panicked and finished counts that `chan metrics` prints.
- The scan error the slide shows holds no path today (a fixed message, or an operating-system error without one); no test fails if the server later puts the chan home path in it, which privacy mode hides elsewhere on the slide.
- On a first open the Metrics slide is short while it waits for the server's first answer and is centered then too, so its heading moves up when the first sample arrives; a waiting state that holds the loaded slide's height would keep it still.
- With privacy mode on, the workspace app's command launcher lists windows by the labels the user gave them (`components/CommandLauncher.svelte`), where the launcher's own deck masks the same rows, and the Dashboard's Workspace slide shows the workspace's root path.

The terminal and the editor:

- A file that is not an image, copied in Finder, has the clipboard shape that sends a paste down the native image path (`editor/bubbles/image_drop.ts`); whether the file's icon is then uploaded and inserted needs a Mac to settle.
- `VtSearch.matchesBetween` (`terminal/ghosttyVt.ts`) has no caller outside its tests; it waits for highlighting every match, which the ghostty-web fork item carries.
- Two body theme writes in flight for one surface: the first one's rollback overwrites the second's optimistic value until the next `config_changed`.
- The test for "this pane is a tmux pane" exists twice (`components/Pane.svelte`, `state/tabs.svelte.ts`), each pointing at the other.

The CLI and the desktop:

- `local_devserver_dial_addr` (`crates/chan/src/devserver/persisted.rs`) reads the systemd unit and never the launchd plist, so a macOS agent bound to an address of its own is dialed on loopback.
- The desktop's shutdown waits for its extension supervisors one after another, 3 s each (`ExtensionRuntime::shutdown`, `crates/chan-server/src/extensions.rs`), so its drain has no fixed bound, and a launch that waits 20 s for a desktop shutting down can still outwait it; and `desktop/src-tauri/src/serve.rs` words the same refusal for a terminal offer with a second literal the launch does not read.
- The metrics runtime carries two stop flags that its `Drop` has to set together (`crates/chan-server/src/metrics.rs`).
- rustfmt gives up on statements that hold a literal wider than its limit, and `cargo fmt --check` passes them unformatted: tests in `crates/chan/src/metrics.rs`, `metrics/varlink.rs`, `metrics/listener.rs` and `devserver/persisted.rs` have such statements (shown by run for the ones v0.127.0 rewrote: a perturbed copy of the old statement passed the check).

The documents:

- `desktop/design.md` and the web app's `design.md` say a tmux window answers New Window by asking tmux; that holds only for a tmux window of the desktop's own library, as the manual says since v0.127.0. `desktop/design.md` also says the Window menu lists hidden windows, where it lists open ones too, and its single-instance paragraph does not name the separate `XDG_RUNTIME_DIR` that keeps two desktops apart.
- `CONTRIBUTING.md`, `docs/contributing/linux-and-macos.md` and `gateway/docs/dev-setup.md` describe Gateway CI without its packaging job and its wider path filter.
- The Settings hint under Privacy mode (`components/settings/GlobalSection.svelte`) lists what the mode hides and leaves out workspace paths, WireGuard files and keys, connection errors, window labels and titles, the pane list's heading and the Metrics slide's host name and chan home path.
- The manual's Metrics section does not say what the storage card reads after a failed scan, and a comment in `App.svelte` still names a "carousel slide-1 button".

## Desired contract

1. Each line above is fixed, or closed with its reason, in one pass.
2. A line that turns out larger than a small change (the `TEMPORARY` grant is the likely one) gets a row of its own, with its own acceptance.
3. The two lines that are the owner's to choose (the size spelling, what privacy mode covers in the workspace app) are put to him first.

## Boundaries

- Nothing here changes a contract a v0.127.0 item states.
- The larger things the reading left have their own rows: the launch beside a desktop that does not answer, the Windows handoff pipe, the minimized window, the unused-token test, the desktop upload's cancel and error paths, and the moved tmux window.

## Acceptance

1. Each line carries, in this item, the commit that closed it or the reason it stands, and each fix that can be pinned has a test shown red without it.
2. The scoped gates of what was touched are green, with Gateway CI green on a tip that holds the workflow and roles changes.

## Built, 2026-11-11 (the CI and the gateway's database roles)

- `.github/workflows/ci.yml` declares `permissions: contents: read` (886dea050). The CI log of a prior run shows the default token was already read-only for contents, metadata and packages, so this is the explicit least declaration, not a repair of a write scope; `make workflow-check` green.
- The roles suite's three "reconcile must refuse" checks and its readiness refusal require the specific exit status and message of each refusal, the sdme driver bounds the suite run to five minutes with a ten-second kill, and the reconcile script's inventory rejects ordinary and materialized views in both runtime schemas, with the Kubernetes copy matching byte for byte (1d74a18eb). Proofs in a disposable PostgreSQL guest: the planted public view passes the old reconciler and is refused by the new one; eight wrong-status and wrong-message mutations pass the old suite and fail the new one at its assertion; the restored suite and the real `make gateway-database-roles-test` driver pass with the bounded timeout.
- `scripts/e2e/gateway-zone.sh` has one service-stop helper for sharedroot, tunnelhint and ctrlplane, both sharedroot curls bypass inherited proxies, and the tunnel stub's root-landing grantee that no run presents is gone with its environment input (200b36b81); `make shell-check`, the helper and curl probes and the stub's baseline red are the evidence. The full gateway zone scenarios were not run this round: the script is a host-loopback full stack with real devserver processes and Postgres, last run by hand in v0.68.0, and no guest of this round holds it.
- The `TEMPORARY` grant through `PUBLIC` is larger than a small change (contract 2): after the complete roles suite both application roles effectively hold `TEMPORARY`, and a revoke from `PUBLIC` in a guest transaction makes both false while `CONNECT` stays true. It is a gateway upgrade step with its own acceptance, drafted for the owner as `dev/v0128-team/reports/row-draft-gateway-application-roles-inherit-temporary-table-creation.md`; the live grant is unchanged here.

## Built, 2026-11-11 (the CLI and the desktop)

- `local_devserver_dial_addr` selects the launchd plist on macOS and the systemd unit elsewhere, and falls back to the recorded port when no usable unit file exists (9085569a0); its tests read both platform shapes against private persisted files (an IPv6 address, an environment decoy, a malformed and a missing plist, missing recorded state), the old selector reds at the wrong address and the removed fallback reds at the recorded address. `crates/chan/design.md`, `docs/metrics.md` and the devserver manual say so. No launchd process was started; the selector is exercised against files.
- The desktop's extension supervisors share one three-second grace at shutdown: cooperative ones are reaped before the return and the rest are aborted at the common deadline, with no unbounded join (7ff78689e); eight stalled supervisors took 24 s under the old loop and 3 s under the fix on a paused clock, and removing the abort reds. The terminal-offer refusal in `desktop/src-tauri/src/serve.rs` now reads the launch guard's constant with the wire text unchanged (a divergence reds). A task that never yields can still delay the process exit; no whole-process deadline is claimed.
- The metrics sampler, storage walk and runtime `Drop` stop on one flag under the demand mutex, and one stop wakes both workers (759add25d); the tests observe both waits before the stop, and notifying one worker only or omitting `Drop`'s stop reds. The storage syscall stays unjoined at teardown; behaviour unchanged, the two old flags already stopped both workers.
- The overlong HTTP, Varlink, systemd-unit and launchd-plist fixtures in `crates/chan/src/metrics.rs`, `metrics/varlink.rs`, `devserver/persisted.rs` and the old `metrics/listener.rs` tests (now `crates/chan/src/test_env/local_listener.rs`) are split, and the statements rustfmt had passed unformatted behind them are formatted (0092b1268); five whitespace perturbations pass `cargo fmt --check` on the old tree and fail on the new, and a probe compares every changed literal's bytes. No protocol bytes or test behaviour change.
- At the merge into the integration branch (`dev/v0128-team/evidence/Lead128/leftovers3-merge`): fmt clean, clippy on chan, chan-server and chan-desktop with warnings denied, the chan-server suite (2540 tests), the chan persisted, metrics, management and activity modules (5, 23, 17 and 4 tests), the desktop single-instance tests (28) and the marketing check, all green at 427c6e75a.
