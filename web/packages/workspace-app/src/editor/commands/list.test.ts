// @vitest-environment jsdom
//
// Coverage for list-editing keybinds. Each test mounts a real
// EditorView in jsdom, dispatches a selection, and inspects the
// post-command state. Going through the live EditorView (rather
// than poking at internal helpers) lets us catch regressions in
// the dispatch wiring as well as the regex itself.

import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  continueListOnEnter,
  indentListItem,
  outdentListItem,
  stripUnusedInlineImageSpaceOnEnter,
} from "./list";

let host: HTMLDivElement;
let view: EditorView;

function mount(doc: string, caret: number): void {
  host = document.createElement("div");
  document.body.append(host);
  view = new EditorView({
    state: EditorState.create({ doc, selection: { anchor: caret } }),
    parent: host,
  });
}

function snapshot(): { doc: string; head: number } {
  return {
    doc: view.state.doc.toString(),
    head: view.state.selection.main.head,
  };
}

beforeEach(() => {
  // jsdom carries DOM state across tests; we mount per-test below.
});

afterEach(() => {
  view?.destroy();
  host?.remove();
});

describe("continueListOnEnter", () => {
  test("inserts a fresh bullet at end of a `- ` line", () => {
    mount("- one", 5);
    expect(continueListOnEnter(view)).toBe(true);
    expect(snapshot()).toEqual({ doc: "- one\n- ", head: 8 });
  });

  test("respects the bullet character (`*` stays `*`)", () => {
    mount("* a", 3);
    expect(continueListOnEnter(view)).toBe(true);
    expect(snapshot().doc).toBe("* a\n* ");
  });

  test("increments an ordered marker", () => {
    mount("1. first", 8);
    expect(continueListOnEnter(view)).toBe(true);
    expect(snapshot().doc).toBe("1. first\n2. ");
  });

  test("preserves the `)` separator on ordered markers", () => {
    mount("3) third", 8);
    expect(continueListOnEnter(view)).toBe(true);
    expect(snapshot().doc).toBe("3) third\n4) ");
  });

  test("mid-list insert renumbers the following items", () => {
    // Inserting after `1.` must push 2->3 and 3->4, not leave a duplicate 2.
    mount("1. one\n2. two\n3. three", 6);
    expect(continueListOnEnter(view)).toBe(true);
    expect(snapshot()).toEqual({
      doc: "1. one\n2. \n3. two\n4. three",
      head: 10,
    });
  });

  test("mid-list insert reuses each item's own separator", () => {
    mount("1) one\n2) two", 6);
    expect(continueListOnEnter(view)).toBe(true);
    expect(snapshot().doc).toBe("1) one\n2) \n3) two");
  });

  test("mid-list insert stops at a nested-indent boundary", () => {
    // The deeper child belongs to its own sublevel; renumbering must not
    // bump it, and it ends the same-indent run.
    mount("1. parent\n   1. child", 9);
    expect(continueListOnEnter(view)).toBe(true);
    expect(snapshot().doc).toBe("1. parent\n2. \n   1. child");
  });

  test("mid-list insert leaves a following non-ordered list untouched", () => {
    mount("1. one\n2. two\n- [ ] task", 6);
    expect(continueListOnEnter(view)).toBe(true);
    expect(snapshot().doc).toBe("1. one\n2. \n3. two\n- [ ] task");
  });

  test("mid-list insert renumbers the contiguous run then stops at a gap", () => {
    // 2 is contiguous (->3); 5 is a deliberate jump, so the renumber stops
    // there and leaves it alone (renumberList gap-stop parity).
    mount("1. one\n2. two\n5. five", 6);
    expect(continueListOnEnter(view)).toBe(true);
    expect(snapshot().doc).toBe("1. one\n2. \n3. two\n5. five");
  });

  test("mid-list insert renumbers across a single blank (loose list)", () => {
    // A loose ordered list separates items with a blank line; the tail must
    // still renumber across it, or item 2 stays a duplicate `2.`.
    mount("1. a\n\n2. b", 4);
    expect(continueListOnEnter(view)).toBe(true);
    expect(snapshot()).toEqual({ doc: "1. a\n2. \n\n3. b", head: 8 });
  });

  test("mid-list insert renumbers a multi-item loose list, stops at a paragraph", () => {
    mount("1. a\n\n2. b\n\ntext", 4);
    expect(continueListOnEnter(view)).toBe(true);
    expect(snapshot().doc).toBe("1. a\n2. \n\n3. b\n\ntext");
  });

  test("mid-list insert stops at a two-blank gap (separate list)", () => {
    // Two blank lines in a row end a CommonMark list, so the item after
    // them belongs to a separate list and is left alone.
    mount("1. a\n\n\n2. b", 4);
    expect(continueListOnEnter(view)).toBe(true);
    expect(snapshot().doc).toBe("1. a\n2. \n\n\n2. b");
  });

  test("task list emits a fresh unchecked box", () => {
    mount("- [x] done", 10);
    expect(continueListOnEnter(view)).toBe(true);
    expect(snapshot().doc).toBe("- [x] done\n- [ ] ");
  });

  test("preserves indentation", () => {
    mount("  - nested", 10);
    expect(continueListOnEnter(view)).toBe(true);
    expect(snapshot().doc).toBe("  - nested\n  - ");
  });

  test("empty bullet exits the list (strips the prefix)", () => {
    mount("- ", 2);
    expect(continueListOnEnter(view)).toBe(true);
    expect(snapshot()).toEqual({ doc: "", head: 0 });
  });

  test("empty nested bullet strips the whole prefix incl. indent", () => {
    mount("  - ", 4);
    expect(continueListOnEnter(view)).toBe(true);
    expect(snapshot()).toEqual({ doc: "", head: 0 });
  });

  test("empty task item exits the list", () => {
    mount("- [ ] ", 6);
    expect(continueListOnEnter(view)).toBe(true);
    expect(snapshot().doc).toBe("");
  });

  test("falls through (returns false) on a non-list line", () => {
    mount("hello", 5);
    expect(continueListOnEnter(view)).toBe(false);
    expect(snapshot().doc).toBe("hello"); // untouched
  });

  test("mid-item caret splits the item: the rest of the line becomes the next item", () => {
    // The long-item flow: caret after a word, Enter, and the tail is its
    // own bullet with the caret after the fresh marker.
    mount("- the quick brown fox", 17); // caret right after "brown"
    expect(continueListOnEnter(view)).toBe(true);
    expect(snapshot()).toEqual({ doc: "- the quick brown\n- fox", head: 20 });
  });

  test("the split swallows the whitespace on both sides of the caret", () => {
    // Caret after the separating space: no trailing space on the old item.
    mount("- hello world", 8);
    expect(continueListOnEnter(view)).toBe(true);
    expect(snapshot()).toEqual({ doc: "- hello\n- world", head: 10 });
    view.destroy();
    host.remove();
    // Caret inside a run of spaces: neither half keeps any of them.
    mount("- hello   world", 9);
    expect(continueListOnEnter(view)).toBe(true);
    expect(snapshot()).toEqual({ doc: "- hello\n- world", head: 10 });
  });

  test("mid-word caret splits the word across the two items", () => {
    mount("- hello", 4); // caret between '- h' and 'ello'
    expect(continueListOnEnter(view)).toBe(true);
    expect(snapshot()).toEqual({ doc: "- he\n- llo", head: 7 });
  });

  test("mid-item split of an ordered item numbers the tail and renumbers below", () => {
    mount("1. one two\n2. three", 6); // caret right after "one"
    expect(continueListOnEnter(view)).toBe(true);
    expect(snapshot()).toEqual({ doc: "1. one\n2. two\n3. three", head: 10 });
  });

  test("mid-item split of a task item gives the moved text a fresh unchecked box", () => {
    mount("- [x] done more", 10);
    expect(continueListOnEnter(view)).toBe(true);
    expect(snapshot()).toEqual({ doc: "- [x] done\n- [ ] more", head: 17 });
  });

  test("mid-item split of a nested item keeps the indent", () => {
    mount("  - a b", 5);
    expect(continueListOnEnter(view)).toBe(true);
    expect(snapshot()).toEqual({ doc: "  - a\n  - b", head: 10 });
  });

  test("caret right after the marker leaves an empty item above and moves the content down", () => {
    mount("- hello", 2);
    expect(continueListOnEnter(view)).toBe(true);
    expect(snapshot()).toEqual({ doc: "- \n- hello", head: 5 });
  });

  test("a whitespace-only remainder behaves like end of line", () => {
    mount("- hello   ", 7);
    expect(continueListOnEnter(view)).toBe(true);
    expect(snapshot()).toEqual({ doc: "- hello\n- ", head: 10 });
  });

  test("falls through when the caret is inside the prefix", () => {
    // In the marker ("-|"), and in the indent ahead of it: the default
    // newline just moves the item down, it does not manufacture a bullet.
    mount("- hello", 1);
    expect(continueListOnEnter(view)).toBe(false);
    expect(snapshot().doc).toBe("- hello");
    view.destroy();
    host.remove();
    mount("  - hello", 1);
    expect(continueListOnEnter(view)).toBe(false);
    expect(snapshot().doc).toBe("  - hello");
  });

  test("falls through when selection is non-empty", () => {
    mount("- hello", 2);
    view.dispatch({ selection: { anchor: 2, head: 5 } });
    expect(continueListOnEnter(view)).toBe(false);
  });
});

