// GFM table rendering as a grid widget.
//
// Atom: a `<table>` DOM rendered from the syntaxTree's Table node.
// Selection-intersect rule applies - caret inside the source range
// suppresses the widget so the user sees the raw pipe / dash form
// for editing. EditorView.atomicRanges so caret motion skips the
// table in one keypress.
//
// Read-only grid. A press on a cell places the caret at the end of that
// cell's text in the source (an empty cell's after its left delimiter) under
// a pointer hold: the grid stays drawn while the button is held and the
// source shows at the release, so motion during the press selects nothing.
// There is no in-cell editing: the markdown source is plain enough to
// edit directly.

import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { StateField, type Extension } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { renderMarkdownInline } from "../../api/markdown";
import {
  pointerPress,
  selectionForReveal,
  selectionInRange,
} from "../decorations/selection";

interface TableData {
  headers: string[];
  rows: string[][];
}

/// A cell's source text, trimmed, and its range in the document. An empty
/// cell's range is the empty one just after its left delimiter.
interface Cell {
  text: string;
  from: number;
  to: number;
}

class TableWidget extends WidgetType {
  constructor(readonly data: TableData) {
    super();
  }

  eq(other: TableWidget): boolean {
    if (this.data.headers.length !== other.data.headers.length) return false;
    if (this.data.rows.length !== other.data.rows.length) return false;
    for (let i = 0; i < this.data.headers.length; i++) {
      if (this.data.headers[i] !== other.data.headers[i]) return false;
    }
    for (let r = 0; r < this.data.rows.length; r++) {
      const a = this.data.rows[r]!;
      const b = other.data.rows[r]!;
      if (a.length !== b.length) return false;
      for (let c = 0; c < a.length; c++) {
        if (a[c] !== b[c]) return false;
      }
    }
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap";
    const table = document.createElement("table");
    table.className = "cm-md-table";
    // A cell carries its row (0 the header, k the k-th body row) and column,
    // never a document offset: `eq` keeps this DOM across an edit above the
    // table, and the press resolves the cell against the current tree.
    const cell = (tag: "th" | "td", source: string, row: number, col: number) => {
      const el = document.createElement(tag);
      el.dataset.row = String(row);
      el.dataset.col = String(col);
      // Cell source is inline markdown; render it (bold, italic, code,
      // links) through the sanitized inline pipeline before insert.
      el.innerHTML = renderMarkdownInline(source);
      return el;
    };
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    this.data.headers.forEach((h, col) => headRow.appendChild(cell("th", h, 0, col)));
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    this.data.rows.forEach((row, index) => {
      const tr = document.createElement("tr");
      row.forEach((source, col) => tr.appendChild(cell("td", source, index + 1, col)));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    wrap.addEventListener("mousedown", (event) => {
      // A primary press on the wrap's own scrollbar, repeated or modified
      // too, scrolls a wide grid. Its default is prevented, which keeps
      // CodeMirror's press out, so it starts no hold and places no caret,
      // and the grid stays drawn.
      if (event.button === 0 && event.target === wrap && onScrollbar(wrap, event)) {
        event.preventDefault();
        return;
      }
      // Plain primary single presses only; a modified or repeated press
      // keeps CodeMirror's own handling.
      if (event.button !== 0 || event.detail > 1) return;
      if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;
      const pressed = (event.target as Element | null)?.closest?.("th, td");
      if (!(pressed instanceof HTMLElement) || !wrap.contains(pressed)) return;
      const caret = cellCaret(view, wrap, Number(pressed.dataset.row), Number(pressed.dataset.col));
      if (caret === null) return;
      // CodeMirror ignores a press whose default is prevented, so its mouse
      // selection never starts and the press still reaches the document's
      // listeners.
      event.preventDefault();
      pointerPress(view, caret);
    });
    return wrap;
  }

  ignoreEvent(): boolean {
    // A press on a cell or on the wrap's scrollbar is the widget's own
    // (above); any other event, another press off the cells included,
    // takes CodeMirror's default.
    return false;
  }
}

/// Whether a press on the wrap falls past its client box, on a scrollbar.
function onScrollbar(wrap: HTMLElement, event: MouseEvent): boolean {
  const box = wrap.getBoundingClientRect();
  const x = event.clientX - box.left - wrap.clientLeft;
  const y = event.clientY - box.top - wrap.clientTop;
  return x >= wrap.clientWidth || y >= wrap.clientHeight;
}

export function tableDecorations(): Extension {
  const field = StateField.define<DecorationSet>({
    create(state) {
      return scanTables(state);
    },
    update(decorations, tr) {
      // The tree-identity check catches async parse progress: the language's
      // ParseWorker publishes a further-parsed tree through an effects-only
      // dispatch (no docChanged, no selection), and create() may have scanned
      // a tree the initial in-budget parse left short of this table. Without
      // it the widget stays missing until the next edit or caret move
      // (walker.ts recomputes on the same trigger).
      // The reveal selection changes without a selection when a held press
      // is released: the grid shows its source then.
      if (
        !tr.docChanged &&
        !tr.selection &&
        selectionForReveal(tr.state) === selectionForReveal(tr.startState) &&
        syntaxTree(tr.state) === syntaxTree(tr.startState)
      ) {
        return decorations;
      }
      return scanTables(tr.state);
    },
    provide: (f) => EditorView.decorations.from(f),
  });
  return [
    field,
    EditorView.atomicRanges.of(
      (view) => view.state.field(field, false) ?? Decoration.none,
    ),
  ];
}

function scanTables(state: EditorView["state"]): DecorationSet {
  const sel = selectionForReveal(state);
  const decos: Array<{ from: number; to: number; deco: Decoration }> = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "Table") return;
      if (selectionInRange(sel, node.from, node.to)) return;
      const data = extractTable(state, node.node);
      if (!data) return;
      decos.push({
        from: node.from,
        to: node.to,
        deco: Decoration.replace({
          widget: new TableWidget(data),
          block: true,
        }),
      });
    },
  });
  decos.sort((a, b) => a.from - b.from);
  return Decoration.set(
    decos.map((d) => d.deco.range(d.from, d.to)),
    true,
  );
}

