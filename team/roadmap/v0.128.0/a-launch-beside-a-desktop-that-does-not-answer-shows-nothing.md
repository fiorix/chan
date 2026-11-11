# A launch beside a desktop that does not answer shows nothing

Status: raised on 2026-11-10 by the review of v0.127.0's single-instance guard before its GA; accepted for v0.128.0 by the owner the same day. Built on 2026-11-11 and merged into the release's integration branch with its Linux reading; the Windows VM reading and the owner's macOS reading are open (the section Built holds the evidence).

## What is there now

One desktop runs per user: a GUI launch claims the per-user handoff endpoint first, and one that finds it held asks the holder to come forward and exits (`desktop/src-tauri/src/single_instance.rs`). When the holder does not answer (its main thread is stuck, or the process is stopped), a launch with no options first waits the handoff's 3 s reply budget for its offer to open a terminal (`Request::reply_budget`, `crates/chan-server/src/handoff.rs`), then asks the holder to come forward for `ASK_BOUND`, 5 s, then logs "another chan-desktop holds the handoff endpoint but does not answer; this launch exits rather than start a second desktop" and exits 1. Started from the Dock, the Start menu or a launcher, that line goes nowhere the user reads: nothing appears and nothing says why. Before v0.127.0 the second process booted and the user had a working window.

Two more launches end the same way, with exit 1 and a log line alone. A desktop whose handoff listener could not start keeps the endpoint claimed and answers nobody, so every later launch beside it exits after the 5 s. And a launch beside a desktop that says it is shutting down waits `DRAIN_GRACE`, 20 s, for the endpoint and exits 1 if that desktop still holds it.

## Desired contract

1. A launch that exits because the running desktop does not answer, or is still shutting down past the wait, says so where the user can see it: a native message naming chan, that a running copy is not answering, and what to do (quit or end that process, then start chan again).
2. The exit status and the log line stay as they are; no second desktop starts.
3. A launch from a terminal keeps the stderr line, and needs no dialog there if a terminal launch can be told apart; otherwise it shows the same message.

## Boundaries

- The guard's `Unanswered` and `StillShuttingDown` arms on macOS, Windows and Linux. The guard runs before the Tauri app is built, so the message cannot use an app handle.
- Not a way to recover or end the stuck desktop.

## Acceptance

1. The decision is already pinned (`a_held_endpoint_whose_desktop_does_not_answer_exits_non_zero`); a test pins that the two arms that exit 1 call the message hook and the other arms do not.
2. On each platform (the owner on macOS, the Windows VM, a Linux desktop): with the running desktop stopped (`kill -STOP`, or a suspended process on Windows), a launch from the Dock, the Start menu or a launcher shows the message within ten seconds and exits; one process remains.
3. The manual's install page says what a launch does beside a desktop that does not answer.

## Built, 2026-11-11

The guard's two exits that leave no desktop answering (`Unanswered` and `StillShuttingDown`) now report through one hook before `std::process::exit`: the log line as before, then a native message titled "Chan is not responding" or "Chan is still shutting down" that says this copy did not open and to quit or end the running one, then start Chan again. A launch whose stderr is a terminal keeps the line and shows no message (a modal there would hold the shell, and over SSH there is no display). The guard runs before the Tauri app is built, so macOS and Windows show the message through rfd at the version and features the dialog plugin links (a user notification alert; a task dialog), and Linux and FreeBSD through gtk, because rfd 0.16.0's blocking GTK dialog never returns when GTK cannot open a display: a minimal rfd program with no display hung until killed, while chan's gtk arm exits 1 in 5.5 s with the log line. The install manual and the desktop design document say what a launch does there (`e11aef4cc`, `e9b342ac6`); the rfd edge changed `Cargo.lock`, so the Nix cargo vendor hash was harvested in a disposable guest and re-pinned with the lock's digest (`0f0db461e`); merged as `c57758221`.

Checks: a hook pin over every guard outcome (red with the arms silent, `left: []`), a terminal-exemption pin, a message pin and a source pin that the guard reports before it exits; eight mutations each red at its own guard; chan-desktop fmt, clippy and 906 tests, the Windows GNU clippy, the marketing check. The Linux reading in a desktop guest under Xvfb: the first desktop stopped with `kill -STOP`, a second launch with stderr on a file showed "Chan is not responding" after 8.97 s (the 3 s terminal-offer wait, the 5 s ask, GTK start-up) and exited 1 once the dialog was dismissed, leaving one chan-desktop; with stderr a pseudo-terminal no dialog and the line; with no display exit 1 in 5.5 s. The ten-second bound therefore holds with about one second of margin. Open: the Windows VM reading (a task dialog from a Start-menu launch beside a suspended desktop), and the owner's macOS reading, where the Dock may activate the stopped app instead of starting a second process, so no guard runs; the check tries the Dock first and then `open -n -a Chan`, and if the Dock shows nothing that is a macOS limit the row states by the owner's word.

The Windows VM reading, 2026-11-11, at `470be4fe9`: with the running desktop suspended (NtSuspendProcess), a launch from the Start menu showed the task dialog "Chan is not responding" in the foreground after 7.0 s, closed it with OK, exited 1 and left one chan-desktop; a launch whose stderr is a file logged the line and showed the dialog after 8.2 s (the 3 s terminal offer, then the 5 s ask). A launch without foreground rights (from a scheduled task) shows the dialog behind the stopped desktop's window with the taskbar button flashing. `chan open` beside it falls back to its own server after 2.3 s and does not mention the desktop. The dialog's advice ("Quit that copy") is wrong for a desktop that is only booting and for another account's desktop the user cannot see; both cases go away with the Windows handoff item's claim and name changes. Open: the owner's macOS reading.

The owner's Mac reading passed on 2026-11-11 (`dev/owner-mac-checks-v0128.md`, section L, built at 811bd5eb8): every step reported passing, which closes the macOS reading the Built section left open.
