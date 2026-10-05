# `chan serve` falls back to a standalone server that the same lock refuses

Status: shipped in [v0.102.0](../../release/release-v0.102.0.md).

Record before the release: raised for a decision on 2026-10-03 by the lead, from the ruling on the handoff socket's answer in [the-add-and-on-answer-a-foreign-lock-two-ways](the-add-and-on-answer-a-foreign-lock-two-ways.md). Read in the code; not run. Ruled by the owner on 2026-10-04: accepted for a build in v0.102.0. On 2026-10-04 the serve's end on that refusal was built and the row moved to cut.

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

Two of the three points left above were closed on 2026-10-04, in a range the lead accepted on its report, its status files (its ten reds at their own labels with the guards beside them green, eight series of twenty runs in parallel and on one CPU with no red, the closing gate green over fourteen steps with the symlinked-temp suite and both Windows lines) and an independent review of its whole diff, which found nothing above medium: two mediums, one a descriptor guard not ordered against its own fixture, repaired in the next range, and one ruled a written cost, and twelve lows, in tests and one doc. The pin across processes asserts the last line of stderr and that the fallback's note is absent, where it asserted the whole of stderr, so the line printed after three seconds without a reply cannot red it (`a_devserver_refusal_over_another_process_lock_ends_the_serve`, `crates/chan/tests/serve_devserver_refusal.rs`). The two guards across processes ran under mutations and red at their own labels: with the library's condition removed, the guard of a devserver of another library; with the comparison loosened, the guard of the older lock text. A third mutation, the fallback's note printed first, reds the pin. The doc of the sentence the server exports says that `chan serve` compares a handoff's answer with the whole of it (`WORKSPACE_OPEN_ELSEWHERE`, `crates/chan-server/src/error.rs`). Still left: the two doc comments of `crates/chan-server/src/devserver_handoff.rs`, which say the command falls back on a refusal. Left for the next range, from the review: the pin's two assertions carry one label, so a red does not say which of them failed.

The point the paragraph above leaves was closed on 2026-10-05, in a range the lead accepted on its report, its status files (the mutations of the two close pins, of the descriptor guard and of the window id's bound red at their labels and restored by hash, twenty runs of each close pin and 200 of the descriptor guard in parallel and on one CPU with no red, the closing gate green over fourteen steps with the symlinked-temp suite and the three Windows clippy lines) and its own reading of the diff, with no separate review: the pin's second assertion carries a label of its own, that the serve used a local fallback after the devserver's refusal, so a red says which of the two failed (`crates/chan/tests/serve_devserver_refusal.rs`). Still left: the two doc comments of `crates/chan-server/src/devserver_handoff.rs`. A fallback this item's fix does not reach is recorded, as a cost raised for the owner, on [a-removal-does-not-hold-the-row-it-selected](../v0.103.0/a-removal-does-not-hold-the-row-it-selected.md): a serve handed to a devserver whose mount of that folder was superseded while it ran.
