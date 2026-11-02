import type { Terminal } from "ghostty-web";
import { VtTerminal } from "./ghosttyVt";

// ghostty-web's selection has two defects over chan's binding, and no public
// call to fix either. Its Select all puts the selection at the absolute row
// its viewport offset counts (the lines scrolled back), so it selects one
// screenful counted from the top of the history: the oldest rows, not the
// rows in view and not the whole buffer. And its `getSelection` reads the
// selected rows a cell at a time, a few wasm calls a cell, and writes a space
// for each wide character's spacer cell. Every copy of a selection goes
// through that `getSelection`: the copy chords, the menu, its own copy on
// mouse release, double and triple click, and the context menu's textarea.
//
// This reaches the internal SelectionManager: Select all selects the history
// and the screen, as xterm.js does, and a selection's text is the binding's
// one formatter call over it (`VtTerminal.plainText`), what the rows show. A
// read the core cannot format falls back to ghostty-web's own. The shape is
// feature-detected, and an absent one leaves ghostty-web's selection as it is.

type Anchor = { col: number; absoluteRow: number };

type SelectionManagerLike = {
  selectionStart: Anchor | null;
  selectionEnd: Anchor | null;
  getSelection(): string;
  selectAll(): void;
  requestRender(): void;
  selectionChangedEmitter: { fire(): void };
};

function selectionManagerOf(term: Terminal): SelectionManagerLike | null {
  const manager = (term as unknown as { selectionManager?: Partial<SelectionManagerLike> }).selectionManager;
  if (
    !manager ||
    typeof manager.getSelection !== "function" ||
    typeof manager.selectAll !== "function" ||
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
    return text ?? ownRead();
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
