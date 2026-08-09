# Audit the workarounds nobody followed up

Status: REGISTERED 2026-08-09 during the v0.87.0 round, from the mechanism behind that
round's most consequential defect. Not implemented, and deliberately not run in the round
that proposed it.

## What

A resolved obstacle stops being information. Someone hits a problem, works around it locally,
and the workaround closes the matter — so nobody asks the second question: **what else
assumes the thing that was just worked around?**

That is not a hypothesis. It is how `mtime-cas-silently-overwrites-external-edits` survived
three releases:

| workaround | where | what it assumed |
| --- | --- | --- |
| spin until the mtime advances, capped at 200 ms | `crates/chan-workspace/src/workspace.rs:7221` | mtime does not reliably advance |
| `std::thread::sleep(Duration::from_millis(20))` | `crates/chan-server/src/doc_sessions/mod.rs:2914` | same |
| clear `flushed_mtime_ns` before the reconcile | v0.82.0, `done/parallel-suite-flake-hygiene.md` | same |

Three engineers, three surfaces, three releases. Each one **had the finding** — every
workaround is an author writing down that mtime cannot be trusted — and each treated it as a
local nuisance. The thing that also assumed mtime advances was `write_text_if_unchanged`,
the compare-and-swap protecting a user's file from being clobbered. It was a silent
data-loss path the whole time.

Two smaller instances from the same round, both in tooling: a 96G `fallocate` that fixed one
disk problem and caused another because nothing re-checked what else lived on that
filesystem, and a `2>/dev/null` added to silence a symlink error that then hid a
one-entry-in-1867 coverage gap in the check it was silencing.

## Why an audit rather than a discipline

The prospective form — "when you work around something, ask what else assumes it" — is
correct and will be in the playbook, but it fires only if the author remembers at the moment
of the fix, which is exactly when they are focused on something else. All four instances
above were committed by people who would have agreed with the rule.

The retrospective form does not need anyone to remember, because **a resolved obstacle
leaves a signature in the tree**: sleeps, spin loops, retry counts and `ATTEMPTS`
constants, `2>/dev/null`, `|| true`, pinned or capped waits, and `safe.directory`-style
environment patches. Those are greppable. The unjoined set can be enumerated instead of
waited for.

A first census over `crates/chan-workspace/src/` gives roughly 43 candidate sites (18
sleeps, 10 retry/attempt constants, 15 loops), which is a tractable read rather than a
project.

## Contract

- Every workaround site in the audited surface has been asked the second question, and the
  answer is recorded.
- A site whose assumption is also relied on somewhere else is registered as its own item at
  its own severity, following the CAS precedent, rather than being repaired in place.
- The audit records what it checked and found clean, not only what it found. A list of hits
  with no denominator is the completeness claim this project keeps re-learning not to write.

## Acceptance

- A recorded pass over the signature population in `crates/chan-workspace/src/`, each site
  marked: assumption named / assumption named and shared elsewhere / not a workaround.
- The greps that produced the population are written into the item so they can be re-run,
  and their known blind spots are stated — a lexical search cannot see a workaround with no
  keyword, which is the same bound the timing sweep had to state.
- Any shared assumption found is registered, not silently repaired.

## The question to ask at the dependent site

A workaround comment explains why *that* code is odd. It does not reach the code that
*relies* on the assumption, and that is where the defect lives. All three mtime workarounds
carried comments; none of them sat at `write_text_if_unchanged`.

But "the dependent site had no note" is too weak a diagnosis here, because it did. Its
docstring named the silent-overwrite failure precisely, asserted that nanosecond resolution
solved it, and called the coarse-mtime remainder a graceful degradation — conflating a
nanosecond mtime *field* with a nanosecond *clock*. Every later reader arrived at a site that
said the problem was handled.

So the audit's question at a dependent site is not "is the assumption recorded?" but:

> **Is what is recorded here still true, and was it ever tested?**

An absent note invites a question. A confident wrong one closes it, which is worse, and it is
the specific reason this defect outlived three workarounds. Where an audited assumption turns
out to be relied on elsewhere, the deliverable is not only a registered item — it is a
correction at the dependent site, so the next reader is not reassured by the same sentence.

## Method note

**Read the comment, not just the line.** Every one of the three mtime workarounds carries a
comment explaining why it exists, and that comment is the author naming the assumption. The
grep finds the site; the comment usually hands over the answer to "what does this assume"
for free. A site with a workaround and no comment is the more expensive read, and is worth
flagging as its own smell.

## Boundaries

`crates/chan-workspace/src/` only, and after
[load-sensitive-tests-keep-recurring-after-three-sweeps](load-sensitive-tests-keep-recurring-after-three-sweeps.md)
rather than beside it — the two populations overlap on sleeps, and running both at once
means two passes editing the same lines. Extending to other crates is a later decision for
whoever reads the first list.

## Rough size

Medium, and almost entirely reading. The technique was proposed by a lane that explicitly
declined to run it, on the grounds that the surface was not theirs — which is the right
instinct and worth preserving: this audit's value is in the judgement per site, so it should
go to whoever knows the surface, not to whoever noticed the pattern.
