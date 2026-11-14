# A warm chan-term launch opens its window without Chan coming forward on macOS

Status: accepted for v0.130.0 by the owner on 2026-11-13 and moved by him to v0.131.0 the same day, at v0.130.0's planning; not started.

Record: seen on the owner's Mac walk of v0.129.0's [chan-term row](../done/the-default-terminal-is-chan-desktop-under-flags-of-its-own.md) on 2026-11-13 (`dev/v0129/owner/reports/parts-abc-at-8a44e110e.md`, Part B, `T2`), which recorded where the keyboard went without predicting it. Asked whether a warm `chan-term` launch should bring Chan forward on macOS in v0.129.0, the owner answered: "let's add a follow up item for this, no need to fix in this version".

## What is there now

A `chan-term` that only runs the shell, beside a running desktop, hands the desktop an `OpenTerminal` and exits 0. The desktop answers it with `serve::spawn_throwaway_terminal_window` (`desktop/src-tauri/src/serve.rs`, called from the handoff handler in `desktop/src-tauri/src/main.rs`), which records a throwaway terminal window for the window watcher to open. Nothing on that path calls the shared raise (`raise::raise_window`), which a second launch's coming forward, a close confirmation and a Window menu row go through. By reading, not proven by a run.

## Evidence

- In the run with the owner's tiling window manager quit (Part B, `T2n`; macOS 27.0.1, a build of `8a44e110e`): `T2a`, a bare launch, and `T2b`, a launch with `--dir`, each added one window to the one desktop (5 to 6, then 6 to 7), exited 0 with nothing printed, and read `front=Terminal` four seconds after the launch: the window opened and the keyboard stayed in Terminal. `T2c`, a missing directory starting at home with a warning, added its window too; its front app was not read. Where the windows appeared on screen was not seen by eye.
- In the same walk a `chan-term -e` window in a process of its own came to the front (`T5a`, `front=chan-term`), and a cold start ended with Chan frontmost and its terminal key (`T6f`).

## Desired contract

1. A warm `chan-term` launch that hands its shell to the running desktop ends with the new terminal window key and Chan frontmost, as a second launch's raise does.
2. No focus is taken where nothing was opened, as the raise row's second contract line says.

## Boundaries

- The desktop's answer to the hand-off's `OpenTerminal` on macOS; the shared raise, applied once the window exists, is the first candidate, as the round's notes say. On Linux, read first: under a window manager that prevents focus stealing, a raise asked for by a launch started in a terminal gets no focus at v0.128.0 or v0.129.0 (the [raise row](../done/coming-forward-to-a-minimized-window-may-not-activate-the-app.md)'s open items).
- Windows installs no `chan-term`, so it has no such launch.

## Acceptance

1. A test that pins the hand-off's terminal window going through the shared raise once it exists, red without the change.
2. The chan-term walk's `T2a` and `T2b` on the owner's Mac with the tiling window manager quit, ten runs each: one window added, one desktop, and Chan frontmost with the new window key in every run.

## Built, 2026-11-14

A successful warm `OpenTerminal` handoff retains its minted native label and requests the shared raise after the local watcher builds that window. The explicit New Terminal path does the same, so this also covers the owner's batch 6 N1/N2 second-launch case (`Forward::OpenTerminal`) when there is no window to raise. Boot's mint callers remain unchanged. The successful handoff answers without waiting for focus, so an expired focus request cannot cause a duplicate terminal through a handoff retry.

The request waits on the watcher's existing completion notification for at most three seconds, subscribing before it reads the window. The main-thread callback rechecks the deadline and the same local visibility rule the watcher uses, with local burial, a pending hide and shutdown also refusing the raise. It looks up only the requested native label and takes no focus when its record or native window is gone. No wire or persisted shape changes.

Acceptance 1: the new source pin fails against the base handoff, which discards its label (`dev/v0131-team/evidence/Desk131/warmterm-9/red-pins.log`, exit 101). The 19 extracted raise tests pass after restoration (`restored-unit.log`, exit 0), including ready, cancelled, expired and missing-window requests and completion between the probe and await. Eighteen mutations of the dispatch, visibility and wait guards each fail an assertion (`mutations-final/results.json`); this includes changing each disjunction to a conjunction. The caller scan now follows symlinked directories, skips root testdata, and bounds cycles by canonical directory identity; stand-ins show the base symlink miss and fixture false positive, and the new scanner's respective red and green, with fixture hashes retained (`base-symlink-provenance.log`, `base-fixture-provenance.log`, `scanner-final/`). Removing the fixture exclusion and cycle guard each fails the caller assertion.

The scoped desktop gate ran as uid 1000 on committed implementation `e758c3ac01ea927258fce39e23a53348e04ab7dc` in a guest: formatting, all-target clippy, rustdoc with warnings denied, the 19 raise tests, the full desktop suite (1058 passed, one unrelated clipboard-image test explicitly ignored), and `make check-windows-test-target` all returned 0. Source drift was zero before and after. The Windows check compiles and lints all desktop targets; it is not native Windows execution. Logs and statuses are under `dev/v0131-team/evidence/Ops131/J49/guest/gate/`. The closing evidence added afterward changes this row alone and does not claim that gate ran on the later documentation commit.

Linux arm B ran the base and implementation under Xvfb/Openbox, ten bare launches and ten with `--dir` per revision. J49 completed both base arms and the tip's `--dir` arm: each launch added one mapped window and one record to the existing desktop, retained the old window and shell, and started a new shell in the expected directory. The new window was active after four seconds in 8/10 base bare launches, 7/10 base directory launches and 10/10 tip directory launches. J49's tip bare arm stopped at cycle 1 with a 15-second cleanup timeout (exit 3); its initial Bash child was already absent before the launch. That run remains incomplete and its cause unexplained. Logs, captures and screenshots remain under `dev/v0131-team/evidence/Ops131/J49/guest/warmterm/`.

J67 reran only tip bare, unchanged and alone in the Ops queue: the binary, all five scripts and deadlines matched J49. It completed ten cycles (exit 0). Independent inspection of all before/after native, registry and process records confirms one new mapped and focused window, one desktop, the initial home-directory Bash child retained and a new Bash child in the launch directory in every cycle; all launches were silent, and all ten exact-window cleanup commands returned 0. All ten screenshots show the new terminal in front with a shell prompt. The raw data is `J49/guest/warmterm/tip-bare-rerun-1/`; the command, exit and host records are `dev/v0131-team/evidence/Ops131/J67/`; the independent audit and its four failing negative controls are `dev/v0131-team/evidence/Desk131/warmterm-12/audit-j67.log` (exit 0). The host was quieter but still recorded swap I/O; the rerun establishes no cause for the first timeout.

Acceptance 2 remains for the owner's batch: T2a and T2b ten times each on macOS with the tiling window manager quit. Linux focus is a window-manager observation and does not stand in for that acceptance. The manual and desktop design describe the requested raise; no macOS runtime claim has been verified yet.
