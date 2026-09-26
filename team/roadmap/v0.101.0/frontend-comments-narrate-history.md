# Frontend comments narrate history, and dead code sits beside them

Status: accepted for v0.101.0 by the owner on 2026-09-25; raised for v0.101.0 from the frontend review (its Phase 4: 534 comments against the house rule and 110 stale-code findings, 13 of them filed as medium), phased out of v0.100.0 because it waits on the source-text test ruling.

## Owner ruling

Accepted on 2026-09-25 as the lead recommended: a frontend round beside or after [one-question-is-answered-in-many-places](one-question-is-answered-in-many-places.md) and [graph-bodies-have-no-mounted-test](graph-bodies-have-no-mounted-test.md), which touch the same files, followed by [the-frontend-review-remainder-has-no-owner](the-frontend-review-remainder-has-no-owner.md). The ruling settles the three questions this item waits on. Dead code that looks reserved is deleted by default, and each exception is named. The workspace demo stays: the source-text round made its demo transport the backbone of the mounted App tests, so retiring it would cost those tests. `editor/design.md` is corrected to the shipped contract rather than the code reverted to it.

## What was seen

The house writing rules say a comment describes the code as it is, in the present tense, and never cites a plan, round or task. The review quotes 534 frontend comments that narrate change over time, 409 of them with a rewrite. Among the medium findings: a file header in `state/tabs.svelte.ts` that still describes a first plan in which drag-rearrange does not exist, a doc block that has drifted onto the wrong function and narrates a debugging session, an opening comment in `GraphPanel.svelte` describing a renderer that was replaced, and plan and task ids in test names and headers.

Beside them sits code nothing reaches: six dead exports in the store including a broken stop-the-poller path, twelve exported tab functions with no caller but their own tests, a dead `overlay` variant of the file browser, a dead terminal configuration component that a test asserts is not mounted, 579 of 667 lines of `desktop/src/styles.css` styling a launcher that was retired, 4.98 MB of orphan PNGs published to the site, and a `SETTINGS_DISABLED` constant whose doc comment and design document both claim a behaviour that does not exist.

Both passes touch the same lines, and both are blocked by the same thing: tests that pin comment text and tests that hold dead code alive. See [source-text-tests-pin-spelling-not-behaviour](source-text-tests-pin-spelling-not-behaviour.md).

## Desired contract

Frontend comments follow the writing rules, and code with no caller is gone unless someone says why it stays. The design documents that have drifted are corrected in the same pass: the review names five load-bearing places, two describing features that do not exist.

## Boundaries

Comments, dead code and the documents that describe them, across the five `web/` packages and `desktop/src`. Rulings needed first: the default disposition for dead code that looks reserved (the review recommends deleting by default and naming exceptions), whether the workspace demo is retired, and whether `editor/design.md` is corrected to the shipped contract or the code reverted to it. One trap recorded during re-verification: deleting the dead terminal configuration component as the review writes it also deletes live assertions in `HybridTerminalConfig.test.ts`, which have to move first.

## Acceptance

1. Every rewritten comment is checked against the code it describes, sentence by sentence, with the function that makes it true cited in the work record and not in the comment.
2. Each deletion names what held the code alive and shows nothing reaches it.
3. `make web-check` is green after each package's pass.
4. The design documents agree with the code on the five named contracts.
