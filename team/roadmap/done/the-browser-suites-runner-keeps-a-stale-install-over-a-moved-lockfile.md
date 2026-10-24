# The browser suite's runner keeps a stale install over a moved lockfile

Status: shipped in [v0.109.0](../../release/release-v0.109.0.md).

Record before the release: built on 2026-10-22 on the seat's branch; the section Built and verified on 2026-10-22 holds the evidence; it closes at the GA as shipped.

## What was seen

`scripts/e2e/browser-smoke/run.mjs` 38 to 45 installs the suite's dependencies only when `node_modules` is absent, with `npm install`. A checkout whose suite directory already holds an install keeps it when the suite's lockfile moves: the lead's whole run at the integrated tip that carries the suite's move to Puppeteer 25 ran Puppeteer 24, which its stack traces show (`node_modules/puppeteer-core/lib/esm/puppeteer/...`, 24's layout; 25 ships `lib/puppeteer/...`), and the run's log names no version. The run was evidence for the product under Puppeteer 24, not for the commit's own lock.

## Desired contract

A run of the suite uses the dependencies its lockfile names: the runner installs with the strict `npm ci` when `node_modules` is absent or its recorded tree differs from the lockfile, and every run's log names `puppeteer-core`'s installed version.

## What to do

In `run.mjs`, compare the lockfile with `node_modules/.package-lock.json` (or the installed `puppeteer-core` version with the lock's) and run `npm ci --no-audit --no-fund` when they differ or the directory is absent; print the installed `puppeteer-core` version in the run's header. Pin red first: a constructed suite directory with a stale `.package-lock.json` makes the runner install, and one with a matching one does not, under a stand-in `npm`; the version line present in a run's log.

## Boundaries

`scripts/e2e/browser-smoke/run.mjs` and its README. Not changed: the checks, the lockfile.

## Acceptance

1. The constructed pins red at the parent and green at the commit, with the commands and logs recorded here.
2. A whole run's log at the commit names the installed `puppeteer-core` version equal to the lock's.

## Built and verified on 2026-10-22

The browser runner is committed as `1b292adb50bd4d3ef3adf0a1d2daa8f8cfdb8d00` and `81a95eae0613d197464ab10f869657a16c797923` over `4b8db0eb17ca138c019c528d9b4f264486024613`. Before a run it compares the suite lock's resolved package key set and versions with `node_modules/.package-lock.json`, reads each direct package's installed manifest, uses `npm ci --no-audit --no-fund` when the tree is absent or differs, and prints the installed `puppeteer-core` version before the first check. The README describes that contract; the suite lockfile and browser checks are unchanged.

The nine constructed Node pins execute the runner's installation prelude against a suite fixture and a stand-in `npm` that refuses every argument list except `ci --no-audit --no-fund`. At the original parent `4b8db0eb1`, the first five pins returned 1 (1/5): stale Puppeteer, absent tree, stale `ws` and missing header failed their assertions. At repair parent `9a0c133fc`, the nine pins returned 1 (8/9): the stale transitive record failed its assertion; the three new record, package and missing-record pins passed because their guards already existed. At the repair commit all nine passed. Five mutations, restored and hash-checked separately, returned 1 on their intended pins: dropping the record comparison failed the stale transitive and stale direct record pins; dropping the direct manifest check failed the stale installed package pin; returning true from the catch failed the missing-record pin; inverting the comparison failed seven pins; dropping the version header failed its pin. One guard has no pin: the key-count comparison alone catches a record key the lock lacks, and no fixture holds an extra record key, so a mutant that drops it passes all nine. After a strict `npm ci` of the suite the runner finds the tree current and installs nothing.

Evidence paths below are under `dev/v0109-team/` in the round's bus.

At the clean committed guest checkout, `node --test scripts/e2e/browser-smoke/lib/runner-dependencies.test.mjs` returned 0 (9/9), `make e2e-check` returned 0, and `npm ci --strict-peer-deps --no-audit --no-fund --prefix scripts/e2e/browser-smoke` returned 0. `make e2e-check` syntax-checks the Node test but does not execute it, so the direct `node --test` command is the behavioral gate. The strict install's recorded versions were lock 25.15.0, npm installed-tree record 25.15.0, and installed `puppeteer-core` package 25.15.0. Gate, pin and mutation logs with raw status files are under `evidence/Hygiene109/bsinst/guest-repair/bsinst-repair/`; the first commit's pin logs are under `evidence/Hygiene109/bsinst/guest/`. Both whole-run logs at `1b292adb5` print `[smoke] puppeteer-core=25.15.0` before the first check, meeting the version assertion of acceptance point 2.

The first whole run at `1b292adb5` recorded raw `smoke_rc=1`, 95 checks, zero skips and three failures. Check 122 lacked the echo fixture because this invocation set `CHAN_BIN` to `/home/ubuntu/target/debug/chan` without its corresponding `CHAN_ECHO_EXTENSION_BIN`; check 165 asserted 14.67px for the Google Docs theme and read 16px in 22 cases; check 177 timed out at the 10-second wait for the reopened Rich Prompt card to contain `kept draft` (`checks/177-rich-prompt-chrome.mjs:112`). The corrected whole run set both binary paths and recorded raw `smoke_rc=1`, 95 checks, zero skips and three different failures: check 133 timed out waiting for the Save to Workspace path input (`lib/drafts.mjs:374`); check 163 exceeded the graph fetch bound after directory bursts; check 170 waited for a status pill to leave while it still read `reindexing fbroot163-mviskvd6-fill-06.md`. Checks 122, 165 and 177 passed in the corrected run. Both full logs, results files, failed-check timelines, cgroup samples and status files are under `evidence/Hygiene109/bsinst/`. Check 122 failed for the invocation's missing fixture path. Check 165 lost its theme part-way: the check sets `data-editor-theme` by hand and the app writes its stored theme back when the workspace preferences change, so its readings after the first two were the other arm's; its own row repairs the check. Check 177 is the Rich Prompt reopen race at a tree without its repair. Check 163 ran under I/O pressure (io full up to 22 percent) and is the known load-sensitive check; check 170 ran while the guest was stalled on I/O (io full up to 49 percent with idle CPU) and also raises its pill while the indexer's section shows, repaired with check 165's row. Check 133 is unexplained and is watched at the freeze. None of these erases either attempt or the installed-version proof.
