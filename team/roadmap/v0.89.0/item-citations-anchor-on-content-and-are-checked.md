# A line number in a roadmap item keeps resolving after the code moves, and nothing reports it

Status: REGISTERED 2026-08-11, merged from two drafts written at the v0.88.0 close: one proposed the content-anchoring rule, one built the check that makes the rule verifiable, and each declared the other blocking. The owner accepted them as a single v0.89.0 item and cut the conversion pass the rule draft asked for. This item is **forward-only** and does not touch `../done/`.

## Why the two halves are one item

The rule alone is a net loss. Today a positional citation is unchecked and a commit sha is checked, by a round-local scan. Promoting content anchoring without shipping a needle check moves every future citation out of the one class anything covers and into a class nothing covers, with the project's authority behind the move. The check alone buys almost nothing: the only item in `team/roadmap/` currently citing by content needle is [the-boot-overlay-locks-the-workspace-behind-its-own-index-rebuild](../done/the-boot-overlay-locks-the-workspace-behind-its-own-index-rebuild.md), it declares three needles, and all three already verify. A checker built for three needles in one closed item is a script nobody will run.

Both drafts reached that conclusion independently and each wrote the same gate: the two land together or not at all. This item is that pair.

## The mechanism: a sha fails closed, a line number fails open

| citation style | fails | checked by |
| --- | --- | --- |
| commit sha | closed | a round-local scan, in gitignored `dev/` |
| `file:line` | open | nothing |
| content needle | open | nothing |
| prose anchor | open | nothing |

A sha that is orphaned by a rebase makes `git cat-file` error, which looks worse and is better. A line number that is orphaned by an edit keeps resolving, points at whatever now occupies that position, and looks entirely valid. A content needle is robust against every edit that does not change the thing being cited, and when it does break the breakage is a fact about the file rather than a coincidence about numbering, but it breaks silently: it matches zero times, or twice, or matches something that moved in. v0.88.0 made that trade for one item without pricing the other half.

## Reproduction, on a citation that was corrected and re-verified inside its own round

[audit-the-workarounds-nobody-followed-up](../done/audit-the-workarounds-nobody-followed-up.md) is the item most careful about this, by a wide margin. Its line `:304` records a correction to its own citations and anchors them explicitly to a sha:

> At `e239c770` the test is `workspace.rs:7349-7377`, `force_mtime_ns` is `:7382`, and the deterministic sibling is `:7397`

Those three were exact at `e239c770`, confirmed by reading the file at that revision. The correction landed in `d47a0dc5` at 09:13. Thirty-four minutes later, `d92ce036` rewrote that test region, and it is the only commit to touch `crates/chan-workspace/src/workspace.rs` since. The item then shipped in v0.88.0 with all three numbers already pointing at the wrong content, and nothing said so.

Resolved against the tree at `f9c2878c`, which is HEAD as this is written:

| cited | what the item calls it | what it lands on now | truly at |
| --- | --- | --- | --- |
| `:7349` | the test | the `#[test]` attribute | `:7350` |
| `:7382` | `force_mtime_ns` | a blank line | `:7373` |
| `:7397` | the deterministic sibling | `token,`, a bare arg | `:7388` |

The cited range `:7349-7377` now opens on an attribute and closes on a `.unwrap()` inside `force_mtime_ns`'s body, so it spans out of the test it names and into the helper. The item's marked-population table has the same problem on the same file: `workspace.rs:7357`, classed `loop`, now lands on an `assert_ne!(` opening, and `workspace.rs:7366`, classed `return`, now lands on an `assert!(matches!(err, ChanError::WriteConflict { .. }))`. Both read as plausible code. Neither is what the row classifies.

Three properties of that reproduction are what make this an item rather than a note.

- It happened to the item that was **trying hardest**, in the round that was paying attention. That item names the fail-open mechanism at `:214` in its own words before tabulating anything.
- The sha anchor did not save it. The anchor is correct and honest, and a reader who navigates the numbers in a checkout rather than at `e239c770` still lands on the wrong lines.
- The escape hatch the item names does not exist. `:214` says to "re-resolve by the enclosing function name, **which is in the table for exactly that purpose**". That table, the fenced block under `### The marked population`, has the header row `site class scope mark note` and 53 rows, and every row identifies its subject by file and line only. There is not one symbol name in it. The remediation the round applied does not supply the thing it tells the reader to fall back on.

Its deliberately preserved stale reference has drifted too: `workspace.rs:7221`, kept on purpose as the known-bad example, is a blank line at HEAD.

## Nothing in the checked-in tree reads `team/roadmap/` at all

The sha scan that covers the one checked class is round-local. It lives in the gitignored `dev/` tree and dies with the round's archive. Verified at HEAD:

