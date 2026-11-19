# Connection health shows in each window, not on its devserver's Computers badge

Status: accepted for v0.132.0 by the owner on 2026-11-18, with its four choices decided the same day (`dev/v0132/decisions.md`, "Link health moves to the Computers window", 2026-11-18T13:15:22Z, "yes" to the lead's four points); merged into `v0132/int` at `cb8023739`, with the owner's walk on his Mac (Acceptance 8) outstanding. It takes the place of the review stage's step 5, the connection-health simplifications, and is built after the keyboard arbiter ([the keyboard owner row](the-rich-prompt-takes-the-keyboard-from-a-survey-a-dialog-an-overlay-or-the-launcher.md)).

Record: the owner's words: "i want all of the link health and network information to be present in the Computers window on the badge of each devserver rather than on the window where we have panes; however i do want that window to know when the remote devserver stopped responding when we usually present the screen with connection failed reconnect/abort - could link to the computers/badge from there too". The row moves the display half of [the lossy-link row](a-window-on-a-lossy-link-freezes-with-no-sign-until-its-socket-is-retired.md) from the window to the desktop and keeps that row's cover. That row's open item on the indicator's placement goes with the indicator. The map of the window side's checks and tests is `dev/v0132-team/reviews/stage-review-B-1.md`, sections 3 to 5. Its proposals P4 and P5 fall away with the code they simplify; P1 to P3 may shape what stays and change no item below. The window code merged on `v0132/int` (`7ffdc5475`) and is in no release, so no released window shows an indicator. The UI keeps the word "connection", per the lossy-link row's ruling on names.

## What is there now

Read at `8dc890b2d`, by reading; nothing run. Window paths are under `web/packages/workspace-app/src/`.

The window:

- The window measures its own watcher socket. Every ping and pong goes to one probe (`state/connectionHealth.svelte.ts:66-78`, `api/connectionProbe.ts:158-261`). It pairs pongs with a queue of at most 32 send times and keeps the last 60 finished pings (`connectionHealth.svelte.ts:24`). It reads `unknown`, `ok`, `slow` or `stalled` (`connectionProbe.ts:73-99`), adds `down` for an outage (`connectionHealth.svelte.ts:81-135`) and runs a 250 ms ticker while a ping waits (`:129-134`). The store opens the watcher on that probe (`state/store.svelte.ts:2856`).
- The watcher pings at open, every 20 s, and every 3 s while the page is in front after its first reply. A remote window in front retires a silent socket after 15 s, every other socket after 45 s (`api/transport.ts:526-543`, `:745-758`). A wake probe waits four times the latest round trip, between 3 s and 10 s (`:557-565`, `:599-605`).
- The indicator sits at the tab bar's end (`components/WindowTabBar.svelte:384`), or first in the status pill when the bar is off (`components/AppStatusBar.svelte:91`, `:269-274`); the pill's close remembers the spell's states (`:136-148`). Its faces and names are at `components/ConnectionIndicator.svelte:28-46`, its popover (state age, chart, latest, median and worst, last contact) at `:134-150`, its math in `components/connectionIndicatorMath.ts`. Under the reconnecting cover the band keeps the title and the indicator and reserves 12ch for it (`WindowTabBar.svelte:72-73`, `:220-226`, `:389`).
- Each terminal socket has a probe of its own (`components/terminalConnectionHealth.svelte.ts`), wired through some twenty hooks in `components/TerminalTab.svelte` (`:409-419`, `:675-685`, `:1106-1113`, `:1598-1625`, `:1759-1806`, `:2051`, `:2123`, `:2280-2285`, `:2430-2433`, `:2763`, `:3627-3631`). Its pill says one of three sentences (`components/TerminalConnectionNotice.svelte:23`, `:109`, `:122`): "No response for N s. Waiting for the connection.", "Connection lost. Typing is not being sent until it reconnects." and "Reconnected. Input typed while disconnected may not have been sent." It sits below the status pill when they overlap (`components/terminalNoticePlacement.ts`). A stalled terminal is redialed after 3 s of the window reading `ok` (`terminalConnectionHealth.svelte.ts:84-112`), read from the window's state at `TerminalTab.svelte:414-419`.
- The cover (`components/DisconnectOverlay.svelte`) shows 600 ms after a status change, or at the outage's due time 45 s after the last contact (`:103`, `:137-169`). Its actions appear 8 s after the drop (`:105`, `:171-180`). Restart connection and Abandon are offered only on a devserver window of the desktop (`:37`, `:330-351`), through `reconnect_devserver_for_window` and `abandon_devserver_for_window` (`desktop/src-tauri/src/main.rs:4827-4873`). Both find the devserver from the window's label (`main.rs:4538-4541`). The cover reads the outage from the connection state (`:135`, `:164`, `:288`), and the close prompt follows the outage's epoch (`state/closeConfirm.svelte.ts:52`, `components/CloseConfirmOverlay.svelte:49`).
- A remote window runs the page its devserver serves, not the desktop's bundle (the lossy-link row's Evidence). A change to the window reaches a user when the devserver runs it.

