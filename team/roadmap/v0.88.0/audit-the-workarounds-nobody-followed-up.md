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
| spin until the mtime advances, capped at 200 ms | `crates/chan-workspace/src/workspace.rs:7221` (stale; `:7349` at `e239c770`, and repaired by this audit) | mtime does not reliably advance |
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

> **Three of those signatures are shell-shaped and yield zero on a Rust surface.** `2>/dev/null`, `|| true` and `safe.directory` matched nothing in `crates/chan-workspace/src/`, not because it is clean but because they cannot appear there. This list was written from a round that spanned shell tooling, and a zero that means "wrong instrument" is indistinguishable in a table from a zero that means "nothing here". Any re-run on a Rust surface should drop them and say it did.

The prospective form's failure is also now demonstrated rather than argued. During the round that ran this audit, its own author hit a container whose `$HOME` was empty, diagnosed it, worked around it locally, and did not pass it on; another lane then concluded from the same mechanism that a clean container could not run the test suite, which was false. The author had read the paragraph above that morning. If the rule cannot survive contact with the person best primed in the round, it is not a discipline problem, and that is the whole argument for the retrospective form.

A first census over `crates/chan-workspace/src/` gives roughly 43 candidate sites (18
sleeps, 10 retry/attempt constants, 15 loops), which is a tractable read rather than a
project.

> **Held up, with one correction and one limit the pass established.** The three class counts were exact; the population is 44 rather than 43, because a `let mut attempt` local binding is invisible to a `const`-oriented expression. "Tractable rather than a project" was true of the declared signatures and the pass finished at 53 sites. What it does not cover is the axis those signatures never had: every expression in this list is shaped by *time*, and the blind-spot section below establishes that a workaround shaped by *failure* matches none of them. That axis is 248 further lines on this same surface.

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
  > **The pass used five marks rather than these three**, and the two additions are the item's own question made visible. `named` here does not distinguish an assumption a test would catch from one nothing would, which is precisely what "what test fails if this sentence is false?" asks, so the pass split it into `named` and `named-ut`. `no-cmt` records the smell the method note names. The mapping is exact: `named` and `named-ut` both satisfy "assumption named", `shared` is "named and shared elsewhere", `not-wa` is "not a workaround", and `no-cmt` is orthogonal to all three.
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

> **Superseded by the pass below, and left standing because it is the specimen.** Everything in this section is written in the present tense about a test that **no longer exists in this form**: the audit repaired it (`d92ce036`), and it now stamps the sub-second gap with `force_mtime_ns` and fails by name on a mount too coarse to hold it. Two things in this section were also wrong by the time the pass ran, and both are corrected in F4: the citation resolves by name to `fn write_text_if_unchanged_detects_subsecond_conflict`, which sat at `:7349-7377` as of `e239c770` and not at the `:7221` this item's prose carries, and the deterministic construction that replaces the spin arrived in the *same* change that left the spinning test in place. A reader stopping here takes away a live defect that was closed in the round this section is describing.

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

> **This instruction was not followed, and the reason it existed did not bind.** The pass ran *beside* the timing work rather than after it. No collision occurred, because the sleep populations turned out to be disjoint by crate: the timing cluster's repairs are in `chan-server` (`control_socket.rs`, `routes/terminal.rs`, `doc_sessions/`) and this pass's sites are in `chan-workspace`. The two populations overlap as a *class* and not as *lines*, which is the distinction the original boundary missed. Anyone re-running this against a differently-scoped timing sweep should re-check that, rather than inheriting either the instruction or this exemption.
>
> **The "later decision" came due and is answered.** The first list has been read, and the class has a confirmed instance in `chan-server` (`build.rs` discards the error on six writes into the source tree). The follow-on registration is scoped to both crates on that basis: an item whose surface knowingly excludes its own confirmed instance is defective.

## Rough size

Medium, and almost entirely reading. The technique was proposed by a lane that explicitly
declined to run it, on the grounds that the surface was not theirs — which is the right
instinct and worth preserving: this audit's value is in the judgement per site, so it should
go to whoever knows the surface, not to whoever noticed the pattern.

> **Accurate, and the reason it was accurate is worth carrying.** The pass was 53 sites of reading against two Rust changes, one of them a comment. The estimate held because the judgement per site is the cost, exactly as this section says. What it did not anticipate is that the pass would spend as long on its own instrument as on the population: the test/production classifier was wrong on first run, and probing it rather than reading it is what found that. Budget for the instrument, not only for the sites.

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

**The population has one axis and workarounds have two.** Every signature above is shaped by *time*: a sleep, a spin, a retry budget, a capped wait, a fail-open return. None of them sees the other axis a workaround runs along, which is *what this code does when something fails*. That is not a tuning gap to be closed by widening an expression; it is a category the census never had, and it means "complete over the signature population" and "complete over the workarounds" are much further apart than the first phrase sounds.

