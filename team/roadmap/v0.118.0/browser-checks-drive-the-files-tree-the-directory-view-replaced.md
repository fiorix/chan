# Browser checks drive the Files tree the directory view replaced

Status: landed in `0.118.0-ga` on 2026-10-31 (merge `879f576a3`; the section Built): the twenty-three checks pass alone and in the whole suite in the Linux guest, whose final reds are exactly the four recorded at `main` (60, 125, 131, 195), so the acceptance holds and the row closes at the GA.

Record before the merge: built, awaiting owner review. The Built section records the implementation and verification.

## What was asked

Nothing was asked yet; this is a finding of the cut. The Files tab shows one directory at a time since v0.117.0 (the item [the-file-browser-shows-a-tree-with-no-directory-navigation-or-keyboard-model](../done/the-file-browser-shows-a-tree-with-no-directory-navigation-or-keyboard-model.md)), and its builder recorded that the browser suite's tree selectors were not migrated and the suite was not run on the branch.

## Evidence

The whole browser suite at the merged release tree in the guest (Ubuntu 26.04, Chrome 156): 103 checks ran, 72 green, 90-launcher-gateways skipped for the missing marketing dist, 30 red. Twenty-three of the reds wait on the tree the Files tab no longer renders, `[role="treeitem"]`, `[role=tree]` or `.browser [role="tree"]`, in the check itself or in `lib/drafts.mjs` (lines 407 and 414): 100, 101, 102, 103, 106, 110, 111, 112, 123, 126, 130, 132, 133, 163, 164, 179, 20, 21, 22, 40, 50, 80 and 98. Each opens a File Browser tab with `app.files.toggle` and clicks a tree row to open a file or to read the selection, and fails at that step, before its own subject (the editor, graph, drafts, inspectors, collaboration and root-loss checks among them). Of the other seven reds, 60, 95, 125 and 131 are red alone at `main` before the release, 195 is the tmux browser row, 107 is green alone, and 170 is red alone at its precondition, which expects the status pill to cover the file browser's Details close button and finds the button clear under the Files tab's new inspector: a precondition of the old layout, to be read again against the new one with the migration.

## Desired contract

The suite drives the Files tab as the product now presents it: a directory listing with breadcrumbs, a path field and a filter, with a docked browser keeping the tree. One shared helper opens a file by path from a Files tab (entering directories through the breadcrumbs or the path field, then the row), replacing the per-check tree walks, and `lib/drafts.mjs` reads the Drafts group where the directory view shows it.

## Acceptance

1. The twenty-three checks above pass alone and in the whole suite in the Linux guest against the release tree or later.
2. The suite's reds are the ones recorded at `main` and no other.

## Owner's decision, 2026-10-31

Surveyed in the owner's window on 2026-10-31 with three options: migrate the twenty-three checks to the directory view; point the checks at a docked browser, which keeps the tree; defer to v0.119.0. The answer, in the survey's words: "1 Migrate the 23 checks to the directory view (recommended)". So the Desired contract stands as written: one shared helper opens a file by path from a Files tab (the breadcrumbs or the path field, then the row) and replaces the per-check tree walks, `lib/drafts.mjs` reads the Drafts group where the directory view shows it, and check 170's precondition is read again against the new inspector with the migration.

## Built, 2026-10-31

The shared `scripts/e2e/browser-smoke/lib/files.mjs` helper brings a Files tab forward with a real tab-strip click, enters a workspace-relative directory through the path field, and acts on the named directory row. Readings include the current directory, rows, filter and status, and absence waits require a visible, unfiltered listing without a loading or error state. `files.test.mjs` covers path normalization and failed or hidden absence containers. The twenty-three checks use this helper while retaining their editor, graph, inspector, collaboration, watcher and root-loss assertions; the suite README describes the helper contract.

`lib/drafts.mjs` reads Drafts in the Files tab's visible `File locations` rail, which `FileBrowserSurface.svelte` renders independently of `FileTree.svelte`'s tree-only Drafts group. The rail hides in narrow panes, so an absence assertion first proves that rail is visible. The Files tab does list drafts; no dock fallback or missing-Drafts product question is needed.

Check 98 visits and verifies all 121 generated directories and 120 files before root loss. Check 163 observes the directory listing in a Files tab and retains its docked-tree arm to prove cached descendant invalidation. Check 164 closes its named UI tabs before reaping remaining sessions, preventing a reload from saving a tab whose attachment arrives late. During development, 123 reached its editor setup but timed out because Details covered the rows in its roughly 190-pixel pane; `openFile` closes Details before the real double-click, and the check now passes with its four-pane layout intact. Check 170 retains the terminal find box as a positive overlap control and requires the Details close button to remain clear below the Files toolbar with the status pill expanded or collapsed. No product component changed.

The untouched baseline at `a71ab0339` ran in the Ubuntu 26.04 guest with Node 22.21.1, Chrome 156.0.8078.80 and tmux 3.6. Its verdict was `[smoke] 29 FAILURE(S) (103 ran, 1 SKIPPED: launcher-gateways)`: 74 passed, 29 failed and 1 skipped among 104 listed checks. The red set was 20, 21, 22, 40, 50, 60, 80, 95, 98, 100, 101, 102, 103, 106, 110, 111, 112, 123, 125, 126, 130, 131, 132, 133, 163, 164, 170, 179-mutation-no-answer and 195. Check 107 passed in position, and 196 accounts for the additional check since the v0.117.0 reading.

