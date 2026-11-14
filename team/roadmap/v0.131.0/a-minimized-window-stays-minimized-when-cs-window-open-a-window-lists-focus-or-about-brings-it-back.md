# A minimized window stays minimized when cs window open, a window list's Focus or About brings it back

Status: accepted for v0.131.0 by the owner on 2026-11-13; not started.

Record: found on 2026-11-12 by the worker that built v0.129.0's shared raise, by reading, and confirmed by reading in the review of that change (`dev/v0129/row-notes.md`, "minraise: questions and follow-ups raised by the worker"; `dev/v0129/reviews/review-minraise-1.md`, "Other raise sites"). Recorded as not built in the shipped [raise row](../done/coming-forward-to-a-minimized-window-may-not-activate-the-app.md) ("Built") and among v0.129.0's follow-ups. Not seen on a screen. At v0.130.0's planning the owner placed the later group of rows, this one among them, in v0.131.0: "yes v0.131" (`dev/v0130/status.md`).

## What is there now

Read at `342dbe791`, with tao 0.37.2 as locked; by reading, not run.

- The shared raise (`raise_window`, `desktop/src-tauri/src/raise.rs:57-70`) restores, shows and focuses a window and settles the platform's remainder. Three callers take it: a second launch coming forward (`come_forward`, `single_instance.rs`), a close confirmation (`serve.rs`) and a Window menu Open row (`show_window`, `main.rs`); a test pins that list (`only_the_three_raises_take_the_shared_raise`, `raise.rs:443`).
- `unbury_window` (`desktop/src-tauri/src/main.rs:7135`) brings a live window forward by `show` then `set_focus`, with no `unminimize`, at three sites (7156-7157 for a `local::` window, 7190-7191 for a devserver `lib-` window, 7200-7201 for any other). It is reached from `cs window open` (`open_window_by_label`, `serve.rs:763`, through `window_ops.rs`), from a window list's Focus, Show or Open in the workspace app on chan-desktop (`runLibraryWindowAction`, `web/packages/workspace-app/src/api/libraryWindows.ts`, through the `focus_library_window` command, `main.rs:5004`), and from a Window menu row for a hidden window (`run_menu_item`, `main.rs:6605-6610`).
- `open_about_window` (`main.rs:7223-7227`) brings an open About window forward with `set_focus` alone.
- tao's `set_focus` does nothing while the window reads minimized, on Linux, macOS and Windows; on Linux and Windows `show` does nothing to a window that is already shown, minimized or not. So on those two a minimized window brought back by these paths stays minimized and unfocused. On macOS, whether `show` alone brings a minimized window out of the Dock is not read here; if it does, the app is not activated, the case the shipped raise row fixed for its three paths.

## Desired contract

1. A window brought forward by `cs window open`, by a window list's Focus, Show or Open, by a Window menu row for a hidden window, or by the About item while its window is open, comes back restored and focused when it was minimized, as a Window menu Open row's window does: these paths take the shared raise.
2. Nothing takes focus that nobody asked for: the pin on the raise's callers names these and no others.
3. A buried window, which the desktop reopens through its watcher, opens as it does now.

## Boundaries

- `unbury_window` and `open_about_window` in `desktop/src-tauri/src/main.rs`, and the caller pin and module comment in `raise.rs`. The raise itself is unchanged.
- Not here: focus-stealing prevention on Linux ([its row](a-second-launch-from-a-terminal-gets-no-focus-where-the-window-manager-prevents-focus-stealing.md)); on GTK the shared raise leaves a window that read hidden shown but unfocused (the module comment of `raise.rs`), which `unbury_window`'s last branch meets for a hidden window that is still alive.

## Acceptance

1. Tests in the raise's own style (its decision table and source pins): the caller pin names the new callers, and each of the four sites restores before it focuses; red on the code without the change.
2. In a guest, a minimized workspace window brought back by `cs window open` from outside it, and a minimized About window by the About item, ten times each under openbox and under metacity with the chan window never clicked (the reading of the raise row's harness, `dev/v0129/evidence/minraise/scripts/read.sh`): restored and focused 10 of 10 with the change, still minimized without it.
3. On the Windows VM (`dev/vm/windows.sh`) and on the owner's Mac, `cs window open` on a minimized window, ten runs each: the window restored and in front.

## Rulings for v0.131.0, 2026-11-14

The owner answered the decisions document for v0.131.0 (`dev/v0131/decisions.md`) on 2026-11-14; on its point 11 he wrote "as you recommend".

- Folded in from v0.130.0's follow-ups: on GTK the shared raise leaves a hidden window shown but unfocused (`raise.rs`'s module comment: "A window that read hidden is shown by the queued `show` after `set_focus` has already skipped it, so the raise leaves it unfocused"). This row routes a hidden window's path through that raise (`unbury_window`'s last branch), so the raise focuses a window that read hidden once it reads shown, as it does a window that read minimized once it no longer does. The boundary's "the raise itself is unchanged" gives way for that arm alone; the caller pin and the decision table cover it, and acceptance 2's guest reading adds a hidden live window brought back by `cs window open`, restored and focused 10 of 10 under openbox and metacity.

