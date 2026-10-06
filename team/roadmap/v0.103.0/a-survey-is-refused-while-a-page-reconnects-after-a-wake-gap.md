# A survey is refused while a page reconnects after a wake gap

Status: accepted for a page-side repair in v0.103.0; server-side survey grace remains outside scope.

## Owner decision, 2026-10-06

Establish which reconnects are needed, remove unnecessary replacement of healthy sockets on visibility changes where safe, and preserve a subscription during deliberate replacement where possible. Test duplicate delivery if sockets overlap and recovery from a genuinely dead connection. Keep server-side grace for a separate decision if the page-side work does not resolve the survey case.

Lead implementation direction on the same date: a repair may retain and probe the current socket rather than create an overlap whose command cutover cannot be made safe.

## Record before this decision

Every section below records the state before the dated decision above and is preserved as history. The dated decision governs the current scope.

Previous status: moved to v0.103.0 on 2026-10-05, before the v0.102.0 GA, by the owner's answer of that day that it stays raised for v0.103; still raised for a decision.

Record before the move: raised on 2026-10-05 by a probe of a browser smoke check on the v0.102.0 integration branch, which timed a page's event socket beside each survey the check raises and found the page closing its own socket just before a refused survey; the lead lists it for the owner. `raised | decide`: not accepted and not built. The gap was recorded in one probed run of six; the code below was read at d949a67d8, and nothing was run for this item. Put to the owner on 2026-10-05, who left it raised for v0.103; the row stays raised.

## Owner ruling

On 2026-10-05 the owner was given three choices and took the first, as the lead recommended: leave the item raised for v0.103. The other two were to build the page's side in this version, and to build the server's side in it for the survey alone. Nothing is built for it in v0.102.0, and neither shape of the contract below is chosen.

## What was seen

Browser smoke check 96 raises surveys with `cs terminal survey` and answers each on its page. With the check's wait before each survey taken out for the probe, five runs alone passed and the sixth was refused at its first survey. That run's log, by its own millisecond stamps: the page's event socket opens; 6507 ms later the page calls `close()` on it, and the close event follows 4 ms after the call, with code 1006 and no reason; 280 ms after the call the survey is asked, and 12 ms later the command exits 1 with `no chan window is connected to receive this; open the workspace in a window, or run from inside a chan terminal so $CHAN_WINDOW_ID targets one`; 20 ms after the survey was asked, 300 ms after the first call, the page disposes the closed socket and dials the next, which opens 5 ms later, 302 ms after the close event and 14 ms after the refusal.

The close is the page's own. The transport of the watch socket installs a wake-gap detector for the life of the watcher (`openWatch`, `web/packages/workspace-app/src/api/transport.ts`). The detector samples the wall clock on an interval of 2 seconds and calls back when two samples lie more than 6 seconds apart, which it takes for a machine that slept and a tick that runs late on wake (`installWakeGapDetector`, `WAKE_PROBE_MS` and `WAKE_GAP_MS`, `web/packages/workspace-app/src/wakeGap.ts`). The transport's callback is `forceReconnect`, which closes the current socket so that its close handler dials again, and that handler dials after the reconnect backoff, 500 ms from a socket that had opened. The app installs a second detector of the same kind (`App.svelte`), whose callback waits 300 ms and then calls `reconnectWatcher` (`web/packages/workspace-app/src/state/store.svelte.ts`), which disposes the watch subscription and opens a new one at once. So after a detected gap the page has no event socket from the transport's close until the first of two redials, the app's 300 ms after its own detector fires or the transport's after 500 ms, plus the time the new socket takes to open. The probed run's second `close()` call and its new socket come 300 ms after the first call, which is the app's hook.

The refusal is the server's rule for a command nobody can receive. A survey's handler sends its overlay as a window command on the tenant's event broadcast (`send_window_command`, `crates/chan-server/src/control_socket.rs`), to which only `/ws` sockets subscribe: a send that finds no receiver at all answers the sentence above, and the handler cancels the survey and returns the sentence as the command's error. The openers that answer without waiting for the page (`cs open`, `cs graph`, `cs dashboard`, `cs terminal new` and the team commands) go through `send_window_command_if_live`, which refuses with `window "<id>" is not connected` whenever the window they name holds no live socket.

