# Browser check 64 fails when it runs directly after check 59

Status: shipped in [v0.107.0](../../release/release-v0.107.0.md).

Record before the release: built on 2026-10-16; the section Repair verification 2026-10-16 holds the evidence; it closes at the GA as shipped.

Record before the release: raised by the review seat on 2026-10-13 from its read of the markdown click range (N6 of `reviews/review-Review106-mdclick-range-1.md` in the round's bus); written down the same day by the lead as a row of its own; owner the hygiene seat; a reading ordered in the round

## What was seen

In the review seat's set of fifteen editor checks, `64-conflict-banner-reload` failed with "banner never appeared" at the base bundle and at the markdown click tip's bundle alike. Read alone at the tip bundle it passes (3 of 3) and after check 58 (1 of 1), and fails directly after `59-large-file-streaming` (the pair once, and both runs of the set, where 59 precedes it: 3 of 3). In a whole run three checks stand between the two, so the whole suite does not meet it today. The suite's README says a check passes alone and in any suite position.

## Desired contract

Each check passes alone and in any position: no check leaves state the next one meets, and no check needs state a neighbour left.

## What to do

Read what check 59 leaves and what check 64 needs (the workspace's files, the server's state, the page's storage, a watcher or an index still busy with the large file), by running the pair with each check's timeline kept and by reading both checks and the runner's per-check reset; say which of the two is at fault. Then the repair in that check or in the runner's reset, red first as the pair, green as the pair and alone.

## Boundaries

`scripts/e2e/browser-smoke/checks/59-large-file-streaming.mjs`, `checks/64-conflict-banner-reload.mjs`, the runner's per-check reset in `scripts/e2e/browser-smoke/run.mjs` and its helpers. No product file unless the reading finds a product fault, which then gets an item of its own.

## Acceptance

1. The cause written down with the lines of the check or the runner and a run of the pair that shows it.
2. The pair green in both orders and each check green alone, in the suite's Chrome, with the engine named.
3. A whole suite run not made slower by more than the repair's own wait, stated.

## The reading 2026-10-13

Acceptance 1 (the hygiene seat, `dev/v0106-team/tasks/task-Hygiene106-Lead106-26.md`; `evidence/Hygiene106/check64-reading-1/`), in its guest's Chrome for Testing 155 against a bundle and a debug `chan` built at the integration tip `143219483`: check 64 alone green three times; check 59 then 64 red three times ("banner never appeared"); the reverse order green; 59, then check 60 (which runs its own devserver), then 64 red; and the pair green when check 59's malformed fixture is removed after its own assertion, the only input changed. The cause, by source and by run: check 59's scenario D writes `bad-utf8.md`, a Markdown file that is not valid UTF-8, into the shared throwaway workspace (`checks/59-large-file-streaming.mjs` 285 to 293) and nothing removes it (the check's `finally` closes only its extra page); the runner seeds one workspace and one server for the whole selected sequence and resets neither between checks (`run.mjs` 134 to 140, 358 to 470); the server's indexer reports the file as an error (`bad-utf8.md: io error: stream did not contain valid UTF-8`) and the next page boots behind the full-viewport preflight cover reading "Build search index failed" (the failing run's screenshot shows it); check 64 finds its editor text mounted behind the cover and proceeds, its local rewrite never reaches the document authority (no `push-ok` and no `conflict` frame in the 66-event timeline), the external write is adopted, and no banner appears. The resource readings of the red and green runs are alike; the order and the fixture, not load, decide the outcome.

The lead's ruling: the suite's fault is check 59's fixture lifetime, repaired in that check (the malformed file scoped to scenario D and removed in a `finally` that runs when D fails too, then a bounded wait on the preflight reading unlocked before the check hands the workspace on), red first as the frozen pair, then both orders, each alone and the pair with a neighbour between; the hygiene seat's task 26. The product's fault behind it is not the suite's to hide: one Markdown file that is not valid UTF-8 leaves the index status at an error and holds the next window behind the cover with its commands dropped. That is the row `idxlock`, now reached with an ordinary file, and its own acceptance asks for a browser arm of its own.

## The commit's home at the v0.106.0 GA 2026-10-15

The commit this item waits on, `7227f11c9b1986dd083eb84cdfeb19ac9598e689` on the seat branch `v0106/hygiene` (not landed on the integration branch), is kept as the patch `dev/v0106-team/evidence/Lead106/ga/carried-patches/chk64o/0001-test-e2e-retire-malformed-file-before-next-browser-c.patch` in the round's bus, which the round's archive carries after the seat branches are deleted at the teardown; it applies on the integration tip `671e49126` (`git apply --check` at the cut).

## Repair verification 2026-10-16

