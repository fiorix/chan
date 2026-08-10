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

Make that mechanical rather than a judgement call: for each recorded assumption, ask **"what
test fails if this sentence is false?"** If no such test exists, the sentence is a hypothesis
wearing the clothes of a fact. That is the prove-the-instrument-can-fail rule applied to
prose.

The CAS claim answers that question in the worst possible way. The test named for it,
`write_text_if_unchanged_detects_subsecond_conflict` (`workspace.rs:7221`), states the hazard
in its own comment — "Without ns precision, two same-second writes would collide and let this
through" — and then **structurally excludes it**: it spins until `mtime_ns` advances, and if
it has not advanced within 200 ms it `return`s and passes green. So on precisely the
filesystems where the docstring's "degrades gracefully" is false, the guarding test asserts
nothing and reports success.

It is not a missing test. It is a test built to skip the case it names, with a silent
early-return rather than an `#[ignore]` or a failure — so the claim it appears to guard was
never once exercised. When the audit finds an assumption whose only test is shaped like this,
that is a stronger finding than an untested one.

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
[load-sensitive-tests-keep-recurring-after-three-sweeps](../done/load-sensitive-tests-keep-recurring-after-three-sweeps.md)
rather than beside it — the two populations overlap on sleeps, and running both at once
means two passes editing the same lines. Extending to other crates is a later decision for
whoever reads the first list.

## Rough size

Medium, and almost entirely reading. The technique was proposed by a lane that explicitly
declined to run it, on the grounds that the surface was not theirs — which is the right
instinct and worth preserving: this audit's value is in the judgement per site, so it should
go to whoever knows the surface, not to whoever noticed the pattern.

## The recorded pass, 2026-08-10, at `e239c770`

53 sites over `crates/chan-workspace/src/`, every one marked below including the ones found clean. Two families: family A reproduces this item's census, family B is a signature the census did not use.

### The greps that produced the population

Run from the repository root. The line counts are what they yield at `e239c770`; the site counts are lower where a match is a comment rather than code, and the difference is stated per grep.

```sh
# A1  sleep call sites                                    19 lines, 18 sites
grep -rnE '(thread::sleep|\bsleep\()' crates/chan-workspace/src/

# A2  unbounded loop constructs                           15 lines, 15 sites
grep -rnE '\bloop\s*\{' crates/chan-workspace/src/

# A3  capped-wait constants, by type                       6 lines
grep -rnE '\b(const|static)\s+[A-Z0-9_]+\s*:\s*(std::time::)?Duration\b' \
     crates/chan-workspace/src/

# A4  capped-wait constants, by name                      10 lines (6 overlap A3)
grep -rnE '\b(const|static)\s+[A-Z0-9_]*(RETRY|RETRIES|ATTEMPT|BACKOFF|BUDGET|DEBOUNCE|INTERVAL|TIMEOUT|DEADLINE)[A-Z0-9_]*\s*[:=]' \
     crates/chan-workspace/src/

# A5  attempt counters as local bindings                   1 line
grep -rnE '\blet\s+mut\s+(attempt|attempts|retries|tries)\b' crates/chan-workspace/src/

# B1  bare early return, the fail-open test shape         56 lines, 9 in test scope
grep -rnE '^\s*return\s*;' crates/chan-workspace/src/
```

A1 yields 19 lines but 18 sites: `indexer.rs:684` is a comment naming `sleep(DEBOUNCE_TEST_MS/3)`, not a call. B1 yields 56 lines but only the 9 inside test scope are in the population; the other 47 are ordinary production guard clauses.

Family A totals 44 against this item's estimate of "roughly 43 (18 sleeps, 10 retry/attempt constants, 15 loops)". The three class counts match exactly. The extra site is `library.rs:629`, a `let mut attempt` counter that a `const`-oriented grep cannot see because it is a local binding. A5 exists to catch that class.

Family B was added because this item argues a test built to skip the case it names is a stronger finding than an untested claim. That shape has a cheap signature the census did not use, and it found 9 sites, one of them the specimen this item already names.

**The signature list above is not the one this item shipped with, and that is the point.** Family B came from this item's *prose* rather than from its greps: the item named the specimen but never gave the class a signature. B1 is one grep, and 8 of its 9 sites were not previously known. A5 has the same provenance in miniature, recovering a `let mut attempt` local binding that a `const`-oriented expression structurally cannot match. Anyone re-running this pass should treat the list as a living inventory and add to it, not as a fixed one to re-execute.