It has a confirmed example rather than a theory behind it. `paths.rs:45-47` ends `dirs::home_dir().map(|p| p.join(".chan")).unwrap_or_else(|| PathBuf::from(".chan"))`, which relocates chan's entire home into the working directory when `home_dir()` fails. **None of the six expressions above matches it**, and it was found from outside this audit, by a lane running the suite over a read-only bind mount. F7 is what it turned out to be.

Worse than a miss: **F2 belongs to the same unsearched family.** `target_inside_root`'s canonicalize fallback, the highest-principle finding in this pass, was reached only because a `loop` signature happened to sit directly on top of it. The best result here arrived through a grep looking for something else, which means the family was yielding findings by accident throughout a pass that called itself complete for its declared signatures. Sized rather than asserted: `unwrap_or_else`, `unwrap_or_default` and `unwrap_or(` yield **131 lines** on this surface, `.ok()` a further **53**, none in this population. Closing that axis is the next pass, not a widening of this one.

The second structural bound, because it limits every number above in a different way. **These greps enumerate workarounds; the defect lives at the dependent site, which by construction carries no signature.** `write_text_if_unchanged` matches none of these expressions. It was reached by following an assumption from a workaround, not by matching one. So the population bounds what can be enumerated, never what can be concluded, and the join from each site to its dependents is manual reading.

- `2>/dev/null` and `|| true` yield **0** here. They are shell signatures and this surface is Rust, so that branch of the signature list is inapplicable rather than clean.
- The Rust analogue of error suppression is **not** in this population and is the largest unexamined lexical class on the surface. **The figure first recorded here was 85 lines and it undercounts**: that set required `.ok();` with a trailing semicolon, so it missed every `.ok()` used as an expression, and it omitted `unwrap_or_else` and `unwrap_or(` entirely. Over the full set (`let _ =`, `.ok()`, `unwrap_or_default()`, `unwrap_or_else`, `unwrap_or(`) the surface carries **248** matching lines. The correction is left visible rather than swapped, because an exclusion justified by a number that was three times too small is a different decision from the one it appears to be.
- `#[allow(` yields 2 and `#[ignore]` yields 2, both examined.
- A workaround with no keyword is invisible to all of the above: a reordering, an extra defensive read, a widened bound, a coarser unit, an `if` special-casing one filesystem.
- Surface is `crates/chan-workspace/src/` only. Dependent sites in `crates/chan-server/src/` are named where found but not edited.

### The marked population

**Every line number below is as of `e239c770` and will not survive the file changing.** A dead sha fails closed and announces itself; a stale line number fails open and silently points at whatever moved into its place, which is the more dangerous of the two and the reason this anchor is repeated here rather than left in the section header above. Re-resolve by the enclosing function name, which is in the table for exactly that purpose, and re-run `scripts/census-workarounds.py` rather than navigating these numbers directly. One of them is already known stale and deliberately kept: see the opening table's `:7221`.

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

**F2. "Canonicalize failed" is answered four different ways on the path sandbox, two of them fail-open, none tested.** Within `fs_ops.rs`: `ensure_parent_inside_root` returns `Err` when the root cannot be canonicalized but returns `Ok(())` when the *parent* cannot; `target_inside_root` falls back to `lexical_path_inside_root`, which cannot resolve symlinks and so cannot detect the escape the function exists to detect; `resolve_safe_strict_canon` walks up to the deepest existing ancestor. `find_git_dir` in `metadata_archive.rs` adds a fourth stance, proceeding with the uncanonical path. No test constructs an uncanonicalizable root or parent. This sits on the project's first principle, "Workspace is the boundary". No exploit is demonstrated here and none is claimed; what is claimed is that the boundary has four unreconciled answers and no test holds any of them.

**F3. `wipe_dir`'s retry budget is untested and its assumption is unverified.** The comment names it exactly: a cancelled reindex "stops within a few ms once it next checks its cancel flag", bounded at 20 attempts of 10ms. Nothing in either crate tests `wipe_dir`, `DirectoryNotEmpty`, or the 200ms bound. If the sentence is false the teardown surfaces an error rather than losing data, so this is lower severity than F1 or F2, and it is the clearest instance of the shape this item hunts: an author who wrote the assumption down and no test that would notice it changing.

**F4. The specimen this item names is still fail-open, and the deterministic replacement now sits twenty lines below it.** The CAS fix in `69a4a651` added `force_mtime_ns` and `write_text_if_unchanged_conflicts_when_an_external_edit_kept_the_mtime`, which stages the collision directly instead of racing the filesystem for it, and left the spinning test in place. So **the capability to test this deterministically exists twenty lines below the test that still spins for 200ms and returns green when it loses the race**. That makes it a better specimen after the CAS fix than before it: the fix landed, the fail-open test was left beside it, and nothing joined the two.

The citation above is corrected. At `e239c770` the test is `workspace.rs:7349-7377`, `force_mtime_ns` is `:7382`, and the deterministic sibling is `:7397`; this item's prose cites `:7221`, which was accurate when written and moved when the CAS fix landed in the same file. This is the second stale line number found in a roadmap item this round. Line numbers in an item decay against the file they point into, and this item is the one designed to be re-run, so cite them with the sha they were read at and expect to re-resolve by symbol name rather than by number.

