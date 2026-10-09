# The connecting-page hide driver creates its output directory before it measures the path

Status: raised for v0.105.0 by the owner's word of 2026-10-09, from the v0.104.0 release report's follow-ups; written down, not designed, not accepted for build.

## What was seen

The driver for reading 1 of the owner's checklist, `scripts/e2e/desktop-observations/owner-connecting-hide.sh`, takes one argument, a fresh absolute output directory whose path is at most 44 characters. At the released tree it refuses a directory that is relative or already exists with status 3 (lines 43 to 46), then creates the directory (`mkdir -p`, line 48), then calls `obs_setup`, which makes a work directory under it, and only then measures the path and refuses a long one with status 2 (line 58). So a refused over-long path leaves its directory and a work directory behind, and a second call with the same path meets the status 3 refusal before the length is ever measured.

The round's gate runner for that driver did exactly that. `dev/v0104-team/evidence/Desktop104/item10/fixture-gate.sh` (33 lines, sha256 `1321532c7d92c965d6dee0af06fbc38c7552d17e8de69a728c240fe6f5c339c3`) hands the driver one fixed path of 63 characters, `/home/ubuntu/r10/an-output-parent-whose-path-is-far-too-long-01`, wants status 2, and sets its own status to 91 otherwise (lines 22 to 26). Its first run, `run1-fixture-16d011a58` on 2026-10-08, read "driver rc=2 (2 wanted)" with the driver's sentence "at most 44 characters, this one has 63" and ended with status 0. Its second run, `run1-fixture-c7178af66` on the candidate's own binaries (00:28Z to 00:29Z on 2026-10-09), read "driver rc=3 (2 wanted)" and ended with status 91, while the real run of the driver in the same job answered 0: the window hidden on its connecting page stayed hidden through the disconnect and reconnect and reopened with the same id (the two `.log` and `.status` files of those labels in that directory).

The lead read the cause in the guest at 00:29:59Z, within a minute of the run's end (`dev/v0104-team/evidence/Lead104/run1-fixture-c7178af66-long-path-read.txt`): the sub-check's log holds the line "output parent must be a fresh absolute directory", and the long directory exists with a modification time of the first run and a work directory `chan-owner-hide.6rDEwS` inside it. The candidate report records it as a red of the gate runner and not of the driver or the product, with two follow-ups: the driver should measure the path before creating the directory, and the gate runner should use a fresh over-long path per run (`dev/v0104-team/reports/candidate-report-Lead104.md`, "Local candidate acceptance 2026-10-09T00:30:28Z", the paragraph on the side observation). The release report carries it in Follow-ups and names the status 91 among the reds that were kept (`team/release/release-v0.104.0.md`, Follow-ups and Retrospective).

Two facts beside it, read for this item. The driver's released bytes (sha256 `5d4622b01d45cebc0479cd5bf8b7f33e5823fba15b013cd38ae7574b9d55827a`, the same hash the second gate run printed) did give the long-path refusal with status 2 once, in `run1-words-4aa9ba607-b.log`, where a sibling runner, `fixture-words-gate.sh`, builds its long path with the shell's process id and so never reuses one. And the gate runner is not a repository file: it lives in the round's evidence tree, and a listing of the tracked files at the released tree finds the driver and no gate runner for it.

Platform: a Linux guest, the driver's real run on Linux WebKitGTK with debug binaries. The status 2 and status 3 refusals are shell paths that start no desktop.

Not established: whether any other observation driver under `scripts/e2e/desktop-observations/` creates its output before a refusal in the same way (not read for this item); whether the leftover directories of refused runs matter anywhere but in a rerun.

## Desired contract

The driver refuses an unusable output path, too long included, before it creates anything, so a refused call leaves nothing behind and the same refused call answers the same status every time. Whatever gates the driver proves the long-path refusal on a path that no earlier run could have created.

## What to do

Move the length test ahead of the directory's creation in the driver, measuring the same budget from the argument and not from a directory that must exist first, red first with a constructed call made twice on one over-long path. Decide where the driver's gate lives: a repository script beside the driver, or the next round's own runner with the fresh-path rule written into the run sheet. Read the other drivers of the directory for the same order and report what is found before changing them.

## Boundaries

`scripts/e2e/desktop-observations/owner-connecting-hide.sh` and, for the budget's arithmetic, `obs_setup` in `lib.sh`; `OWNER-CHECKS.md` where it states the limit and the statuses. A repository gate for the driver, if one is decided, is a new test file there. Not changed: the reading the driver takes, its steps, its 300-second bound, and its meanings of statuses 0, 1, 2 and 3. No product file.

## Acceptance

1. Called twice in a row with one over-long output path, the driver answers status 2 both times with its sentence naming the limit, and neither call leaves a file or directory; red first on the second call.
2. A relative path and an existing directory still answer status 3, and a usable path still runs the reading; shown at the commit.
3. The gate that proves the long-path refusal uses a path no earlier run created, and its own rerun at one commit answers the same status as its first run.
4. `make shell-check` green at the commit in the owning guest.
5. The record says which other drivers of the directory were read for the same order and what each does.