### Separating test from production

The test/production split is load-bearing, since a production workaround can reach a user and a test one cannot. It is also the step that misfiled eight production backoff paths in v0.87.0 by comparing a line number against the position of `#[cfg(test)]`. Here it is done by brace tracking over comment-stripped and string-stripped source, refusing to answer for any file whose depth does not return to zero at EOF.

The first version of that classifier was wrong, and probing rather than reading is what found it: `watch.rs:480` (`record_registration_result`, production) came back `test`, because a `#[cfg(test)]` guarding a statement at `watch.rs:373` and `:384` bound to the next `fn` token 85 lines away. An attribute's reach now ends at the first intervening line that is neither an attribute nor an item declaration. It classified a production function as test code and said so without hedging, which is the same bucket error as the v0.87.0 misfiling and this item's own thesis landing on the audit's instrument.

The classifier is therefore built to fail loudly rather than plausibly. Fed a file with unbalanced braces it prints `UNPARSED (classification refused)` and marks every site in that file `?` instead of guessing; no file in the crate is currently unparsed. That refusal is what makes the clean rows in the table below worth anything, since a classifier that always answers cannot distinguish a site it understood from one it did not. The greps alone are not re-runnable in any useful sense without this split, which is why `scripts/census-workarounds.py` ships beside them.

### Blind spots

The structural one first, because it bounds every number above. **These greps enumerate workarounds; the defect lives at the dependent site, which by construction carries no signature.** `write_text_if_unchanged` matches none of these expressions. It was reached by following an assumption from a workaround, not by matching one. So the population bounds what can be enumerated, never what can be concluded, and the join from each site to its dependents is manual reading.

- `2>/dev/null` and `|| true` yield **0** here. They are shell signatures and this surface is Rust, so that branch of the signature list is inapplicable rather than clean.
- The Rust analogue of error suppression (`let _ =`, `.ok();`, `unwrap_or_default()`) yields **85** lines and is **not** in this population. It is the largest unexamined lexical class on the surface.
- `#[allow(` yields 2 and `#[ignore]` yields 2, both examined.
- A workaround with no keyword is invisible to all of the above: a reordering, an extra defensive read, a widened bound, a coarser unit, an `if` special-casing one filesystem.
- Surface is `crates/chan-workspace/src/` only. Dependent sites in `crates/chan-server/src/` are named where found but not edited.

### The marked population

Marks: `not-wa` not a workaround; `named` assumption named and a test fails if it is false; `named-ut` assumption named and **no** test fails if it is false; `shared` assumption relied on elsewhere too, registered rather than repaired; `no-cmt` a workaround carrying no comment, which this item flags as its own smell.