- `grep -rn "cat-file"` over the repository outside `dev/`, `.git/` and `team/roadmap/v0.89.0/` returns exactly one hit, and it is prose inside a roadmap item (`the-boot-overlay-locks-the-workspace-behind-its-own-index-rebuild.md:256`). This round's directory is excluded from the scope because this item's own prose mentions the command twice, and those hits are prose as well: no script, workflow or `Makefile` target in the checked-in tree contains the string.
- `grep -rln "team/roadmap"` over `scripts/`, `.github/` and `.agents/` returns one file, `.agents/README.md`, which is a read-order pointer and not a check. Nothing under `scripts/`, no workflow, and no `Makefile` target reads `team/` for any purpose.
- The release skill at [`../../../.agents/skills/release/SKILL.md`](../../../.agents/skills/release/SKILL.md) contains no scan step. Step 5 of the lifecycle in [`../../README.md`](../../README.md) is prose about moving items.

So "the close scan catches it" is true of a practice, not of the repository. Both halves of this item inherit that problem: the check needs a home that does not exist yet.

## The population, counted with a stated rule

Three verification passes counted the positional citations under `team/roadmap/` and returned **876**, **970** and **992**. They disagree because none of them stated an extraction rule and they did not count the same population: at least one counted `done/` only while another counted all of `team/roadmap/`. That disagreement is not a side issue. It is the argument for writing the rule down, because a citation format nobody can extract mechanically is a citation format nobody can check.

The rule used here, stated so the next count can be compared to this one: a positional citation is any token matching `[A-Za-z0-9_./-]+\.<ext>:<digits>` where `<ext>` is drawn from a fixed list of source and config extensions (`rs ts tsx js mjs cjs py sh bash toml md yml yaml json svelte css scss html nix txt lock service conf spec rules`). A range such as `workspace.rs:7349-7377` counts once. Bare continuation fragments in backticks, the `` `:7382` `` form, are counted separately because they name no file and cannot be resolved without their antecedent.

Counted against the working tree at `f9c2878c`:

| population | positional citations | files with at least one |
| --- | --- | --- |
| `team/roadmap/done/` | 997 | 62 of 129 |
| `team/roadmap/v0.89.0/` | 305, and rising | 8 of 13 |
| `team/roadmap/README.md` | 0 | n/a |

Plus 318 bare `` `:NNN` `` fragments across `team/roadmap/`, counting the `` `:7349-7377` `` range form as one, of which 126 are in the settled `done/` population and 192 in this round's directory and still moving, 3 positional citations under `team/release/`, and 0 under `.agents/`.

`done/` is the number to compare against, because it has not been touched since the v0.88.0 release commit. 997 there against the earlier 970 and 992 is pure extraction-rule disagreement, measured with the tree held still.

`v0.89.0/` is the number that matters, and it does not hold still. Three observations, all in the same working day:

- **0**, across five items, when the two drafts behind this item were verified.
- **86**, across seven items, when the population section above was first written.
- **305**, across thirteen items, when it was last re-run. The figure rose by four between two runs a few minutes apart, because sibling items were still landing, so treat it as a lower bound at the moment of writing rather than a settled number. This item itself carries six, counted by the same rule.

So the directory the rule would govern went from zero positional citations to roughly three hundred in a single working day, while the item proposing the rule was being drafted. That is not an argument for the rule made in the abstract; it is the cost of not having it, accruing in the same afternoon, in the tree.

## The practice has been derived three times and propagated zero

[`../../../.agents/writing-rules.md`](../../../.agents/writing-rules.md) is eight lines and says nothing about citations, line numbers, shas or needles. It has not been touched since 2026-06-27. Meanwhile:

- [source-pins-bound-on-sibling-string-literals](../done/source-pins-bound-on-sibling-string-literals.md), v0.86.0, established uniqueness-by-count for source pins in code and shipped a live probe at [`../../../scripts/pin-mutation-probe.py`](../../../scripts/pin-mutation-probe.py). This is the origin the round's own trace names, in journals that are archived rather than checked in. The merged draft credited a different item as the origin, and that attribution is corrected here; the two are not interchangeable, since this one is the code-level analogue and carries the only executable form of the practice in the tree.
- [large-transfer-ceiling-refinements](../done/large-transfer-ceiling-refinements.md), v0.86.0, at `:59`: "The assertion is identified by its subject rather than by a line number, because this section has already outlived one such citation."
- [the-boot-overlay-locks-the-workspace-behind-its-own-index-rebuild](../done/the-boot-overlay-locks-the-workspace-behind-its-own-index-rebuild.md), v0.88.0, at `:256` to `:260`, states the fail-open versus fail-closed reasoning in full, names its three needles and their expected counts, and observes that `.agents/writing-rules.md` says nothing about line references. One of the source drafts is substantially a lift of that paragraph.

