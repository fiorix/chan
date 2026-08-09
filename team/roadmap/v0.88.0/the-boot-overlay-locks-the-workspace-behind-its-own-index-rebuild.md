# The boot overlay locks the workspace behind its own index rebuild

Status: REGISTERED 2026-08-09 during the v0.87.0 delivery round, as the stricter reading of
one contract line in
[gitignore-write-strands-the-workspace-in-recovering](gitignore-write-strands-the-workspace-in-recovering.md).
Considered and deliberately not taken inside that item; registered so the alternative is
not lost.

## What

While a recovery pass runs, the boot overlay locks and the workspace is unusable. That is
correct-by-design for a pass that is progressing, and it was the only sane behaviour while
a stalled pass and a running pass were indistinguishable — which is the defect the
`gitignore-write-strands-the-workspace-in-recovering` item fixes.

Once a stalled pass is distinguishable from a running one, the question reopens: should a
**running** pass lock the workspace at all? A reconcile over a large tree is not
instantaneous, and everything the user wants to do meanwhile — read a file, use a terminal,
edit — needs no index. Only search does.

The narrower reading of that item's contract line ("a workspace never presents a locked
boot overlay for a recovery pass that has no worker assigned to it") is satisfied by making
every parked pass have a worker, which is what shipped. This item is the wider reading:
do not lock at all, report the pass non-blockingly, and let the user into the workspace
with an index that is briefly stale.

## Why it was not taken in that item

Scope and surface. The delivering lane owned `crates/chan-workspace/src/workspace.rs`,
`crates/chan-server/src/indexer.rs`, and `crates/chan-server/src/routes/preflight.rs`. The
non-blocking form needs a new field on the preflight snapshot and a component to render it
in `web/packages/workspace-app/`, which was another lane's surface in that round.

What shipped instead is strictly better than the prior behaviour under either reading: the
stall is stated rather than silent, and it carries a `needs_decision` step offering
"Rebuild the search index" — an escape that previously existed only as an out-of-band
`POST /api/index/rebuild` with a token dug out of the devserver config.

## Contract

- A recovery or index pass that is progressing normally does not make the workspace
  unusable.
- The user can tell, without acting, that the index is rebuilding and that search results
  may be incomplete until it finishes.
- Search behaviour during a stale window is defined rather than incidental: it either
  serves partial results and says so, or declines and says why.

## Acceptance

- With a recovery pass in flight over a workspace large enough for it to be observable, the
  editor, terminal, and file tree are usable and the overlay is not locked.
- The rebuilding state is visible without opening anything.
- A stalled pass — one with no claimant — remains distinguishable from a running one, and
  does not regress to the pre-v0.87.0 behaviour where the two rendered identically.

## Rough size

Small to medium, and mostly frontend. The server side is one field on the preflight
snapshot; the workspace app needs a non-blocking indicator and a decision about what search
does while the index is stale, which is the part worth thinking about rather than the
plumbing.
