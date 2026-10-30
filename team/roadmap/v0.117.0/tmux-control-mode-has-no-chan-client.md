# tmux control mode (`tmux -CC`) has no chan client

Status: proposed for v0.116.0 (the open version, chosen for lack of another; the target is the owner's to set); owner accepted the decisions on 2026-10-30, assessed against `a4b5844b9` (main, v0.115.0). Built so far on `v0116/tmux-protocol`: the protocol crate (stage 2), the marker policy, the consent question and the hardening after an allow (stage 3a), and the connection with its pane sessions (stage 3b); the control window's status view, the tab per tmux window and splits are not. Not a roadmap item until accepted for a target version.

## Ask

- Running `tmux -CC` in a chan terminal turns that tab into a control terminal, detached from its window, like the ones that run the ssh connect script for a devserver.
- When the tmux process ends the tab stays a control terminal; the user decides when to end it.
- Every connect (new or reattach) opens a new chan window, as iTerm2 does. Inside it, Cmd+Shift+N (the existing New Window chord) creates a new tmux window in a new chan window, and Cmd+T creates a new tmux window as a tab in the same chan window.

## What the tree says today (observed)

1. A terminal is a server-side PTY session (`crates/chan-library/src/terminal_sessions.rs`) with any number of clients on `/ws` frames (`input`, `resize`, `program-status` in `crates/chan-server/src/routes/terminal.rs`). The browser only renders bytes. The PTY may live on a devserver, so the tmux protocol must be parsed where the PTY is, not in the page.
2. The server already walks every PTY byte (`Session::record_output`, `terminal_sessions/bytes.rs`) and OSC 7501 settled the pattern: one server-side parser, state published to all clients, the library answers itself (`team/roadmap/done/a-program-in-a-chan-terminal-cannot-report-its-status-osc-7501.md`). The tmux gateway should follow it.
3. A control terminal today is a desktop-native window over a transient, in-memory `control: true` record (`WindowRegistry::create_control`, `crates/chan-library/src/windows.rs:530`). It is minted by the desktop for a devserver connect script, reaped when its PTY exits, tagged with a foreign `library_id`, and serves terminals only (`desktop/design.md` lines 196 and 250). The ask inverts two of those properties: it must survive PTY exit, and it is born from an existing tab, not from the desktop.
4. A window is a binary split tree of panes, each pane an ordered list of tabs (`web/packages/workspace-app/src/state/tabs.svelte.ts`, line 3). A tab is one view; no tab holds a split of its own. iTerm2 maps a tmux window to a tab that holds splits, so chan has no direct equivalent.
5. Window > New Window is Cmd+Shift+N and asks the focused window's library to mint another record of the same kind (`desktop/design.md` line 214); a workspace window mints a workspace window. A tmux window fits that rule with no new chord: the same action means a new tmux window. Plain Cmd+N stays the SPA's New Draft and is untouched.
6. tmux 3.8 is installed on this host, so a real `tmux -CC` can drive protocol fixtures here.
7. Established at stage 1: the control tab's session can be re-homed to a new control window id (see the measurement below). Not established: how a tmux-initiated window opens in a browser (read: the launcher deck opens a blank popup synchronously on a user gesture and the window record carries a holder tag, `web/packages/launcher/design.md`; a server-initiated open has no gesture and a popup blocker may refuse it); what ghostty-web does with DCS 1000p; whether ConPTY passes DCS intact.

## Stage 1 measurement (2026-10-30)

Run inside a throwaway sdme guest (2 GiB, 2 CPUs, private network, no host binds) with the host's tmux 3.8 bundled in; the host devserver was not involved. Captures are in `fixtures/tmux-control/` (see its README). Each point is observed in those captures unless marked.

1. Entry is `ESC P 1000 p` followed at once by the first reply. That first `%begin T N 0` has flags 0 (server-originated, no command of ours behind it), then `%sessions-changed` and `%session-changed $0 name`. Exit is `%exit` or `%exit reason` then `ESC \`: graceful detach, an empty line, `detach-client`, a missing session (`%error` then `%exit`), `kill-server` from outside (`%exit`) and a SIGKILLed server (`%exit server exited unexpectedly`) all end the same way, with the client process exiting 0 or 1. So server death needs no separate path; a PTY that closes with no `%exit` is the only other end.
2. `%output` escapes every byte under 0x20 and the backslash as three octal digits (`\\134` for a backslash, `\\033`, `\\000`, `\\015\\012`); UTF-8 above 0x7f passes raw (the 4-byte non-BMP emoji arrived as raw bytes in the capture of scenario 02, not shown octal). `%` is not escaped, but every `%output` line starts `%output %pane `, so a pane cannot forge a line through it.
3. Reply data is raw. In scenario 06 a pane that printed `%exit` and `%end` came back inside a `capture-pane` reply as bare `%exit` and `%end` lines, followed by blank lines for the empty screen rows. In scenario 13 a hostile pane printed a `%end T N 1` line for every plausible time and command number plus `%exit`; `capture-pane` returned them all, so the framer sees `%exit` and forged terminators inside an open block. This is a finding, not a theory: a framer that closes a block on any `%end`, or on an id-only match as iTerm2's does, can be cut short by pane content, and the lines after the forged end then parse as notifications (`%exit`, `%output %N` for another pane). Exact match of the block's own time, number and flags narrows it but a program that prints every plausible triple still reaches one. Candidates for stage 2, to be measured, not assumed: capture a fixed row count (`-S` and `-E` absolute) and consume exactly that many lines before accepting a terminator; never act on a notification line that arrives inside an open block.
4. Layouts: `%layout-change @W csum,WxH,x,y{...} visible_layout flags`, with `{}` for side-by-side and `[]` for stacked; checksum header as iTerm2 skips. With `refresh-client -f new-layouts` the layout is JSON (`{"V":2,"L":{"t":"h"|"v"|"p",...,"I":"%0"}}`) in `%layout-change` and in `list-windows`. `%window-pane-changed @W %P` follows a split. `%window-add`, `%window-renamed`, `%window-close`, `%session-window-changed` arrive as expected. A resize makes tmux redraw every pane through `%output`.
5. `capture-pane -peqJ` keeps escape sequences raw in the reply, and its lines start with an SGR reset where a colour was open (`ESC[39m1`); a backslash stays a single raw backslash, which is why pending-output decoding in iTerm2 needs a workaround. `list-panes -F '#{cursor_x} #{cursor_y} #{pane_in_mode} #{alternate_on} #{scroll_region_upper} #{scroll_region_lower}'` returns the pane state.
6. Flow control: with `pause-after=1` and 1.2 MB of output the stream was 1,102 `%extended-output %0 0 : ...` lines (latency 0), no `%pause`, because the harness read as fast as it was written. A `%pause` and `%continue` run needs a client that does not read; that is a stage 3 test.
7. A session can be re-homed: `Session::window_id` is interior-mutable and a reattach rebinds it, a cross-window terminal move is a supported path (`terminal_sessions.rs` near line 4341, `unpersist_window` near line 3109).
8. The seam for virtual pane sessions exists: a session's input, resize, redraw and kill already travel as `PtyCommand` (`Input`, `InputSequence`, `Resize`, `Redraw`, `Kill`) to a controller, `child_pid` and `master_fd` are already `Option`, and `record_output` is the one entry for output. A pane session needs a different consumer of `PtyCommand` and no child; the 77 uses of `child_pid` and `master_fd` in the file were counted, not each read, so the size of the change is still an estimate.
9. Not measured, and why: what ghostty-web and xterm.js do with `DCS 1000p` is moot by design, because the server swallows the stream from the marker on and no client sees it (the marker itself must be stripped, and the byte walk must handle it split across reads); ConPTY with a remote `tmux -CC` is unmeasured (no Windows host here; the existing ConPTY OSC 7501 measurement in `terminal_sessions.rs` is the pattern to extend in stage 3); chan's server path with a real `tmux -CC` in a terminal was not run.

## Stage 2 results (2026-10-30)

`crates/chan-tmux` is built: stream framing, notifications, commands, layouts and a `Client` that pairs replies with commands, with no I/O and one dependency (`serde_json`). Design in its `design.md`; 36 tests across replay of the stage 1 captures at every chunk size, hostile streams, a deterministic noise run, command injection and a live run against tmux 3.8 inside an sdme guest (`CHAN_TMUX_BIN`, skipped by default).

1. The forged-terminator finding is closed in the decoder: a block ends only on an exact header match, and a capture ends only after exactly `history_rows + rows` rows, which tmux returns when `history_rows` does not exceed the pane's `history_size` (measured). A test pins the hazard (the same stream cuts a no-promise reply short and is plain data with a promise), and removing either guard fails named tests.
2. A second injection, found by the live run: tmux format-expands window names and directories, so `rename-window -t @0 '#(touch /tmp/x)'` runs a shell command on the tmux host (control run in the guest: the file appeared). Free-text arguments now double every `#`; the live test renames a window to a `#(touch ...)` name and checks no file appears.
3. tmux stores a window name C-escaped, so a backslash comes back doubled in `%window-renamed`. The crate reports what tmux reports.
4. The line discipline drops pending echo when `^C` arrives in the same write as earlier keys, so a client that types a line and an interrupt in one `send-keys` loses the line. Send an interrupt alone.
5. A failed `capture-pane` (its pane closed mid-flight) is an `%error` block whose rows differ from the promise, so it ends the stream with `Error::ReplyShape`; the gateway reconnects. This is the cost of not believing a terminator pane content can forge.
6. The entry marker is recognized only while the decoder is armed. The gateway must arm it only when the user ran `tmux -CC`; a program that prints `ESC P 1000 p` into an ordinary terminal otherwise starts a session. How the library knows the user ran it (the foreground process, or an explicit command) is a stage 3 decision.
7. Not covered by the live run: `pause-after` flow control (needs a client that does not read), the reconnect after a failed capture, and a `tmux -CC` PTY (the live run uses `tmux -C` over pipes; the `-CC` marker path is covered by the captures).

## Stage 2 hardening (2026-10-30)

A second pass over `crates/chan-tmux`, with an independent read of the crate against tmux 3.8 (eleven findings, in the commit messages `028e7d299` and `fe3ad52b5`):

1. A capture was sized by a pane state read in an earlier command, so a resize from another tmux client or a shrunken history between the two left the reply short and ended the stream. `CapturePane` is now one command line of two commands, the state and then the rows with `-S -N -E -`, which tmux runs back to back; the decoder sizes the rows from the state just before them, and the client answers both as one `Event::Capture`. A capture whose pane is gone fails at its state and ends the stream (`NoPaneState`): the one benign event the framing still cannot absorb, since its rows cannot be sized.
2. `capture-pane -a` is the screen tmux keeps under an alternate screen, not the alternate screen: one row when none is on, and its old height after a resize. It is never asked for; the one capture is the screen the pane shows, with the history tmux still reports above it.
3. tmux reads a quoted positional that starts with `-` as flags, so a window name goes after `--` (live: `-x`, `--` and `-t @0; kill-server` stored verbatim).
4. A `-e` capture row carries each cell's escapes, and a cell can hold a hyperlink of about 1 KiB, so the line bound is 12 MiB, a row of the widest pane a size command may ask for; the block byte bound is 64 MiB; a capture whose rows could exceed the block's line bound is refused at `submit`, which queues nothing on a refusal.
5. An armed decoder passes everything up to the next `ESC` in one piece; release build, 64 MiB in 16 KiB reads: plain text 388 to 4,509 MiB/s, two escapes per 60-byte line 376 to 1,524 MiB/s, against about 19 GiB/s disarmed. A PTY delivers far less, so the gate is not where a terminal's output time goes.
6. Every plain byte passes as it arrives, the marker's own included, so a read that ends inside the marker holds nothing back and a parked session loses nothing; the terminal is shown an empty `DCS 1000 p`, which the gate closes with `ESC \` on entry (found by the fd-store framing tests, which saw bytes reach the program status framer late).
7. Recorded, not changed: a reply tmux generates for a user's hook carries no promise, and `%exit` is believed only outside a block, so the owner of the tmux process ends the session on its exit or the PTY's end, never on the decoder alone.

## Stage 3a results (2026-10-30)

Built on `v0116/tmux-protocol`: decisions 1 to 5 and the hardening of decision 4, as `terminal_sessions/tmux_gate.rs` in chan-library over the crate's client, the consent frames on the terminal WebSocket, the banner in the SPA, the `terminal.tmux` table (`enabled`, `trust`) through `chan config`, `PATCH /api/config` and Settings, and the design docs and manual. What a connected session does in this stage is swallow the protocol and show chan's notices (the version on entry, the reason on exit); the gateway thread, pane sessions, windows and tabs are stage 3b and later.

1. The foreground is read as the PTY's process group from `tcgetpgrp` and its name from `/proc` on Linux; macOS and Windows read nothing and ask, since no dependency was added for a process name there (libproc on macOS is the candidate when the question becomes a habit).
2. The interrupt line is a command through the client (`Command::Interrupt`, a line holding only `^C`), paired with the parse error tmux answers, and goes out with the version probe only once the peer has announced a session; a `tmux -CC` client on a PTY is in raw mode and reads a bare `^C` as part of the next command line (probed on the host), so a peer that never announces gets the bare `^C` at the five-second abort instead, which cancels a shell's held line.
3. Verification: 27 library tests (the gate's state machine and the session's ring, controller and attach handle), 4 server tests (the frames and the PATCH keeping a stored table), 2 CLI tests, 8 SPA tests (the Settings toggle and the banner); nine guards mutated and each caught by a named test, rebuilt from fresh mtimes after the loop; the library's terminal session suite (403), workspace clippy, rustdoc, `make web-check` and the Nix hash pin. Not run: a real `tmux -CC` through chan's server path (the live crate test drives `tmux -C` over pipes), macOS and Windows.

## Stage 3b results (2026-10-30)

Built on `v0116/tmux-protocol` after its rebase onto `desktop/terminal-prototypes`: a connected session's panes are sessions of the same registry with no PTY, recorded from what tmux reports and commanding tmux through the connection (`terminal_sessions/tmux_connection.rs`, `Session::for_tmux_pane`, `Registry::add_tmux_pane`), a gateway thread per connection for their commands, the host's hook that mints a buried chan window per tmux window within the cap, and the foreground read on macOS and FreeBSD through the process table.

1. Session shape: `Session::command_tx` is a `CommandSink`, the controller's channel for a PTY session and the connection's one channel for a pane session, with the pane id on each command; the sixteen senders are unchanged. A pane session is never restarted, parked or pruned for idleness, does not count against `terminal.session_cap`, and is capped at 256 per registry; its exit is recorded without the registry's last-exit copy.
2. The connection runs under the control session's gate lock and hands the registry its work (pane sessions, their ends and renames, chan windows, the gateway thread) through a per-session queue the drainer performs every 150 ms, since the session has no registry reference and the lock order forbids the registry's lock under the gate lock. The attach: pause-after, JSON layouts on 3.8, the window list with names and layouts (the crate's list-windows format gained the name, read as the rest of the line), each window's panes, and per pane one capture sized by the scrollback setting at the pane's width (10 MB at 80 columns is 10,922 rows, the SPA's arithmetic) inside the reply's bounds; output read before the capture is held up to 1 MiB and follows it. A layout change sizes pane sessions and adds or ends panes; a window close, `%exit`, a stream error, a detach and the control process's end each end every pane with its exit.
3. Found by running a real `tmux -CC` through chan's server (a throwaway `chan serve`, the control terminal opened through `POST /api/terminals`, `cs terminal list`, `write` and `scrollback` over the control socket): tmux titles its processes, so Linux reports the client's name as `tmux: client`, and the policy now matches the process name's first word; a byte typed into a connected control terminal reached tmux's stdin as a command the client never paired and ended the stream, so a client's typed bytes reach nothing from the marker until the stream is plain again. With both in, the run shows the notice, the pane session under the tmux window's name in the `tmux` group, typing through it with the echo and the output in both the pane session and tmux's own capture, and a tmux-initiated end that leaves one notice and no residue.
4. Minted chan windows are buried, since they hold none of the tmux window's tabs (stage 5 seeds them and unburies); a crash leaves a row behind that nothing sweeps.
5. Verification across the three commits: 8 pane session tests, 11 connection tests, 2 for the hook and the process table, the gate's tests, 24 guards mutated and each caught by a named test on real rebuilds; the library's whole suite (813), the crate's live run against tmux 3.8, fmt, clippy -D warnings, rustdoc -D warnings, the Nix hash re-pinned for the `sysinfo` dependency.
6. Not run: macOS, FreeBSD, ssh; those are the hand tests of decision 17.

## Stage 4a results (2026-10-30)

The rows a crash would leave, from stage 3b's point 4. The window registry already holds a class of rows no save writes (control rows and throwaway terminals, filtered in `save_best_effort`), so the sweep the design note proposed is replaced by construction: a tmux-minted row carries `tmux: true` (`PersistedWindow`, `WindowRecord`, the scoped launcher row), `WindowRegistry::create_tmux_window` mints it native, buried and labelled, and the save filter leaves it out, so `windows.json` never carries one and a crash strands nothing. Nothing is read back and dropped: a row no build writes needs no sweep. Rows minted by the stage 3b builds before this change were written as plain hidden rows with no mark, so they cannot be told apart; the owner removes any such leftover by hand. Tests: the row lives in memory only across a durable save and a reload, the mark is on the wire and omitted when false, the mint notifies the window feed, and the host hook's row carries the mark and is absent from the store.

## Stage 3 decisions (2026-10-30)

Settled by the owner on 2026-10-30, after reading iTerm2's handling of the marker (see Evidence below):

1. When the marker is honored. iTerm2 honors `ESC P 1000 p` unconditionally and relies on a leading ^C, writes held until `%session-changed`, a `phony-command` and a regex on echoed values; the owner does not want unconditional honoring. Chan decides from the PTY's foreground process at the moment the marker arrives: a local `tmux` enters control mode with no question; anything else (`ssh`, `mosh`, `cat`, an unknown foreground) shows a banner over the tab and writes nothing to the PTY until it is answered. Chan does not detect a remote tmux, which it cannot see; the banner names the foreground process (its arguments where the OS lets them be read) and the user, who just ran the command, is the detector.
2. The banner offers Allow, Allow for this tab, and Deny. Allow for this tab is held on the session and dies with the tab; it is not persisted and not per remote host. Any attached client may answer and the first answer wins; every attached client shows the same banner. No answer in 60 seconds is Deny. Bytes after the marker are held in a bounded buffer meanwhile. Deny writes one newline (which detaches a real tmux), discards the held bytes and returns the tab to plain output, draining until the `%exit` and `ST` or a short timeout so they do not draw.
3. Settings. `terminal.tmux.enabled` (default on) is the master switch, set from `chan config`, `PATCH /api/config` and Settings, Terminal, in the way `terminal.program_status` is: a registry-level switch that applies to live sessions. Off, the marker is not honored and passes through as ordinary bytes. `terminal.tmux.trust` is a list of foreground program names treated like a local `tmux` (default empty, for `ssh` and `mosh` users who do not want the question); it is config-file only and not surfaced in Settings. Both rows go into `docs/config-reference.md` in the commit that adds them.
4. Hardening carried over from iTerm2 and kept after an Allow: a leading ^C before the first write, a first command that is harmless to a shell, an abort when the peer does not answer like tmux within a timeout, a window cap, and a 3.2 version floor with a clear message and a clean detach below it. Chan's own commands are already a closed set of typed ids and quoted text, which iTerm2's are not.

Settled by the owner's answers of 2026-10-30:

5. Turning `terminal.tmux.enabled` off changes nothing for a live connection, which runs until it ends; it only stops honoring new markers.
6. Size: last resize wins, sent per window with `refresh-client -C @id:WxH` on tmux 3.4 and later and client-wide below that.
7. When tmux ends (detach, `%exit`, server death, a dropped connection) the chan windows and tabs opened for that connection close by themselves; the control terminal stays.
8. A live connection is not restored after a devserver or desktop restart; the user runs `tmux -CC attach` again. Re-syncing after a graceful restart is a later option, not v1.
9. History: per pane, `min(history_size, the terminal scrollback setting)`, normal screen first and the alternate screen only when `alternate_on`; live output is held until the capture lands.
10. Window cap: 8 chan windows opened at connect; the rest are listed in the control terminal to open on demand. Each open pane costs one WebSocket, which counts against a gateway tunnel's 120 substreams.
11. The control terminal shows a small status view: the tmux sessions and windows (those past the cap with an Open button), errors, the tmux version, and Detach and End.
12. No `cs tmux` in v1.
13. Typing into a pane session follows the ordinary terminal rule, which was read on 2026-10-30: `/api/terminal/ws` is declared `NonOwner` in `route_authority.rs` ("no gate on the route tells the owner and a grantee apart, or one client from another") and the terminal route has no leader or follower check, so any caller that reaches a terminal, a gateway grantee included, may type into it. Pane sessions inherit this and add nothing. The same holds for the consent banner: any attached client may answer it, which is no escalation over typing into the shell.
14. Withdrawn on 2026-10-30 with the gateway: a pane session's socket stays attached while its tab is hidden, as every terminal's does. (It read: a tmux pane session's terminal WebSocket is attached only while its tab is visible, to keep a session with many panes from spending a gateway tunnel's 120 substreams.)
15. Hidden panes' output keeps flowing to the gateway thread and the ring in v1; it costs CPU on the machine that runs the terminal. Turning it off with `refresh-client -A '%N:off'` is a later optimization.
16. Withdrawn on 2026-10-30 with the gateway. (It read: one acceptance run through a real gateway tunnel in an sdme guest, a browser opening 8 windows by 4 panes, left quiet past the 300 second idle cut, the substream count read off the devserver, keystrokes typed through it, a window minted on the devserver opened by a gateway-connected client.) The gate for stage 3 is decision 17.
17. The owner scoped the feature on 2026-10-30 to a local tmux and a remote one reached over ssh from a chan terminal, on Linux, macOS and FreeBSD; the chan gateway (a tunnel to a devserver through the cloud gateway) is out of scope for `tmux -CC`, and Windows is not tested, since no machine is at hand and local tmux is not a use there. A terminal on a devserver reached by the desktop without the gateway runs the same code and is tested when convenient. The gate for stage 3: on each of the three platforms, a local `tmux -CC` enters with no question, types, resizes, detaches and attaches again, and the server's death ends the connection cleanly; and `ssh localhost` then `tmux -CC` asks once, naming `ssh`, and enters without asking after `trust = ["ssh"]`. The foreground process name must therefore be read on macOS and FreeBSD as well as Linux.

Agreed as the build approach and not a user-facing choice: pane sessions are registry sessions with no PTY, with a gateway thread consuming `PtyCommand`.

Read in code on 2026-10-30: a window minted on a devserver reaches a connected desktop through the window watcher, which reconciles each connected library's records; a hidden tab stays mounted with `visibility: hidden` and keeps its socket, which is fine now that the gateway's substream budget is out of scope.

Evidence for decision 1, read in iTerm2's source on 2026-10-30: `VT100DCSParser.m` sets the hook on `1000p` alone, `VT100Terminal.m` calls `terminalStartTmuxModeWithDCSIdentifier`, and `PTYSession.m` `startTmuxMode` refuses only a nested start, writes ^C ("to make it hard to use tmux mode for RCE because we'll soon write a newline"), and creates the gateway. `TmuxGateway.m` holds writes until the first `%session-changed`.

## Design

### The gateway lives on the server

- A `TmuxGateway` per entered session, beside `program_status.rs` in `terminal_sessions/`. The byte walk detects `DCS 1000p` (`ESC P 1000 p`), which tmux prints once on entry. From then on the session's output is no longer terminal output: it is lines of the control protocol, parsed by the gateway and never fed to the ring, to a client's emulator, or to `VisibleScan`.
- The tmux protocol ends with `%exit` then `ESC \`; a plain ST does not end it, and ESC sequences inside are literal. `%exit` inside a `%begin` to `%end` block is data (capture-pane output), so the framer tracks the open block. The gateway then reverts the session to a plain byte stream, so a shell prompt after `tmux -CC` returns draws normally. Writes are held until the first `%session-changed`, and an empty line detaches.
- Parsing happens once per session on the server, so two clients of one session see the same state, the page can reload, and `cs` can list it. A page-side parser would be written twice and lose state on reload (the OSC 7501 reasoning).

### Protocol surface (v1)

- Notifications (the set iTerm2 handles): `%begin/%end/%error`, `%output` and `%extended-output` (pause-after flow control, tmux 3.2 and later), `%pause`, `%window-add`, `%window-close`, `%window-renamed`, `%unlinked-window-*`, `%layout-change`, `%window-pane-changed`, `%session-changed`, `%sessions-changed`, `%session-renamed`, `%session-window-changed`, `%client-session-changed`, `%client-detached`, `%subscription-changed`, `%exit`. `%noop`, `%continue`, `%pane-mode-changed` are ignored; any other `%` line is logged and ignored.
- Commands the gateway sends: `display-message -p '#{version}'` first (version gates everything below), `refresh-client -C`, `refresh-client -f pause-after=N`, `list-sessions`, `list-windows -F`, `list-panes -F`, `capture-pane -peqJ -S -N` for history, `send-keys -H`, `new-window -PF '#{window_id}'`, `kill-window`, `select-window`, `split-window`. Order per pane at attach is in the appendix.
- Input encoding is one place: every user byte becomes `send-keys -t %PANE -H xx xx` and the gateway never builds a command from user text unescaped.
- Command replies are matched in strict FIFO order (iTerm2 does not use the command number either); a `%begin` with an empty queue aborts the gateway, as does a malformed notification. A 5 s unanswered-command timeout offers detach instead of guessing.

### Virtual pane sessions

- Each tmux pane becomes a session in the registry with no PTY: it has a ring, scrollback and clients, and takes `%output` as its output. Input and resize on it go to the gateway instead of a PTY. The existing terminal WebSocket, `cs terminal` and the unseen-output machinery work unchanged on top.
- This is the biggest structural change: `Session` today assumes a child and a controller thread. Stage 1 measures how far that assumption goes before committing (see Stages).
- History restore on attach: `capture-pane` per pane is written into the ring before live `%output` is admitted, with the ordering held by the gateway so a live byte never lands before the history it follows.

### The control terminal

- On `DCS 1000p`, the library mints a control-flagged window record for the session and moves the session into it; the original tab leaves its window. The control window is the gateway's console: it shows the raw session until entry (a failed `tmux -CC` prints its error there), and afterward shows a status view (sessions, windows, errors, Detach and End buttons).
- Differences from the devserver control terminal, all of them new: the record is created from a session, not by the desktop; it is not reaped when the PTY exits (the user ends it with Close, `cs window rm`, or an explicit End); and a second `tmux -CC` run in the same control terminal after an exit re-enters control mode and opens a new window again.
- Whether the record is persisted across a host restart is a decision (see Decisions); the default here is no, like today's control rows.

### Windows, tabs and panes

- Per connect: one chan window per tmux session attached (iTerm2's behavior). The gateway asks `list-windows` and `list-panes`, then the library mints a workspace-less terminal window for the session and fills it.
- A tmux window is a chan tab. A tmux window with several panes needs a tab that renders a layout. Options in Decisions; the recommendation is a `tmux-window` tab kind that renders the parsed `%layout-change` tree as splits of pane terminals, and that is the stage most likely to slip.
- Layout strings (`%layout-change` with its checksum prefix) are parsed on the server into a tree. A mismatch of checksum or of cell sizes is dropped, not repaired.
- Resize: the page reports the cell size of the window; the gateway sends one `refresh-client -C WxH` for the session, and per-pane sizes follow tmux's layout.
- Cmd+T inside a tmux window sends `new-window`; the answer `%window-add` makes the tab, so the tab never exists ahead of tmux. This is also iTerm2's behavior: its new window is a new tmux window in a new native window, grouped by an affinity it stores in tmux session options (`@affinities` and siblings) so a reattach restores the grouping; the same trick can restore chan's grouping. Cmd+Shift+N does the same with `new-window` and a new chan window. No `new-session` is used, so every chan window of a connect belongs to one tmux session.
- Close of a tab sends `kill-window`. Close, Hide and Detach of a window are Decision 2: Hide is a local bury, Detach is whole-connection.

### Shortcut scoping

- Cmd+T and Cmd+Shift+N keep their chords; what changes is the action behind them when the focused window is a tmux window, routed through the library's existing same-kind mint (the path Window > New Window uses) with the tmux capability injected the way `chan-files` is. Plain windows are unchanged. The Linux and Windows chord equivalents follow the rule that already maps Cmd to Ctrl or Super.

### Authority and trust

- Everything tmux sends is untrusted: window names, pane titles and `%output` bytes are bounded and rendered as text. The gateway caps line length, outstanding commands, per-pane queued output (flow control through `pause-after`), and the number of windows and panes it will materialize.
- A control terminal opened over a tunnel or devserver gets the same bearer rules as any session; the gateway adds no new route.

## Stages

Each stage lands behind its own check and leaves chan working.

1. Measure (no feature). Done 2026-10-30 in part: protocol captures, the re-homing question and the session seam are answered in the measurement section; the ConPTY and chan-server-path runs remain, and the forged-terminator finding adds a stage 2 design item. Run `tmux -CC` under chan today and under `script`, capture real traffic in `fixtures/`, read how much of `Session` assumes a child, and answer observation 7: re-homing a session, the browser window path, ghostty-web and ConPTY with DCS 1000p. Output: a short measurement note and a go or reshape call on virtual pane sessions.
2. Protocol crate. Done 2026-10-30: `crates/chan-tmux`, see the stage 2 results above. A new `chan-tmux` crate (pure parser and command encoder, no I/O, `#![forbid(unsafe_code)]`): line framing, octal unescape, reply correlation, layout string parser. Tested against the stage 1 captures (`fixtures/tmux-control/`) including the hostile-pane run, fuzzed on random bytes (`%output` with partial escapes, split reads, huge lines), and differentially against `tmux 3.8` output.
3. Gateway in the library. Done 2026-10-30 (3a and 3b): the marker in the byte walk, the policy, the question and the hardening after an allow; the connection, pane sessions, history restore, `send-keys -H` input, resize and the exit back to bytes; see the stage 3a and 3b results. The hand tests of decision 17 on macOS and FreeBSD and over ssh are open.
4. Control window. The record minted from a session, not reaped on exit, End and Close semantics, `cs window list` shows it, launcher rows for it. Desktop path first; the browser path follows the stage 1 answer.
5. Windows and tabs. One window per attach, tab per tmux window, notifications as the single source of structure, Cmd+Shift+N and Cmd+T routing, close semantics.
6. Panes. Layout tab kind with splits; resize; pane focus sync with `select-pane`.
7. Docs and manual. `design.md`, per-crate design docs, the manual page, and the keyboard reference, in the same commits as the behavior (`.agents/README.md` rule).

Gate per stage: the `gate` skill's pre-push set, plus a browser check (`scripts/` browser suite) from stage 5 on, named by what it observes in a real window.

## Verification

- Protocol: replay captured sessions, assert the structure the gateway publishes; mutation checks that a dropped `%begin` pairing, a wrong octal decode and a bad layout checksum each fail a named test.
- Preservation: bytes typed into a pane arrive in order and unmodified (including NUL, ESC, bracketed paste and non-BMP UTF-8) through `send-keys -H`; scrollback after reattach equals `capture-pane`.
- Failure arms: tmux killed mid-line, server `%exit` with a reason, malformed `%layout-change`, 10 MB of `%output` in one second (memory bound holds, `pause-after` engages), a client that never reads, two clients on one control session, reconnect after a devserver restart.
- The control terminal outlives the tmux process and a second `tmux -CC` re-enters it.
- Regression: a plain terminal, OSC 7501 and the write queue behave as before (their tests untouched).

## Decisions for the owner

Owner's word of 2026-10-30: the recommendations on items 1 to 7 are accepted, and Cmd+Shift+H stays Hide (bury), never detach. Item 4 (browser clients) was agreed after the owner asked for web to work. The target version is not yet set.

1. Tab for a multi-pane tmux window. (a) New `tmux-window` tab kind rendering splits: matches iTerm2, largest build. (b) Each tmux pane becomes its own chan tab and the tmux window is only a grouping label: small, loses the tmux layout. (c) v1 supports single-pane windows and shows a multi-pane window as a read-only notice. Recommended: (a), staged so (c) ships first if stage 6 runs long.
2. Closing a tmux window. The close overlay today is Close, Hide, Cancel. Tmux's detach is per connection, not per window: it ends the control client and every chan window of that connect. Recommended: in a tmux window the overlay is Close (kills that tmux window, with a confirm), Hide (buries the chan window as today, the tmux window keeps running, Cmd+Shift+H unchanged), Detach (new, drops the whole connection, tmux keeps running), Cancel. Detach is also in the control terminal and in `cs`. Alternative: Cmd+Shift+H detaches, only safe when the window is the connect's last visible one; otherwise one keypress drops every sibling window.
3. Persistence of a control terminal across a desktop or devserver restart. Recommended: not persisted, like today's control rows; the user runs `tmux -CC attach` again.
4. Browser clients. Agreed by the owner on 2026-10-30: web is first class, not desktop-only. The tmux connection is a server-side object (the gateway) owned by the library, independent of any client; windows are views of it, so the launcher of any client, desktop or browser, lists a connection's windows and can Open or Show them. Auto-open on connect is a convenience on the client that holds the originating tab: the desktop builds native windows; a browser tries `window.open`, and when the popup blocker refuses (the attach finishes seconds after the keypress, with no user gesture), the control tab shows a banner with an Open button whose click is the gesture. Cmd+Shift+N and Cmd+T are user gestures, so the browser's synchronous blank-popup-then-fill pattern the deck already uses applies. Cost: the web path needs the launcher rows and the popup fallback built, not just the desktop watcher.
5. Window cap: iTerm2 refuses to open more than a dashboard limit of tmux windows at attach and hides the rest. Chan needs a cap and a way to show hidden ones; recommend a cap with a list in the control window.
6. Tunnel and devserver: `tmux -CC` on a devserver terminal opens its windows through the desktop's existing window watcher; confirm that is the intended route.
7. Minimum tmux version. Recommended 3.2 (pause-after, `%extended-output`, `send -H`), which drops iTerm2's legacy paths. This host has 3.8.

## Out of scope

- Windows hosts (no tmux there), mouse reporting parity beyond what the pane terminal already does, and tmux popups and menus (`display-menu`).
- A tmux status line; chan draws its own chrome.
- `tmux -C` without the doubled flag (no DCS wrapper; same gateway, separate follow-up).

## Appendix: iTerm2 reading

Read in source (iTerm2 master, `sources/tmux/` and `sources/VT100/VT100DCSParser.m`); scratch copies are in the session scratchpad. Not read: tmux's own `control.c` and `control-notify.c`, and iTerm2's server-death path (inferred to surface as `%exit` or a bare PTY close).

- Attach order: version probe, `refresh-client -f new-layouts` (JSON layouts, tmux 3.8 and later), pause-after on 3.2 and later, `refresh-client -C W,H`, `list-sessions`, `list-windows -F '#{window_id} #{window_layout} #{window_flags} #{window_visible_layout}'`. Per pane: `capture-pane -peqJ -t %P -S -N`, the same with `-a` for the alternate screen, `list-panes -t %P -F` for cursor, modes, scroll region and tab stops, `capture-pane -p -P -C` for pending output, then `refresh-client -A '%P:continue'`.
- `%output` octal: bytes below 0x20 are skipped, `\` plus three octal digits is one byte, a bad escape becomes `?`. tmux escapes control characters but not backslashes, so pending-output decoding needs a workaround. `%extended-output` carries a latency field.
- Input: plain alphanumerics as `send -lt %P`, control bytes as `send -H -t %P xx`. `0xNN` form is unsafe on tmux 3.5 with modifyOtherKeys. Pre-2.2 tmux needs UTF-8 byte by byte; the plan can require a minimum tmux version instead (Decision 9 below).
- Layout: `csum,WxH,x,y{...}` horizontal, `[...]` vertical, `,pane` leaf; checksum header skipped; JSON form on 3.8; a `<float,...>` suffix on 3.7.
- Races: `%output` for a pane not yet opened is dropped and recovered by the capture; a small whitelist of OSC 1337 keys is replayed from dropped output because the capture cannot recover them.
- Resize: client-wide `refresh-client -C W,H`, or per window `-C @id:WxH`; sizes clamped under 10000, repeats suppressed.
- Detach: `detach` command; a second request offers force detach.
