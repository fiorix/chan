# The Outline marks the last slide current after a jump that scrolls the editor to its bottom

Status: raised for v0.109.0 on 2026-10-21 by the lead, from the review seat's placement of browser check 173's red; closes in the round.

## What was seen

In a ten-slide deck with the editor's Outline open, a click on the thumbnail of slide 8 or 9 leaves slide 10 marked current. `web/packages/workspace-app/src/components/FileEditorTab.svelte` 491 to 511 derives the Outline's line from the editor's scroll position: when the scroller is at its bottom (`scrollTop + clientHeight >= scrollHeight - 2`) it writes the document's last line, and otherwise the first visible line. The Outline reads `outlineScrollLine ?? caretLine` (1540). A selection or document change clears `outlineScrollLine` (510), but the jump to slide 8 or 9 scrolls the editor to its bottom, the scroll event lands after the selection update, and the bottom rule marks slide 10 current over the clicked slide. Whether a run shows it depends on layout timing: the review seat saw it in 4 of its 20 runs of the check alone and its probe copy in a two-CPU guest, one at each of the four commits read, the version's base included (`dev/v0109-team/evidence/Review109/c173/`, the probe reading `{"current":["Slide 10"],...}` at the timeout); the check's red rate with its own unwaited reads counted was 7 of 20. The behaviour came with the floating Outline in v0.108.0.

## Desired contract

After a jump from the Outline, the clicked slide stays current whatever scroll position the jump lands at: for the scroll a jump causes, the Outline follows the caret's line wherever the scroller rests; a person's own scroll keeps today's rules, the first visible line and the last line at the bottom.

## What to do

Mark the jump in `jumpTo` after its dispatch, so the jump's own selection change does not clear it. While the mark stands, the scroll handler's `read` returns the caret's line (the editor view's selection head, not the coalesced tab caret) at any scroll position, in place of both the first-visible-line rule and the last line at the bottom, since the jump's own scroll can land with the clicked slide's heading off the first visible line as well as at the document's end. A later selection or document change clears the mark, and so does a user scroll input (a wheel or touch scroll, or a pointer down on the scroller outside the content); once it is cleared both rules apply as before. Pin red first, in a mounted `FileEditorTab` test. The jump arm has two legs: a jump to a late slide followed by a forced scroll to the bottom, and a jump followed by a scroll event whose position is away from the bottom with another slide's heading first visible; each asserts the clicked slide current and is red at the parent on its own assertion. Four own-scroll legs each jump first and then clear the mark: by a selection change to an earlier visible heading, a wheel event, a touchstart on the scroller, and a pointer down on the scroller outside the content; each then forces a bottom scroll with the caret visible and asserts the last slide current, green at the parent and at the fix. One mutant per guard, each red at its own arm: the read ignoring the mark (both legs of the jump arm), the selection-change clear removed (its leg), and each user-input clear removed (its leg: the wheel, the touch and the scrollbar press). Then check 173 alone, repeated, with the check's own unwaited reads repaired first.

## Boundaries

`web/packages/workspace-app/src/components/FileEditorTab.svelte` at the scroll handler and its test. Lands after the check's own repair and before the rich prompt item, which edits the same component elsewhere (`--editor-top-pad`, 1559 and 1671) and rebases on it. Not changed: the Outline component, the caret rule, the jump.

## Acceptance

1. The mounted pin's jump arm red at the parent on both of its legs and green at the commit, its own-scroll legs green at both, one mutant per guard red, with the commands and logs recorded here.
2. Check 173 alone green in repeated runs at the commit with the check's own repair landed, against the review seat's rate at the parent, recorded here.
3. `make web-check` green at the commit.
