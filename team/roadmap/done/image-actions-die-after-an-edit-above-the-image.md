# Image actions die after an edit above the image

Status: shipped in [v0.100.0](../../release/release-v0.100.0.md): An image action resolves its source range from the live syntax tree when it runs, and its document listeners leave with their view.

## What was seen

**A stale position.** `ImageWidget.eq` compares alt, source, path, standalone, editing, writable and dark, and not `nodePos`, so CodeMirror keeps the old DOM when only the position moved and the widget's stamped `data-image-pos` goes stale. Type one character anywhere above an image and the hover Edit button does nothing, Copy and Cmd+C throw "no image source range", right-click Copy returns null, drag-to-move degrades to a native image drag, and the selection ring stops appearing. It heals only when the widget happens to be rebuilt. The doc comment on `imageNodeRange` says the stamp is always current, which is what made this invisible.

**Five copies of the walk.** The `cursor.name === "URL"` walk that finds an image's source range is written out five times in the file, the Edit button is built twice, and the action payload is stamped three times. Five copies are why the stale position has five failure modes.

**Listeners that outlive the view.** `ensureDeselectListener` installs a `mousedown` and a `keydown` listener on `document`, lazily from `toDOM`, and nothing removes them; the comment above them says they are torn down with the view. Every closed markdown tab leaves both alive holding a destroyed `EditorView`, and each runs a `querySelector` on every click and keypress in the app. Neither checks that the event came from its own view, so with two editor panes open and an image ring-selected in pane A, pressing Enter while typing in pane B moves pane A's caret into the image URL and steals focus.

**Tests that pin the prose.** `widgets/imageScrollCaretLost.test.ts` and `widgets/diagram.test.ts` hold 47 assertions over module source text imported with `?raw`, some of them over comment prose. They fail when a comment in this file is rewritten and pass when its behaviour breaks, so they block the three fixes above while guarding none of them.

## Desired contract

An image action resolves its source range from the live syntax tree at the moment it runs, through one helper, and falls back to the stamp only where the tree cannot answer (the block-preview case the file already documents). Document-level listeners belong to a view: they are installed by a `ViewPlugin` and removed in its `destroy`. The key listener answers a key typed inside its own view, or with the focus nowhere (the body, the document element, a target that is not an element), and nothing else. The first wording here asked it to ignore every event from outside its view's DOM; that would drop the key that follows a click on an image, because that click does not focus the editor, and the ring exists for exactly that key. Answering a focusless key is safe only while one ring exists, so at most one ring is lit across every open view: lighting one clears the others. An image move applies only in the view that started the drag and only while that drag's state is live, so a drop in another pane, or after the document changed, moves nothing.

## Boundaries

`web/packages/workspace-app/src/editor/widgets/image.ts` and its tests, one owner at a time, and, added by the lead on 2026-09-20 after the second review, the drop handler in `editor/bubbles/image_drop.ts` with `editor/image_drag_indicator.ts`: the drop applied the dragstart offsets to whichever view received it, so one user dragging an image from one pane into another moved the second pane's text. The stamp is reachable and stays: when one selection enters two images on a line it is the only candidate that names the second preview. Two residuals are accepted: after an edit under such a selection a reused preview's actions do nothing until it is rebuilt, and two images with one URL on a line that starts with an image resolve to the first for Copy and Edit, with no document write going wrong. Two traps the review recorded still hold: adding `nodePos` to `eq` is the wrong fix, because it rebuilds every image widget on every edit above it; and the stamp stays as the fallback. Clear the source-text assertions first or the other three changes fail them: delete the prose and absent-code assertions, keep the dynamic-import ones, and replace the rest with jsdom behaviour tests.

## Acceptance

1. After an insertion above an image, Edit, Copy, Cmd+C, right-click Copy, drag-to-move and the selection ring all act on the image's current range. One test per action, on a real `EditorView`.
2. Destroying a view removes its document listeners, asserted by listener count before and after, and a key event in one view never moves another view's selection.
3. The source-range walk exists once in the file.
4. No test in the two named files asserts on comment text or on the absence of removed code.
