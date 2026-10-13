# A draft being created is listed as broken until its creation finishes

Status: raised by the review seat on 2026-10-13 from the forty recorded timelines of check 131's loop (N2 of `reviews/review-Review106-chk131-recorder-1.md` in the round's bus); written down the same day by the lead as a row of its own, outside that item; owner the frontend seat with the server; not reached in the v0.106.0 round

## What was seen

In the forty recorded runs of check 131 (`evidence/Frontend106/chk131-loop-{idle,churn}/` in the round's bus), 128 of 288 `GET /api/drafts` polls answered 200 with a `broken_draft` warning for a draft whose creation was in flight: 107 read "draft identity is unavailable: No such file or directory (os error 2)" and 21 "draft has no primary file", each with a source the page can offer to discard (`store.svelte.ts` 630 at the round's base). The warned polls sit between a `POST /api/drafts/new` request and its response: the 80 creations took a median of 41 ms idle and 46 ms under churn, 21 ms at the shortest, 1.2 s idle and 6.3 s under churn at the longest, four over a second; the longest run of consecutive warned polls was 5.8 s. So a list read during a creation reports the draft as damaged when it is unfinished. Not read: when the page refreshes its list and whether a person sees the warning or a discard offer during a slow creation; whether the warning can outlive the creation.

## Desired contract

A draft whose creation is in flight is either absent from the list or listed as being created; it is never listed as broken, and the page never offers to discard it, until its creation has finished or failed.

## What to do

Read the create route and the list route for the window between the lifetime's registration and its primary file's write, and the page's list refresh (how often, and what it shows for a `broken_draft` row); construct the window in a route test (the create held between the two writes while the list is read) and read the page's behaviour once in a browser with a slowed creation. Then decide: the list skips lifetimes whose creation is in flight, or the create registers the lifetime only after its files exist, or the page holds a broken row for a grace period before offering to discard. Design before code; the review seat reads the design.

## Boundaries

`crates/chan-server/src/routes/drafts.rs` (create and list), the drafts store in `chan-workspace`, the page's drafts list (`state/drafts.svelte.ts`, `components/DraftsGroup.svelte`) and their tests. Not changed: what a truly broken draft shows and offers.

## Acceptance

1. A route test with the creation held between its writes: the list answers without a `broken_draft` warning for that lifetime (absent, or marked in flight); red first at the base on the warning.
2. The page's behaviour during a slowed creation read once in a browser and recorded, before and after.
3. A truly broken draft (its primary file removed after creation) still lists as broken with its discard offer, pinned.
