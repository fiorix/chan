# The boot overlay locks the workspace behind its own index rebuild

Status: REGISTERED 2026-08-09 during the v0.87.0 delivery round, as the stricter reading of
one contract line in
[gitignore-write-strands-the-workspace-in-recovering](../done/gitignore-write-strands-the-workspace-in-recovering.md).
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

> **This estimate was wrong on its central claim and is left standing because the error is
> instructive.** The server side is **not** one field; it is a deletion — see
> [The server side turned out to be no field at all](#the-server-side-turned-out-to-be-no-field-at-all-it-was-a-deletion).
> A reader stopping here takes away the opposite of what this item concluded. The rest of
> the estimate held: it was small-to-medium and mostly frontend, and the search decision
> was indeed the part worth thinking about.

## Implemented 2026-08-10, v0.88.0 round

### The premise was checked, not assumed

The item asserts that only search needs the index. That is load-bearing for the whole
change, so it was verified rather than read:

```
grep -rn "readiness()\|is_ready()" crates/chan-server/src/routes/*.rs
```

Every hit outside `preflight.rs` lands in `search.rs`. No file, doc, terminal, graph or
fs route consults `WorkspaceReadiness` at all. Unlocking therefore hands back a genuinely
usable workspace, and content search is the only degraded surface.

### The server side turned out to be no field at all. It was a deletion.

The item predicted "one field on the preflight snapshot", and the round brief repeated
the prediction. Both were wrong, and the wrong prediction is recorded here rather than
quietly matched.

A `blocking: bool` on `PreflightStep` was drafted first and discarded: it would have been
fully determined by `state` at every call site, for the index step and the model step
alike, so it carried no information and would have left the next reader believing a
choice was being made where none was.

What shipped is smaller. `Phase::Running` is **deleted**, and the phase derivation
collapses to:

```rust
let phase = if any Failed        { Failed }
       else if any NeedsDecision { NeedsDecision }
       else                      { Ready };
```

The two arms removed from between them -- `!readiness.is_ready() => Running` and
`all steps Done => Ready, else Running` -- *were* the lock. With them gone `Phase::Running`
has no producer, so leaving it in the enum would be a lint suppression plus a lie in the
type; `phase: "running"` disappears from `GET /api/preflight` and from `PreflightPhase` in
`web/.../api/types.ts`.

This is what makes the contract structural rather than conditional. A flag holds only
while every call site keeps setting it correctly; with the variant deleted there is no
phase in which the boot waits on an index pass, so an innocent-looking edit cannot flip
the contract back. One primitive with two call sites, one wired and one not, is the exact
failure shape this lineage keeps repeating -- it is how `refresh_repository_scope` and
`set_excluded_dirs` came to differ in
[gitignore-write-strands-the-workspace-in-recovering](../done/gitignore-write-strands-the-workspace-in-recovering.md).

The one field that *was* needed is client-side: the server has always serialized
`readiness` on the snapshot, but `api/types.ts` never modelled it, so the SPA could not
see it.

### What search does while the index is stale: it declines, and says why

Chosen deliberately, and the argument is recorded because it is the durable half.

The behaviour was **already** decline. `routes/search.rs:202` and `:225` both return
`ready:false, hits:[]` for any `!readiness.is_ready()`, once before the search and once
after to guard a mid-flight transition, and `web/.../api/client.ts:243-252`
(`readContentSearch`, the "Contract-5 decision boundary") re-asserts it client-side. The
defect this item names was never that the behaviour was wrong; it was that the behaviour
was **enforced but never stated**, which is exactly the "incidental" the contract
objects to. Stating it is the fix.

Serving partial results was rejected on its merits, not only on scope. **A reconcile's
delta is unbounded in both directions**: it drops files that no longer exist and adds
files that do, so stale hits can point at paths that are gone while real files the pass
has not reached are missing. "Some results, possibly wrong, with no way to tell which" is
a worse contract than "no results, and here is why". It would also have meant editing
`routes/search.rs` and moving a documented boundary other consumers read `ready` from,
which is not the "small to medium, mostly frontend" this item scoped.

Serving partial BM25 results behind a staleness banner remains the better long-run answer
for the common case, and is registered separately as a candidate for a later version.

### Saying why, in the place the user is standing

Four surfaces rendered this state and all four named the state rather than its
consequence, in wording that reads like data loss and says nothing about search. Four
different sentences for one condition was the actual user-facing bug:

| surface | before | after |
| --- | --- | --- |
| `SearchPanel.svelte` | `workspace recovering - content search not ready` | `rebuilding search index - content search is paused until it finishes` |
| `AppStatusBar.svelte` | `workspace recovering` | `rebuilding search index` + muted `search paused` |
| `EmptyPaneCarousel.svelte` | `workspace recovering...` | `rebuilding search index...` |
| `editor/bubbles/empty_state.ts` | `Workspace recovering...` / `search is not ready yet` | `Rebuilding search index...` / `content search is paused until it finishes` |

Each names the cause, the consequence, and that it clears itself without the user acting,
which is the whole of what the contract's "says why" asks for.

`GraphPanel.svelte` carries a fifth `workspace recovering…` string and was deliberately
**left alone**: its cue warns that dead-end "missing" graph nodes may simply be unindexed,
so its consequence is the graph rather than search, and renaming it to talk about search
would make it wrong. It is noted here so the inconsistency is a recorded decision rather
than an oversight.

### A named consequence of the phase change, so it is not "simplified" back

`summary` was attached whenever `phase == Ready`, and the first-run onboarding nudge gates
on `summary.indexed_docs > 0`. Once `Ready` started arriving *during* a rebuild, an
established workspace mid-full-rebuild could read `indexed_docs: 0` and be shown the
first-run nudge it dismissed long ago.

So `phase == Ready` is no longer sufficient for the summary; `PreflightSnapshot::is_settled()`
(`phase == Ready && readiness.is_ready()`) gates it. That in turn forces the overlay to
keep polling **past** unlock until settled, because it previously stopped at
`phase === "ready"` -- without both halves the nudge would never arrive at all for a
workspace that booted into recovery. The two changes are a pair; removing either one alone
reintroduces the bug in a different place.

### End-to-end reconciliation before close

This item accreted its Implemented sections across a round, each written against the
file's state at that moment and none against the whole. Read end to end at close, three
things needed reconciling and one needed correcting. Recorded rather than silently
smoothed, because a reader deserves to know which of these sections were written before
the answer was known.

**1. "Rough size" asserts a fact this item later disproves.** Corrected in place above
with a forward pointer, not deleted. The server side is a deletion, not a field.

**2. The Contract's second line presumes the branch that was not taken.** It reads:

> The user can tell, without acting, that the index is rebuilding **and that search
> results may be incomplete until it finishes.**

"Incomplete" presumes partial results. What shipped **declines** — content search returns
nothing and says so — so the honest rendering of that line is that the user can tell the
index is rebuilding and that **content search is paused** until it finishes. The contract's
intent is met (the user learns, without acting, that search is affected and that it clears
itself); its wording anticipated the other branch. The wording is left as written because
it records what was expected at registration, and this paragraph records what was
delivered instead.

**3. Acceptance status, stated per line rather than as a whole.**

| line | status |
| --- | --- |
| editor, terminal and file tree usable with a pass in flight; overlay not locked | **established by test, NOT yet demonstrated live** — `recovery_with_a_claimant_does_not_lock_the_workspace` asserts `phase: Ready` / `locked: false` under `readiness: recovering`; the human-visible demonstration over a large tree is prepared and has not run |
| the rebuilding state is visible without opening anything | **by construction, not yet demonstrated live** — the status-bar index pill renders whenever `indexStatus` is non-idle and now names the consequence; no interaction is required to see it |
| a stalled pass stays distinguishable from a running one | **established** — `a_stall_and_a_running_pass_never_collapse_together`, one test over two workspaces differing only in whether a driver claimed the pass, asserting `phase` **and** `locked` both differ |

**The first two acceptance lines are the ones this item exists for, and neither has been
demonstrated against a running workspace at the time of writing.** The code is gated and
the behaviour is asserted by unit test; that is not the same as a human seeing an unlocked
workspace during a live reconcile. If this item closes without that demonstration, its
status line must say so in those words rather than reporting the tests as if they were the
demonstration.

**4. What no section of this item establishes.** Search declining during a stale window is
now *stated*, but the decision to keep declining rather than serve partial results is
registered separately as a candidate for a later version, and nothing here should be read
as having settled that question on the merits for all time. It was settled for this round,
on this surface, for the reasons given above.