Three lanes, three releases, three independent derivations, and the reasoning never left the item it was written in. The correction worth carrying is that the claim "no other item states the practice" was false when the draft was written; the practice is stated, repeatedly, in places nobody consults before citing something.

## Boundaries

- **Forward-only.** This item does not convert citations in `../done/`. The 997 positional citations there sit in records deliberately anchored to the revision they were read at, and rewriting them cuts against the lifecycle rule in `../README.md`, at `:10` under Lifecycle, which has evidence accumulate in a proposal "without replacing the proposal's original rationale". The audit item is explicit about it at its own `:214`: every number below that line is as of `e239c770` and is expected not to survive the file changing. Converting those citations would be editing a record of what was true at a revision into a claim about now.
- It does not touch code comments, `CHANGELOG.md`, or `team/release/`. The snapshot rule in `.agents/writing-rules.md` already governs code comments and is a different question.
- It does not attempt to detect a citation whose needle still matches while the surrounding logic has inverted. See the blind spots below.
- It does not add a CI gate. Where the check runs is an open question, stated below, and defaulting it to CI would be deciding that question by omission.

## Contract

- A source citation written in the governed set identifies its subject by **content**, not by position. Where a position is genuinely the subject, for example a recorded panic site, it is anchored to the revision it was read at and marked as such.
- A content needle **declares how many times it is expected to match**. An undeclared count is unverifiable in a second way, because a checker cannot distinguish an intended two from a drifted two. The tree already contains the counter-example that rules out an implicit "exactly once": `!readiness.is_ready()` occurs exactly twice in `crates/chan-server/src/routes/search.rs`, at `:202` and `:225`, and the boot-overlay item cites **both** deliberately.
- A citation carries enough to be re-resolved by a human when the needle breaks: the repository-relative path and the enclosing symbol name. The audit item's failure above is the case for the symbol name being mandatory rather than encouraged.
- Where content anchoring is impossible and prose must name a location, that is allowed and is a **recorded uncovered class**, not a violation pretended away.
- A checkable citation record exists that a script can extract without parsing prose. Its shape is open, below.

## Open questions, not settled here

These are the three things neither draft supplied, and they are what makes this item's shape a real decision rather than a script.

1. **What the machine-readable record is.** Today a citation names its file as a bare fragment inside a sentence. The boot-overlay item names the same file as `routes/search.rs` at `:135` and as `search.rs` at `:258`, neither repository-relative, and its needles are backticked spans indistinguishable from the dozens of other backticked code spans in the same item. A checker cannot extract its own input from that. Whatever record is chosen must survive the delimiter trap the checker draft hit by hitting it: a needle is arbitrary source text and can contain any separator a table might use. The first dry run split inside the needle `|| p.q.trim().is_empty()` and reported `MISMATCH declared=1 actual=` for a citation that was correct, which is a failure in the worst direction, sending a reader to hunt a defect that does not exist. So one needle per invocation, or a NUL-separated or length-prefixed record, and never a human-delimited table.
2. **Where the check lives.** There is no checked-in close procedure to add it to. The candidates are the release skill, `team/README.md`, or a `scripts/` entry with a `Makefile` target, and they carry different costs: a skill step runs only when someone follows the skill, a `Makefile` target runs on every gate including for external contributors who never touch `team/`.
3. **Which files the rule governs.** `team/roadmap/vX.Y.Z/` only, or all of `team/roadmap/` going forward, or `team/` plus `.agents/`? The counts above are the input to that call: roughly 300 citations in active scope and growing, 997 in closed history that this item excludes, 3 under `team/release/`, 0 under `.agents/`.

A fourth is smaller but real: the check needs an **explanation channel** for references that are deliberately dead. The tree already has them. [chan-ps-cannot-answer-what-a-workspace-is-doing](../done/chan-ps-cannot-answer-what-a-workspace-is-doing.md) at `:35` addresses a future scan directly:

> **To a future dead-reference scan: this `6c57dc33` is deliberate and will flag `DEAD` forever. Do not "fix" it.**

The audit item does the same at `:114` for a test it quotes in the present tense and that no longer exists in that form. A needle check will hit this class on its first run, and a scan that cannot tell a recorded dead reference from an accidental one will either train people to ignore it or get its evidence deleted.

## The record format, ruled 2026-08-11

