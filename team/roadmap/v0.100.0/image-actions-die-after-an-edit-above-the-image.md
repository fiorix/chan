# Image actions die after an edit above the image

Status: raised for v0.100.0 on the owner's instruction to fold the frontend review's most critical findings into this version. From the review (findings MEDIA-01 and MEDIA-02 high, MEDIA-05 and MEDIA-10 medium), re-verified against `main` at `d3de0180b` by reading. All four live in one file, `web/packages/workspace-app/src/editor/widgets/image.ts`, and are one piece of work.

## What was seen

**A stale position.** `ImageWidget.eq` compares alt, source, path, standalone, editing, writable and dark, and not `nodePos`, so CodeMirror keeps the old DOM when only the position moved and the widget's stamped `data-image-pos` goes stale. Type one character anywhere above an image and the hover Edit button does nothing, Copy and Cmd+C throw "no image source range", right-click Copy returns null, drag-to-move degrades to a native image drag, and the selection ring stops appearing. It heals only when the widget happens to be rebuilt. The doc comment on `imageNodeRange` says the stamp is always current, which is what made this invisible.

**Five copies of the walk.** The `cursor.name === "URL"` walk that finds an image's source range is written out five times in the file, the Edit button is built twice, and the action payload is stamped three times. Five copies are why the stale position has five failure modes.

**Listeners that outlive the view.** `ensureDeselectListener` installs a `mousedown` and a `keydown` listener on `document`, lazily from `toDOM`, and nothing removes them; the comment above them says they are torn down with the view. Every closed markdown tab leaves both alive holding a destroyed `EditorView`, and each runs a `querySelector` on every click and keypress in the app. Neither checks that the event came from its own view, so with two editor panes open and an image ring-selected in pane A, pressing Enter while typing in pane B moves pane A's caret into the image URL and steals focus.

**Tests that pin the prose.** `widgets/imageScrollCaretLost.test.ts` and `widgets/diagram.test.ts` hold 47 assertions over module source text imported with `?raw`, some of them over comment prose. They fail when a comment in this file is rewritten and pass when its behaviour breaks, so they block the three fixes above while guarding none of them.

## Desired contract

An image action resolves its source range from the live syntax tree at the moment it runs, through one helper, and falls back to the stamp only where the tree cannot answer (the block-preview case the file already documents). Document-level listeners belong to a view: they are installed by a `ViewPlugin`, removed in its `destroy`, and ignore events from outside their view's DOM.

## Boundaries

`web/packages/workspace-app/src/editor/widgets/image.ts` and its tests, one owner at a time. Two traps the review recorded still hold: adding `nodePos` to `eq` is the wrong fix, because it rebuilds every image widget on every edit above it; and the stamp stays as the fallback. Clear the source-text assertions first or the other three changes fail them: delete the prose and absent-code assertions, keep the dynamic-import ones, and replace the rest with jsdom behaviour tests.

## Acceptance

1. After an insertion above an image, Edit, Copy, Cmd+C, right-click Copy, drag-to-move and the selection ring all act on the image's current range. One test per action, on a real `EditorView`.
2. Destroying a view removes its document listeners, asserted by listener count before and after, and a key event in one view never moves another view's selection.
3. The source-range walk exists once in the file.
4. No test in the two named files asserts on comment text or on the absence of removed code.