The Computers screen:

- The launcher is an HTTP client of the serving library and never dials a devserver (`web/packages/launcher/design.md:9`). A devserver's health is its glyph: connected, connecting, connection lost or disconnected (`launcher/design.md:105`; `web/packages/launcher/src/components/Library.svelte:195-221`, `:533-541`). The glyph reads the row's `status` (`crates/chan-library/src/devserver_registry.rs:33-49`), and the manual says the same (`web/packages/marketing/src/pages/manual/computers.html:121`). The deck lists a lost or disconnected devserver under Needs attention (`web/packages/web-shared/src/command-deck/computers.ts:980-984`).
- The launcher re-lists devservers, workspaces and gateways on every window-feed push (`web/packages/launcher/src/state/library.svelte.ts:117-136`). While visible it re-lists workspaces every 2 s, and gateways only while one has WireGuard state (`:215-225`).
- The desktop builds each row's `status` (`desktop/src-tauri/src/config.rs:798` for configured rows, `:651` for gateway roster rows). A row reads `unreachable` once its feed watchdog has marked the devserver (`main.rs:634-674`, `set_unreachable` at `:802`).
- The desktop holds one window feed socket per connected devserver, `GET /api/library/windows/watch` (`window_watcher_wiring.rs:1614-1700`), beside a colour feed. `keepalive_pump` (`:1490-1531`) sends a WebSocket Ping after 30 s with no inbound frame (`:1244`) and ends the round after two such intervals (`:1247`). Two rounds with no frame mark the devserver unreachable (`:1254`, `FeedRounds::settle` at `:1362-1392`). A round's end drops the tmux records (`:1027-1030`). Nothing is timed.
- The devserver's feed handler ends its wait on every client frame and sends its set again (`crates/chan-server/src/routes/library.rs:1459`, whose arm falls through to the next turn), so the desktop's 30 s WebSocket Ping draws a set. The tenant watcher answers `{"type":"ping"}` with `{"type":"pong"}` (`crates/chan-server/src/routes/ws.rs:468`, `:718`). A gateway's proxy forwards WebSocket Ping and Pong both ways (`gateway/crates/devserver-proxy/src/proxy.rs:1943-1944`, `:2157-2158`). As an axum server it also answers a Ping itself, since tungstenite replies on read [inferred, not run], so through a gateway the first Pong the desktop gets would be the proxy's.
- The management protocol must match exactly (`main.rs:2557`; `DEVSERVER_API_PROTOCOL = 1` at `crates/chan-server/src/devserver_api.rs:32`). `DevserverInfo` takes fields with `#[serde(default)]` (`desktop/src-tauri/src/devserver.rs:237-257`).

Raising the screen on a card:

