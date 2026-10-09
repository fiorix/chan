# The release procedure is silent on a seat refused the push of main and the tag

Status: raised for v0.105.0 by the lead on 2026-10-09, from the round's record of the refused tag push of that day, which the v0.104.0 release report predates, and reported to the owner with the other left-overs; written down, not designed, not accepted for build.

## What was seen

On 2026-10-09 every check the owner's answer named stood green at the GA commit `af2af8ac0136705a7d2933b9dbc5c51c535d76b0`, and the owner had answered "Publish when green, no further ask" at 04:41:05Z. At 06:29Z the lead seat, an agent session on the Linux development box, ran its reviewed script once (`dev/v0104-team/evidence/Lead104/rc/ga-tag.sh`, whose header reads: fast-forward `main` on GitHub, annotate the tag, push the tag in the foreground, read both back). The record says the call "was denied before it started by the Claude Code auto mode classifier", with the words "Permission for this action was denied ... Reason: [Create Public Surface]". Nothing ran: no local tag existed, and a read of the remote at 06:29:43Z showed `main` unmoved, the branch `0.104.0-ga` at the GA commit and no tag (`dev/v0104-team/reports/decisions-Lead104.md`, the section of 2026-10-09T06:30:29Z).

The lead ruled in that section that "the refusal is not worked around, in any form (no smaller pieces, no other tool, no other seat)" and put it to the owner by survey with three options: the owner runs the one line at the lead tab's prompt; the owner adds a permission rule and the lead retries; or hold (`dev/v0104-team/evidence/Lead104/surveys/ga-tag-refused.body.md`). The answer, at 06:38:41Z, was "I run the tag line myself" (the section of 06:38:59Z). The owner ran it: `main` moved at 06:39:15Z and the tag was pushed at 06:39:17Z (the section of 06:40:10Z), about ten minutes after the refusal. Earlier the same day the same seat had pushed two branches without a refusal: the candidate branch `0.104.0-rc0` at 03:12Z (the section of 03:13:59Z), and the branch `0.104.0-ga` at 05:11Z (`dev/v0104-team/evidence/Lead104/pushes/ga-branch.started` and `ga-branch.log`), which the read of 06:29:43Z found.

[The release procedure](../../../.agents/skills/release/SKILL.md) in the released tree `af2af8ac0` says under "Actors" that the release owner "owns `main`, the RC branches, the final tags, and the publish decision", and that host agents "review, gate, and report, but never own the release decision". Its step 8 says to annotate and push the tag in the imperative, without naming who types it, and its invariant "Push tags in the foreground" covers how. Nothing in it says that an agent seat's session may refuse the push, what the seat does then, or that the line and its checks should stand ready for the owner to run. The [v0.104.0 report](../../release/release-v0.104.0.md) was cut inside the GA commit, before the refusal, and does not mention it; its Retrospective records an earlier refusal by the same seat's permission check, of a host run the lead had ruled on its own after a survey timed out, with the word "rightly".

Not established: that the check refuses every such push. This is one refusal of one script, on one day, in one client and one mode; by the lead's ruling a push of `main` alone or of the tag alone was not tried. Whether a permission rule would have let the seat push: the option was offered and not taken. Which part of the script the refusal answers to: the tag, `main`, or the publication the tag starts. What another client or another approval mode does: not observed. The lead's later note that a documents push to `main` "may be refused by the session's permission check as the tag push was" (the section of 07:55:57Z) is an expectation, not an observation.

## Desired contract

The release procedure says who performs the push of `main` and the tag, and what an agent seat does when its session refuses a publishing step: stop, change nothing, hand the owner one reviewed line, and take the release watch afterwards. The item asks the owner for the rule, and the procedure then states the one chosen: the owner always runs the publishing line; or a named permission rule lets the lead seat run it after the owner's go.

## What to do

Put the choices to the owner with the v0.104.0 record: the owner runs the line, as happened; a standing permission rule for the two pushes; or a grant given per release. Write the answer into the procedure's "Actors" and step 8, with the preparation it implies for a round: the script written and reviewed before the greens are in, its refusals rehearsed, and the one line shown to the owner. List the other publishing acts of a cycle (the candidate branch push, the workflow dispatches, the RC branch's deletion, a documents push to `main` after the freeze) and say for each what v0.104.0 observed and what it did not.

## Boundaries

`.agents/skills/release/SKILL.md`; and, if the answer is a permission rule, the one settings file that holds it, changed by the owner or on the owner's explicit word. No seat changes its own permission settings, and no script splits or reroutes a refused step. The release's checks, the tag's form and the workflows are unchanged.

## Acceptance

1. The owner's answer is recorded in this item in the owner's words, with its date.
2. The procedure names who runs the push of `main` and the tag, and says what a seat does when its session refuses a publishing step; read against the record of 2026-10-09, following the text would have produced what was done, or the difference is stated.
3. If the answer is a permission rule: the rule is quoted in this item, was added by the owner, and one publishing step run under it is recorded with its result; a refusal under the rule is recorded as a red.
4. The procedure lists each publishing act of a cycle with who performs it.