The carried patch was applied as a diff on `e11541f6a8b5f6a0631204fefcc39eb0e55a66cc`. Check 59 scopes `bad-utf8.md` to scenario D, removes it in a `finally`, and waits at most 30 seconds for `/api/preflight` to report `locked: false` before handing the shared workspace to the next check. The malformed-file assertion remains intact, and the evidence records the cleanup wait and returned preflight state. No product file changed. The product fault the cover shows, one malformed Markdown file holding the next window behind the preflight cover, is idxlock's: from this landing until idxlock's browser arm exists no check meets it, and once idxlock lands this wait returns at its first poll and stays as a guard.

Acceptance 1 was reproduced in headless Chrome for Testing 155.0.8059.84 (Blink) in the hygiene guest. At the unpatched base, `SMOKE_SKIP_BUILD=1 SMOKE_ONLY=59,64 node scripts/e2e/browser-smoke/run.mjs` exited 1: check 59 passed, then check 64 failed with `banner never appeared`, `mine=false`, `theirs=true` and `banners=[]`. Its opened-page screenshot shows `Preparing workspace / Build search index / failed / bad-utf8.md: io error: stream did not contain valid UTF-8`. Full log/status: `dev/v0107-team/evidence/Hygiene107/base-pair.{log,status}`; screenshots, timelines and results: `dev/v0107-team/evidence/Hygiene107/browser-output/chk64o/base-pair/`. Both checks ran; neither skipped.

Scenario D also preserves a thrown body error when cleanup fails: one error is rethrown unchanged; simultaneous errors are reported together with both original objects and messages. The constructed probe `dev/v0107-team/evidence/Hygiene107/scenario-d-errors.mjs` exercises success, body-only failure, cleanup-only failure and both failures. The carried implementation failed the last arm (exit 1, `scenario-d-errors-red.{log,status}`); all four arms pass against the corrected implementation at `7ff18e0ed16b1f08f496e50e10f1b2e96d43cc89` (exit 0, `scenario-d-errors-green.{log,status}`). Each arm checks that removal and preflight cleanup run after the attempted open.

Acceptance 2 passes against the harness at `60c7bf76c44da42bf8628d91fe8d0bc7ca04ab92`, using the product binary and bundles built at the unchanged product base. The clean runs are `SMOKE_ONLY=59,64`, `59`, `64` and `59,60,64`, all through `SMOKE_SKIP_BUILD=1 node scripts/e2e/browser-smoke/run.mjs`: exits 0 with respectively 2, 1, 1 and 3 checks and no skips. Their evidence labels are `green-pair`, `alone-59`, `alone-64` and `spaced-pair` under `dev/v0107-team/evidence/Hygiene107/`, each with log, status and before/after cgroup readings. The measured cleanup waits are respectively 1275, 1277 and 1280 ms where check 59 runs, each returning HTTP 200, phase `ready`, `locked: false`.

The reverse order also passes (exit 0, 2 checks, no skips, `reverse-pair`), with check 64 before 59 and a 1020 ms cleanup wait. `SMOKE_ONLY` does not control order; this run uses a temporary adjacent `run-reverse.mjs` whose only change reverses the comparator. Its exact diff and hashes are retained with the browser evidence, the check files remain byte-identical, and the scratch file is removed with the guest clean afterward. This is a recorded runner deviation, distinct from the four clean runs.

The cleanup-dropped mutation at the same harness revision removes only `rmSync(badPath, { force: true });`, keeping the bounded wait intact. The `59,64` run exits 1: check 59 times out with preflight still locked in phase `failed`, then check 64 fails its `banner never appeared` assertion with `mine=false`, `theirs=true`, `disk-theirs=true` and `banners=[]`. Both checks run; neither skips. The mutant diff, hashes, log, status and restoration to a clean guest are retained as `cleanup-mutant`; the full matrix artifacts are under `dev/v0107-team/evidence/Hygiene107/browser-output/chk64o/`. The base pair and the mutant both reach check 64's own failure, rather than relying on the earlier cleanup failure alone.

The whole-suite timing comparison in acceptance 3 remains open for the integrated suite run: the recorded waits state this repair's added work, while the two-CPU guest's nonzero swap and throttling readings make these contended functional runs. The matrix above ran at a harness revision whose check 59 is byte-identical to the item's commit's (sha256 `b23e893be32d97738ec9dc22b1951d1c5336af4ffcf4d0b7ddb00fafd0e9bb9c`), the row text alone differing. At the item's commit the final runs are `final-pair` (exit 0, 2 checks, cleanup wait 1280 ms), `final-alone-59` (exit 0, 1288 ms), `final-alone-64` (exit 0) and `scenario-d-errors-final` (rc 0, 4 arms), each with its log and status under `dev/v0107-team/evidence/Hygiene107/`. Environment and build provenance: `dev/v0107-team/reports/environment-Hygiene107.md` and `dev/v0107-team/evidence/Hygiene107/build-browser-base.{log,status}`.

Acceptance 3 is met by the candidate's whole suite run at `989a76acb` on 2026-10-16 (88 of 88 green, alone in the hygiene guest at 2 CPUs, file order): check 64 ran after check 59 and passed; the run sheet and the duration table under `dev/v0107-team/evidence/Hygiene107/candidate-suite/` hold the times.