Open question 1 is settled. A citation record is a line in a ```` ```citations ```` fenced block, tab separated, in the order `path`, `symbol`, `expect`, `needle`, with **the needle last and never split**. The parser splits on tab with a bound of three, so a needle containing tabs, pipes, quotes or any other delimiter survives intact.

That ordering is the whole design, and it is a direct answer to the delimiter trap this item recorded: the earlier dry run split inside the needle `|| p.q.trim().is_empty()` and reported a mismatch for a citation that was correct, which is a failure in the worst direction because it sends a reader hunting a defect that does not exist. Putting the arbitrary field last means no needle can ever be misparsed, without needing NUL separation or length prefixes.

`expect` is an integer, or `DEAD` for a reference that is deliberately dead. That is the answer to the fourth question, the explanation channel: the tree already contains recorded dead references that a scan must not "fix", and `DEAD` is how the record says so. A `DEAD` record whose needle starts matching again is reported as drift, because the record has become wrong in the other direction.

The check is `scripts/citation-check.py`. It compares literally, so regex metacharacters in a needle are data and never pattern. It classifies rather than skips: a record whose file is missing is `UNRESOLVED` and is printed, never silently dropped. A run that finds zero records exits non-zero, because zero failures over zero records examined is exactly the shape that makes a broken gate read green.

This item's own citations, in the form it mandates:

```citations
crates/chan-server/src/routes/search.rs	search_content_with_mode_resolver	1	|| p.q.trim().is_empty()
web/packages/workspace-app/src/api/client.ts	readContentSearch	1	function readContentSearch(
crates/chan-server/src/routes/search.rs	search_content	2	!readiness.is_ready()
```

Run against the tree at the time of writing, those three report `3 good`, including the deliberate two that rules out an implicit "exactly once". The checker was also shown red once by construction in each failure mode it claims to detect: a drifted count, a needle that no longer resolves, a file that does not exist, a `DEAD` record that started matching again, and a run with no records at all.

## Still open

Questions 2 and 3 are not settled and are the host's: where the check is invoked from, and which files the rule governs. The rule and the checker are written so that answer changes one line of wiring rather than the design. Nothing here is wired into a gate yet, because the item is explicit that defaulting it to CI would be deciding that question by omission.

## Acceptance

- `.agents/writing-rules.md` states the practice **with the fail-open versus fail-closed reasoning**. The reasoning is the part that survives a rule people disagree with, and its absence is why the practice has been derived three times.
- The check exists as a runnable command that takes a citation record and reports, per citation, the declared count and the actual count, so a mismatch is legible without opening the file. Verdicts: `0` means the citation is dead; equal to the declared count means good; different from it means the citation no longer identifies what it claims.
- It **classifies rather than skips**, matching the sha scan's ruling. A needle it cannot resolve is reported with its context and never silently dropped, and a needle containing regex metacharacters is compared literally with `grep -F` rather than skipped as unparseable.
- The rule and the check land in the **same change**. Neither ships alone.
- Every content needle in the governed set declares its expected match count, and every citation in the governed set is in the extractable record form.
- Run against the tree, the check reports zero unexplained mismatches, or each one is read for context and recorded, exactly as the sha scan's hits are.
- The dry run on today's only needle-citing item reproduces. At HEAD it does: `|| p.q.trim().is_empty()` occurs once in `crates/chan-server/src/routes/search.rs`, `function readContentSearch(` occurs once in `web/packages/workspace-app/src/api/client.ts`, and `!readiness.is_ready()` occurs twice in `search.rs`. Three declared counts, three actual counts, all matching, including the deliberate two.

## Sequencing

The landing barrier in `../../README.md`, at `:31` under the lifecycle, makes this an ordering constraint rather than a preference: "a process or contract change that reshapes these paths must reach `main` before the technical work that depends on it, and parallel branches rebase onto it before intake." A citation format is such a change, so it reaches `main` before the work that is written against it, and branches in flight rebase onto it rather than carrying a format of their own.

The baseline it lands against: seven of this round's other items carry positional citations, 295 between them at the last count and still rising as they were written. Nothing about that is a defect in those items, which are written to the practice the tree currently has, and this item deliberately does not ask for them to be rewritten.

## Blind spots, stated

The check verifies that a needle still matches what it claims. It cannot verify that the matched code still **means** what the item says about it: a guard that keeps its exact text while the logic around it inverts will pass. That is a strictly smaller gap than the one being closed, and no cheap check reaches it.

It cannot see a citation that names no needle at all, in prose form such as "the guard in `search_content_with_mode_resolver`". Those stay invisible to both scans and are the acknowledged uncovered class.

Nothing here is a live defect in shipped software. Every needle and prose anchor checked at HEAD currently resolves. What is live is the documentation failure, reproduced above, and its cost is a reader's time and a reader's confidence in a record that is designed to be re-run.

## Rough size

Small, now that the conversion pass is cut. The rule is three sentences in a file that is eight lines long. The check is one script: one needle per invocation, `grep -cF`, compare against a declared count. What is not small and not yet decided is the three open questions above, particularly the record format, because the checker's whole value depends on being able to extract its input without parsing prose. Sizing this as small assumes those are answered by ruling rather than by discovery; if the record format has to be designed against the existing citation styles, it is medium.
