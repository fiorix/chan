# tmux control mode (`tmux -CC`) has no chan client

Status: proposed for v0.116.0 (the open version, chosen for lack of another; the target is the owner's to set); owner accepted the decisions on 2026-10-30, assessed against `a4b5844b9` (main, v0.115.0). Nothing is built. Not a roadmap item until accepted for a target version.

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
2. Protocol crate. A new `chan-tmux` crate (pure parser and command encoder, no I/O, `#![forbid(unsafe_code)]`): line framing, octal unescape, reply correlation, layout string parser. Tested against the stage 1 captures (`fixtures/tmux-control/`) including the hostile-pane run, fuzzed on random bytes (`%output` with partial escapes, split reads, huge lines), and differentially against `tmux 3.8` output.
3. Gateway in the library. DCS detection in the byte walk, gateway state machine, virtual pane sessions, history restore, `send-keys -H` input, resize, exit back to bytes. Tests drive a real `tmux -CC` on a PTY on Linux and macOS; Windows has no tmux and skips with a named reason.
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
