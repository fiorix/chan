# Renaming a terminal window in the launcher leaves the desktop window's title unchanged

Status: shipped at [v0.110.0](../../release/release-v0.110.0.md); the section Repair and evidence 2026-10-25 holds the evidence.

Record before the release: built on 2026-10-25 on v0110/lrnttl; the section Repair and evidence 2026-10-25 holds the evidence; it closes at the v0.110.0 GA

## What was seen

The owner's words of 2026-10-23: "changing the name of a terminal window in chan-launcher on chan-desktop does not change the title of the window, until the window is hidden and reopened; i havent checkes the Window menu value, but i want the value to propagate from the chan-launcher to the window title without having to hide/close and reopen it."

Later the same day: "btw the window title change seems to be working now.. i dont know why it didnt the first time and when i reported". The title follows a rename at least some of the time, so the fault is intermittent: it depends on an order or a state the first attempt met and later ones did not.

## Desired contract

A terminal window renamed in chan-launcher on chan-desktop shows the new name as its native window title at once, without being hidden, closed or reopened; the desktop's Window menu entry for it reads the same name.

## What to do

First step, a reading: where chan-desktop sets a terminal window's native title and its Window menu entry, which event carries a launcher rename to the window, and which order or state leaves the title unchanged until the window is shown again (a rename before the window's page has loaded, a window opened from the launcher before the rename's event subscription, a hidden window renamed); then the change, pinned by a test that reproduces the failing order first. If the reading finds no failing order, the row closes on the reading.

## Acceptance

1. A rename in the launcher retitles the open window and its Window menu entry with no hide, close or reopen, pinned by a desktop test.
2. A hidden window shows the new name when it is shown again, as today.

## Repair and evidence 2026-10-25

The launcher writes a changed caption through `web/packages/launcher/src/components/WindowRow.svelte`, `state/library.svelte.ts` and `api/library.ts` to `crates/chan-server/src/routes/library.rs`. The local route persists it through `crates/chan-library/src/host.rs::set_window_label` and `windows.rs::set_label`; the remote route forwards it through `desktop/src-tauri/src/window_ops.rs` and receives the devserver's full window snapshot in `window_watcher_wiring.rs`. Both rename paths read correctly at the base. The native builder in `desktop/src-tauri/src/serve.rs` composes the record's current caption; the reconcile in `window_watcher.rs` refreshes an already open window and `window_watcher_wiring.rs::sync_title` applies a changed title and rebuilds the Window menu. A hidden window is reopened from the latest record.

The lead's R12 ruling accepted one lost-notification order at the start of `WorkspaceHost::install_window_registry`: the first registry waiter was made inside its spawned forwarder, so a changed caption could call `notify_waiters` before any waiter existed. The repair creates and pins the owned registry waiter before spawning the task and retains the loop's re-arm-before-forward ordering. This closes that startup gap without changing the caption route or native title composer.

The current-thread library pin sets a row's caption after installing the registry but before the forwarder's first poll. With `cargo test -p chan-library window_registry_forwarder_delivers_label_ -- --test-threads=2`, the unrepaired tree hash `e612d492610a3209dd2dbbd6f9596b7a68d103651bebf6b607804fbb59885777` failed the early-order assertion, `the registry label change must reach the library watcher`, with rc 101 (one passed, one failed); the late-order control passed. At the repaired tree hash `a8e3b3743dab369baae5773762b7dc357f479b45ce0bc6672999aed338689d0f`, both passed with rc 0. Moving the first waiter back inside the task in one guest mutant returned the early-order failure with rc 101; the repaired source was then restored. The runs and their real statuses are in `dev/v0110-team/evidence/Tests110/lrnttl/{red-pin,green-pin,mutant-pin}.{log,status}`.

The lead's R13 desktop pin drives the real reconcile at the `NativeSurface` boundary. A snapshot changed only in an open record's caption reaches `refresh`, never `open` or `close`, and `watched_window_title` includes the new caption; a hidden renamed record receives no refresh and its reopen composes the latest caption. `cargo test -p chan-desktop caption_ -- --test-threads=2` passed with rc 0 (the two new tests and one existing composer test). The Tauri 2.12.4 mock runtime returns an empty title and ignores `set_title`, so this Linux pin does not execute the main-thread native `set_title` or Window menu rebuild arm. The production `sync_title` and menu path are read at `desktop/src-tauri/src/window_watcher_wiring.rs:788-840` and `desktop/src-tauri/src/main.rs:6344-6452`; the desktop pin run is in `dev/v0110-team/evidence/Tests110/lrnttl/desktop-pin.{log,status}`.

Acceptance 1 is pinned for the caption-only reconcile and title composition without a hide, close or reopen; the production title mutation and Open-menu refresh follow the `sync_title` path above. Acceptance 2 is pinned for a hidden record's reopen from its latest caption. The owner's intermittent occurrence is not reproduced by the repaired startup order, which is only the one failing order found by the reading.

At committed SHA `06661eea5cdf6bf0172a3e698b70db965df679e5`, `cargo fmt --check` and `RUSTFLAGS='-D warnings' cargo clippy --all-targets -- -D warnings` both passed with rc 0. The whole suites with two test threads each passed: `chan-library` 745 passed, one ignored, rc 0; `chan-server` 2,467 passed, one ignored, plus the zero-test example, rc 0; `chan-desktop` 649 passed, none ignored, rc 0; and `chan` 438 passed, one ignored, rc 0. The bounded guest logs and real exit statuses are in `dev/v0110-team/evidence/Tests110/lrnttl/gate-{fmt,clippy,chan-library,chan-server,chan-desktop,chan}.{log,status}`.

For the lead's R15 observation outside this row, `crates/chan-server/src/control_socket.rs:1681-1696` prints `WindowRecord.title` for `cs window list`, while the `WindowTitles` comments at `desktop/src-tauri/src/window_watcher_wiring.rs:826-827` and `desktop/src-tauri/src/serve.rs:971-974` say it prints the composed native title.
