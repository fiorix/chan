# The browser suite's runner keeps a stale install over a moved lockfile

Status: raised for v0.109.0 on 2026-10-21 by the lead, from the review seat's reading of the integrated suite's stack traces; closes in the round.

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
