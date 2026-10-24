# The image hold pin fails in a whole-suite run on a throttled host

Status: shipped in [v0.109.0](../../release/release-v0.109.0.md).

Record before the release: built on 2026-10-22 on the seat's branch; the section Built 2026-10-22 holds the evidence; it closes at the GA as shipped.

Record before the build: raised for v0.109.0 on 2026-10-22 by the lead, from three reds of the workspace app's suite in the integration guest; closes in the round.

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

## Built 2026-10-22

Built on the frontend seat's branch as `127a16bca` on `540a2e571`, in `web/packages/workspace-app/src/`.

**The image.** In `editor/widgets/image.ts`, two conditions take a syntax-tree change, the rule `table.ts` and `diagram.ts` follow:
- the ViewPlugin's update condition (`syntaxTree(u.startState) !== syntaxTree(u.state)`);
- the block field's early return (`syntaxTree(tr.state) === syntaxTree(tr.startState)` beside its document, selection and effect tests).

The hold's product code, the parse budget of the other widget pins and the language state's creation parse are unchanged.

**The siblings.** Each was read against the construction, and the construction reaches all four. Each takes the same condition with a construction pin of its own.
- **`date.ts`, `mention.ts`, `tag.ts`:** they mark regex matches outside the code and link ranges the tree holds. With the creation parse cut before a fence, a date, a `@@name` and a `#word` inside it are marked, and they stay marked after `forceParsing` until the tree check rescans.
- **`wikilink.ts`'s pill plugin:** it draws from `WikiLink` nodes, so a link past the cut is undrawn until the rescan.
- **`wikilink.ts`'s inline code link plugin:** it reads `InlineCode` nodes, so a code span naming a resolved file is unlinked until the rescan.

Both wikilink plugins rescan on a resolved kind as well. The construction is the one the pins use for all seven. The parse worker's path (the review seat's job-2) is not a pin. At this commit that path is repaired: with the creation parse cut and the worker delivering the whole tree, a `#word` inside a fence is not marked (`dev/v0109-team/evidence/Review109/imghld147/job-3.log`); the tag pin's tree check guards both paths.

**The construction.** `__tests__/shortParse.ts` builds the state and view while `Date.now` steps 1,000 ms at each read, then restores the clock. The language's bounded creation parse stops at its first check: 7 of 26 characters for the image's document, the review seat's job-1 measure. Each pin first asserts that the creation tree stops before its target, so the construction cannot become vacuous unnoticed, then completes the tree with `forceParsing`. No load, no time budget, no sleep.

**The pins.** Two sit in `editor/widgets/imageHold.test.ts` beside the hold pin, and five in `editor/widgets/shortParseRescan.test.ts`. Each was red at the parent `540a2e571` on its own assertion, the parent's five widget files under these tests (`evidence/Frontend109/imghld/redgreen.sh`, `build/redgreen-1.log`):
- "draws the image once a forced parse reaches it past where the creation parse stopped": "the image renders inline: expected null not to be null";
- "draws the edit preview of the image the caret is in once a forced parse reaches it": "the edit preview renders: expected null not to be null";
- the tag: "expected [ '#notatag', '#realtag' ] to deeply equal [ '#realtag' ]";
- the mention: "the fenced mention: expected true to be false";
- the date: "only the date outside the fence: expected [ '2026-08-11', '2026-08-12' ] to have a length of 1 but got 2";
- the wiki pill: "the link's pill: expected [] to have a length of 1 but got +0";
- the inline code link: "expected [] to deeply equal [ 'notes/short-parse-real.md' ]".

The hold pin passes at the parent, as it does on an unthrottled host. At the tip all eight pass.

**The mutants.** One per guard: each removes its tree check at the tip, and each was red on its own pin alone, 1 of 8.
- IP: the image plugin's condition.
- IF: the block field's.
- DT: the date plugin's.
- MN: the mention plugin's.
- TG: the tag plugin's.
- WL: the wiki pill's.
- WC: the inline code link's.

**The design text.** `editor/design.md`'s decoration pipeline diagram states the providers' triggers. Its three edges read:
- the tag, mention and date plugins on "docChanged, viewportChanged, selectionSet, new syntax tree";
- the wiki link and inline image plugins on "the same four";
- the table, diagram and image edit preview fields "also on a new tree".

The workspace app's `design.md` states no widget update rule; its one "rescan" is the terminal's.

**The gate**, in the frontend guest from a clean fetch at `127a16bca`:
- The two pin files alone with one worker (`evidence/Frontend109/imghld/filealone.sh`, `build/filealone-1.log`): 8 of 8, tracked state equal before and after.
- `VITEST_MAX_WORKERS=1 make web-check` (`build/gate-1.log`): rc 0, 17:56:01Z to 18:12:38Z. The workspace app had 7626 tests in 591 files, web-shared 218, the launcher 624, profile 20. The web lock was unchanged and the checkout clean after.
- svelte-check: 0 errors before the commit (`build/dev-1.log`).
- Export check: the range adds one export, the test helper `viewWithShortParse`. The marketing, launcher, web-shared and profile packages import or mock none of the touched modules at the base or the tip, beside marketing's own 8 lines naming `workspace-app/src` as the control (`build/export-grep.txt`), so `make web-marketing-check` is not added.
- No browser check: the row names none.

**Acceptance covered:**
- (1) the construction red at the parent on the image's absence after `forceParsing` and green at the commit, one mutant per guard, and the same for each sibling the reading reaches;
- (2) each sibling named with whether the construction reaches it;
- (3) the files alone and `make web-check` green at the commit in the owning guest. The integration gate's whole `web-check` is the landing's.
