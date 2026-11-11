import type { Terminal } from "ghostty-web";
import { copiedText } from "./ghosttyCopy";
import { VtTerminal } from "./ghosttyVt";

// ghostty-web's selection has two defects over chan's binding, and no public
// call to fix either. Its Select all puts the selection at the absolute row
// its viewport offset counts (the lines scrolled back), so it selects one
// screenful counted from the top of the history: the oldest rows, not the
// rows in view and not the whole buffer. And its `getSelection` reads the
// selected rows a cell at a time, a few wasm calls a cell, ends every row
// with a line break, a soft wrap included, and writes a space for each wide
// character's spacer cell. Every copy of a selection goes through that
// `getSelection`: the copy chords, the menu, its own copy on mouse release,
// double and triple click, and the context menu's textarea.
//
// This reaches the internal SelectionManager: Select all selects the history
// and the screen, as xterm.js does, and a selection's text is the binding's
// one formatter call over it (`VtTerminal.plainText`), what the rows show
// with soft wraps joined, less what the screen does not draw (`copiedText`).
// A read the core cannot format falls back to ghostty-web's own, stripped the
// same. The shape is feature-detected, and an absent one leaves ghostty-web's
// selection as it is.
// Find writes its active match through the same anchors (ghosttyFind.ts).

/// A cell of the selection: `absoluteRow` 0 is the oldest history row and the
/// active rows follow.
type Anchor = { col: number; absoluteRow: number };

/// The members of ghostty-web's private SelectionManager chan uses. The
/// selection runs from `selectionStart` to `selectionEnd`, both cells
/// included. With the viewport at the bottom ghostty-web repaints only the
/// rows marked as changed, and `clearSelection` marks the rows of the
/// selection it drops.
export type SelectionManagerLike = {
  selectionStart: Anchor | null;
  selectionEnd: Anchor | null;
  getSelection(): string;
  selectAll(): void;
  clearSelection(): void;
  requestRender(): void;
  selectionChangedEmitter: { fire(): void };
};

/// ghostty-web's SelectionManager of `term`, or null when it is absent or not
/// of the shape chan uses.
export function selectionManagerOf(term: Terminal): SelectionManagerLike | null {
  const manager = (term as unknown as { selectionManager?: Partial<SelectionManagerLike> }).selectionManager;
  if (
    !manager ||
    typeof manager.getSelection !== "function" ||
    typeof manager.selectAll !== "function" ||
    typeof manager.clearSelection !== "function" ||
    typeof manager.requestRender !== "function" ||
    typeof manager.selectionChangedEmitter?.fire !== "function" ||
    !("selectionStart" in manager) ||
    !("selectionEnd" in manager)
  ) {
    return null;
  }
  return manager as SelectionManagerLike;
}

/// Install chan's Select all and selection text on an opened ghostty-web
/// terminal over the binding. Returns false, changing nothing, when the
/// terminal has no selection manager of the shape this reaches or runs
/// another core.
export function installGhosttySelection(term: Terminal): boolean {
  const manager = selectionManagerOf(term);
  // Typed as unknown: ghostty-web's terminal type and the binding's class
  // both have private fields, so narrowing one to the other is empty.
  const core: unknown = term.wasmTerm;
  if (!manager || !(core instanceof VtTerminal)) return false;
  const ownRead = manager.getSelection.bind(manager);

  manager.getSelection = (): string => {
    const start = manager.selectionStart;
    const end = manager.selectionEnd;
    if (!start || !end) return "";
    // A selection made backwards keeps its anchor as `start`; the core orders
    // the two corners itself.
    const text = core.plainText({
      startCol: start.col,
      startRow: start.absoluteRow,
      endCol: end.col,
      endRow: end.absoluteRow,
    });
    return copiedText(text ?? ownRead());
  };

  manager.selectAll = (): void => {
    const { cols, rows } = core.getDimensions();
    manager.selectionStart = { col: 0, absoluteRow: 0 };
    manager.selectionEnd = { col: cols - 1, absoluteRow: core.getScrollbackLength() + rows - 1 };
    manager.requestRender();
    manager.selectionChangedEmitter.fire();
  };
  return true;
}