## Built, 2026-11-14

The three live-window branches of `unbury_window` and the existing About window use `raise::raise_window`, which restores, shows and focuses in order. The caller pin names the seven direct call sites, and each unbury branch still leaves a destroyed watcher-managed window to its watcher. The helper accepts the caller's Tauri runtime so the generic unbury path keeps its signature. On GTK the helper also settles a window that read hidden: its bounded task waits for both visibility and a non-minimized reading before focusing, and stops without focusing when either reading fails or the wait expires. The macOS activation and Windows settlement choices are unchanged.

Local proofs under `dev/v0131-team/evidence/Desk131/unbury-1/`: the new source pins failed four assertions against the base production code (`red-source.log`, exit 101). The unchanged pure Rust helper code and its tests, extracted alongside the source pins and linked to the cached Tokio test runtime, passed 12 tests (`green-unit.log`); this avoids rebuilding Tauri for the focused proof and is not a full-crate compile. Sixteen mutations each failed an assertion (`mutations.log` and `mutations/*.log`), covering each new caller, the extra-caller refusal, restore order, GTK settlement, visibility capture and polling, readiness, unreadable state and the timeout bound. A first full-crate red-test attempt was interrupted while building dependencies (exit 130, `red-base.log`); it established no test result.

The scoped gate and base/tip desktop guest reading passed as recorded below, with ten tip triggers for each minimized workspace, minimized About and hidden live-window case under Openbox and Metacity. Acceptance 3 remains open: the Windows VM line belongs to the later VM queue and the owner's Mac line to the batch prepared by the lead. A window hidden while minimized was not exercised by the guest matrix; the separate minimized and hidden cases do not establish that combined state.

### Guest verification, 2026-11-14

The implementation at `65f8aa279b4420b126489527b05b37afafe76fd7` passed its scoped gate in the desktop guest as uid 1000: formatting, all-target Linux clippy with warnings denied, rustdoc with warnings denied, the 12 raise tests, the desktop suite (1051 passed, 0 failed, one clipboard/display test explicitly ignored), and `make check-windows-test-target`. Every command returned 0; the complete source manifest matched before and after. The base and tip native desktop builds also returned 0. Logs and per-command exit files are under `dev/v0131-team/evidence/Ops131/J17/guest/gate/` and `guest/build/`; `followup-Ops131-Desk131-2.md` records the commands and build hashes.

Acceptance 2 passed against native X11 windows in the isolated desktop guest, using Openbox 3.6.1 and Metacity 3.58.1. For each manager, the minimized workspace and About windows and the hidden live control-terminal window were restored and focused on their original XID in 10/10 tip triggers. All 36 no-trigger controls across base and tip stayed hidden or minimized with the other application focused. The base workspace and About windows stayed minimized in all 40 triggers. The base hidden window was shown but left unfocused in 2/10 Openbox triggers, while Metacity focused it 10/10; that difference is recorded rather than treating the base hidden case as a deterministic failure. No chan window received a click or key; About used its real GTK menu action through AT-SPI, and the other two arms used `cs window open` from outside the target window. The GUI sessions ran as guest root; permission-sensitive unit tests ran separately as uid 1000.

The matrix driver returned 0 with 24 complete runs and 156 cycles. Readable raw native states, binary provenance, trigger logs and screenshots are under `dev/v0131-team/evidence/Ops131/J17/export/runs/matrix.A6axEi/`; the raw-record reading is `dev/v0131-team/evidence/Desk131/unbury-final-1/raw-matrix.log`. Every cycle began with the other client active, kept the original XID alive, and agreed with its run summary. The first screenshot of each run and both base hidden-window focus failures were inspected. These observations establish the guest line; acceptance 3 on native Windows and the owner's Mac remains unrun, assigned to the later platform checks.
