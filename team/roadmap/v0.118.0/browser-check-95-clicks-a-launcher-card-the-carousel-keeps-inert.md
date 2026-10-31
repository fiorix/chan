# Browser check 95 clicks a launcher card the carousel keeps inert

Status: built, awaiting owner review. The Built section records the implementation and verification.

Record before the release: carried into v0.117.0 at the v0.116.0 GA on 2026-10-30, not started: the check is still red alone at the GA's base and tip (the launcher's carousel keeps the card inert), and no one took the row in the v0.116.0 round.

Record before the release: carried into v0.116.0 at the v0.115.0 GA on 2026-10-29, not started: the owner asked for the GA before it was built, and by the roadmap lifecycle an unbuilt row moves to the next version.

Record before the release: accepted for v0.115.0 by the owner's word of 2026-10-28; not started.

## What was asked

The owner's words of 2026-10-28, after the v0.114.0 GA: "let's add a roadmap item to fix browser check 95".

## Evidence

Read at `3931bf610`. Browser check 95 (`scripts/e2e/browser-smoke/checks/95-launcher-native-trust.mjs`, `launcher-native-trust`) serves the launcher bundle (`web-launcher/dist`) behind a fake backend holding one shared, trust-required devserver `shared-lab`, waits for `[aria-label="Connect shared-lab"]`, clicks it and waits for the "Grant native access?" dialog. It fails before the dialog: "native trust dialog name missing; saw []". Its first screenshot shows the launcher's carousel with All windows in front and the machine cards beside it; the carousel makes side cards inert (`web/packages/launcher/src/components/Carousel.svelte`), so the button the check finds receives no click.

It fails the same way at the GA commit `1d8434419` and at the base `0604056a2` with the launcher bundle built from that commit, so it predates the v0.114.0 launcher changes; the records are in the v0.114.0 archive (`check95-ga/`, `check95-base/`). The v0.114.0 GA ran it alone because the window counter cleanup removed a route stub from its fake backend; it is not a release gate step.

## Desired contract

The check proves what it was written for: Cancel on the native trust dialog mutates nothing, Grant puts trust before connect, and Revoke tears both down, on the launcher as it renders today.

## What to do

- Bring the `shared-lab` card to the front before each click (as a user does with the deck's arrows, the Left and Right keys or `showCard`), or select it by the deck's own controls, then press Connect; keep the request-order assertions as they are.
- Read the rest of the launcher checks for the same shape (a click on a control inside a card that is not in front) and fix any that share it.

## Acceptance

- Check 95 alone green at the fix, and red at the base with the identical failure, so the fix is what turned it green.
- The whole browser suite run at the fix, with any other launcher check the search found green.

## Owner's decision, 2026-10-31

Surveyed in the owner's window on 2026-10-31 with three options: build it this round in the lane that migrates the Files-tree checks ([browser-checks-drive-the-files-tree-the-directory-view-replaced](browser-checks-drive-the-files-tree-the-directory-view-replaced.md)); build it this round in a lane of its own; carry it to v0.119.0. The answer, in the survey's words: "1 Build it this round in the filesel lane (recommended)". So one browser-suite agent in the Linux guest takes this row with the migration, and one whole-suite run at the lane's tip proves both; the Acceptance above stands.

## Built, 2026-10-31

`scripts/e2e/browser-smoke/lib/carousel.mjs` brings the requested launcher card forward through the deck's Next control, requires the front card to be non-inert, and waits for the ring's CSS motion before returning. Check 95 uses this barrier before each Connect or Revoke action. Its Cancel, Grant-before-connect and Revoke assertions are unchanged; the observed request order is `PUT native-trust`, `POST connect`, `DELETE native-trust`. Seven Node tests in `carousel.test.mjs` cover delayed motion, reduced motion, an inert front card, ambiguous controls, ignored navigation and bounded failures.

The launcher-check sweep found another immediate card interaction in 90 after adding a gateway, where the deck turns to the newly saved card before Connect. That check uses the same barrier. With marketing assets built, 90 passed at the untouched baseline and with the guard, so this is a timing guard rather than a claimed reproduced failure. The other launcher checks drive ordinary devserver cards or already wait for their screen or card flip; no other front-card change was needed. No product component changed.

Check 95 failed alone and in the whole baseline with the identical line `Error: native trust dialog name missing; saw []`. It passes alone and in the final suite. The companion Files migration and the re-read Details precondition in 170 share the verification record below. Drafts are present in the Files tab's `File locations` rail, so no missing-Drafts product question arose.

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
