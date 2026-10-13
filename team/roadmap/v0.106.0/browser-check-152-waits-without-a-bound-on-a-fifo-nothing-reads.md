# Browser check 152 waits without a bound on a FIFO nothing reads

Status: raised by the hygiene seat on 2026-10-13 from a hang of its whole browser run at two CPUs (`followups/followup-Hygiene106-Lead106-38.md` in the round's bus); written down the same day by the lead as a row of its own; owner the frontend seat; the repair ordered in the v0.106.0 round

## What was seen

In the whole browser suite at the integration commit `ea4b04f18`, in a guest capped at two CPUs, the run reached check 152 as its 46th check and made no further progress for several minutes, until the seat ended the run's own timeout (`evidence/Hygiene106/stalls-2cpu-1/whole-2.log`). The check has each subject terminal run a Python program that opens a named FIFO in the workspace and waits for a line before it prints its status sequence; the check then releases it with `await writeFile(<fifo>, "go\n")` (`scripts/e2e/browser-smoke/checks/152-program-exit.mjs` 27 to 28) and only after that enters its bounded wait. Opening a FIFO for writing blocks until a reader has it open, and that open has no deadline: with no reader the check never reaches its own 30-second bound, and the suite's runner waits with it. In the guest the FIFO existed and no such Python process was running.

Not established at this writing: why the reader was absent (the guest's environment, or a reader that started and went away); the seat reads that next. Whether the same shape is in the suite's other FIFO-released checks.

## Desired contract

A check that releases a program through a FIFO fails with its own message within a stated bound when nothing reads the FIFO, and says that the reader was absent; it does not hang the suite. A missing interpreter is a refusal the runner reports as the environment's, not a pass and not a hang.

## What to do

Repair the check, test only: bound the release (an open that does not block, retried to a deadline, or the write raced against a timer), with a failure sentence that names the absent reader; before the release, confirm the reader program started where the check can observe it. Search the suite's other checks for the same unbounded release and report each. Show the repaired check red within its bound when the reader is absent (the interpreter hidden from the subject terminal's path in a guest), and green alone at the commit.

## Boundaries

`scripts/e2e/browser-smoke/checks/152-program-exit.mjs` and, if the release is shared, the helper it calls under `scripts/e2e/browser-smoke/lib/`. Not changed: the program status feature and its server route.

## Acceptance

1. With no reader the check fails on its own sentence within its stated bound; shown.
2. The check green alone at the commit in the owning guest.
3. The other checks that release through a FIFO are listed with what each does when nothing reads.