- On the desktop the Computers screen is a second webview inside each window that hosts the page, toggled over its content (`desktop/src-tauri/src/launcher_panel.rs:1-12`, `can_host_panel` at `:154`). A page toggles it through `toggle_launcher_panel` (`:221`; `api/desktop.ts:446-449`), which the gateway grant carries (`runtime_capability.rs:126`). `show_for_attention` shows it and returns once it is shown, so an event sent next reaches a loaded page (`launcher_panel.rs:235-265`). `evaluate_in_launcher` runs a script in one window's launcher (`:407-417`), and `FORWARDED_EVENTS` reach every launcher (`:87-95`).
- The launcher brings a card to the front with `showComputerCard(key)` (`web/packages/launcher/src/state/computerActions.ts:243-246`), which backs the deck's "Show on Computers screen" (`web-shared/src/command-deck/computers.ts:939-947`). The deck's position lives in each webview's sessionStorage (`launcher/src/state/deck.svelte.ts:25-56`), and a saved key holds while the registry loads (`launcher/design.md:91`). A devserver card's key is its row id (`Library.svelte:125-129`), the id `devserver_id_for_window_label` returns. No command shows the screen on a given card.
- A page learns what the installed desktop can do from `native_vocabulary` (`api/nativeVocabulary.ts`; the tab bar's use, `design.md:160`).

Docs and checks:

- `manual/navigation.html:76-122`, "Connection health", describes the indicator, its faces and popover, the three terminal sentences, the cover and its timings. `manual/connect.html:103` and `manual/troubleshooting.html:88` link to it. `design.md:134-146` describes the probe, the classification, the indicator and the terminal probe.
- Browser check 295 (`scripts/e2e/browser-smoke/checks/295-connection-health-faces.mjs`, 711 lines) drives the window's faces through a relay that can delay and silence each flow. Checks 184 and 68 cover the cover's keyboard and wake recovery. Twenty-five jsdom files, 7,946 lines, test the window side (the stage review's section 5). The desktop observations drive the real launcher in a guest through WebKitGTK's inspector, direct or through the gateway fixture (`scripts/e2e/desktop-observations/tmux-feed.sh`; `scripts/e2e/README.md:26`).

## Desired contract

### The window

1. No window shows a connection indicator: none at the tab bar's end, none in the status pill, no popover. This holds on local and remote windows, in the desktop and in a browser. Under the reconnecting cover the band keeps the window's title, its drag space and its window controls, with no space kept for an indicator.
2. A terminal shows one connection note, "Reconnected. Input typed while disconnected may not have been sent.", on its existing rules. It shows after a socket is replaced with the user's input unanswered, or after keys a socket refused, for at least 4 s and at most 12 s of shown time, only on the tab in front and not under the cover. It sits at the pane's top right and never under the status pill, takes no pointer, key or focus, and moves no row. "No response for N s. Waiting for the connection." and "Connection lost. Typing is not being sent until it reconnects." are not shown; the cover stands for them.
3. The cover keeps its rules. It shows 600 ms after the watcher's socket closes under the page, or 45 s after the watcher's last contact, and reads "reconnecting to the chan server" with the attempt and the time since the drop. Focus parks on it and returns where it was when the cover clears. Restart connection and Abandon appear 8 s after the drop on a devserver window of the desktop. The close prompt follows the outage's start and end.
4. The window keeps the liveness that decides whether and when the cover shows ("redial early, cover late", the owner's ruling of 2026-11-15). The watcher pings at open, every 20 s, and every 3 s while the page is in front and has had a reply. A remote window in front retires a silent socket after 15 s, every other socket after 45 s. A wake probe waits four times the latest round trip, between 3 s and 10 s. An outage ends at a reply, not at a socket's open. (Decided 2.)
5. A terminal socket keeps its heartbeat (a ping at open and every 20 s, a 45 s read deadline) and the ping the note rests on. When the user types, pastes or submits a prompt, one ping goes 1 s later, at most one per 2 s, and only a pong whose ping left after the input answers it. A stalled terminal is replaced at its own read deadline or close, not early (decided 2).
6. The page keeps no reply times, no samples and no slow or stalled reading. Of the connection it keeps the outage the cover and the close prompt read, and what item 4 needs.

### The badge

7. On the desktop's Computers screen, each connected devserver's card shows that devserver's connection health. The faces are the indicator's, drawn with its bars mark:
   - healthy: the mark alone, named "Connection healthy";
   - slow: the larger of the latest reply time and the current wait once it reaches 1 s ("850 ms"), or the mark alone, named "Connection recovering", while the latest reply time is under 300 ms and no wait shows;
   - stalled: the wait counting ("stalled 8 s");
   - reconnecting: "reconnecting".
   Before the first reply the mark is dimmed and named "Connection status unknown".
8. The thresholds are the window's. Slow: a reply has waited 1 s, or the latest took 1 s or more, or the last two took 400 ms or more; it ends when two in a row come back under 300 ms with none overdue. Stalled: a reply has waited 4 s or more with no frame of the devserver's, a set or a pong, in the last 4 s; a WebSocket Pong does not count, since a gateway's proxy can answer one. Reconnecting: from the loss of the devserver's open feed socket until a later one answers a ping.
9. The card shows the detail the popover held: how long the state has lasted ("Slow for 12 s", "No response for 8 s", "Reconnecting for 20 s", "No reading yet"), a chart of the last 60 finished pings with the misses as gaps, the latest, median and worst reply times, and the last contact as a clock time to the second. Where on the card: decided 3.
10. While the Computers screen is visible, a change of face shows within 2 s, and a count moves by whole seconds without skipping. A wait of 1 s or more stops counting when its reply arrives, at the cost of one library push per such reply.
11. The status glyph keeps its four states, colours and title, and the face sits beside it. A devserver marked lost (its feed down for two rounds) keeps the red glyph and reads reconnecting until its feed answers.
12. In privacy mode the face keeps its colour; its words and the detail are concealed behind one reveal per devserver, as a gateway badge's connection details are.
13. A devserver reached through a gateway shows the same faces, from the same measurement, as a configured one. The deck's Computers rows and its Needs attention section keep their rules: a slow or stalled devserver is not listed as needing attention.

### The measurement

14. The desktop measures each connected devserver once, over the window feed socket it holds to it, however many of that devserver's windows are open, none included. The reading reaches the Computers screen in the serving library's devserver rows; the launcher dials nothing.
15. It pings every 3 s while a window of the desktop has the focus and every 20 s otherwise, and once more when the desktop gains the focus and when a Computers screen shows. A move of the focus between two of its windows that the platform reports loss first is a loss and a gain, so it pings once too. The chart then holds the last three minutes of use, and a card opened after a freeze shows the freeze.
16. The reply it times is the devserver's own and crosses every leg between them: an ssh forward, a gateway and its tunnel, WireGuard. With decided 1 it is a `{"type":"ping"}` text frame on the feed, which the devserver answers with `{"type":"pong"}`.
17. A sleep of the local machine never reads as a slow reply or a stall: a ping in flight across a sleep is not timed. A sleep is a step of the wall clock against the monotonic one of more than 2 s, or a gap of more than 6 s in the reports the desktop makes every 2 s while a ping waits on a connection whose devserver has answered. A reply that took longer than 45 s is not timed either, while a wait past 45 s keeps counting. On a monotonic clock that counts a sleep (Windows), a sleep under 45 s across a connection's first ping, before any reply, shows no step and no report gap, so that one reply is timed: one slow sample that two fast replies clear.
18. Measuring never retires or redials the feed. The feed keeps its 30 s keepalive, its two-interval rule and its two-round lost mark, and the measurement adds no reason for the feed's tmux windows to close. A pong does not count as the feed's activity for the keepalive's idle clock, so the 30 s WebSocket Ping still goes out when no set has arrived for 30 s, and the set it draws keeps a window's transfer state (which has no change notice) as fresh as it is today.
19. The desktop learns whether a devserver answers the feed's ping from a pong: it sends one ping when a feed socket opens and no other until a pong arrives on that socket, and a pong at any time turns the reading on. The feed's opening set is not a reply, and a set that arrives before any pong decides nothing (a current devserver sends its opening set, and a change's set, before it reads the ping). An older devserver re-sends its set for that one ping and never answers it, so it costs one set per feed socket and its card shows the status glyph and no face. While its feed is down it reads reconnecting, as any devserver does, and on a later socket its set ends that with no face. While the first ping waits, the face reads "Connection status unknown". The devserver's info is not the carrier, since a gateway's proxy answers 404 under `/api/devserver/*` (`gateway/crates/devserver-proxy/src/proxy.rs:322-326`, `:913-915`).

### Cases

20. A disconnected or connecting devserver shows no face and no detail. One the desktop drops (its script exits, Abandon) loses its face with its card's content.
21. The local machine's card shows no face: its library runs inside the desktop, with no network between.
22. Many windows of one devserver share one reading and one face, and every one of their covers leads to the same card.
23. A plain browser tab, with no desktop, gets the cover alone: no indicator, no note but the Reconnected one, no Restart connection, Abandon or Show in Computers. The Computers page a browser opens at a server's `/` lists no devserver and shows no face (decided 4).
24. A window's cover and its devserver's face read different sockets. A cover can show while the face reads healthy (the window's own socket or workspace is gone while the devserver answers), and the face can read stalled while a window's socket still carries frames. The desktop's workspace poll is a third reading: while it finds a held devserver not answering, the card lists none of the devserver's windows, tmux connections or workspaces and says they show again when the connection recovers (`rows_hidden` on the row), under any control terminal the outage leaves and in place of an empty devserver's prompt to add a workspace.

### The cover's action

25. On a devserver window of the desktop, the cover offers Show in Computers from the moment it shows, since it disrupts nothing; Restart connection and Abandon keep their 8 s. It is in the cover's Tab cycle with them, and focus parks on the cover, never on an action.
26. Show in Computers shows the Computers screen over that window, or keeps it shown, with that devserver's card in front and the keyboard on it, whatever card the screen held last. Hiding the screen leaves the cover up while the outage lasts, and the cover takes the focus back.
27. It is offered only where the installed desktop advertises its command in `native_vocabulary`, since a devserver's page can be of another release than the desktop. It is never offered on a local window, a control terminal or a browser page.
28. With no card for the devserver (its row has left the registry), the screen opens at its first card. A refusal shows on the cover as a Restart connection failure does.

### The manual

29. The navigation page's "Connection health" section (`navigation.html#connection`) describes what the window keeps: the cover, its three actions and their timings, and the Reconnected note. Its anchor is kept, so `connect.html` and `troubleshooting.html` still link there. The faces, the detail and the measurement move to a section of their own on the Computers page (`computers.html`), and that page's line on a devserver's icon names them. The cover's placeholder shot in `connect.html` shows the third action.

## Boundaries

- The devserver: `crates/chan-server/src/routes/library.rs` answers a ping on the window feed, with its tests. No other route, frame or protocol number changes (decided 1).
- The registry wire: `DevserverEntry` in `crates/chan-library/src/devserver_registry.rs` gains the reading (face, whether a slow face is recovering, its start, latest reply time, the wait's start, last contact, and the reply times of up to 60 pings with `null` for a miss) and `rows_hidden`, whether the desktop lists none of a held devserver's rows because its workspace poll finds it not answering. Both always serialize, the reading as `null` without one, and take `#[serde(default)]` for older producers, with their byte tests. The mirror is in `web/packages/launcher/src/api/library.ts`, plus the demo backend.
- The desktop:
  - The feed pump in `window_watcher_wiring.rs` sends the ping on the cadence and hands a pong to the reading before it decodes a window frame, so a pong is neither logged as an unreadable frame nor taken for a set, nor counted as activity for the keepalive.
  - The reading, its classification and its tests live in a module of their own; `DevserverFeed` in `main.rs` holds one reading per devserver; `config.rs` fills both row builders.
  - A command shows the Computers screen over the calling window on its devserver's card, sending the card after the show as `show_for_attention` does. Its grant goes in `permissions/app.toml`, `capabilities/workspace.json`, the gateway grant list in `runtime_capability.rs` (with the ACL parity tests in `serve.rs`) and `native_vocabulary`.
  - `desktop/design.md`.
- The launcher: the face and detail on the devserver card in `Library.svelte`; the chart math moved from the workspace app; the 2 s refresh of devserver rows while one has a reading (`state/library.svelte.ts`); the card event in `App.svelte`; `launcher/design.md`.
- The workspace app: the deletions and shrinks listed with this row; the cover's action in `DisconnectOverlay.svelte` and its call in `api/desktop.ts`; `design.md`.
- Checks: 295 rewritten for the window; a desktop observation for the badge and the cover's link, sharing 295's relay; 184 and 68 kept green.
- Not touched:
  - the cover's timers, focus rules and close prompt beyond the added action; Restart connection and Abandon;
  - the terminal wire (no ping id);
  - `DEVSERVER_API_PROTOCOL`, whose exact match would refuse every older devserver;
  - the feed's keepalive, round and lost rules and its tmux round end;
  - the gateway workspace (`gateway/`) and the WireGuard badge;
  - `terminalNoticePlacement.ts`'s rule, which the index pill row builds on;
  - the keyboard arbiter, which this row consumes.
- Not here: which leg is slow, byte counters, connection health in `chan devserver ls` or `cs`, the browser page at `/` (decided 4).

## Acceptance

1. Before the build, a reading through the gateway fixture (`scripts/e2e/gateway-zone.sh`) of what answers a WebSocket Ping from the desktop's feed: the proxy, the devserver or both. It grounds the line marked inferred above.
2. The devserver: a test that the library window feed answers `{"type":"ping"}` with `{"type":"pong"}` and sends its window sets unchanged, and that any other client frame is still answered as before. Red at the base.
3. The desktop's reading, as Rust tests with an injected clock, each seen red against a deliberate break:
   - every face and threshold of items 7 and 8;
   - the 60-sample cap with misses;
   - reconnecting until a later socket's first reply;
   - a reply over 45 s and a ping across a sleep left untimed;
   - the 3 s and 20 s cadence and the focus ping;
   - one ping per feed socket to a devserver that does not answer, and a change's set before the pong still turns the reading on;
   - a pong reaching the reading and not the frame decoder.
   The feed's keepalive and `FeedRounds` tests stay unchanged and green. The wire: `DevserverEntry` byte tests with a reading, with `null` and with the key absent.
4. The badge on the desktop, in the desktop guest on WebKitGTK, through the desktop observations harness. Chan-desktop is connected to a direct devserver whose flows pass through a relay that can delay and silence each one (295's relay, shared through `scripts/e2e/browser-smoke/lib/`).
   - With the devserver's card in front, read through the inspector and captured in both themes: healthy; at 650 ms each way, the reply time; with the feed silenced, stalled and counting; with the feed dropped, reconnecting; restored, healthy, with the chart showing the gap and the last contact.
   - With two of its windows open and with none: one face, and the relay sees one feed ping per cadence.
   - The local machine's card shows no face.
   - Red first: the driver fails at its first face against the base.
5. The same through the gateway fixture (as `gateway-zone.sh tmuxfeed` runs the launcher), with a relay delaying the devserver's tunnel leg alone: the face reads slow. A reply the gateway answered itself would read healthy, so this leg is red against the WebSocket-ping option (b) the owner did not take.
6. The cover's link, in the same guest. The window's flows are closed with the feed left flowing. The cover shows within about 1 s, with Show in Computers. Another card is put in front of the Computers screen first; a trusted click (XTEST) on the action then shows the screen over that window with the devserver's card in front and the keyboard on it. Hiding the screen leaves the cover up with the focus on it. A local window's cover offers no such action. Red first: the button is absent at the base.
7. The window in a browser, guest Chrome, with check 295 rewritten. Through its relay, a slow and a stalled connection draw no indicator in the bar or the status pill and no terminal note. The cover shows 600 ms after a close and 45 s after the last contact. A browser page offers no Restart connection, Abandon or Show in Computers. Typing during an outage gives the Reconnected note for at least 4 s after the reconnect, with no pointer events and the terminal's rows unchanged (the stage review's E6). Red first against the base, where the indicator shows. Checks 184 and 68 green.
8. On the Windows VM (`dev/vm/windows.sh`, WebView2): the cover's link shows the screen over its window with the card in front, and the badge reads healthy and stalled on the delay and silence legs. On the owner's Mac: a brief, one self-contained file, for a gateway devserver, covering the faces under the packet filter's delay and cut and the cover's link; then his line on the merged build.
9. The jsdom tests of the window's connection display are deleted in the same commits as the code they test (the list with this row), and the chart math's tests move with it to the launcher. svelte-check clean; the workspace-app and launcher suites green; cargo test, clippy, the Windows-target clippy for the desktop and rustdoc; the Nix hash check if `Cargo.lock` moves.
10. The docs:
    - `web/packages/workspace-app/src/design.md:134-146` describes the cover, its liveness and the note;
    - `web/packages/launcher/design.md:105` describes the faces and where they come from;
    - `desktop/design.md:148` describes the feed's ping and the reading;
    - the manual as in item 29;
    - a CHANGELOG entry at the release.
11. Captures of decided 3's placements, in both themes, for the owner before the badge lands. An independent review of each stage before it lands, and of the whole range after.

## Decided

The owner took the four recommendations on 2026-11-18 ("ok i take your recommendations, let's do it"; `dev/v0132/decisions.md`, "The health badge row's four choices"):

1. The devserver answers `{"type":"ping"}` with `{"type":"pong"}` on its window feed and says so in its info; the desktop sends that ping on the feed it already holds, and a devserver of an older release gives no reading.

Amended by the lead on 2026-11-18, reported to the owner the same day: the info does not carry the capability, because a gateway's proxy answers 404 under `/api/devserver/*`; the desktop learns it from a pong (contract 19). The devserver's answer and the reply crossing every leg are as he chose.
2. The window keeps its early redial of a silent watcher socket and the wake probe's deadline (contract 4); a terminal's early redial of a stalled socket goes, so an untouched stalled terminal waits for its own 45 s deadline.
3. The face sits beside the devserver's name on the card's identity row, and the detail under its address on the card in front, shown while connected; captures of this and of a face-only card with a popover go to the owner before the badge lands.
4. The Computers page a browser opens at a server's `/` is not in this row: a browser tab gets the cover alone.
