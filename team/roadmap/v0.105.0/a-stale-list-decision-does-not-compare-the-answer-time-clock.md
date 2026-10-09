# A stale-list decision does not compare the answer-time clock

Status: raised for v0.105.0 by the owner's word of 2026-10-09, from the v0.104.0 release report's follow-ups; written down, not designed, not accepted for build.

## What was seen

A concern the review read at source, not a reproduced failure. When a request on a draft's file is answered stale, `decidingStale` fetches the drafts list again and decides by it: a lifetime the list no longer has is gone. Since a repair made during the v0.104.0 review it decides only when the list's reading moved, so that a failed refresh decides nothing. The test is whether `listedAt` changed, and a list request that was already in flight when the stale answer arrived can change it: `refreshDrafts()` waits for that request and for one more, and if the first is answered and the second fails, `listedAt` has moved to a request that began before the stale answer, and the decision is made from that older list. The record is `dev/v0104-team/reviews/review-Review104-drafts-web-range-1.md`, section "The two commits after `d2bddb31b`, read ahead 2026-10-08T17:04:34Z", the point "A residue of N4, not asked (N8)", restated under "Notes, none holding the range"; it adds that the function's own comment ("when that fetch itself fails there is no new list to decide by") is then not what happens, and that the exact form compares with the clock's reading at the stale answer (`const asked = clock` before the refresh, decide only when `listedAt > asked`).

The consequence is the one the same review states for the case this is a residue of (its note N4 in the section "Read ahead at `d2bddb31b`", "By reading, not run"): a lifetime that the older rows never held and that this window did not create reads as gone, so a composer is rebound off a live draft, or a tab is marked missing and stays so; it names the Rich Prompt's own draft and a tab that arrived from another window as such lifetimes. For this residue the review says what it takes, a list in flight, a second request failing, and a lifetime the first never held and this window did not create, and holds it "too remote to move the tip". The lead's dispositions record it as a remote timing concern, "not a new demonstrated failure" (`dev/v0104-team/reports/held-observation-dispositions-Lead104.md`, the paragraph after the table), and row 19 of `dev/v0104-team/reports/held-observations-Lead104.md` says nothing changed for it in v0.104.0. The closed item says no repair and no remote timing measurement is claimed (`team/roadmap/done/drafts-and-attachments-live-inside-the-workspace.md`, section "Landing and validation 2026-10-08", last paragraph).

The code is in the released tree as the review read it, checked at the v0.104.0 commit: `web/packages/workspace-app/src/state/drafts.svelte.ts`, `decidingStale` (lines 149 to 160), reads `const answeredBefore = listedAt`, awaits `refreshDrafts()`, rethrows the stale answer when `listedAt === answeredBefore` and otherwise asks `draftGone(path)`; `fetchList` (lines 47 to 72) sets `listedAt` to the clock reading taken when its own request started, and only when that request succeeds; `refreshDrafts` (lines 87 to 96) follows a request in flight with one more. The existing pin holds the case with no request in flight: an earlier answered list that never held the lifetime, the list request then rejecting, and the server's own stale answer coming back (`web/packages/workspace-app/src/state/drafts.test.ts`, "with the list request failing, passes through as it came: an earlier list decides nothing").

Not established: that the decision from the older list happens at all, since no test or run constructs the three conditions together; which product flows can meet them and how often; any user-visible occurrence. It is a reading of one function, and nothing was run for it on any engine.

## Desired contract

The item asks for a decision. The choices: `decidingStale` decides only from a list whose request began after the stale answer was received, the exact form the review names; or the present test stands and the function's comment is corrected to say what it guarantees. Either way the comment and the behaviour agree.

## What to do

Construct the case before deciding, as a unit test in `state/drafts.test.ts` with that file's own held-request helper: a list request in flight that will be answered without the lifetime, a stale answer on a lifetime this window did not create, and the request after it rejecting; read whether the outcome is `DraftGoneError`. Then read which product flows can meet it, starting from the two the review names, and how a list answered just before can lack a live lifetime. Report the constructed outcome and the reading to the lead with the two choices.

## Boundaries

`web/packages/workspace-app/src/state/drafts.svelte.ts` and `state/drafts.test.ts`; `state/draftEvents.test.ts` only if a pin at the level of a tab's flow is wanted. Not changed: the rule that a failed refresh decides nothing, the born-after-the-list guard of `draftGone`, the single retry of a request on a lifetime still listed, and the server's stale answer.

## Acceptance

1. The constructed case exists as a test, and its outcome on the released code is recorded: the decision made from the older list, or not.
2. The decision recorded here: the exact form, or the present test with a corrected comment.
3. If the exact form: the constructed test red first on its own assertion and green after; a mutant that restores the equality test turns it red; the existing pins under "a stale answer to a draft's request" and "whether a draft's lifetime is gone" stay green.
4. If the comment alone: the doc comment of `decidingStale` says which list can decide, and the constructed test stays as the record of the behaviour.
5. `make web-check` green at the commit in the owning guest.
