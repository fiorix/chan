import type { Terminal } from "@chan/ghostty-web-ng";
import { copiedText, VtCells, VtTerminal, type VtCell } from "@chan/ghostty-web-ng/vt";

// ghostty-web's selection has four defects over chan's binding, and no
// public call to fix any. Its Select all puts the selection at the absolute
// row its viewport offset counts (the lines scrolled back), so it selects one
// screenful counted from the top of the history: the oldest rows, not the
// rows in view and not the whole buffer. Its `getSelection` reads the
// selected rows one at a time, a history row a few wasm calls a cell, ends
// every row with a line break, a soft wrap included, and writes a space for
// each wide character's spacer cell. And its own copies, on mouse release, double and
// triple click, write the clipboard themselves, around chan's writer. Its
// double and triple click select within one screen row, so a word or a line
// the program soft-wrapped is cut at the wrap. Every copy of a selection reads
// that `getSelection`: the copy chords, the menu, ghostty-web's own copies,
// and the context menu's textarea.
//
// This reaches the internal SelectionManager: Select all selects the history
// and the screen, as xterm.js does; a selection's text is the binding's one
// formatter call over it (`VtTerminal.plainText`), what the rows show with
// soft wraps joined, less what the screen does not draw (`copiedText`); and
// ghostty-web's own copies write through the writer chan gives, so every copy
// path writes the same text the same way; a double click selects a word and a
// triple click the whole line across soft wraps, as xterm.js's do
// (`installGhosttyClickExtents`). A read the core cannot format
// falls back to ghostty-web's own, stripped the same. The shape is
// feature-detected, and an absent one leaves ghostty-web's selection as it is.
// Find writes its active match through the same anchors (ghosttyFind.ts).

/// A cell of the selection: `absoluteRow` 0 is the oldest history row and the
/// active rows follow.
type Anchor = { col: number; absoluteRow: number };

