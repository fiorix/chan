# The release procedure names no ci.yml run on a candidate's branch

Status: carried into v0.106.0 at the v0.105.0 GA on 2026-10-11; the lead ruled on 2026-10-12 (see "Lead's decision") and wrote the step into the procedure the same day.

Record before the release: raised for v0.105.0 by the owner's word of 2026-10-09, from the v0.104.0 release report's follow-ups; written down, not designed, not accepted for build.

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

## Lead's decision 2026-10-12

The lead of the v0.106 round read the three reports side by side with the v0.105.0 report, which postdates this item, and the runs on GitHub. Wall times, from each run's creation to its last job's end: v0.103.0's candidate run `37561118821` on `0.103.0-rc0`, 02:15:32Z to 03:44:40Z on 2026-10-07 (89 minutes, of which the macOS job waited 57 minutes for a runner and ran 32; `make ci-linux` 56 minutes, `make ci-windows` 36); v0.104.0's GA run `37887428855` on `0.104.0-ga`, 05:12:01Z to 06:08:51Z on 2026-10-09 (57 minutes; `make ci-linux` 57, `make ci-windows` 36, `make ci-macos` 33, the two AUR jobs 36 at a GA pin); v0.105.0's candidate run `38072526544` on `osc7501-int` at `6a0e16b16`, 17:37:58Z to 18:16:22Z on 2026-10-10 (38 minutes) and its rc0 run `38120998265`, 07:19:53Z to 08:44:57Z on 2026-10-11 (85 minutes, with one macOS rerun of a pre-existing timing test); its Gateway CI run `38120999644` on the same rc0, 4 minutes 42 seconds; its GA run `38126893734`, 09:01:36Z to 09:51:45Z on 2026-10-11 (50 minutes).

Ruling: `ci.yml` is dispatched on every candidate's branch when the candidate is cut, beside the step-4 dry run, and Gateway CI with it. Every candidate rather than the last: a candidate is cut because fixes landed, each candidate run is the first time those fixes meet Windows and macOS, and the cost is wall time alone, since a branch run writes no shared cache key and runs beside the dry run it already waits for. Gateway CI with it: five minutes, and the candidate's pin bump touches `Cargo.toml` and the web lock, which are among its triggers, so the GA push to `main` runs it anyway and a candidate should see the same. Written into the procedure's step 4 (the dispatch, what it covers and what only the GA run covers), step 6 (the greens confirmed on the same candidate) and the gate skill's line on the platform checks, with step 8 unchanged; acceptance 4 was read: under the text, v0.102.0's and v0.104.0's first `make ci-windows` runs would have been on a candidate, and v0.103.0 did what the text says. Acceptance 5 falls to the v0.106.0 report.
