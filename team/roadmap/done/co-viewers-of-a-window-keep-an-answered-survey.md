# Co-viewers of one window keep an answered survey

Status: shipped in [v0.101.0](../../release/release-v0.101.0.md).

Record before the release: raised during v0.101.0 on 2026-09-26 by the independent review of the survey client order (`dev/v0101-team/reviews/review-Clients-6.md`, finding 4, in the development tree), read in code and not reproduced; inherited from the server's close fan-out, not introduced by that order. A source reading against `main` at `ef33cb0f3` and the order's tip `0e281b882`.

## Owner ruling

Accepted on 2026-09-26 as the lead recommended: the close fan-out reaches the answering window too, since the client's raise and close are idempotent by id and the answering instance holds the id it answered; red first with two sockets on one window id.

## What was seen

Two SPA instances can share one window id (`?w=`), which the code calls co-viewers (`web/packages/workspace-app/src/api/client.ts`, `crates/chan-server/src/routes/sessions.rs`). When a survey targets that window, both instances show it. The close fan-out in `crates/chan-server/src/control_socket.rs` skips the window id that answered, on the assumption that the answering window's own reply cleared its overlay, and the client keeps its set of answered ids per instance. So when one instance answers, the other gets no `close_survey` and keeps an overlay with no request behind it, until its socket next attaches or lags (which brings a `survey_sync` without the id) or a click there is refused with 404 and clears it. The contract's "except in the window that answered it" holds for one instance per window id.

## Desired contract

Every instance showing a survey learns of its close, the answering one included; the client's raise and close are idempotent by id, so a close reaching the answerer is harmless.

## What to do

Send the close to the answering window too (drop the skip in the fan-out); the answering instance already holds the id in its answered set and its slot is clear, so the frame is a no-op there, and the co-viewer clears at once. Red first with two sockets on one window id, one answering. Small; it is the server's fan-out.

## Boundaries

`crates/chan-server/src/control_socket.rs` (the close fan-out) and its tests; no client change.

## What shipped

Landed on 2026-09-27. After a reply the server sends the survey's close to every window the survey targeted, the answering one included, so another app instance sharing that window id clears at once. The answering instance finds nothing left to close by that id: a close that arrives while its reply is in flight is held and dropped when the reply is accepted, and after that no slot shows the survey. Both are pinned through the app's own socket arm.

The server no longer reads the window id a reply carries, and the workspace app no longer sends it. A reply body that still carries `windowId`, as shipped apps and desktops send it, parses to the same reply and completes its survey, pinned through the route for an option, a follow-up and a dismissal. An app without the field against an older server gets the close fanned back to the answering instance, which is the same no-op.
