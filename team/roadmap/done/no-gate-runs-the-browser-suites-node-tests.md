# No gate runs the browser suite's node tests

Status: shipped in [v0.109.0](../../release/release-v0.109.0.md).

Record before the release: built on 2026-10-22 on the seat's branch; the section Built 2026-10-22 holds the evidence; it closes at the GA as shipped.

Record before the build: raised for v0.109.0 on 2026-10-22 by the lead, from the review seat's reading of the suite runner's commit; closes in the round.

## What was seen

`scripts/e2e/browser-smoke/lib/` holds six `node --test` files (`delay-proxy`, `failure-record`, `hold-proxy`, `program-status`, `runner-dependencies` and `terminal-cut-proxy`) that pin the suite's own helpers and its runner. `make e2e-check` runs `scripts/check-e2e-syntax.py`, which syntax-checks them (Makefile 826 to 833), and `node --test` appears in no Makefile target and no workflow, so none of the six runs in any gate; a broken pin is found only when a seat runs the file by hand. The last needs the suite's `ws`, so the suite's dependencies must be installed from its lock first.

## Desired contract

A Linux gate step installs the suite's dependencies from its lock when the installed tree is absent or stale and runs every test file under `scripts/e2e/browser-smoke/lib/`; a failing pin reddens the gate.

## What to do

One Makefile target that installs the suite's dependencies with the runner's own staleness check (the comparison the runner uses, reached without starting a run) and runs `node --test scripts/e2e/browser-smoke/lib/*.test.mjs`, added to the Linux arm of `make pre-push` beside the other Linux-only steps and named in the gate skill's step list in the same commit; the macOS and Windows arms unchanged (the stand-in `npm` the runner pins use is a shell script). A positive control proves the step: a test made to fail reddens the target, restored and hash-checked.

## Boundaries

`Makefile`, `.agents/skills/gate/SKILL.md`, and a small exported helper in `scripts/e2e/browser-smoke/` if the runner's staleness check is not reachable without a run. Not changed: the test files, the suite's lock, the workflows unless a job runs the target.

## Acceptance

1. The target green at the commit in a guest, with the suite's install from the lock in its log; the positive control red, with the command and log recorded here.
2. `make build-matrix-check`, `make shell-check` and `make workflow-check` green at the commit, and `make pre-push`'s Linux step list in the gate skill naming the step.

## Lead's rulings 2026-10-22

- R1, ruled by the lead, 2026-10-22, in the task: `run.mjs` takes `--deps-only`: read after the dependency prelude's Puppeteer version line (so the slice the runner-dependencies test cuts, from the `// Self-install harness deps` marker to the `const { default: puppeteer }` line, stays byte for byte as it is), it ends the process with status 0 once the install check has run, before any server, browser or check starts; with the install's own failure the runner exits non-zero as today.
- R2, ruled by the lead, 2026-10-22, in the task: `browser-smoke-lib-test` in the Makefile beside `browser-smoke-deps`, `$(LINUX_ONLY)` first, then `node scripts/e2e/browser-smoke/run.mjs --deps-only`, then `node --test scripts/e2e/browser-smoke/lib/*.test.mjs`; every `*.test.mjs` under `lib/` joins the step without a Makefile edit. Added to `pre-push`'s first Linux `ifeq` block after `sdme-contract-check`. The task's refusal text named `make ci-linux`; the lead ruled the same day that the shared macro's `make ci-macos` and `make ci-windows` messages stand.
- R5, ruled by the lead, 2026-10-22, in the task: `.agents/skills/gate/SKILL.md`: a new step after step 4 in the numbered list, the later steps renumbered and every `step N` reference in the file moved with them. The section `The browser smokes are outside the gate, deliberately` gains one sentence saying the suite's own node tests are the exception, run by that step.

## Built 2026-10-22

At `9138800e759b6f07018d33991c048a94ef12ca21`, `scripts/e2e/browser-smoke/run.mjs` exits on `--deps-only` after the existing locked-tree check, Puppeteer version line and Puppeteer import, before its other dynamic imports, server and browser setup. The dependency prelude between the test's two markers is byte for byte unchanged from base `cba78eaa45137add06e76521314c4f38234a562d`: 1,748 bytes with SHA-256 `a31e8de5aba2ac6650b07dae63b13db51b3d130bfad48f4f4112d15e9a418294` at both commits (`dev/v0109-team/evidence/Hygiene109/nodtst/final/prelude-control.txt`). `runner-dependencies.test.mjs` therefore exercises the same install logic. `Makefile` has the Linux-only `browser-smoke-lib-test` target beside `browser-smoke-deps` and calls it after `sdme-contract-check` in the first Linux `pre-push` block. The target runs the runner's check and the `lib/*.test.mjs` glob; the README names the flag, and the gate skill names the step as number 5 and keeps browser checks outside the gate.

Acceptance 1: in `chan-v0109-hygiene` at the committed SHA, `make browser-smoke-lib-test` returned 0 twice over the five files at this branch tip, with 47 passed and 0 failed each time. `dev/v0109-team/evidence/Hygiene109/nodtst/final/target-first.log` shows `[smoke] installing harness dependencies...`, npm's install output, and `# pass 47` / `# fail 0`; `final/target-second.log` shows no install line and the same test result. The five files are in `final/test-files.txt`; the integrated branch also has `hold-proxy.test.mjs`, so the lead's landing gate proves the sixth file there under the same glob. A single assertion at `scripts/e2e/browser-smoke/lib/failure-record.test.mjs:62`, in "a noisy check still retains its final failure within the event bound", was flipped to expect `mutated final failure`; `make browser-smoke-lib-test` returned 2 with `not ok 3`, 46 passed, `# fail 1` and Make's nonzero result in `final/red-control.log`. The test file was restored from the committed blob and matched SHA-256 `8f1ada1fc8dbdb2f5f3f32e09c653392d315ef9c93490259a207461fb2b3ad77`. With the installed-tree record's Puppeteer version set to `0.0.0`, `node scripts/e2e/browser-smoke/run.mjs --deps-only` returned 0 and installed once (`final/deps-stale.log`); with the current record it returned 0 and installed nothing (`final/deps-current.log`).

Acceptance 2: at the same committed SHA, `make build-matrix-check`, `make shell-check`, `make workflow-check` and `make e2e-check` each returned 0 in `final/<target>.status`, with logs beside them; `make e2e-check` syntax-checked 156 files. `.agents/skills/gate/SKILL.md` lists the new Linux gate step after the sdme contract and numbers the later steps 6 through 21. Simulated Darwin and Windows invocations of the new target each returned 2 before Node started, naming `make ci-macos` and `make ci-windows` respectively, through the shared `LINUX_ONLY` macro (`final/linux-guard-*.log`). The guest source and owning worktree were clean after the checks. An earlier target-pair evidence wrapper at the superseded tip returned 1 because this guest has no `rg`; both target invocations inside it returned 0, and the corrected judge returned 0. That wrapper failure remains under `dev/v0109-team/evidence/Hygiene109/nodtst/guest/`, separate from the final tip's results. All final-tip guest logs and statuses are in `dev/v0109-team/evidence/Hygiene109/nodtst/final/`; `final-evidence.tar` has SHA-256 `7968d6378d8a2a4bd0b4386455ed05d1708fa29958649bcdb13c44e2e5953732`.
