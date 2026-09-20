# Editor triggers fire inside syntax that already exists

Status: accepted for v0.100.0 by the owner on 2026-09-20. Raised on the owner's instruction to fold the frontend review's most critical findings into this version. From the review (findings BUBBLES-01 high, BUBBLES-02 and the date half of ECS-03 medium), re-verified against `main` at `d3de0180b`. The reviewer reproduced BUBBLES-01 in a scratch vitest against a parsed markdown state.

## What was seen

Three text scans decide from the characters before the caret and never ask the syntax tree where the caret is.

**An image's alt text.** With the caret inside the alt text of an already-formed image, two ArrowLeft presses from where a click parks it, `computeBubbleSpec` in `web/packages/workspace-app/src/editor/bubbles/triggers.ts` misses its URL-slot branches and its `matchBracket(before, "![", "]")` scan opens the image bubble in wrap mode. Enter replaces only `![al`, and the line becomes `![](./other.png#w=250)t](img.png#w=250)`. The empty-alt case is worse: an empty query pre-fills the list, so Enter always commits something.

**A heading marker.** Typing the `#` of a heading matches `matchAtTrigger(before, "#")`, opens the tag picker and fires a graph fetch; the Enter that ends the heading line commits a tag over the marker.

**A fenced code block.** `detectTrigger` in `editor/commands/date_macros.ts` expands `@today` and `@date` on Space or Enter inside a fence, rewriting a literal code sample. `enclosingFence` in `editor/commands/fence.ts` is the helper that answers the question, and `commands/format.ts` and `commands/list.ts` already use it. The page-break macro has the same hole and is handled in [four-detectors-disagree-about-page-breaks](four-detectors-disagree-about-page-breaks.md).

Each of these destroys text the user already wrote, with the keystroke they would press anyway.

## Desired contract

A trigger scan asks the tree before it fires. Inside an existing `Image` or `Link` node only the URL-slot branches may open a bubble; the tag picker stays closed for the two shapes that can still become a heading marker, a bare `#` opening a line with no query yet and any trigger that already has a `#` before it on an otherwise blank prefix (`##`, `###`, `##todo`); inside a fenced code block no macro expands. A line that opens with `#tag` keeps its picker: `#t` cannot be a heading, and a line that starts with a tag is ordinary writing. The first wording of this contract closed the picker for every trigger after a whitespace-and-`#` prefix, which came from the review and not from the owner; the lead narrowed it on 2026-09-20 and told the owner.

## Boundaries

`web/packages/workspace-app/src/editor/bubbles/triggers.ts` and `triggers.test.ts`, `editor/commands/date_macros.ts` with a new test. The bail for images goes after the three URL and wikilink branches and before the `matchBracket` scans, so the wrap trigger for a freshly typed `![query` is unaffected: an incomplete `![alt` is not an `Image` node. For headings the review's own column-zero test is not enough, because for `## ` the trigger starts at the second `#`. Keep `widgets/imageExcalidraw.test.ts` green.

## Acceptance

1. `computeBubbleSpec` returns no spec for a caret in the alt text of a formed image and of a formed link, including the empty-alt case, and still returns the wrap spec for a freshly typed `![query`.
2. Typing `#`, `##` and `###` at the start of a line opens no tag picker, and neither does a query typed against `##`. A `#tag` later in a line still opens it, and so does a `#tag` that opens a line once its query is not empty.
3. `@today` and `@date` inside a fenced code block stay literal, and still expand outside one.
4. Each case is a behavioural test on a parsed state, not an assertion on source text.