```
site                                    class   scope  mark      note
--------------------------------------  ------  -----  --------  ----------------------
contacts/slug.rs:70                     loop    prod   not-wa    suffix iteration
fd_budget.rs:77                         wait    prod   named     backoff spacing
fd_budget.rs:123                        loop    prod   not-wa    condvar wait
fd_budget.rs:151                        loop    prod   shared    F1 probe availability
fd_budget.rs:158                        sleep   prod   shared    F1
fd_budget.rs:211                        sleep   prod   named-ut  cfg(not(unix)), uncompiled
fs_ops.rs:327                           loop    prod   shared    F2 canonicalize fallback
fs_ops.rs:1247                          loop    prod   shared    F2
graph.rs:89                             wait    prod   named-ut  2s vs healthy checkout
graph.rs:723                            wait    prod   named-ut  chunking path untested
index/bm25.rs:35                        wait    prod   named-ut  "our corpora are small"
index/facade.rs:564                     loop    prod   not-wa    F1 dependent site
indexer.rs:54                           wait    prod   named     debounce tuning
indexer.rs:200                          loop    prod   not-wa    worker loop
indexer.rs:398                          wait    test   not-wa    test constant
indexer.rs:417                          wait    test   named     budget, reasoned
indexer.rs:430                          sleep   test   no-cmt    poll interval, benign
indexer.rs:582                          sleep   test   named     FSEvents coalescing
library.rs:629                          attempt prod   named-ut  F3 wipe_dir retry
library.rs:630                          loop    prod   named-ut  F3
library.rs:636                          sleep   prod   named-ut  F3
library.rs:1285                         sleep   test   named     bounded poll, asserts
metadata_archive.rs:673                 loop    prod   shared    F2 fourth instance
registry.rs:405                         sleep   test   no-cmt    clock advance, fails closed
registry.rs:474                         sleep   test   no-cmt    clock advance, fails closed
report.rs:28                            wait    prod   named     debounce tuning
report.rs:320                           sleep   prod   not-wa    the design, not a patch
watch.rs:285                            wait    prod   named     degrade throttle
watch.rs:287                            wait    prod   no-cmt    F6 undocumented 250ms
watch.rs:338                            loop    prod   not-wa    supervisor loop
watch.rs:1924                           sleep   test   named     registration settle
watch.rs:2076                           sleep   test   named     registration settle
watch.rs:2081                           sleep   test   named     registration settle
watch.rs:2113                           sleep   test   named     catch-up scan
watch.rs:2137                           sleep   test   no-cmt    uncommented twin of 1924
workspace.rs:1806                       loop    prod   not-wa    chunked read
workspace.rs:2458                       loop    prod   not-wa    name generation
workspace.rs:2734                       loop    prod   not-wa    name generation
workspace.rs:4586                       loop    test   not-wa    test probe hook
workspace.rs:5372                       sleep   test   named     bounded poll, asserts
workspace.rs:6462                       sleep   test   named     F5 mtime family
workspace.rs:6585                       sleep   test   named     bounded poll, asserts
workspace.rs:7357                       loop    test   named-ut  F4 fail-open
workspace.rs:8721                       sleep   test   named     async flush window
fs_ops.rs:2158                          return  test   named     xattr skip, narrowed
index/embeddings.rs:775                 return  test   named     model-gated skip
index/embeddings.rs:791                 return  test   named     model-gated skip
index/embeddings.rs:810                 return  test   named     model-gated skip
indexer.rs:631                          return  test   named     sibling verified, clean
watch.rs:1107                           return  test   named     fails closed at caller
workspace.rs:4583                       return  test   not-wa    probe not armed
workspace.rs:4588                       return  test   not-wa    cancel check
workspace.rs:7366                       return  test   named-ut  F4 the silent return
```

Totals, counted from the table above rather than asserted: 13 `not-wa`, 21 `named`, 9 `named-ut`, 5 `shared`, 5 `no-cmt`, summing to 53. By scope, 26 production and 27 test. By class, 18 sleep, 15 loop, 10 capped-wait constant, 1 attempt counter, 9 fail-open return.

The per-class split is 13 production and 2 test loops, 4 production and 14 test sleeps, 8 production and 2 test wait constants, 1 production attempt counter, and 9 test fail-open returns. Regenerate all of these with `scripts/census-workarounds.py` rather than trusting this paragraph: an earlier hand-tallied version of it put the loops at 11 production and 4 test, which moved both subtotals, and an audit whose whole argument is that a hit list needs a denominator has no business hand-counting its own.

### What was checked and found clean

Recorded because a hit list with no denominator is the completeness claim this project keeps re-learning not to write.

`indexer.rs:631` is the clean case worth naming. Its skip is narrowed to the environment limitation (the OS watcher dropped the event), keeps the real regression as a `panic!`, prints to stderr rather than passing silently, and names `reindex_walks_in_root_drafts_into_graph_and_bm25` as the deterministic cover. That test exists at `workspace.rs:8166`, writes the file directly to bypass the watcher, drives the boot walk, and asserts both BM25 and graph. The claim is true and it is tested.

`watch.rs:1107` reads like a fail-open helper (`inject_provider_loss` silently no-ops when the command channel is absent) and is not one: its caller at `watch.rs:2178` asserts `Degraded` and `provider_errors == 1` immediately afterwards, so a no-op fails the test rather than passing it.

`library.rs:1285`, `workspace.rs:5372` and `workspace.rs:6585` are bounded poll loops that assert after the deadline, so a timeout goes red. That is the shape the fail-open sites should have.

`registry.rs:405` and `:474` carry no comment but their assumption (`Utc::now()` advances within 10ms) holds at `DateTime<Utc>` resolution, and an equal-timestamp sort would fail the assertion rather than pass it. They fail closed.

The three `index/embeddings.rs` skips are gated on `CHAN_RUN_MODEL_TESTS` to avoid pulling 130 MB per run, and say so at the gate.

### Findings

