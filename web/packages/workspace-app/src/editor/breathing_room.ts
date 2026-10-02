// Room below the last line of the CM6 editors, so the caret is not
// held flush against the bottom edge at the end of a document. Two
// pieces:
//
//   1. A static 60px padding-bottom on `.cm-content` (in each
//      editor's <style>) so there's always physical room below the
//      last line for the viewport to scroll into.
//   2. A bottom scroll margin of BOTTOM_MARGIN_PX, which is 0. CM
//      only scrolls when the cursor would leave the visible
//      viewport; the padding above gives it room to do that at EOF
//      without moving on every keystroke.
//
// The scroller keeps the browser's default, instant scroll-behavior;
// each editor's <style> says why. No JS animation, no per-keystroke
// measuring.

import { EditorView } from "@codemirror/view";

const BOTTOM_MARGIN_PX = 0;

export function breathingRoom() {
  return EditorView.scrollMargins.of(() => ({ bottom: BOTTOM_MARGIN_PX }));
}
