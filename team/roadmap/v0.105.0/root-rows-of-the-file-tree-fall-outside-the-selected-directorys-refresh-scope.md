# Root rows of the file tree fall outside the selected directory's refresh scope

Status: raised for v0.105.0 by the owner's word of 2026-10-09, from the v0.104.0 release report's follow-ups; written down, not designed, not accepted for build.

## What was seen

A source inference after two development observations; no dedicated reproducer was run. In two development runs of browser check 132 a file written on disk at the workspace root did not appear in the File Browser's tree: `dev3-132` and `dev4-132` each ended "timed out waiting for the file smoke-attach-<stamp>-root.md in the tree" (`dev/v0104-team/evidence/Frontend104/drafts-web/dev3-132.log` and `dev4-132.log`, each with status 1, on Chrome for Testing 155.0.8059.39 in a guest), and the second log lists the tree's rows at the failure: the folder, the document inside it, the image uploaded into the folder in the same interval and the other root entries, without the new root file. The author recorded it as an observation with the cause not established, seen while the File Browser tab was not the active tab, within 20 seconds of the tab coming forward again (`dev/v0104-team/reports/validation-Frontend104-drafts-web.md`, section "Outside the item, for the lead"). The two runs were of two uncommitted development versions of the check, whose file's hash differs between the two logs; the committed check seeds both of its documents before the tree is first shown (the same report, section "The development runs, kept").

The review then read a cause at source and did not run it (`dev/v0104-team/reviews/review-Review104-drafts-web-range-1.md`, section "Notes, none holding the range", entry B3): a File Browser's refresh scope is its selection's directory, and a watch event refreshes the tree only when its path is inside some scope; in both runs the selection was the document inside the folder, so the scope was that folder and the file written at the root was outside it, while the image uploaded into the folder showed. The review holds the cause to be the scope rule as written, whether or not the tab is in front, and gives a reproducer by reading: select a file inside a folder in the File Browser, create a file at the workspace root from outside chan, and the root's rows do not gain it. It found the three scope functions and the filesystem tail of `onWatchEvent` byte-identical at the drafts range's base `1392c6012` and tip `728e66e8c`, so the drafts work is not the cause.

The functions are in the released tree as described, read again at the v0.104.0 commit: `web/packages/workspace-app/src/state/store.svelte.ts`, `fbScopeForSelection` (line 2996: no selection is the root scope, a selected directory is its own scope, a selected file gives its parent directory), `activeFbScopes` (line 3006: the dock's browser and every browser tab contribute one scope each), `pathInAnyScope` (line 3022), and the tail of `onWatchEvent` (lines 1182 to 1188), which calls `refreshTreeForPath` only when a watched path is inside some scope. The comment above the three functions states the rule and its reason: an event refreshes the tree if and only if at least one scope contains its path, the gain being no flicker when the scope and the event path do not intersect.

Not established: that the scope rule is the cause, since nothing was run to separate it from the inactive tab the author observed; the lead's dispositions say the explanation is read at source, not a separately run reproducer (`dev/v0104-team/reports/held-observation-dispositions-Lead104.md`, the paragraph after the table), and the candidate report claims no dedicated reproducer and no inactive-tab cause (`dev/v0104-team/reports/candidate-report-Lead104.md`, section "Held observations and limits"). Also not established: whether and when the stale root rows catch up (a later event inside the scope, a change of selection, a collapse and expand, a reload); the dock's browser as against a browser tab; any engine other than headless Chrome 155. Whether root rows that go stale while a folder's file is selected are wanted is recorded as a product question, the owner's to decide (the dispositions' same paragraph; the review's entry B3).

## Desired contract

The item asks for a reproduction and then the owner's decision. The choices: a file created at the workspace root appears in the tree within the watcher's ordinary delay whatever the File Browser's selection is; or the scope rule stands as written, and what goes stale and what brings it up to date are stated where a user and a check author can read them.

## What to do

Run the review's reproducer in a guest as a development run of a browser check, in the two arms the record cannot separate: a browser tab in front with a file inside a folder selected, and the same with the tab not in front, each beside a control with no selection, which is the root scope. Create the root file from outside chan and read the tree's rows for a stated time; then read how long the root rows stay stale and what clears them. Put the result to the lead for the owner's decision before any design. A wider refresh has the cost the rule's own comment names, which a design would have to answer.

## Boundaries

`web/packages/workspace-app/src/state/store.svelte.ts` (the scope functions, the tail of `onWatchEvent` and `refreshTreeForPath`) with its tests, and one browser check under `scripts/e2e/browser-smoke/checks/` if the decision is a change. Not changed: the server's watcher and its events, the Drafts group above the tree and its list, and check 132 as committed.

## Acceptance

1. A run record of the reproducer with both arms and the control, naming the engine and the build: whether the root file's row appears, after how long, and what makes it appear.
2. The cause stated as shown or not shown: the scope rule, the inactive tab, or both.
3. The owner's decision recorded here.
4. If the decision is a change: a pin, red first on its own assertion, that a file created at the root appears while a file inside a folder is selected; what the decision leaves out of scope still refreshes nothing, pinned; `make web-check` green and the browser check green alone at the commit in the owning guest.