/// The members of ghostty-web's private SelectionManager chan uses. The
/// selection runs from `selectionStart` to `selectionEnd`, both cells
/// included. With the viewport at the bottom ghostty-web repaints only the
/// rows marked as changed, and `clearSelection` marks the rows of the
/// selection it drops. `copyToClipboard` is the clipboard write of
/// ghostty-web's own copies.
export type SelectionManagerLike = {
  selectionStart: Anchor | null;
  selectionEnd: Anchor | null;
  getSelection(): string;
  copyToClipboard(text: string): void;
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
    typeof manager.copyToClipboard !== "function" ||
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

/// Install chan's Select all, selection text and clipboard write on an
/// opened ghostty-web terminal over the binding; ghostty-web's own copies
/// hand their text to `write`. Returns false, changing nothing, when the
/// terminal has no selection manager of the shape this reaches or runs
/// another core.
export function installGhosttySelection(term: Terminal, write: (text: string) => void): boolean {
  const manager = selectionManagerOf(term);
  const core = term.wasmTerm;
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

  manager.copyToClipboard = (text: string): void => write(text);

  manager.selectAll = (): void => {
    const { cols, rows } = core.getDimensions();
    manager.selectionStart = { col: 0, absoluteRow: 0 };
    manager.selectionEnd = { col: cols - 1, absoluteRow: core.getScrollbackLength() + rows - 1 };
    manager.requestRender();
    manager.selectionChangedEmitter.fire();
  };
  return true;
}

/// The members of ghostty-web's private SelectionManager a click's selection
/// reads besides the ones above: the cell under a pixel of the canvas, and
/// the absolute row of a viewport row.
type ClickSelectionManager = SelectionManagerLike & {
  pixelToCell(x: number, y: number): { col: number; row: number };
  viewportRowToAbsolute(row: number): number;
};

/// The characters ghostty-web's double click takes as a word.
const WORD_CHAR = /[\w\-./~@+]/;

function isWordCell(cell: VtCell | undefined): boolean {
  return !!cell && cell.codepoint !== 0 && WORD_CHAR.test(String.fromCodePoint(cell.codepoint));
}

function isBlankCell(cell: VtCell | undefined): boolean {
  return !cell || cell.codepoint === 0 || cell.codepoint === 32;
}

/// Row `row` of the history and the screen, 0 the oldest history row, in a
/// view of its own: a walk across wraps holds more than one row.
function rowAt(core: VtTerminal, row: number): VtCells | null {
  const cells = new VtCells();
  const history = core.getScrollbackLength();
  const read = row < history ? core.readHistoryRow(row, cells) : core.readRow(row - history, cells);
  return read ? cells : null;
}

/// Whether row `row` continues the row above it, a soft wrap between them.
function continuesAbove(core: VtTerminal, row: number): boolean {
  const history = core.getScrollbackLength();
  return row < history ? core.isScrollbackRowWrapped(row) : core.isRowWrapped(row - history);
}

type Extent = { start: Anchor; end: Anchor };

/// The word under a cell, with ghostty-web's word characters, carried into
/// the rows a soft wrap joins it to, as xterm.js's double click does. Null
/// when the cell is not a word character.
export function wordAcrossWraps(core: VtTerminal, col: number, row: number): Extent | null {
  const cells = rowAt(core, row);
  if (!cells || !isWordCell(cells.at(col))) return null;
  let start = { col, absoluteRow: row };
  let startCells = cells;
  for (;;) {
    while (start.col > 0 && isWordCell(startCells.at(start.col - 1))) start.col--;
    if (start.col > 0 || !continuesAbove(core, start.absoluteRow)) break;
    const above = rowAt(core, start.absoluteRow - 1);
    if (!above || !isWordCell(above.at(above.length - 1))) break;
    start = { col: above.length - 1, absoluteRow: start.absoluteRow - 1 };
    startCells = above;
  }
  let end = { col, absoluteRow: row };
  let endCells = cells;
  for (;;) {
    while (end.col < endCells.length - 1 && isWordCell(endCells.at(end.col + 1))) end.col++;
    if (end.col < endCells.length - 1 || !continuesAbove(core, end.absoluteRow + 1)) break;
    const below = rowAt(core, end.absoluteRow + 1);
    if (!below || !isWordCell(below.at(0))) break;
    end = { col: 0, absoluteRow: end.absoluteRow + 1 };
    endCells = below;
  }
  return { start, end };
}

/// The whole line a row belongs to, every row a soft wrap joins to it, as
/// xterm.js's triple click selects it, to its last cell that is not blank,
/// as ghostty-web's triple click ends a row. Null when the line is blank.
export function lineAcrossWraps(core: VtTerminal, row: number): Extent | null {
  let first = row;
  while (first > 0 && continuesAbove(core, first)) first--;
  let last = row;
  while (continuesAbove(core, last + 1)) last++;
  for (let r = last; r >= first; r--) {
    const cells = rowAt(core, r);
    for (let c = (cells?.length ?? 0) - 1; c >= 0; c--) {
      if (!isBlankCell(cells?.at(c))) return { start: { col: 0, absoluteRow: first }, end: { col: c, absoluteRow: r } };
    }
  }
  return null;
}

/// Install chan's double and triple click on an opened ghostty-web terminal
/// over the binding. ghostty-web's click handler on its canvas selects within
/// one screen row, so a word or a command the program soft-wrapped selects
/// cut at the wrap and copies cut. chan answers the click first, from a
/// capture listener on the element the terminal opened in: a double click
/// selects the word across the wrap (`wordAcrossWraps`), a triple click the
/// whole wrapped line (`lineAcrossWraps`), each copied as ghostty-web copies
/// its own, through `copyToClipboard`, and the click goes no further. A click
/// that finds no word or an empty line is left to ghostty-web, which finds
/// none either. Returns the listener's cleanup, or null, changing nothing,
/// when the terminal has no selection manager or canvas of the shape this
/// reaches or runs another core.
export function installGhosttyClickExtents(term: Terminal): (() => void) | null {
  const manager = selectionManagerOf(term) as ClickSelectionManager | null;
  const core = term.wasmTerm;
  const host = term.element;
  const canvas = (term as unknown as { renderer?: { getCanvas?(): HTMLCanvasElement } }).renderer?.getCanvas?.();
  if (
    !manager ||
    typeof manager.pixelToCell !== "function" ||
    typeof manager.viewportRowToAbsolute !== "function" ||
    !(core instanceof VtTerminal) ||
    !host ||
    !canvas
  ) {
    return null;
  }
  const onClick = (event: MouseEvent): void => {
    if (event.target !== canvas || event.detail < 2) return;
    const cell = manager.pixelToCell(event.offsetX, event.offsetY);
    const row = manager.viewportRowToAbsolute(cell.row);
    const extent = event.detail === 2 ? wordAcrossWraps(core, cell.col, row) : lineAcrossWraps(core, row);
    if (!extent) return;
    event.stopPropagation();
    manager.selectionStart = extent.start;
    manager.selectionEnd = extent.end;
    manager.requestRender();
    const text = manager.getSelection();
    if (text) {
      manager.copyToClipboard(text);
      manager.selectionChangedEmitter.fire();
    }
  };
  host.addEventListener("click", onClick, true);
  return () => host.removeEventListener("click", onClick, true);
}
