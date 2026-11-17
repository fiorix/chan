# A window on a lossy link freezes with no sign until its socket is retired

Status: built and tested outside the v0.131.0 round on the branch `feat/link-health` (`15946dcf2`, fourteen commits on `v0131/int` `1bcf78c93`, pushed), and accepted for v0.132.0 by the owner on 2026-11-16, to merge once the indicator's placement is redesigned and the branch rebased: "since you're adding items to the v0.132, include the merging of the linkhealth branch, which still needs a final design touch of the UI component - today the button with link activity shows *right of the pane's hamburger button* and I don't think that's how I want it; other than that, the code in the branch will need rebasing first; i want to make sure the item is in the roadmap since the code is written and tested".

Frontend only. The code calls the feature "connection health" (`api/connectionProbe.ts`, `state/connectionHealth.svelte.ts`, `components/ConnectionIndicator.svelte`). The contract below is the lane's, as it stood after the owner's rulings of 2026-11-15; the lane's ledger, evidence and captures are under `dev/linkhealth/` (`status.md`, `evidence/`, `captures/`, the owner's Mac reports and briefs).

## Observed

Reaching a remote devserver from chan-desktop over a poor link (mostly through a gateway, also over ssh), the window hangs with nothing on screen saying why or that it will come back. On macOS and Windows, where the tabs sit in the title bar, the window also looks broken while the connection flaps.

## Evidence

Read from the code at `826adee91`, before the lane:

- The page detects a dead socket, not a bad link. `/ws` and each terminal socket ping every 20 s and retire the socket after 45 s without an inbound frame (`api/transport.ts`). On a lossy link TCP retransmits, the socket stays open, and the page shows nothing for up to 45 s.
- Pongs are not timed (`{"type":"pong"}` carries no id), so the page knows no round-trip time, and there is no degraded state.
- A return to the window probes the watcher with a fixed 3 s pong deadline, so a link slower than that at that moment loses a working socket.
- The reconnecting cover takes the whole window, blurs the tabs in the title bar and takes away the band's drag space, and it parks focus on Reconnect, which tears the connection down and reopens every window of that computer.

