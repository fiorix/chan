# `chan serve` falls back to a standalone server that the same lock refuses

Status: raised for a decision on 2026-10-03 by the lead, from the ruling on the handoff socket's answer in [the-add-and-on-answer-a-foreign-lock-two-ways](the-add-and-on-answer-a-foreign-lock-two-ways.md). Read in the code; not run. Ruled by the owner on 2026-10-04: accepted for a build in v0.102.0. On 2026-10-04 the serve's end on that refusal was built and the row moved to cut.

## Owner ruling

On 2026-10-04 the owner accepted the row for a build in v0.102.0: when the devserver's handoff refuses the workspace as open in another chan process, and that devserver serves the CLI's own library, `chan serve` prints that answer once and exits 1 instead of starting a standalone server the same lock refuses.

## What was seen

`chan serve` on a workspace asks the local devserver to mount it over the handoff socket. When another chan process holds the workspace's writer lock the devserver refuses, and the command prints that the devserver could not mount the workspace and that it is starting a standalone server (`crates/chan/src/serve.rs`). The standalone open then meets the same lock and exits with a second sentence, which advises `chan serve --devserver`. The user reads two messages for one fact, and the second advises the path that just failed.

## Desired contract

A refusal over another process's lock ends the command with the one sentence every other caller answers for that lock, and no standalone server is tried.

## What to do

The handoff socket's answer would have to say which refusal it is, so that the command stops at this one and still falls back on the others. That changes the wire between a command and a devserver that can be of two versions, which is why it is not part of the foreign lock's row.

## Boundaries

The fallback to a standalone server stays for every other refusal and for a devserver that does not answer.

## Acceptance

1. With the workspace held by another chan process and a local devserver running, `chan serve` prints the one sentence, starts no standalone server and exits non-zero; pinned red first.
2. A command of this version against a devserver of v0.101.0, and the reverse, do what v0.101.0 does; pinned or read, and said.

## What shipped

Built on 2026-10-04 on the v0.102.0 integration branch and not on `main`, in a range the lead accepted on its report, its status files (each of its three behaviour changes red first at its own assertion at a committed sha, fifteen mutations restored by hash, its two pins across processes at twenty runs each with no red and one of them at twenty more on one CPU, the own gate green at the tip) and an independent review of its whole diff, which found nothing above medium, its three mediums sent to the next range, two as repairs and one as a cost to write. This record was written that day from those.

When a local devserver that serves the command's own library refuses a workspace because another chan process holds it, `chan serve` prints `Error: This workspace is open in another chan process. Quit it and try again.`, starts no standalone server and exits 1 (`devserver_registration_action`, `crates/chan/src/serve.rs`). The handoff's answer is unchanged: the command compares it, whole, with the sentence every other caller answers for that lock, which `crates/chan-server` exports as `WORKSPACE_OPEN_ELSEWHERE`, and only for a devserver whose library root is its own. Every other refusal, a version skew and a devserver of another library fall back to a standalone server as before, and a reply that times out or is lost exits 1 as before. Pinned red first across processes, against a stand-in that speaks the handoff's protocol on the real discovery listener beside a recorded writer lock: before the fix the command printed its fallback note and then the standalone refusal that advises `chan serve --devserver`. Six mutations red their pins at the pins' own labels.

Acceptance 2 is pinned in one direction and read in the other. This command against the answer a v0.101.0 devserver gives for the lock, `chan-workspace: workspace is locked by another process`, falls back as v0.101.0 does, held by a guard on that text with no second binary. A v0.101.0 command against this devserver wraps the devserver's sentence in its fallback note, then its standalone open meets the lock and exits 1: read in the release's source, not run.

Costs, written: a holder that lets the lock go between the devserver's refusal and the command's end is not retried, and the next `chan serve` registers; the sentence is the signal, so a rewording on one side alone restores the fallback and never a wrong end. Left outside the acceptance, for later ranges: two doc comments in `crates/chan-server/src/devserver_handoff.rs` still say the command always falls back; the two guards across processes, for a devserver of another library and for the older text, were run under no mutation; and the pin across processes asserts the whole of stderr, which the line printed after three seconds without a reply would red. The row moved to cut.
