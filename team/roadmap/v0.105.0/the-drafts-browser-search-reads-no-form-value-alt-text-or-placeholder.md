# The drafts browser search reads no form value, alt text or placeholder

Status: raised for v0.105.0 by the owner's word of 2026-10-09, from the v0.104.0 release report's follow-ups; written down, not designed, not accepted for build.

## What was seen

The browser smoke checks of the drafts work assert that a page shows no draft path mark and no draft lifetime id. They do it through one helper, `assertNothingMarkedShown` in `scripts/e2e/browser-smoke/lib/drafts.mjs`, which searches what `readable(page)` returns. At the released tree `readable` joins the body's `innerText`, the body's `textContent`, and the `title` and `aria-label` attributes of every element that has one. A form control's current value, an image's `alt` and a `placeholder` are in none of those. Checks 130, 131 and 133 call the search (six calls, by a search of the suite for the helper's name), and its positive control, `assertMarkedShownIsRefused`, which check 130 calls once, plants a marked path in a `title`, the id as text and the percent-encoded id as text, so no arm of the control covers a form value, an `alt` or a `placeholder` either.

The record names the limit three times. The author's validation report (`dev/v0104-team/reports/validation-Frontend104-browser-b1b2.md`, "Gaps and what is not claimed"): "A form control's current `value`, an `alt` and a `placeholder` are in none of those, so a marked path in the Save to Workspace prompt's input, for one, would not be found by this search. Whether that belongs in the helper is for the reviewer and the lead." The review (`dev/v0104-team/reviews/review-Review104-browser-b1b2-1.md`, "The author's five points"): true at source, outside that change, a limit of the instrument to name in the report, and the lead had ruled it no task in that round. The closed item ([drafts-and-attachments-live-inside-the-workspace](../done/drafts-and-attachments-live-inside-the-workspace.md), "Browser assertion follow-up landed 2026-10-08"): "form values, alt text and placeholders remain outside it, a source-read coverage limit unchanged by this repair." The release report repeats it in Follow-ups ("Broaden the browser search instrument if it must detect form values, alt text or placeholders") and in Known gaps (`team/release/release-v0.104.0.md`).

One sentence of the helper says more than it reads: the comment over `readable` opens "Everything a person can read or hear in the page" and then lists its text, titles and aria labels, and a person also reads an input's value and a placeholder and hears an image's alt text.

Engine: the checks ran in Chrome for Testing 155, headless, in a Linux guest with no GPU, alone and in the whole run of the candidate's and the GA commit's browser matrices, where every leg passed; the candidate's matrix ran debug binaries.

Not established: that any page of the product puts a draft's marked path or lifetime id into a form value, an `alt` or a `placeholder`. The limit is a source reading of the helper; the Save to Workspace prompt's input is the author's example of where one would go unseen, not an observed leak, and no run searched those places. Which drafts surfaces carry such fields was not listed. Nothing here was read in a native webview.

## Desired contract

The item asks for a decision: whether the drafts checks must find a mark or an id in form values, alt text and placeholders. If they must, the search reads those sources and each one has a positive control that requires its own refusal; if not, the helper's comment and the suite's README say what the search does not read.

## What to do

Read which surfaces of the drafts flows can put a draft's path or id into a form control, an image's `alt` or a `placeholder`, starting from the one the record names, the Save to Workspace prompt's input, and list them with the source line that fills each. Put that list and the choice to the lead. If the search is widened, build it red first: a plant for each new source in the control, failing at the commit before the search reads it.

## Boundaries

`scripts/e2e/browser-smoke/lib/drafts.mjs`, checks 130, 131 and 133 under `scripts/e2e/browser-smoke/checks/`, and the suite's `README.md`. The helper keeps leaving URLs out, since an image's address rightly carries its draft's id, as its comment says. No product file: a leak that a wider search finds gets an item of its own.

## Acceptance

1. A written list of the drafts surfaces whose form values, alt text or placeholders can carry a draft's path or id, from a source read, with the decision recorded beside it.
2. If the search is widened: it reads each decided source; the control plants one value in each and requires that source's own refusal; the control is red at the commit before the widening on exactly the new plants and on nothing else.
3. Checks 130, 131 and 133 pass alone at the tip with no skip, in the suite's Chrome; a red there is read and kept, not run again until green.
4. If the search is not widened: the comment over `readable` and the suite's README state what it does not read.
5. The record names the browser and says that no native webview was observed.