Seen in a real window (the owner's Mac run of 2026-11-15 against a devserver through the gateway, link cut and delayed by the packet filter, `owner-mac-report-1.md`): the first build's indicator, terminal notice and cover worked as designed, and eight findings came back, all since addressed below.

One fact that run surfaced: a remote window loads its web app from the devserver it talks to, not from the desktop's bundle. So this feature reaches a user when the remote devserver runs it, and the page and its server are always the same build.

## Contract

### Connection health (detection)

1. Every pong is timed. Pongs return in send order on one socket, so a queue of ping send times gives the round-trip time with no wire change. The queue keeps at most 32 send times; later pings are counted, not timed. A ping in flight when the wake detector fires is not timed, and neither is a round trip longer than the 45 s read deadline: both measure a sleep, not the connection.
2. A socket pings once as it opens. While the window is visible and focused and its probe has been answered, the watcher pings every 3 s; otherwise every 20 s. Gaining focus sends a ping at once.
3. A remote window (a desktop window whose library is not `local`, or a browser page whose host is not loopback) in front also retires its socket after 15 s without an inbound frame. Every other socket keeps 45 s. A change of cadence may shorten a waiting socket's read deadline and never extends it.
4. The wake probe's deadline is four times the latest round-trip time, between 3 s and 10 s.
5. A window has one connection state, read from the watcher:
   - `unknown`: the page has had no pong yet.
   - `slow`: a ping has been unanswered for 1 s, or the latest round trip took 1 s or more, or the last two took 400 ms or more. It leaves `slow` once two round trips in a row are under 300 ms and nothing is overdue.
   - `stalled`: a ping has been unanswered for 4 s and no frame of any kind arrived in those 4 s. A frame that arrives while a pong is late means `slow`.
   - `down`: from the loss of an open watcher until a later socket answers a ping. An outage ends at a pong, not at a socket's open.
   - `ok` otherwise.
6. Once the page has had a pong, a new socket's first ping is timed like any other, and if the socket is retired unanswered its pings are misses. During an outage the window itself reads `down` until the redialed socket's first pong. The page's first socket reads `unknown` until its first pong.
7. The state keeps the last 60 finished pings (round-trip time, or a miss), the time of the last frame, the wait of the oldest unanswered ping, when the state began, and the outage with its start and the time its cover is due. A 250 ms ticker runs only while a ping waits. A wait past the read deadline is a clock jump: the timings are forgotten.
8. Each terminal socket has a probe of its own, which does not remember across sockets. It pings once at open and keeps its 20 s heartbeat and 45 s read deadline. When the user types, pastes or submits a prompt, it sends one ping 1 s later, at most once per 2 s, whether or not a frame arrived. Mouse reports, focus reports, generated replies and the ghostty wheel do not arm that. The control terminal takes no part.

### Indicator

1. With the window tab bar on, the indicator sits at the bar's end, after the tmux badge and before the window controls' inset, and is never a drag region. On a remote window it is a quiet glyph while `ok` (dimmer while `unknown`); on a local window it is absent then. It is not drawn while the Computers launcher covers the window.
2. `slow` shows the larger of the latest round trip and the current wait ("850 ms"). While still `slow` with a reading under 300 ms it shows the warning glyph alone, named "Connection recovering". `stalled` counts the wait ("stalled 8 s"). `down` reads "reconnecting".
3. In the bar the label reserves a width by state: 7 characters while `slow`, 12 while `stalled` or `down`, none otherwise. The bar's width changes when the state does and never while a number counts.
4. With no window tab bar, the status pill takes a connection section, first in its row, only while `slow`, `stalled` or `down`. Its close holds for the states already seen since the connection was last healthy.
5. A press opens a popover: a sparkline of the kept pings with misses as gaps, the latest, median and worst round-trip time, the last contact as a clock time, and the state with its age. The press takes no focus from a terminal or editor. A second press, Escape or a press outside closes it. Under a full-window cover it is closed and a press does not open it.

### Terminal

1. A stalled connection blocks nothing and blurs nothing.
2. A terminal whose socket is stalled shows a pill at the pane's top right, clear of the find bar and the inspector: "No response for 8 s. Waiting for the connection." It counts from the earlier of the terminal's own unanswered ping and the window's. The pill moves no row and takes no pointer, key or focus. It never sits under the app's status pill: when the two would overlap it sits 5 px below the status pill, still at the pane's right, and returns when the overlap ends.
3. From the moment a connected terminal loses its socket until its next socket is open, the pill reads "Connection lost. Typing is not being sent until it reconnects." A socket the page replaces after a wake from sleep shows nothing unless its dial fails.
4. After a socket is replaced with the user's input unanswered, or after keys a socket refused, the pill reads "Reconnected. Input typed while disconnected may not have been sent." for at least 4 s and at most 12 s of shown time.
5. A terminal that is stalled, or closing after its read deadline, is redialed after 3 s in which the window's connection is `ok` with contact newer than the stall: at most once per 30 s, and never with the user's input in flight on the socket. Bytes written to a socket can still arrive after it is replaced, so a terminal the user typed into keeps its socket until that socket recovers or closes.

### Cover (reconnecting)

1. The cover comes when the watcher has been silent for 45 s, or 600 ms after a socket closed under the page. The 600 ms restart at each status change. Until the cover shows nothing is blocked: terminals take keys, the bar is as usual, the indicator reads "reconnecting".
2. With the tabs in the title bar the cover starts below the band, unless an overlay or dialog owns the keyboard, where it keeps the whole window. The band hides the tree button and the strip in place, stays the window's drag space, and shows the window's title and the indicator. When the Computers launcher is also up, its rule for the band wins.
3. Focus parks on the cover and never on an action. When the cover clears, focus returns to what held it: a terminal or editor through its own focus routine, a field inside Search, Settings, a survey card or another owner of the keyboard directly, and nothing against an owner that took the keyboard meanwhile.
4. The cover reads "reconnecting to the chan server" in every status and draws no focus ring. Its timer counts from when the watcher lost its socket, so a late cover on a focused remote window opens at about 00:30.
5. Its actions appear 8 s after the outage began: "Restart connection", with "Restart closes and reopens this computer's windows.", and Abandon.
6. The window's close button: a prompt open when the connection drops is cancelled; a press while down and uncovered opens the prompt and it stays through redial attempts; it is cancelled when the outage ends and when the cover appears; under the cover a press closes straight away while the watcher is not open, and prompts while a redialed socket is open but unanswered.

## Boundaries

- `web/packages/workspace-app` only. No wire change, no server change, no desktop change, no new dependency.
- `TerminalTab.svelte` carries hooks and one mounted component; the logic is in `components/terminalConnectionHealth.svelte.ts`.

## Known limits, left for items of their own

- Input typed into a terminal during an outage can arrive late or not at all. The page says so; delivering it needs acknowledged input on the wire, and the server ending an older attachment when a tab attaches again.
- The terminal the user typed into is the one the faster redial does not reach. Its socket keeps the input in flight, so the page leaves it to its 45 s read deadline, which calls `close()` and waits for `onclose` before it redials; how long that wait lasts on a dead link is the engine's. An untouched terminal is back within seconds of the window. The pill says what is happening throughout.
- An idle terminal shows nothing while the window reads stalled, until its own 20 s heartbeat or the first key.
- The terminal's pill and the window's indicator count from different pings, so while both show, their seconds can differ by up to about 2 s.
- The terminal's pill follows the status pill one painted frame late after a resize; the status pill's hover scale is read as its box; in a very short top pane a dropped pill hangs past the pane's bottom.
- After a wake from sleep, keys typed while a terminal's replaced socket is still dialing are dropped; the notice reports it afterwards.
- A key typed within about 1 to 3 s before a sleep can show the reconnect notice although its echo was on screen.
- An unfocused window pings every 20 s, so after one late pong its warning colour can stand for up to 40 s.
- The probe times the page as well as the network: a main-thread stall of a second or more with a ping in flight reads as a slow round trip for a few seconds.
- A connection that is steadily slower than 400 ms reads `slow` for as long as it is.
- A redialed terminal socket that never answers a ping shows nothing until its 45 s deadline.
- A `ModalShell` dialog under a full-window cover keeps the keyboard (the lock screen's PIN field cannot hold focus over a dialog; under the reconnecting cover Tab and Escape act in the hidden dialog). Predates the lane.
- The command launcher, open when the connection drops, takes focus back from the cover. Predates the lane.
- A menu open when the connection drops stays open under the cover.
- A browser page reached through `ssh -L` counts as a local window.
- Out of scope from the start: byte counters in the desktop's loopback proxy, WireGuard tx/rx on the launcher cards, a gateway probe that says which leg is slow.

## Acceptance

- Unit and component tests for each rule above, each seen red against a deliberate break; `svelte-check` clean and the workspace app's whole vitest suite green in the lane's guest. Done at each commit.
- An independent review of each task and of the whole lane. Done for the tasks and once for the whole; a last read of the final tip is owed.
- A real window: the owner's Mac run of the first build is in `owner-mac-report-1.md`; a re-run on the fixed build is owed.
- Browser, in the guest: `295-connection-health-faces` drives a page through a relay that can delay and silence every flow, in both placements, with a capture of each face (`captures/`); seen red against the terminal pill under the status pill and against a status pill the product cannot find. The two tracked browser checks the lane changed (`184-cover-keyboard`, `68-watcher-wake-recovery`) run green. Done.
- The production build: the guest build runs it. Done.

## Rulings (owner, 2026-11-15)

- Detection plus indicator, a non-blocking stalled stage and cover fixes; isolated from the release round; Codex seats build, Fable reviews.
- Terminal notice: a compact pill at the top right. Lost input: a notice plus a faster terminal redial.
- Label width: reserved per state.
- Cover: redial early, cover late.
- Names: "connection", not "link".
- Close button: the prompt works while reconnecting and uncovered, and is cancelled at the drop and at recovery.

## For v0.132.0

1. **The indicator's placement.** With the window tab bar on, the indicator sits at the bar's end, after the tmux badge and before the window controls' inset (Indicator, item 1), which puts it right of the pane's menu button; the owner does not want it there. The new placement is his design call, taken at this row's start with captures of the candidates in both placements (the tab bar and the status pill); Indicator item 1 and browser check 295's bar pass change with it.
2. **The rebase.** The branch sits on `v0131/int` `1bcf78c93`; it is rebased onto the v0.132.0 integration branch, with `TerminalTab.svelte`'s hooks kept to the few lines the lane uses.
3. **The cover's wording.** The cover's "Restart closes and reopens this computer's windows." (Cover, item 5) breaks the owner's rule ("local machine", never "this machine" or "this computer") and is fixed in this row's work; the owner, 2026-11-16: "you're right about the 'this comupter' working, mark to be fixed together with the work there". The rest of the lane's copy is read against the same rule at the merge.
4. **Owed from the lane.** The owner's Mac re-test of the fixed build (`dev/linkhealth/owner-mac-checks-linkhealth-2.md`, naming `15946dcf2`; the remote devserver must run the branch too, since a remote window loads its web app from it); the write-up of the items outside the lane (Known limits); a CHANGELOG entry at the release; the teardown of the lane's worktrees, branches and guest on the owner's word.

Acceptance for the merge, beside the lane's own: the new placement built and captured in a guest in both placements, red against the old one in check 295; the rebased branch's workspace-app suite and checks 295, 184 and 68 green in a guest; a review of the rebase's resolutions and of the placement change; no "this computer" or "this machine" left in the lane's copy; the owner's Mac line on the merged build.
