# The image hold pin fails in a whole-suite run on a throttled host

Status: raised for v0.109.0 on 2026-10-22 by the lead, from three reds of the workspace app's suite in the integration guest; closes in the round.

## What was seen

`src/editor/widgets/imageHold.test.ts` ("keeps the image drawn without its edit preview through a held pointer selection and enters edit mode at the release") fails at its first assertion, line 41, "the image renders inline: expected null not to be null", in a whole `make web-check` run on the integration guest (4 CPUs, 12 GiB, about 90 percent of its CPU periods throttled through such a run): once at `c0854819f` (1 test of 7,554, the only red) and twice at `8559b81e4` (one red each), while the file alone with one vitest worker passes at both commits three times in a row. The pin is the pressed-widget item's (`b469749aa`), which added the file and changed `image.ts` in `selectionForReveal` and a comment; the pin passed in the whole runs of its own gate and the next. The cause, read at source and reproduced (`dev/v0109-team/evidence/Review109/imghld147/`): the editor's language state parses one bounded slice at creation, about 20 ms of work, and under a throttled share that slice can end after the document's first block, so the image provider's creation scan finds no image node. The pin then calls `forceParsing`, which completes the tree and dispatches a transaction with no effect; `image.ts`'s ViewPlugin rescans on a document, viewport, selection or editable change or on any effect, and its block field returns its mapped value on a transaction with no document change, selection or effect, so neither reads the completed tree and the widget stays absent at the first assertion. Stepping the clock by one second while the state and view are built reproduces it with no load: 7 of 26 characters parsed at creation, the widget absent after `forceParsing`, drawn after a selection-only transaction. `table.ts` and `diagram.ts` rescan when the syntax tree changes; `image.ts`, `date.ts`, `mention.ts`, `tag.ts` and `wikilink.ts` do not. In the product the parse worker delivers its tree through an effect, which the image plugin reads, so this path shows no person a missing image today; the assumption that every tree advance carries an effect is unguarded. The four siblings rescan on no effect, so the parse worker's delivery does not reach them either, and for the tag widget a person sees it: with the creation parse cut, a `#word` inside a code fence is marked as a tag, and stays marked after the worker has delivered the whole tree until a selection or document change (`dev/v0109-team/evidence/Review109/imghld147/job-2.log`).

## Desired contract

The image widget's providers rescan when the syntax tree changes, as the table's and the diagram's do, and the pin's red-first arm is the deterministic construction: no load reproduction, no time budget that load can exhaust, no sleep.

## What to do

In `widgets/image.ts` the ViewPlugin's update condition and the block field's early return each take a syntax-tree change (`syntaxTree(u.startState) !== syntaxTree(u.state)`) as a rescan condition, the siblings' rule. The construction (the clock stepped by 1,000 ms while the state and view are built, then restored) is added beside the existing pin as its red-first arm, red at the parent on the image's absence after `forceParsing` and green at the commit; one mutant per guard, the plugin's condition and the block field's. The update conditions of `date.ts`, `mention.ts`, `tag.ts` and `wikilink.ts` are read against the same construction; a sibling it reaches takes the same condition in this commit with a construction pin of its own, and one it does not reach is recorded as read.

## Boundaries

`widgets/image.ts` at its two update conditions and `imageHold.test.ts`; the four sibling widgets' update conditions where the reading reaches them, with a pin each; the editor's `design.md` where it states the widgets' update rule, if it does. Not changed: the hold's product code, the parse budget of the other widget pins, the language state's creation parse.

## Acceptance

1. The construction red at the parent on the image's absence after `forceParsing` and green at the commit, one mutant per guard (the plugin's condition, the block field's), and the same for each sibling the reading reaches.
2. The reading's result in the row: each sibling named with whether the construction reaches it.
3. The file alone and `make web-check` green at the commit in the owning guest, and the whole `web-check` green in the integration gate at the landing.
