# The deck's Computers orb lights during each poll in a window with no library

Status: raised on 2026-10-04 from a reading of the command deck's code made during the excluded-directories control's build, not seen on a display; accepted the same day as a defect with one fix and built on the v0.102.0 integration branch, where the owner reviews it before any cut.

## Owner ruling

Not yet put to the owner as a question: the fix has one defensible shape and changes one expression, so it was built on the branch and is recorded here and in the branch's decision log for the owner's review.

## What was seen

In a window served by `chan serve --standalone`, the command deck asks the scoped-library route each time it opens and every 2.5 seconds while it shows. The route answers 404 or 405 there, since the window has no library. The Computers orb was enabled whenever a request to that route was unanswered, so it lit up at each poll for as long as the server took to answer, over one disabled entry, and went dark again at the answer.

## Desired contract

After the scoped route has answered 404 or 405, the Computers orb is disabled and stays disabled through every later request to that route, while the deck is open and when it is opened again. The orb is enabled while the page's first request to the route is unanswered and whenever a snapshot of the scoped library is held.

## What to do

One expression of the deck decides the orb from the snapshot, the first request's pending state and the absence of a recorded refusal, instead of from any request in flight; the page's design states the rule.

## Boundaries

`web/packages/workspace-app/src/components/CommandLauncher.svelte` and its test; `web/packages/workspace-app/src/design.md`. No change to the route, the poll's cadence or the deck's other orbs.

## Acceptance

1. After a 404 or 405 the orb stays disabled through the request that follows, also after the deck is closed and opened again; pinned red first in the deck's suite.
2. The orb is enabled while the first request to the route is unanswered and whenever a snapshot is held; pinned as a guard.
3. The design states the rule.

## What shipped

Built on 2026-10-04 on the v0.102.0 integration branch and not on `main`, in a range the lead accepted on its report, its status files and an independent review of its whole diff: the orb's `available` expression in `web/packages/workspace-app/src/components/CommandLauncher.svelte` reads the snapshot, the first request's pending state and the absence of a recorded refusal; the pin and its guard are in the deck's suite, each red under its own mutation; `web/packages/workspace-app/src/design.md` states the rule beside the deck's scope. Inferred and not seen: that the orb is quiet on a standalone tenant through every poll; the pin drives the reopen's request, and the 2.5-second poll calls the same function. The changelog carries the line.
