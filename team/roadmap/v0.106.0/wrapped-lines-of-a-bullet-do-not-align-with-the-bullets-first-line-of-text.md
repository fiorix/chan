# Wrapped lines of a bullet do not align with the bullet's first line of text

Status: raised by the owner on 2026-10-13, during the v0.106.0 round, in the lead's terminal with a screenshot; accepted as scope and for a repair in this version by his words; written down the same day by the lead; owner the frontend seat; first step a constructed case; not designed

## What was seen

The owner's words: "the vertical alignment of bullet points is not aligned, we need to make it properly aligned when the lines break onto multiple lines", and of the item, "to be fixed in this version". His screenshot of the rendered editor (kept in the round's bus as `evidence/Lead106/bulwrp/owner-screenshot.png`) shows a list of `-` items. In each item that wraps, the second line starts a little to the left of where the first line's text starts, by about one space's width as the lead reads the image by eye: the first line's text near 160 px from the image's left edge, the wrapped line near 152 px, the marker near 82 px, in an image 392 px wide. Items of one line show the first-line position only.

Read at source by the lead, not constructed: a list line gets its indent and its hanging indent from `decorateListIndents` in `web/packages/workspace-app/src/editor/decorations/blocks.ts` and from the rule in `Wysiwyg.svelte` that sets `padding-left` and a negative `text-indent` from `--cm-md-list-hang-col`. Not established: what the screenshot's items hold between the marker and the text (one space, two, a tab, or a pasted space of another kind), the font and the zoom, and whether the offset is a hang column that counts one character where the line holds more, or a width measured in one font and applied in another. The hypothesis the image suggests, to be tested first: the hang is the marker and one space, and the first line carries more than that.

## Desired contract

In the rendered editor, every wrapped line of a list item starts at the same horizontal position as the item's first line of text, at every depth, for `-`, `*`, `+` and numbered markers and for a task item.

## What to do

Construct the case in a guest's Chrome on a one-space item and on the variants named above (two spaces, a tab, a pasted non-breaking space), at depth one and two, and measure the left edge of the first line's text and of each wrapped line; name the variant that reproduces the screenshot. Then the design to the review seat before code. Keep the marker's own position and the caret's behaviour beside the marker as they are: the item `bulrtl` (typing beside a bullet's marker) reads the same decoration, and its reading is rerun.

## Boundaries

`web/packages/workspace-app/src/editor/decorations/blocks.ts` and the list rules of `Wysiwyg.svelte`. Not changed: the document's text (no whitespace is rewritten on load or on save), the source view, and the exported PDF's own list layout unless the reading shows the same offset there.

## Acceptance

1. The screenshot's offset reproduced on a named variant, with the measured positions.
2. After the repair the first line's text and every wrapped line share one left edge within a pixel, on each variant and at two depths, measured by a browser check or a constructed page; red first.
3. A one-space item's layout is unchanged: its positions before and after are equal.
4. The `bulrtl` reading rerun green.
