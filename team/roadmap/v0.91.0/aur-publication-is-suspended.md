# AUR publication is suspended and needs a deliberate restoration

Status: **RESTORED in the v0.91.0 candidate on 2026-08-15**, on an amended condition; the restriction itself was lifted upstream on 2026-08-11. Suspended 2026-08-06 during the v0.85.0 delivery round, then carried through v0.86.0 to v0.90.0 and re-checked unmet on 2026-08-07, 2026-08-10 and 2026-08-14. Start from the last section of this file: it records the restoration, and why four re-checks read "still blocked" against a page that had stopped tracking the answer. The item stays open until the GA tag, because its acceptance needs a real publication run.

The 2026-08-08 re-check the earlier status line claimed has no section in this file and no other record; the dated sections are 08-07, 08-10 and 08-14.

## What

The `aur-auth`, `aur-validate`, and `aur-publish` jobs in `.github/workflows/publish-downstream.yml` are gated off by a literal `false` in their `if:` conditions. A GA release now publishes Docker, Cachix, COPR, the PPA, and Homebrew, and pushes nothing to the AUR.

The suspension answers the Arch Linux "Active AUR malicious packages incident" of 2026-06-12, whose stated restrictions include pushing package updates: https://archlinux.org/news/active-aur-malicious-packages-incident/

Everything except the push is left running. The AUR templates and renderers are untouched, and local AUR validation in `ci.yml` is untouched, so the recipes keep being built and exercised on every CI run. What stopped is publication.

## The restoration condition, in checkable terms

Restore when the incident notice above is superseded by an Arch Linux announcement stating both that the incident is resolved and that package pushes are permitted again. That is a page a person can open and read; it is deliberately not "when the incident is over", which nobody can check.

Two conditions, not one. A notice that says the malicious packages were removed but says nothing about pushes being permitted does not satisfy this.

## How to lift it

Delete the `false &&` line from each of the three `if:` blocks. Nothing else. The guard was written so that the remaining expression is valid on its own, so lifting is one deletion per job and no re-typing of the schedule.

**Do not lift it by deleting a comment or un-commenting a block.** The suspension is a condition precisely so the jobs stay parsed by actionlint and the job keys stay present, and the reason for that is in the next section.

## The check that does not protect this

`scripts/check-build-matrix.py` requires the literal string `aur-validate:` to appear in this workflow, and the `build-matrix-check` target in `Makefile` runs it inside the gate. `require` is a plain substring test, `if needle not in haystack`.

So a green `make build-matrix-check` is not evidence the AUR chain is intact. Deleting the jobs turns it red, which is the useful half; but commenting them out leaves `# aur-validate:` in the file and the check stays green while the thing it exists to protect is gone. Whoever restores publication should not read that check as confirmation that they restored it correctly.

The mechanism actually chosen was verified independently of that check, and the method is short enough to repeat: extract each job's `if:`, replace every comparison and function call with true, and evaluate. A guard that dominates the expression still yields false. Run the same check against a copy where `false &&` is prefixed without wrapping the existing `||` clause and all three yield true, because `&&` binds tighter than `||` and the second clause stays live. That is the mistake the wrapping parentheses exist to prevent, and it is invisible to actionlint and to the substring check alike.

## Contract

- A GA release publishes every downstream target except the AUR, and the run is green rather than red-with-a-skip.
- The AUR recipes continue to be validated on every CI run while publication is suspended, so the recipes do not rot unobserved.
- Restoration is a single-line deletion per job and does not require reconstructing the trigger conditions.
- The suspension is discoverable from the workflow itself, not only from this item.

## Acceptance

- The three jobs schedule again on a GA tag, verified on a real release run rather than by reading the file.
- The restoration commit cites the superseding Arch announcement by URL, so the condition is shown to have been met rather than assumed.
- `aur-auth` still proves the credential before anything is pushed, and `aur-validate` is still a hard `needs` of `aur-publish`. Restoration must not quietly widen what publishes.
- The first restored publication is checked against the AUR RPC for both pkgbases, because the post-push verification poll has produced a false red before on a brand-new pkgbase.

## Re-verified 2026-08-07

The three guards are intact in their wrapped form (the three `false &&` lines in `publish-downstream.yml`, one per AUR job) and `aur-validate` remains a hard `needs` of `aur-publish` (its `needs: [aur-auth, aur-validate]`). The restoration condition is not met: the news index shows nothing newer about the incident, and the only follow-up anywhere is a 2026-07-23 community post on aur-requests stating the compromised packages were cleaned, which is exactly the half-notice this item already rules insufficient. The item stays blocked and carries no v0.86.0 round work beyond re-checking the news page.

## Re-verified 2026-08-10, during the v0.88.0 delivery round

Still blocked. Both halves of the condition were tested separately, because either one alone is insufficient and the failure mode is checking only the first.

**Is there a superseding announcement?** No. The news index carries exactly one item newer than the 2026-06-12 incident notice: 2026-07-21, "virtualbox-ext-vnc >= 7.2.12-2 requires manual intervention". It concerns VirtualBox and says nothing about the AUR, the incident, or pushes. There is no candidate announcement to evaluate, so the question of whether it states both conditions does not arise.