function extractTable(
  state: EditorView["state"],
  node: SyntaxNode,
): TableData | null {
  const headers: string[] = [];
  const rows: string[][] = [];
  const cursor = node.cursor();
  if (!cursor.firstChild()) return null;
  let foundHeader = false;
  do {
    if (cursor.name === "TableHeader") {
      foundHeader = true;
      headers.push(...extractCells(state, cursor.node).map((cell) => cell.text));
    } else if (cursor.name === "TableRow") {
      rows.push(extractCells(state, cursor.node).map((cell) => cell.text));
    }
    // Other children (TableDelimiter for the --- separator row) are
    // ignored.
  } while (cursor.nextSibling());
  if (!foundHeader) return null;
  return { headers, rows };
}

/// The row's cells as the parser's delimiters split them: the grid renders
/// these texts and a press maps to these ranges, so the two never disagree
/// on an escaped pipe or a pipe inside a code span.
function extractCells(
  state: EditorView["state"],
  rowNode: SyntaxNode,
): Cell[] {
  const delimiters: Array<{ from: number; to: number }> = [];
  const cursor = rowNode.cursor();
  if (!cursor.firstChild()) return [];
  do {
    if (cursor.name === "TableDelimiter") {
      delimiters.push({ from: cursor.from, to: cursor.to });
    }
  } while (cursor.nextSibling());

  const segment = (from: number, to: number): Cell => {
    const raw = state.doc.sliceString(from, to);
    const text = raw.trim();
    if (text.length === 0) return { text, from, to: from };
    const start = from + raw.length - raw.trimStart().length;
    return { text, from: start, to: start + text.length };
  };
  const cells: Cell[] = [];
  let segmentFrom = rowNode.from;
  for (let index = 0; index < delimiters.length; index++) {
    const delimiter = delimiters[index]!;
    const cell = segment(segmentFrom, delimiter.from);
    if (index > 0 || cell.text.length > 0) cells.push(cell);
    segmentFrom = delimiter.to;
  }
  const last = segment(segmentFrom, rowNode.to);
  if (last.text.length > 0) cells.push(last);
  return cells;
}

/// The caret for a press on the cell at `row` and `col` of the table the
/// widget's DOM stands for: the end of the cell's text, or just after the
/// left delimiter of an empty cell. Null when the tree no longer has that
/// cell there.
function cellCaret(view: EditorView, wrap: HTMLElement, row: number, col: number): number | null {
  if (!Number.isInteger(row) || !Number.isInteger(col)) return null;
  const at = view.posAtDOM(wrap);
  let table: SyntaxNode | null = syntaxTree(view.state).resolveInner(at, 1);
  while (table && !(table.name === "Table" && table.from === at)) table = table.parent;
  if (!table) return null;
  let index = 0;
  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (child.name !== "TableHeader" && child.name !== "TableRow") continue;
    if (index++ !== row) continue;
    const cell = extractCells(view.state, child)[col];
    if (!cell) return null;
    return cell.to;
  }
  return null;
}
