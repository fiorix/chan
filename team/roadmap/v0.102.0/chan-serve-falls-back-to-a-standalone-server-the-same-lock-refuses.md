# `chan serve` falls back to a standalone server that the same lock refuses

Status: raised for a decision on 2026-10-03 by the lead, from the ruling on the handoff socket's answer in [the-add-and-on-answer-a-foreign-lock-two-ways](the-add-and-on-answer-a-foreign-lock-two-ways.md); the owner has not ruled on it. Read in the code; not run.

## Owner ruling

Not ruled.

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
