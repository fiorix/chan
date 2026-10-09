# The release procedure names no ci.yml run on a candidate's branch

Status: raised for v0.105.0 by the owner's word of 2026-10-09, from the v0.104.0 release report's follow-ups; written down, not designed, not accepted for build.

## What was seen

[The release procedure](../../../.agents/skills/release/SKILL.md), read in the released tree `af2af8ac0` ("The cycle"), asks for three dispatches on a candidate's branch, all in its step 4: `release.yml` with `publish=false`, and `publish-downstream` twice with `publish=false` (`targets=docker`, then `targets=cachix`). Its step 6 asks for `make windows-cross-check` on the candidate and says of it: "It does not link or smoke a Windows binary, and `ci-windows` remains the authority for that". It names a `ci.yml` dispatch only in step 8, for the GA commit: "`ci.yml` triggers on `main` and pull requests only, so a release branch gets no automatic run; dispatch it with `gh workflow run ci.yml --ref <branch>` and wait for it". No step says to dispatch `ci.yml` on a candidate. `.github/workflows/ci.yml` has `workflow_dispatch` among its triggers (line 26) and holds the jobs `make ci-linux`, `make ci-macos`, `make ci-windows`, `Linux deb + rpm`, `COPR + PPA source packages`, the two `AUR build + smoke` jobs, `Nix chan-desktop` and `chan container`.

What three versions did:

- v0.102.0 made no `ci.yml` run on a candidate. Its report's Retrospective: "The round's Windows tests first ran at the GA commit. No CI run was made on a candidate, and the candidates' dry runs build the Windows packages without running tests, so `make ci-windows` first ran this round's code after the pin commit was cut. Its one red was a time guard and not the product, and it still cost the cut a repair commit and a second round of proofs" ([release-v0.102.0](../../release/release-v0.102.0.md); the red is in its Validation, run `37361189679`).
- v0.103.0 ran `ci.yml` on its candidate (run `37561118821`), "the first run of this round's code on Windows and the first `Nix chan-desktop` check of the rc0 hashes". That run found `make ci-macos` red once, and its two AUR jobs were green without a build, "which they skip at a prerelease pin" ([release-v0.103.0](../../release/release-v0.103.0.md), Validation).
- v0.104.0 made none again: "No `ci.yml` run was dispatched on the candidate" (Validation), "Neither `ci.yml` nor Gateway CI was dispatched on the candidate" (Platform and pipeline), and its Follow-ups ask to "Dispatch `ci.yml` on a candidate's branch when it is cut, as the v0.102.0 round learned" ([release-v0.104.0](../../release/release-v0.104.0.md)). The GA commit's own run, `37887428855`, was green in nine of nine jobs (`dev/v0104-team/reports/decisions-Lead104.md`, the section of 2026-10-09T06:30:29Z), so this time the late first run cost the cut nothing.

What did run on a v0.104.0 candidate for Windows, by that report's Validation and Known gaps: the gate's Windows GNU test-target lint, "which compiles and executes no Windows binary"; `make windows-cross-check`, where "Nothing ran on Windows"; and the Release dry run's signed Windows packages and its Windows headless health smoke. The same Validation names what first met the version's code at the GA commit: `make ci-windows`, the Linux deb and rpm jobs, the COPR and PPA source packages and the AUR jobs.

Not established: that a candidate run would have found anything in v0.104.0, since the GA run was green. What a candidate run costs here: the procedure's step 7 names a 35 to 55 minute CI wait for a re-cut GA commit, and no figure for a candidate's run was read. What it does to the Rust cache: the workflow's header says a branch run does not write the shared keys, and that was not measured. Whether Gateway CI belongs in the same step: `.github/workflows/gateway-ci.yml` also has `workflow_dispatch` (line 60), the v0.104.0 report notes that it was not dispatched on the candidate, and the procedure does not name that workflow at all.

## Desired contract

A candidate's branch gets its own `ci.yml` run before the GA commit is cut, so that the Windows test suites and the packaging jobs meet a version's code while a red still costs a candidate and not the cut; the procedure says so, and says what that run cannot see (the AUR builds at a prerelease pin, and the GA pin's own lockfiles and hashes). The item asks for a decision on when: at every candidate, or at the last candidate before GA; and on whether Gateway CI is dispatched with it.

## What to do

Read the three reports' accounts side by side and write the step as the procedure's own text, beside the dispatches of step 4 and the platform checks of step 6, without weakening step 8: the GA commit's own run stays required. State in it what a candidate run covers that the dry run and the cross-check do not, and what only the GA run covers. Put the two choices (every candidate or the last one; with or without Gateway CI) to the lead with the wall time of the v0.103.0 candidate run and of the v0.104.0 GA run read from GitHub.

## Boundaries

`.agents/skills/release/SKILL.md`, and `.agents/skills/gate/SKILL.md` where it repeats the release checklist. No workflow file changes: `ci.yml` and `gateway-ci.yml` already accept a dispatch. The requirement of a green `ci.yml` run on the GA commit before the tag is unchanged.

## Acceptance

1. The procedure names a `ci.yml` dispatch on a candidate's branch, with its command, the point of the cycle at which it runs and what a red there means for the candidate.
2. The procedure says what that run does not cover, naming the AUR builds at a prerelease pin and the GA pin's lockfiles and hashes, and keeps step 8's requirement in its own words.
3. The decision on every candidate or the last one, and on Gateway CI, is recorded in this item.
4. The text is read against the v0.102.0, v0.103.0 and v0.104.0 records: under it the first `make ci-windows` run of v0.102.0's and of v0.104.0's code would have been on a candidate, and nothing in it contradicts what v0.103.0 did.
5. The next version's report names its candidate's `ci.yml` run by id, or says why none was made.
