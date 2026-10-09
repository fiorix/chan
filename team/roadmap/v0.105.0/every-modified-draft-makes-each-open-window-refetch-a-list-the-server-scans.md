# Every modified draft makes each open window refetch a list the server scans

Status: raised for v0.105.0 by the owner's word of 2026-10-09, from the v0.104.0 release report's follow-ups; written down, not designed, not accepted for build.

## What was seen

A designed cost that was never measured. Every draft event a window receives makes it ask the server for the drafts list again, and a `modified` event is one of them, so each save of a draft costs every open window one `GET /api/drafts`, and the server reads every draft to answer each one. The record is `dev/v0104-team/reviews/review-Review104-drafts-web-range-1.md`, section "Notes" of the first read, entry N3: "Every `modified` frame refetches the list, as the accepted design says. A draft's saves are frequent and each costs every open window one `GET /api/drafts`, which on the server scans every draft. Nothing asked now; a `modified` frame changes no row but the attachments flag." The accepted design says the same of the client (`dev/v0104-team/reports/design-Frontend104-drafts-web.md`, the `state/store.svelte.ts` entry: "Every frame refetches the list (coalesced)"), and the wire design calls the draft event channel refresh hints after which clients refetch the authoritative draft state (`dev/v0104-team/reports/design-Runtime104-draft-events-wire.md`, first paragraph). The author changed nothing for the note (`dev/v0104-team/reports/validation-Frontend104-drafts-web.md`, section "Against the conditions", last point). The closed item records "a designed cost with no performance improvement claimed" (`team/roadmap/done/drafts-and-attachments-live-inside-the-workspace.md`, section "Landing and validation 2026-10-08", last paragraph), the candidate report calls it deliberate (`dev/v0104-team/reports/candidate-report-Lead104.md`, section "Held observations and limits", last paragraph), and the release report asks for the measurement in its Follow-ups (`team/release/release-v0.104.0.md`).

Read again at the v0.104.0 commit, as source and not as a run: `web/packages/workspace-app/src/state/store.svelte.ts`, `onDraftFrame` (lines 1036 to 1056), ends with `refreshDrafts()` for every draft frame whatever its event, with no test of whether the window shows a draft or ever listed any, where the path for a gap in what the window heard, `resyncDrafts` (line 1025), has that test; `web/packages/workspace-app/src/state/drafts.svelte.ts`, `refreshDrafts` (lines 87 to 96), keeps one request in flight and one queued behind it that every caller meanwhile shares, so a burst of frames in one window becomes at most one request running and one waiting; `crates/chan-server/src/routes/drafts.rs`, `list_drafts_sync` (from line 215), enumerates the draft store and for each draft reads its id, takes a pin and inspects it, on a blocking task, once per request.

Not established: no number of any kind. No record measures how many `modified` frames one save or one session of typing in a draft produces, what one list request costs the server at a given number of drafts, or the load with several windows open; "saves are frequent" and "changes no row but the attachments flag" are the review's readings, not counts. Nothing was run for it on any engine or build.

## Desired contract

The cost is known as numbers: for a stated number of drafts and open windows, how many list requests one save of a draft causes and what each costs the server. The item then asks for a decision between leaving the design as it is, with those numbers on record, and reducing the cost; the record proposes no repair.

## What to do

Read first what writes a draft's file and how often (a tab's save, the Rich Prompt's autosave, an image upload), since the record says only that saves are frequent. Then measure in a guest, on a build of the released tree whose kind is stated: count `modified` frames and `GET /api/drafts` requests per save, with one, two and four windows open on the workspace; time the list request on the server with a few drafts and with a few hundred constructed ones, some of them with attachments. Record the guest's cores and CPU pressure with each run; a throttled run is not a measurement of the product. Report the numbers to the lead before any design. If a reduction is then accepted, it is designed against the wire document's rule that a draft frame is a hint and the list is the authority.

## Boundaries

A measurement changes no product file: a script and its record in the round's evidence tree, and at most an uncommitted development counter. If a reduction is accepted later: `web/packages/workspace-app/src/state/store.svelte.ts` and `state/drafts.svelte.ts` with their tests (`state/drafts.test.ts`, `state/draftEvents.test.ts`), and `crates/chan-server/src/routes/drafts.rs` with its tests. Not changed: the rule that the list decides whether a draft's lifetime is gone, the shapes of the draft events on the wire, and the changed-on-disk banner that a `modified` frame from another window raises.

## Acceptance

1. A count with its run record: `modified` frames and list requests per save of a draft, for one, two and four open windows, with the build, the engine and the guest's size named.
2. A timing with its run record: the server's time for one list request at two or more stated draft counts, one of them in the hundreds, with the CPU quota and pressure of the run.
3. The decision recorded here with the numbers beside it: left as designed, or a reduction accepted with a contract of its own.
4. If a reduction is accepted: its pin red first on its own assertion; the list still decides a gone lifetime, with the existing pins of `state/drafts.test.ts` and `state/draftEvents.test.ts` green; `make web-check` and the whole `chan-server` suite green at the commit in the owning guests.
