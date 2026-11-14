# cs window new returns before the window can take commands

Status: accepted for v0.131.0 by the owner on 2026-11-14 ("take the cs window new race as work of the round"); not started.

Record: measured by the session that fixed the printed id (`dev/winid/handoff-release-agent.md`, "The race"; `dev/winid/report.md`). The owner's Mac agent saw the new window's `/ws` socket live 1.6 to 1.7 s after the command.

## What is there now

Read at `826adee91`, with the printed id fixed ([its row](cs-window-new-prints-an-id-the-window-verbs-refuse.md)): `cs window new` returns as soon as the desktop has minted the registry row. The new window's page connects its `/ws` socket later, and until then every `--window` verb refuses the id with `is not connected`. From the moment `cs window new` returned to the first `cs pane list --window ID` that answered: 924 and 942 ms for a workspace window, 984 and 1,229 ms for a standalone terminal window, on WebKitGTK in a guest. Typed by hand the two commands work; in a script, `w=$(cs window new) && cs open X --window "$w"` is refused for about that second.

Facts read at `826adee91`: `handle_window_new` in `control_socket.rs` passes the desktop's reply through and has no session registry today, though the handler's context holds one, the registry the `--window` checks read; the calling tenant's registry is the new window's; `SessionRegistry` (`crates/chan-library/src/session_presence.rs`) has `snapshot(now)` and a set-once change signal; a plain `cs` request has no reply timeout on the client and `DesktopBridge::dispatch` none either; with no desktop attached the verb answers `NO_DESKTOP` first; a stand-in desktop for a server test exists (`window_hide_answers_the_desktops_refusal`).

## Desired contract

1. The id `cs window new` prints is usable at once: the next `--window` command takes it, in a script with no wait of its own.
2. A window that never connects does not hang the verb: past a bound it says so and exits nonzero, naming the id.
3. With no desktop, and for a window the desktop mints and does not show, the verb answers as the build decides and says so.

## Boundaries

- The shape is the build's, read against the code: `cs window new` waits, bounded, for the registry to show the new window live and prints the id then (one place changes); or the `--window` verbs wait for a window the registry lists and no page has reached (every caller of `require_connected_window`). The recommendation handed over is the first.
- Read before the design is fixed: `cs window new` from a devserver's terminal that the desktop views (`new_workspace_window` asks the embedded local server only); a window minted and not shown; what the verb prints and exits with when the bound passes.
- What moves with it: `CS_WINDOW` and `CS_WINDOW_AFTER` in `crates/chan-shell/src/help.rs`; the `cs window` row of `web/packages/marketing/src/pages/manual/cs.html`; the driver `scripts/e2e/desktop-observations/window-new-id.sh`, whose first attempt then has to succeed at once (it records `first=0` today, logged, not judged), and its line in `scripts/e2e/README.md`.

## Acceptance

1. A server test with a stand-in desktop: `cs window new` answers only once the registry shows the window live, and past the bound answers the timeout; red on today's code for the first.
2. The driver, judging `first=0` for both kinds of window, red at the base and green at the tip in a desktop guest, ten runs each.

## Folded in, 2026-11-14

The owner took the round's candidates as recommended on 2026-11-14 ("Take all my recommendations", answering `dev/v0131-team/reports/owner-candidates-1.md`, item 2), folding in a finding of the warm chan-term review (`dev/v0131-team/reviews/review-warmterm-1.md`, note 2): `cs window new` for a terminal and the launcher's new-terminal route (`DesktopWindowOp::New { kind: Terminal }`, `desktop/src-tauri/src/window_ops.rs:44-46`) mint the window through `serve::spawn_local_terminal_window` and request no raise, so a `cs window new` run from a Terminal.app shell on macOS can leave the new window behind, as chan-term did before the warm chan-term row.

- Contract 4: a terminal window `cs window new` opens comes forward through the shared raise, as the warm chan-term launch does, on every platform.
- Acceptance 3: a test that the terminal arm of `cs window new` requests the raise, red on today's code; the driver's run in the desktop guest shows the new window focused; the owner's Mac line, in his batch.

## Correction to contract 4's caller, 2026-11-14

The fold above named the launcher's new-terminal route as `DesktopWindowOp::New { kind: Terminal }`. The build found otherwise by reading: only `control_socket.rs` constructs that operation (the `cs window new` bridge); the launcher's New Terminal button calls `backend.createWindow` (`state/library.svelte.ts`), which posts `/api/library/windows`, and chan-server mints the record directly (`routes/library.rs`), with no desktop bridge dispatch. A button in a chan window is pressed while chan is the active app, so its new window needs no raise across applications, which is what contract 4 is about. The lead's ruling: contract 4 covers the `cs window new` bridge and the desktop's own New Window terminal path (whose raise request compared a bare window id with the native label, so it was dropped); the launcher's HTTP route is outside it. The desktop guest's reading records where the launcher's new window opens; a window it leaves behind would be a new candidate.
