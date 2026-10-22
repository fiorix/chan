# No gate runs the browser suite's node tests

Status: raised for v0.109.0 on 2026-10-22 by the lead, from the review seat's reading of the suite runner's commit; closes in the round.

## What was seen

`scripts/e2e/browser-smoke/lib/` holds six `node --test` files (`delay-proxy`, `failure-record`, `hold-proxy`, `program-status`, `runner-dependencies` and `terminal-cut-proxy`) that pin the suite's own helpers and its runner. `make e2e-check` runs `scripts/check-e2e-syntax.py`, which syntax-checks them (Makefile 826 to 833), and `node --test` appears in no Makefile target and no workflow, so none of the five runs in any gate; a broken pin is found only when a seat runs the file by hand. The last needs the suite's `ws`, so the suite's dependencies must be installed from its lock first.

## Desired contract

A Linux gate step installs the suite's dependencies from its lock when the installed tree is absent or stale and runs every test file under `scripts/e2e/browser-smoke/lib/`; a failing pin reddens the gate.

## What to do

One Makefile target that installs the suite's dependencies with the runner's own staleness check (the comparison the runner uses, reached without starting a run) and runs `node --test scripts/e2e/browser-smoke/lib/*.test.mjs`, added to the Linux arm of `make pre-push` beside the other Linux-only steps and named in the gate skill's step list in the same commit; the macOS and Windows arms unchanged (the stand-in `npm` the runner pins use is a shell script). A positive control proves the step: a test made to fail reddens the target, restored and hash-checked.

## Boundaries

`Makefile`, `.agents/skills/gate/SKILL.md`, and a small exported helper in `scripts/e2e/browser-smoke/` if the runner's staleness check is not reachable without a run. Not changed: the test files, the suite's lock, the workflows unless a job runs the target.

## Acceptance

1. The target green at the commit in a guest, with the suite's install from the lock in its log; the positive control red, with the command and log recorded here.
2. `make build-matrix-check`, `make shell-check` and `make workflow-check` green at the commit, and `make pre-push`'s Linux step list in the gate skill naming the step.