describe("indentListItem / outdentListItem", () => {
  // Tab/Shift-Tab step between VALID markdown columns, not by a fixed width:
  // an ordered item indented past its sibling band but short of the sibling's
  // content column parses as lazy paragraph continuation (only `1.` may
  // interrupt a paragraph) and silently loses its list rendering.

  test("Tab nests a bullet under its previous sibling's content column", () => {
    mount("- a\n- b", 7);
    expect(indentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("- a\n  - b");
  });

  test("Tab nests an ordered item at the sibling's content column (3, not 2)", () => {
    mount("1. a\n2. b", 9);
    expect(indentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("1. a\n   2. b");
  });

  test("Tab under a wide ordered marker lands on ITS content column", () => {
    mount("10. a\n11. b", 11);
    expect(indentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("10. a\n    11. b");
  });

  test("Tab nests under the sibling ACROSS a deeper subtree between them", () => {
    // The user's repro: `3.` sits at 2 spaces, so its content column is 5.
    // A blind +2 landed `4.` on column 4 - the dead band where it stops
    // parsing as a list item. The nest must target column 5 in one press.
    const doc = "1. Hello\n    2. World\n  3. three\n  4. four";
    mount(doc, doc.length);
    expect(indentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("1. Hello\n    2. World\n  3. three\n     4. four");
  });

  test("Tab on the first item of a level is a consumed no-op", () => {
    // Nothing to nest under: an indented FIRST item is at best pointless and
    // at 4+ spaces becomes a code block. Consume the key, change nothing.
    mount("- a", 3);
    expect(indentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("- a");
  });

  test("Tab on a first child (already at the parent's content column) no-ops", () => {
    mount("1. a\n   2. b", 10);
    expect(indentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("1. a\n   2. b");
  });

  test("Tab nests star and plus bullets alike", () => {
    mount("* a\n* b", 7);
    expect(indentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("* a\n  * b");
    view.destroy();
    host.remove();
    mount("+ a\n+ b", 7);
    expect(indentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("+ a\n  + b");
  });

  test("Tab nests a task item under the previous task's content column", () => {
    mount("- [ ] t1\n- [x] t2", 17);
    expect(indentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("- [ ] t1\n  - [x] t2");
  });

  test("Tab nests a paren-ordered item at its sibling's content column", () => {
    mount("1) a\n2) b", 9);
    expect(indentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("1) a\n   2) b");
  });

  test("Tab nests across marker families (ordered under a bullet sibling)", () => {
    mount("- a\n1. b", 8);
    expect(indentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("- a\n  1. b");
  });

  test("multi-level: Tab in under a nested sibling, Shift-Tab out level by level", () => {
    mount("- a\n  - b\n  - c", 15);
    expect(indentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("- a\n  - b\n    - c");
    expect(outdentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("- a\n  - b\n  - c");
    expect(outdentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("- a\n  - b\n- c");
  });

  test("repeated Tab walks one level deeper per press through the prior subtree, and back", () => {
    // Indent in and out MULTIPLE times on the same item: with a deep subtree
    // above, every level has a reference line, so each Tab lands one level
    // deeper and each Shift-Tab pops one level back out. The walk caps at one
    // level below the deepest line above; markdown cannot represent a child
    // with no parent item, so a further Tab is a consumed no-op, never an
    // invalid dead-band indent.
    mount("- a\n  - b\n    - c\n- d", 21);
    expect(indentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("- a\n  - b\n    - c\n  - d");
    expect(indentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("- a\n  - b\n    - c\n    - d");
    expect(indentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("- a\n  - b\n    - c\n      - d");
    expect(indentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("- a\n  - b\n    - c\n      - d");
    expect(outdentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("- a\n  - b\n    - c\n    - d");
    expect(outdentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("- a\n  - b\n    - c\n  - d");
    expect(outdentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("- a\n  - b\n    - c\n- d");
  });

  test("Tab is a no-op (returns false) on a non-list line", () => {
    mount("plain", 5);
    expect(indentListItem(view)).toBe(false);
    expect(snapshot().doc).toBe("plain");
  });

  test("Shift-Tab pops a nested item back to its parent's own indent", () => {
    mount("1. a\n   2. b", 10);
    expect(outdentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("1. a\n2. b");
  });

  test("Shift-Tab with no shallower parent normalizes to column 0", () => {
    mount("    - a", 7);
    expect(outdentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("- a");
  });

  test("Shift-Tab on a top-level list item is a no-op (keeps the bullet)", () => {
    // A top-level item is already at the outermost level, so
    // outdent must NOT strip the marker (that silently demoted the
    // bullet to a plain paragraph). Still consumed (returns true) so
    // Shift-Tab never escapes the editor; the doc is unchanged.
    mount("- a", 3);
    expect(outdentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("- a");
  });

  test("Shift-Tab on a top-level task item keeps the bullet", () => {
    mount("- [x] done", 10);
    expect(outdentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("- [x] done");
  });

  test("Shift-Tab on a non-list line is an editor-local no-op", () => {
    mount("plain", 5);
    expect(outdentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("plain");
  });

  test("Shift-Tab strips only 1 space when only 1 space of indent", () => {
    mount(" - a", 4);
    expect(outdentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("- a");
  });

  test("Tab shifts every list line in a multi-line selection by one delta", () => {
    // `- b` is the anchor (first list line in range); it nests under `- a`
    // (content column 2) and `- c` rides the same +2 so the pair keeps shape.
    mount("- a\n- b\n- c", 0);
    view.dispatch({ selection: { anchor: 4, head: 11 } });
    expect(indentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("- a\n  - b\n  - c");
  });

  test("Tab leaves non-list lines untouched within a multi-line selection", () => {
    mount("- a\n- b\nplain\n- c", 0);
    view.dispatch({ selection: { anchor: 4, head: 17 } });
    expect(indentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("- a\n  - b\nplain\n  - c");
  });

  test("a whole-list selection whose anchor cannot nest is a consumed no-op", () => {
    mount("- a\n- b\n- c", 0);
    view.dispatch({ selection: { anchor: 0, head: 11 } });
    expect(indentListItem(view)).toBe(true);
    expect(snapshot().doc).toBe("- a\n- b\n- c");
  });
});

describe("inline image paste helpers", () => {
  // There are no bullet caret-snap helpers (clampListCaretPosition /
  // listAwareArrowDown-Up / isListEolClick): `*`/`+` markers are real-
  // width glyph widgets, so cursor/click/arrow are plain CodeMirror
  // (browser-smoked) with no snap helpers to unit-test here.
  test("retracts one unused pasted-image space before list continuation", () => {
    const doc = "- ![](photo.png#w=250) ";
    mount(doc, doc.length);
    expect(stripUnusedInlineImageSpaceOnEnter(view)).toBe(false);
    expect(snapshot()).toEqual({
      doc: "- ![](photo.png#w=250)",
      head: doc.length - 1,
    });
  });

  test("retracts the pasted-image space when the caret rests after the )", () => {
    // The image paste leaves the caret just after the `)`, before the
    // trailing space (doc.length - 1), not at EOL. Strip must still fire so
    // continueListOnEnter then sees a caret at the true EOL.
    const doc = "- ![](photo.png#w=250) ";
    mount(doc, doc.length - 1);
    expect(stripUnusedInlineImageSpaceOnEnter(view)).toBe(false);
    expect(snapshot()).toEqual({
      doc: "- ![](photo.png#w=250)",
      head: doc.length - 1,
    });
  });

  test("keeps normal trailing spaces outside pasted image markers", () => {
    const doc = "- words ";
    mount(doc, doc.length);
    expect(stripUnusedInlineImageSpaceOnEnter(view)).toBe(false);
    expect(snapshot()).toEqual({ doc, head: doc.length });
  });
});