**F1. The descriptor probe's absence is assumed impossible on Unix, at five sites, and fails open at every one.** `fd_snapshot()` is `read_dir("/dev/fd").ok()?`, so it returns `None` whenever `/dev/fd` is unreadable; on Linux that path is a symlink to `/proc/self/fd`, so it depends on `/proc`. `pace_reindex_worker` states the opposite in a comment: "On Unix `snapshot()` is always `Some`, so this arm is dead there", and `pace_no_probe`'s own docstring repeats it. All five `None` arms degrade toward *more* resource use: no read-worker cap, full tantivy writer budget, `MAX_ACTIVE_WORKSPACES`, and no reindex pacing at all. Every one of the 12 `fd_budget` tests constructs an `FdSnapshot` directly and exercises the pure policy functions, so **no test fails if that sentence is false**. This is one assumption relied on at five sites and is registered rather than repaired. Severity is bounded honestly: no shipped systemd unit removes `/proc`, so this is a claim that closes a question rather than a demonstrated live fault.

**F2. "Canonicalize failed" is answered four different ways on the path sandbox, two of them fail-open, none tested.** Within `fs_ops.rs`: `ensure_parent_inside_root` returns `Err` when the root cannot be canonicalized but returns `Ok(())` when the *parent* cannot; `target_inside_root` falls back to `lexical_path_inside_root`, which cannot resolve symlinks and so cannot detect the escape the function exists to detect; `resolve_safe_strict_canon` walks up to the deepest existing ancestor. `metadata_archive.rs:669` adds a fourth stance, proceeding with the uncanonical path. No test constructs an uncanonicalizable root or parent. This sits on the project's first principle, "Workspace is the boundary". No exploit is demonstrated here and none is claimed; what is claimed is that the boundary has four unreconciled answers and no test holds any of them.

**F3. `wipe_dir`'s retry budget is untested and its assumption is unverified.** The comment names it exactly: a cancelled reindex "stops within a few ms once it next checks its cancel flag", bounded at 20 attempts of 10ms. Nothing in either crate tests `wipe_dir`, `DirectoryNotEmpty`, or the 200ms bound. If the sentence is false the teardown surfaces an error rather than losing data, so this is lower severity than F1 or F2, and it is the clearest instance of the shape this item hunts: an author who wrote the assumption down and no test that would notice it changing.

**F4. The specimen this item names is still fail-open, and the deterministic replacement now sits twenty lines below it.** The CAS fix in `69a4a651` added `force_mtime_ns` and `write_text_if_unchanged_conflicts_when_an_external_edit_kept_the_mtime`, which stages the collision directly instead of racing the filesystem for it, and left the spinning test in place. So **the capability to test this deterministically exists twenty lines below the test that still spins for 200ms and returns green when it loses the race**. That makes it a better specimen after the CAS fix than before it: the fix landed, the fail-open test was left beside it, and nothing joined the two.

The citation above is corrected. At `e239c770` the test is `workspace.rs:7349-7377`, `force_mtime_ns` is `:7382`, and the deterministic sibling is `:7397`; this item's prose cites `:7221`, which was accurate when written and moved when the CAS fix landed in the same file. This is the second stale line number found in a roadmap item this round. Line numbers in an item decay against the file they point into, and this item is the one designed to be re-run, so cite them with the sha they were read at and expect to re-resolve by symbol name rather than by number.

**F5. A fourth member of the mtime family, not in this item's table of three.** `workspace.rs:6462` sleeps 1100ms with the comment "Sleep past the 1-second mtime granularity floor of HFS+ / older ext4 so the modify is observable via stat". Same assumption as the three tabulated above, a fourth engineer, worked around locally.

**F6. `WATCH_RETRY_INTERVAL` is the population's one wholly undocumented wait**, at `watch.rs:287`, sitting directly beneath `DEGRADE_MIN_INTERVAL` whose four-line comment explains its value. This item's method note flags exactly this: a workaround with no comment is the more expensive read and a smell of its own.

**Noted and withdrawn.** `graph.rs:80-82` says reindex pacing on Windows "is otherwise a no-op", which reads as false against `pace_no_probe`'s non-unix arm. `git log -S` shows both landed in the same commit `b1d42f21`, so "otherwise" means "absent this fix" and the sentence is ambiguous rather than wrong. Recorded so the next reader does not spend the same twenty minutes.

**Out of surface.** `lexical_path_inside_root` exists twice, at `fs_ops.rs:338` and `crates/chan-server/src/routes/fs_graph.rs:1345`, with reversed parameter order between them. The chan-server copy has tests; the chan-workspace copy has none. Two independent implementations of one sandbox primitive is worth a decision, and chan-server belongs to other lanes this round.
