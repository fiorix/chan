# A gateway page may delete a saved layout

Status: accepted for v0.131.0 by the owner on 2026-11-14 as a reading (`dev/v0131/decisions.md`, point 11: "as you recommend"); a fix follows only if the reading shows a difference. Not started.

Record: a follow-up of v0.130.0 with no row (its release record, "Follow-ups", the manual): whether a saved layout can restore to nothing in a gateway browser page but not in a desktop page, which would make a gateway leader delete that layout on its first save, was not established. The decisions document for v0.131.0 sorted it as a reading; the owner took that recommendation.

## What is there now

Read at `f7457becb`, by reading.

- The session save (`commitSessionSave`, `web/packages/workspace-app/src/state/store.svelte.ts`, around line 4278) deletes the window's saved session when a boot that found one serializes to nothing (`api.deleteSession()`); a follower suppresses the delete (`followerSuppressesSessionDelete`), a leader does not.
- No desktop-only branch in a tab's restore was found by reading. Whether any tab kind restores to nothing in a gateway page is open.

## Desired contract

1. A saved layout that holds tabs is never deleted by a page that restored it, in a gateway page as in a desktop page.

## Boundaries

- A reading first: a workspace app test that boots one saved layout per tab kind both ways (as a gateway page and as a desktop page) and compares what each serializes back. A fix, in the restore or the save, only if the reading shows a difference; the fix then gets its own red test from the reading.

## Acceptance

1. The reading's test, recorded with its result per tab kind, kept as a regression test whatever it shows.
2. If a kind differs: the fix, with that test red at the base and green at the tip.

## Built, 2026-11-14

The workspace-app reading found no platform difference for the seven current tab kinds: terminal, file editor, file browser, graph, dashboard, diagram and extension. Terminals were read both with a live session id and without one. Each saved payload comes from the real session writer's PUT, then boots separately through the desktop and gateway environment, the real restore path and session serializer. Both return the same complete, nonempty layout, retain the expected tab kind and leave the saved blob unchanged on the first save. No product change was needed.

The retained test is `web/packages/workspace-app/src/state/store.gatewayLayout.test.ts`. Its gateway page has an origin-follower participant that holds the leader slot, so DELETE suppression cannot conceal a lost layout. Two controls explicitly empty a restored layout and verify the real session transport sends DELETE, on both surfaces. This is a Vitest bootstrap reading with mocked network/content boundaries and distinct native globals, tenant prefixes and rosters, not a browser or native engine observation.

All ten cases pass. A temporary mutation that skips graph tabs during restoration makes the graph case fail because its leaf has no tab; the other nine pass. The original source hash was restored. Logs, statuses, the mutation diff and source hashes are under `dev/v0131-team/evidence/Edit131/gwlayout/` (`second-run.log`, `mutation-red.log`, `restored.log`); committed validation is recorded in `committed-test.log` and `committed-typecheck.log`. The first harness run failed before comparison because its status assertion did not handle a null status; that setup error is retained as `first-run.log` and is not evidence of a product difference. No guest or owner pass is required by this reading's acceptance; no product fix follows it.
