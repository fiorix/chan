# Eight empty-pane animations and a tuner page wait on the chan-anim branch

Status: shipped in [v0.104.0](../../release/release-v0.104.0.md).

Record before the release: accepted for v0.104.0 by the owner's word of 2026-10-08, which took the scope reading prepared for the owner as the starting point for the version; picked, checked and landed on the integration branch on 2026-10-08 (see Landing); the owner's branch is never rewritten or moved.

## What was seen

The owner's branch `chan-anim` holds ten commits over `85f2c5cdeb728567bdeb28abaa071f499773a363`, read on 2026-10-08 at `32c93aba5317d06e4cec0fa20059282e8220f43e`: eight new empty-pane animations (Tenfold Dahlia `c02131007`, Beaded Torus `171b0d014`, Spiral Fountain `83b1b091a`, Twisting Swarm `2d5406fc6`, Branching Wreath `6c8d7b387`, Drifting Galaxy `0bb445501`, Ninefold Lotus `82805a05c`, Eightfold Coil `32c93aba5`), a dev-only animation tuner page (`8a8608e48`: `web/packages/workspace-app/animation-tuner.html` and `src/animation-tuner/`), and the fragment-shader animations added to the frame-rate page under `scripts/e2e/animation-fps/` and its driver `scripts/e2e/animation-fps.py` (`19a9f2dad`). The diff against its base is 41 files, 5,759 insertions and 13 deletions: 35 files added and 6 modified. `main` at `910811335` is two commits ahead of that base (`6d4927bc4`, a chan-server test; `910811335`, the v0.102.0 pipeline record), neither touching the branch's files. The branch has no changelog entry.

Not established at acceptance: that `animation-tuner.html` stays out of the embedded bundle (the workspace app's `vite.config.ts` names no `rollupOptions.input`, so Vite's default builds `index.html` alone; that is a reading of the config, not a build), and that the branch passes `make web-check` and the browser checks that render the empty pane. No web check runs on the host, whose Node is v26.7.0 against the pin of 22.

## Desired contract

The eight animations, the tuner page and the frame-rate page additions are on `main` as the owner wrote them, with `make web-check` green, the affected browser checks green, the tuner page absent from the embedded bundle, and one changelog entry for the animations.

## What to do

Pick the ten commits in order onto the frontend seat's branch and report any that do not apply cleanly; the owner's branch is read, never checked out elsewhere, rewritten or moved, and commits the owner adds to it during the round are picked only after the lead asks. Run `make web-check` in a guest at the pinned Node; run the browser checks that render the empty pane and the welcome. Build the workspace app once and list the bundle's HTML entries and the embedded `web/dist` for the tuner page by name, beside a positive control (an entry known to be in the bundle). Write the changelog entry.

## Boundaries

`web/packages/workspace-app/` (the animations, the welcome component and the tuner), `scripts/e2e/animation-fps/` and `scripts/e2e/animation-fps.py`, `CHANGELOG.md`. No change to the picked commits' content; a repair the checks require is a separate commit on top, reviewed on its own.

## Acceptance

1. The ten commits are on the candidate as picks, each new sha mapped to its original, and no commit of `chan-anim` was rewritten or moved; a conflict, if any, is recorded with its resolution.
2. `make web-check` is green in a guest at the pinned Node on the picked tree, with the run's log and exit status.
3. The browser checks that render the empty pane and the welcome are green at the picked tree, run alone, with their records.
4. A build of the workspace app at the picked tree lists no tuner page in `web/dist` and in the embedded bundle's entries, shown beside a positive control that is listed.
5. One changelog entry names the eight animations and the frame-rate page additions and says the tuner page is a development page outside the bundle.

## Landing 2026-10-08

The frontend seat picked the ten commits in order onto its branch without conflict (`dev/v0104-team/tasks/task-Frontend104-Lead104-1.md`, the mapping of each original sha to that branch's pick) and ran, in its guest at the pinned Node, `make web-check` on the picked tip `f822743c3` (7,310 tests passed across the four packages, four `svelte-check` stages at zero, exit 0, `dev/v0104-team/evidence/Frontend104/web-check.log`), the bundle inspection (`web/dist` holds `index.html` as its one HTML entry and no file name or content matches `animation-tuner` or `graph-tuner`, beside positive controls, `bundle-inspection.log`), browser checks 10, 111 and 123 each alone (exit 0, `browser-{10,111,123}/`), and a guest-only probe that mounted and drew all eight new animations on Chrome's software renderer (`welcome-choices/`); the probe's console assertion failed on the base's own window-title startup race (two refused capability mints before the mint's retry succeeds, the four files of that chain unchanged), recorded in `reports/animation-Frontend104-validation.md` and held as a finding outside this item. The reviewer read the range (`dev/v0104-team/reviews/review-Review104-item1-range-1.md`): the owner's ten commits unchanged by patch id, author, date and message; acceptances 2, 3 and 4 established, with two limits: no suite check asserts the welcome, so the probe is what shows the new animations draw; and the bundle evidence is the emitted `web/dist`, so one served request for `/animation-tuner.html` beside `/index.html` at the lead's gate closes the embedded half. The lead landed the range on `v0104/int` at `8c516a875` by cherry-pick, one commit at a time (`dev/v0104-team/evidence/Lead104/landings/item1-landing-01.log`, the ten pairs of original and candidate sha), after two rehearsals: the first over an earlier head, the second over the same head as the landing with a tree equal to it, both with the range's patch id. The candidate's ten shas in that log meet acceptance 1; the changelog's unreleased entry meets acceptance 5.
