# AUR publication is suspended and needs a deliberate restoration

Status: REGISTERED for v0.86.0, suspended 2026-08-06 during the v0.85.0 delivery round.

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

`scripts/check-build-matrix.py:286` requires the literal string `aur-validate:` to appear in this workflow, and `Makefile:211` runs it inside the gate. `require` is a plain substring test, `if needle not in haystack`.

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

The three guards are intact in their wrapped form (`publish-downstream.yml` lines 403, 461, 502) and `aur-validate` remains a hard `needs` of `aur-publish` (line 510). The restoration condition is not met: the news index shows nothing newer about the incident, and the only follow-up anywhere is a 2026-07-23 community post on aur-requests stating the compromised packages were cleaned, which is exactly the half-notice this item already rules insufficient. The item stays blocked and carries no v0.86.0 round work beyond re-checking the news page.

## Rough size

Very small as a code change, one line per job. The judgement is entirely in reading the Arch announcement and deciding the condition is met.
