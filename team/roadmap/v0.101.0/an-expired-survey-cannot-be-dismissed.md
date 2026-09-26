# A survey whose request is gone cannot be dismissed

Status: accepted for v0.101.0 by the owner on 2026-09-25; raised for v0.101.0 from a defect the owner hit on v0.99.0 and reported on 2026-09-20: after a `cs terminal survey` expired its overlay stayed on screen, every click was ignored, and only a full window reload cleared it. The mechanism below is a source reading against `main` at `4afc24296`. It has not been reproduced, and which of the loss paths the owner hit is not established.

## Owner ruling

Accepted on 2026-09-25 as the lead recommended, as a lane of its own whose first step is the reproduction: a survey raised with a short `--timeout` and the window taken offline across the deadline, shown red on today's code.

## What was seen

The overlay has no exit that does not go through the server. `pickOption`, `requestFollowup` and `dismissSurvey` in `web/packages/workspace-app/src/state/survey.svelte.ts` each post `/api/survey/reply` and clear the slot only when the post succeeds; on failure they reset `busy`, raise a notice and leave the overlay up. Escape and the backdrop are deliberately not a close, so a stray key cannot hang the waiting CLI. The reply route (`crates/chan-server/src/routes/survey.rs`) answers 404, "no survey parked with id ... (already answered or stale)", once the request is gone. So an overlay whose request the server has dropped is stuck: every button, Dismiss included, posts, gets 404 and changes nothing. Survey state lives in memory, which is why a reload clears it.

The one thing that removes such an overlay is the `close_survey` window command, and it is sent once. `send_survey_close_commands` in `crates/chan-server/src/control_socket.rs` fires it when the deadline passes, the client disconnects or another window answers, and discards the send result. It rides the `/ws` event broadcast, which loses a frame two ways. A window whose socket is down at that instant never receives it; the server does have a place to park commands for a window with no socket (`pending_window_commands`, drained on attach in `crates/chan-server/src/routes/ws.rs`), but only a routed open uses it, not the survey push. And a socket that has fallen behind skips ahead: the pump answers `RecvError::Lagged` with `continue`, so a busy window can drop the close without ever disconnecting. The default deadline is 600 seconds, long enough for a laptop to sleep or a tunnel to reconnect across it.

`closeSurveyFromRemote` has a second hole. It ignores a close while the slot is `busy`, on the assumption that the in-flight reply will succeed and clear the slot itself. A click that races the deadline gets the 404 instead, and the close that would have cleared the overlay has already been swallowed.

The mirror image has the same cause. `open_survey` is also sent once, from one site, so a window that reloads or reconnects while a survey is open loses the overlay while the CLI keeps blocking until its deadline: the host cannot answer what the window no longer shows.

## Desired contract

Owner, 2026-09-20: when the command is interrupted or disconnected from the survey UI, the UI cleans up, so surveys do not pile up; showing that only dismiss remains would be the lesser fix.

An overlay never outlives its request. The set of surveys a window shows converges on the set the server is still waiting on: when the close arrives, when the window's socket attaches or re-attaches, and whenever the server refuses a reply as unknown. A refused reply clears the overlay and says the survey expired, which is the floor: any click gets the host out. A close that arrives during an in-flight reply is applied if that reply fails. A survey that is still open when a window attaches is raised there again.

## Boundaries

`survey.svelte.ts`, the `open_survey` and `close_survey` arms and the socket attach path in `web/packages/workspace-app/src/state/store.svelte.ts`, and `BubbleOverlay.svelte`. On the server: `crates/chan-server/src/survey.rs` (the bus knows which ids are parked and for which target windows), `send_survey_close_commands`, the reply route, and the `/ws` attach in `routes/ws.rs`, where the existing parking is the obvious thing to reuse for a window with no socket. Parking does not cover a lagged socket, so the convergence on attach and on a refused reply is still needed. What a live survey means does not change: Dismiss on a live request still answers the CLI "survey dismissed; no answer", a deadline still exits 124, and Escape still does not close a live one. The handover prompt is pushed the same one-shot way and deserves the same reading; it is not this item.

## Acceptance

1. A test replies to a survey id the server does not know and finds the slot cleared and the expiry notice raised, for each of option, follow-up and dismiss.
2. A test delivers a close while a reply is in flight, fails that reply, and finds the slot cleared.
3. A server test attaches a window after its survey timed out and finds it told the survey is gone; a second attaches a window while a survey is open and finds it raised there.
4. A browser check raises a survey with a short `--timeout`, takes the window offline across the deadline and brings it back: the overlay is gone without a reload. The check is shown red on unmodified code first.
5. On a live survey, Dismiss still prints "survey dismissed; no answer" and a deadline still exits 124.