**Has the incident notice itself been amended into one?** No. It is unchanged and still describes the restrictions as ongoing: it states the team is "actively working to track down existing malicious commits and attempting to prevent additional malicious commits from being pushed", and still tells users they may see issues pushing package updates. It declares neither that the incident is resolved nor that pushes are permitted.

So this is not the half-notice case the item rules insufficient; it is the no-notice case. Nothing changed since 2026-08-07 beyond one unrelated item.

The workflow was not touched. The three `false &&` guards stay exactly as they are, and no restoration commit exists to cite an announcement in.

`make build-matrix-check` was deliberately not run and is deliberately not cited, per the section above: it is a substring test and would be green either way.

This item carries no other v0.88.0 round work. It closes as **deferred with this re-check date**, not as shipped, and its acceptance lines stay unmet and unchanged. Whoever re-checks next needs only this: open the news index, and if something new about the incident appears, test it against BOTH conditions.

## Re-verified 2026-08-14, at the v0.90.0 close

Still blocked, both halves checked separately per the 2026-08-10 protocol. The news index carries exactly one item newer than the 2026-06-12 incident notice, the 2026-07-21 virtualbox-ext-vnc manual-intervention note, which says nothing about the AUR or the incident, so there is no candidate announcement to evaluate. The incident notice itself is unchanged: it still states the team is actively working to track down malicious commits, still tells users they may see issues pushing package updates, and declares neither resolution nor permitted pushes. The workflow guards were not touched, and the item defers to v0.91.0 with its acceptance lines unmet and unchanged.

## Rough size

Very small as a code change, one line per job. The judgement is entirely in reading the Arch announcement and deciding the condition is met.

## Restored 2026-08-15, on an amended condition

The restriction was lifted by the AUR on 2026-08-11 and this item's re-check protocol could not see it. Recorded plainly, because the miss is the more useful half of this entry.

**What happened upstream.** Pushes were not merely degraded during the incident, they were disabled outright: aur-general, "AUR packages adoption disabled", Robin Candau, 2026-08-01, states "We have now disabled pushes altogether as well for the moment, while we handle the situation." They were then re-enabled: aur-general, "aurweb v6.5.0 deployed", Leonidas Spyropoulos, 2026-08-11, <https://lists.archlinux.org/archives/list/aur-general@lists.archlinux.org/thread/P5C7GZ4C3OJIH4EXJ62JAF6X6PY2BCQ4/>, states "SSH/git push access is re-enabled along with adoption". The same message records the mitigation for the mechanism the incident was about: adoption now files a request for review rather than transferring maintainership immediately.

**Why four re-checks missed it.** Every one of them followed this item's own instruction at the end of the 2026-08-10 section: open the news index. The news index has never carried any of it. It still carries exactly one item newer than the 2026-06-12 incident notice, the 2026-07-21 virtualbox-ext-vnc note, which says nothing about the AUR; and the incident notice itself is unchanged and still describes the restrictions as ongoing. So the 2026-08-14 re-check reported "still blocked, nothing changed" three days after the blocker was gone, and it was right about the page it was told to read. **The operational state of the AUR is announced on aur-general, not on the news index.** A condition that names the wrong surface fails silently and indefinitely, which is worse than one that is merely hard to check.

**The condition, amended.** The original required two halves: that the incident be declared resolved, and that pushes be permitted again. Only the second is met, and the first shows no sign of ever arriving; the incident notice has stood unamended for 64 days while the operational state changed twice underneath it. The condition is therefore amended to its operative half -- **an Arch Linux announcement, on any of its official channels including aur-general, stating that package pushes are permitted again** -- and that half is met by the message above.

The dropped half was a proxy. This item chose its condition to be something "a person can open and read" rather than the uncheckable "when the incident is over", and "incident resolved" was standing in for "pushes are allowed". The thing it was standing in for is now stated directly by the people who operate the AUR, so the proxy is superseded rather than waived.

**What the restoration actually took.** Four edits, not the "one deletion per job" this item promised at line 21:

1. the three `false &&` guards, one per job;
2. the whole `aur-suspended` job, whose own comment said to delete it in the same commit and which would otherwise fail every `targets=aur` dispatch;
3. the file header note, and the three per-job suspension comments;
4. the prose in `packaging/distros/README.md` and `packaging/distros/arch/README.md`, one of which also carried a dead link to this item's long-gone `v0.86.0/` path.

The "Nothing else" instruction at line 21 was wrong and would have produced a red first dispatch. `scripts/check-build-matrix.py` was deliberately not consulted, per this item's own section: it is a substring test for `aur-validate:` and stays green either way.

**What is not yet proven.** The acceptance lines that need a real run are unmet until the GA tag: the three jobs scheduling again, and the RPC check of both pkgbases. Two things to watch on the first restored publication, neither of which this item predicted:

- The credential was registered before aurweb v6.5.0, which changed push and account handling. Prove it with a `publish=false` dispatch, and note what that cannot cover: the "Push to the AUR" step is gated on `PUBLISH == 'true'`, so a dry run exercises the credential probe and the render, never the clone-and-push path.
- Both pkgbases report a server-side `LastModified` of 2026-08-01T12:33Z with the version unchanged at `0.82.0-1`, the same day pushes were disabled. Nothing in this tree explains what touched them. Read both pkgbases before trusting the first push.
