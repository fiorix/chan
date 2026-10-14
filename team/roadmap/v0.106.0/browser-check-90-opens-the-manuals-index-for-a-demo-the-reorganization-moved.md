# Browser check 90 opens the manual's index for a demo the reorganization moved

Status: raised by the lead on 2026-10-13 from the candidate's browser suite in the hygiene guest (`tasks/task-Hygiene106-Lead106-48.md` in the round's bus); written down the same day as a row of its own; owner the frontend seat; not reached in the v0.106.0 round

## What was seen

Check 90 (`scripts/e2e/browser-smoke/checks/90-launcher-gateways.mjs`) opens `/manual/` and waits thirty seconds for `#launcher-demo.mounted` on that document (line 104) before it drives the Computers to Gateways flip. At v0.105.0 the manual was one page, `web/packages/marketing/src/pages/manual.html`, with the launcher demo mounted inline (its line 31) and the devserver demo in an iframe; the manual's reorganization into guides (`f0901774a`, on `main` on 2026-10-11, in the round's base `4507fe5a0`) moved the inline mount to `pages/manual/install.html` (`/manual/install/`) and left `/manual/` without it. The check was green at v0.105.0's candidate (its report: 82 of 82, zero skips) and skipped in every run of this round until the candidate's suite, where the marketing dist was built for the first time: red whole (30.6 s) and alone (30.5 s) at `e0e21f400` on that first wait, with one `404` on `POST /api/library/command-capabilities` logged before it (the demo bundle's call against the suite's workspace server, which serves no library route; a page error, not the cause of the wait, which is the element's absence). No commit of the round touches the check, `launcher-demo.ts`, `pages/manual.html` or `pages/manual/install.html` (an empty diff between `4507fe5a0` and `f3014d84b` for the four; two commits of the round touch the marketing package elsewhere, the `--sleep` flag's manual text). At the second candidate `f3014d84b` the check went red the same way whole and alone, 30.4 to 30.6 s on the same wait over the four attempts at the two candidates. Not established: whether the check's later waits (`.topbar button.title-toggle`, the flip's turn) hold on `/manual/install/`; whether the `404` is new since v0.105.0.

## Desired contract

The check opens the page that holds the demo it drives, and a reorganization that moves the demo turns the check red at the next run with the dist present rather than leaving it skipped for a release.

## What to do

Point the check at the page that holds the `data-variant="empty"` mount (`/manual/install/` at the candidate), read its later waits against that page, and run it alone and in the whole suite with the marketing dist built. Then the lead decides whether a whole run that selects the check and finds no dist reports a skip the gate's reader counts, since the skip hid this for a release.

## Boundaries

`scripts/e2e/browser-smoke/checks/90-launcher-gateways.mjs` and, if the decision takes it, the runner's skip reporting. The marketing pages are not changed for the check.

## Acceptance

1. Check 90 green alone and in the whole suite with the marketing dist present, at one commit, on the page that holds the demo; the four red attempts at `e0e21f400` and `f3014d84b` kept beside it.
2. The decision on the skip's reporting recorded here.
3. The suite's lints green at the commit.
