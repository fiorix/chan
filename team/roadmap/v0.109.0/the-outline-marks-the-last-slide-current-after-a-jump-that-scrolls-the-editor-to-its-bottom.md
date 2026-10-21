# The Outline marks the last slide current after a jump that scrolls the editor to its bottom

Status: raised for v0.109.0 on 2026-10-21 by the lead, from the review seat's placement of browser check 173's red; closes in the round.

## What was seen

In a ten-slide deck with the editor's Outline open, a click on the thumbnail of slide 8 or 9 leaves slide 10 marked current. `web/packages/workspace-app/src/components/FileEditorTab.svelte` 491 to 511 derives the Outline's line from the editor's scroll position: when the scroller is at its bottom (`scrollTop + clientHeight >= scrollHeight - 2`) it writes the document's last line, and otherwise the first visible line. The Outline reads `outlineScrollLine ?? caretLine` (1540). A selection or document change clears `outlineScrollLine` (510), but the jump to slide 8 or 9 scrolls the editor to its bottom, the scroll event lands after the selection update, and the bottom rule marks slide 10 current over the clicked slide. Whether a run shows it depends on layout timing: the review seat saw it in 4 of its 20 runs of the check alone and its probe copy in a two-CPU guest, one at each of the four commits read, the version's base included (`dev/v0109-team/evidence/Review109/c173/`, the probe reading `{"current":["Slide 10"],...}` at the timeout); the check's red rate with its own unwaited reads counted was 7 of 20. The behaviour came with the floating Outline in v0.108.0.

## Desired contract

After a jump from the Outline, the clicked slide stays current whatever scroll position the jump lands at: for the scroll a jump causes, the bottom rule yields to the caret's line; a person's own scroll keeps today's rule, the last line at the bottom.

## What to do

Mark the jump in `jumpTo` after its dispatch, so the jump's own selection change does not clear it. While the mark stands, the scroll handler's `read` returns the caret's line (the editor view's selection head, not the coalesced tab caret) instead of the last line at the bottom. A later selection or document change clears the mark, and so does a user scroll input (a wheel or touch scroll, or a pointer down on the scroller outside the content). The first-visible-line rule is unchanged. Pin red first, in a mounted `FileEditorTab` test. The jump arm jumps to a late slide, forces a scroll to the bottom and asserts the clicked slide current; it is red at the parent on its own assertion. Two own-scroll legs each jump first and then clear the mark, one by a selection change to an earlier visible heading and one by a wheel event; each then forces a bottom scroll with the caret visible and asserts the last slide current, green at the parent and at the fix. Three mutants, each red at its own arm: the read ignoring the mark (the jump arm), the selection-change clear removed (its leg), and the user-input clear removed (its leg). Then check 173 alone, repeated, with the check's own unwaited reads repaired first.

## Boundaries

`web/packages/workspace-app/src/components/FileEditorTab.svelte` at the scroll handler and its test. Lands after the check's own repair and before the rich prompt item, which edits the same component elsewhere (`--editor-top-pad`, 1559 and 1671) and rebases on it. Not changed: the Outline component, the caret rule, the jump.

## Acceptance

1. The mounted pin's jump arm red at the parent and green at the commit, its two own-scroll legs green at both, the three mutants red, with the commands and logs recorded here.
2. Check 173 alone green in repeated runs at the commit with the check's own repair landed, against the review seat's rate at the parent, recorded here.
3. `make web-check` green at the commit.