**F5. A fourth member of the mtime family, not in this item's table of three.** `reconcile_picks_up_modified_files` in `workspace.rs` sleeps 1100ms with the comment "Sleep past the 1-second mtime granularity floor of HFS+ / older ext4 so the modify is observable via stat". Same assumption as the three tabulated above, a fourth engineer, worked around locally.

**F6. `WATCH_RETRY_INTERVAL` is the population's one wholly undocumented wait**, the `const WATCH_RETRY_INTERVAL` binding in `watch.rs`, sitting directly beneath `DEGRADE_MIN_INTERVAL` whose four-line comment explains its value. This item's method note flags exactly this: a workaround with no comment is the more expensive read and a smell of its own.

Now documented, and the honest half of that is that **the figure's rationale does not exist anywhere in the tree**. The constant carries two roles, both verified from the code: it is the deadline offset for re-registering watch roots after a failure or a provider loss, and it is the supervisor's idle wakeup when no retry is pending, so it bounds both recovery latency and how long the supervisor sits before looking at anything. Why 250ms specifically is recorded nowhere. Searched: the introducing commit's diff (the constant arrives with no comment) and message, every commit touching it (`git log -L` shows the value never changed), every commit message touching `watch.rs` matching "retry", and `team/` plus `.agents/`. The only 250ms rationale in the tree belongs to the Linux clipboard handle in `release-v0.78.0.md`, an unrelated number. The comment now says the cadence is unverified rather than inventing a justification for it, because a plausible-sounding rationale for a constant nobody measured is the confident-wrong-note failure this item exists to stop, and committing one inside this audit would be that failure at its least excusable.

**F7. The chan home collapses to the working directory when `home_dir()` returns `None`, and the test that names that hazard cannot detect it.** `config_dir()` in `paths.rs` ends `dirs::home_dir().map(|p| p.join(".chan")).unwrap_or_else(|| PathBuf::from(".chan"))`. That fallback is relative, so it resolves against the process working directory, and `config_dir` is documented three lines above as "the SINGLE authority for the chan home" from which `state_dir`, `cache_dir`, `global_config_path` and `workspaces_dir` all derive.

The hazard is named by name in the same file. `chan_home_override` in `paths.rs` documents that an empty value is treated as unset "so `CHAN_HOME=` does not collapse the home to the cwd", and `config_dir_honors_chan_home_override` repeats it as a comment: "Empty is treated as unset: the home-based default, NOT the cwd." The assertion under that comment is `assert!(config_dir().ends_with(".chan"))`, and `PathBuf::from(".chan")` ends with `.chan`. **The expression is equally true in the cwd case the comment says it is excluding**, as is the `assert_ne!(config_dir(), PathBuf::from(""))` beside it. So the answer to "what test fails if this sentence is false" is none, and it is none in the stronger way this item cares about: a test exists, it names the failure, and it is built so that failure passes it.

The failure is silent on an ordinary checkout, which is why it survived. A writable working directory means the fallback quietly creates `.chan/` inside the source tree and the suite stays green; it took a read-only bind mount to make it loud, and it surfaced from @@Timing's rig rather than from this audit.

The seam that would make it testable already exists in this crate. `vcs.rs` calls `detect_parent_vcs_with_home(path, dirs::home_dir())`, passing the home in as a parameter precisely so the `None` case can be constructed in a test. `config_dir` calls `dirs::home_dir()` directly and cannot. This is the same shape the CAS carried: the codebase already contained its own counter-argument, one file away.

**Noted and withdrawn.** the `READER_CHECKOUT_TIMEOUT` doc comment in `graph.rs` says reindex pacing on Windows "is otherwise a no-op", which reads as false against `pace_no_probe`'s non-unix arm. `git log -S` shows both landed in the same commit `b1d42f21`, so "otherwise" means "absent this fix" and the sentence is ambiguous rather than wrong. Recorded so the next reader does not spend the same twenty minutes.

**Out of surface.** `lexical_path_inside_root` exists twice, in `fs_ops.rs` taking `(root, path)` and in `crates/chan-server/src/routes/fs_graph.rs` taking `(path, root)`, reversed between them. The chan-server copy has a test; the chan-workspace copy has none. Two independent implementations of one sandbox primitive is worth a decision, and chan-server belongs to other lanes this round.

**Every call site passes them in the order its own copy declares**, checked before this was written down because a reader will assume it was: `target_inside_root` passes `(root, path)` into the `(root, path)` copy, and `target_is_inside_workspace` passes `(target_abs, &self.root)` into the `(path, root)` copy, as do both assertions in `lexical_fallback_rejects_parent_escape`. So this is a maintainability hazard and not a live containment bug: the duplication is what invites the transposition, and nothing has transposed it yet.