## Why it matters

A `cs` command that addresses a window is refused when it lands in the gap, though the window is open, was connected a moment before and is connected again a moment later. An agent that raises a survey then gets an error and no card, and nothing in the answer says that asking again would work. The survey is refused only while the tenant's broadcast has no receiver, which is so when the reconnecting page holds the tenant's one socket, as the check's page does; the openers are refused whenever the window they name is the one reconnecting. The detector exists for a machine that slept, but it fires on any tick that runs more than 6 seconds after the one before it, and the probe met it 6.5 seconds after a page's socket had opened, in a run of the suite. The browser suite does not show the gap, since check 96 waits for its window before each survey ([the-browser-smoke-suite-is-red-at-the-base](the-browser-smoke-suite-is-red-at-the-base.md)).

## Desired contract

Not chosen: two shapes are candidates, and the owner's ruling picks one, both or neither.

On the page: a reconnect the page starts itself keeps its old socket until the new one is open, so that a window with a live page is never without a subscribed socket by its own doing. It leaves a drop of the network as it is, and for the length of the overlap the window holds two sockets.

On the server: a command that addresses a window waits a short grace for a receiver before it refuses, so that a reconnect of any cause does not refuse a command the window would have taken a moment later. It adds that wait to the refusal of a command sent to a window that is truly gone.

Either keeps the refusal for a window that is not there.

## Boundaries

For the page's shape: `openWatch` and `forceReconnect` in `web/packages/workspace-app/src/api/transport.ts`, `web/packages/workspace-app/src/wakeGap.ts`, the resume hook in `web/packages/workspace-app/src/App.svelte` and `reconnectWatcher` in `web/packages/workspace-app/src/state/store.svelte.ts`. For the server's: `send_window_command` and `send_window_command_if_live` in `crates/chan-server/src/control_socket.rs`. Their tests with either. Not the detector's two thresholds, the terminal tab's own use of the detector, or what a survey does once its card is up; check 96 keeps its wait whatever is ruled.

## Acceptance

Left open until the owner rules.

1. The ruling is recorded: built in one of the two shapes, or kept as a written cost with the wait a caller owes.
2. If it is built: a survey asked while its page reconnects after a detected gap shows its card on that page and is not refused; pinned where a test orders the close, the ask and the reopen with no sleep deciding the order.

## Not established

What made the browser's interval tick late in the probed run: no sleep of the machine is recorded for it. How often an open page meets a detected gap in use, and whether a throttled background tab trips the detector. What a survey does when another page of the tenant holds a socket while its own window's page reconnects: the send then finds a receiver and is not refused, and the handler's comment says a window that attaches too late for the push is synced the survey on attach; that path was read no further and not run.

## Reading of 2026-10-05

A reading of the page's code beside one red of a browser check found a second way into a gap of this kind and a second thing lost in it. It is a reading: nothing was run, and the browser and its driver were not read. The second way in is a tab's return to visible. 300 ms after its tab becomes visible the page disposes its event socket and dials a new one, with no gap detected and a socket that was open (`onVisibility` and `scheduleResume`, `web/packages/workspace-app/src/App.svelte`; `reconnectWatcher`, `web/packages/workspace-app/src/state/store.svelte.ts`). From the old socket's detach to the new socket's subscription no handler of the page hears the tenant's broadcast, and the broadcast keeps nothing for it. That span is one dial: 2 to 27 ms on loopback in ten probe logs of 2026-10-04, against the 300 ms the detected gap above leaves; over a tunnel it was not measured. That a return to visible is what redials rests on those logs, which show each redial about 300 ms after the check brought a page to the front. The second thing lost is a layout: a `session_changed` frame that a co-viewer's save broadcasts in that span reaches no handler, and the new socket's ready reads nothing back. That is the cost [a-window-misses-a-layout-saved-while-its-socket-was-down](a-window-misses-a-layout-saved-while-its-socket-was-down.md) writes as accepted by the owner, the gap at a reconnect; the reading found it reached by the page's own act and not by a network's. The resume hook and `reconnectWatcher` are inside this item's boundaries. The reading names a change smaller than either shape above, a return to visible that does not swap a socket that is open, and nothing of it is ruled. The row stays raised.