At committed code `c0d2475c6`, all twenty-five affected checks passed individually, followed by one whole-suite run. Its verdict was `[smoke] 4 FAILURE(S) (104 ran)`: 100 passed, 4 failed and none skipped. The red set is exactly the unchanged checks 60, 125, 131 and 195. Check 90 also passed individually and in the whole suite after its marketing assets were built. A private GNU date link on the guest run's PATH avoids the uutils timestamp effect; 155 passed in both whole runs. Terminal roster samples peaked at six sessions and ended at five, with no session-cap cascade.

Each check below was red in the baseline and green both alone and in the final whole suite. `179 mutation` means `179-mutation-no-answer.mjs`; `179-welcome-gpu-hint.mjs` does not drive the Files tree.

| Check | Baseline | Alone | Suite |
| --- | --- | --- | --- |
| 20 | red T | green | green |
| 21 | red T | green | green |
| 22 | red T | green | green |
| 40 | red T | green | green |
| 50 | red T | green | green |
| 80 | red F | green | green |
| 98 | red R | green | green |
| 100 | red T | green | green |
| 101 | red T | green | green |
| 102 | red M | green | green |
| 103 | red T | green | green |
| 106 | red F | green | green |
| 110 | red T | green | green |
| 111 | red T | green | green |
| 112 | red P | green | green |
| 123 | red T | green | green |
| 126 | red L | green | green |
| 130 | red D | green | green |
| 132 | red D | green | green |
| 133 | red D | green | green |
| 163 | red D | green | green |
| 164 | red T | green | green |
| 179 mutation | red D | green | green |
| 170 | red I | green | green |
| 95 | red N | green | green |

The baseline failure keys preserve each first failing line:

- T: ``TimeoutError: Waiting for selector `[role="treeitem"]` failed``
- D: ``TimeoutError: Waiting for selector `[role=tree]` failed``
- F: ``TimeoutError: Waiting failed: 15000ms exceeded``
- R: ``TimeoutError: Waiting for selector `.pane .browser [role=tree]` failed``
- P: ``TimeoutError: Waiting for selector `.pane[data-pane-id="pane-1"] .browser [role="tree"] [role="treeitem"]` failed``
- L: ``Error: B's tree lacked xw-1793447814528-381125-holder.md within 15000ms``
- M: ``Error: Waiting for selector `[role="treeitem"]` failed; probe={"steps":[{"name":"check-start","at":1793447622141}],"geometryAtMeasurement":null,"geometryBeforePress":null,"geometryAtCapture":null,"page":{"timeOrigin":1793447621808.2,"events":null}}``
- I: ``AssertionError [ERR_ASSERTION]: details-close: the expanded pill covers the control ([{"x":1228,"y":127,"control":true,"pill":false,"at":"button.close.svelte-17w6cpd"},{"x":1236,"y":127,"control":true,"pill":false,"at":"svg"},{"x":1244,"y":127,"control":true,"pill":false,"at":"svg"}])``
- N: ``Error: native trust dialog name missing; saw []``

The final failures are outside these changes:

- 60: ``TimeoutError: Waiting for selector `section.machine .machine-actions button.count-badge.machine-toggle` failed``.
- 125: ``TimeoutError: Waiting for selector `.rich-prompt .cm-content` failed``.
- 131: `Error: no promotion request was seen`.
- 195: `Error: the source window let the control tab go did not appear within 30000ms: no matching value`. Its baseline failed earlier with `Error: the record lacks the tmux window`; the check and product code are unchanged here.

Evidence is under `dev/browser-suite/evidence/`: `baseline/results.json` and `final/results.json` hold the whole-suite results, `baseline-95/results.json` holds the identical trust-dialog failure alone, and `final-alone-<check-file-without-.mjs>/results.json` holds each individual proof, including 90. Each run has a masked `run.log` containing its results JSON; screenshots remain in the guest run directories, except the copied 123 development failure under its evidence directory. `comparison.json` records the per-check comparison, and each whole run's `first-failures.tsv` records its exact red lines. The initial empty `SMOKE_ONLY` invocation was refused before running checks, was corrected to omit the variable, and is retained as `baseline/unrunnable.log` rather than counted as a baseline.

The host checks at `c0d2475c6` passed: `node --check` on all 31 changed modules and `make browser-smoke-lib-test`, including dependency resolution and 64 Node tests. Their records are `final-host-syntax.txt` and `final-host-lib-test.log` under the evidence directory. Shell and workflow gates were not run because neither kind of file changed. Product web and Rust gates were not run because no product code changed; the baseline guest web, chan and echo-extension builds passed. Check 21's optional video playback stage was not run because `SMOKE_VIDEO_FILE` was unset; its inspector and byte-range assertions passed. No affected check was omitted from the individual or whole-suite proofs.

Open questions: none. Owner review is pending. No product question remains from the Drafts-listing survey.
