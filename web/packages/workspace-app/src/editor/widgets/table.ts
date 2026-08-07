// GFM table rendering as a grid widget.
//
// Atom: a `<table>` DOM rendered from the syntaxTree's Table node.
// Selection-intersect rule applies - caret inside the source range
// suppresses the widget so the user sees the raw pipe / dash form
// for editing. EditorView.atomicRanges so caret motion skips the
// table in one keypress.
//
// v1.2 scope: read-only grid. Click on the widget drops the caret at
// the table's source start (selection-intersect then reveals source
// next tick). True in-cell editing without losing pipe alignment is
// v1.3+ work - the markdown source is plain enough that direct
// editing is acceptable for now.

import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { StateField, type Extension } from "@codemirror/state";
import { renderMarkdownInline } from "../../api/markdown";
import { selectionInRange } from "../decorations/selection";

interface TableData {
  headers: string[];
  rows: string[][];
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

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap";
    const table = document.createElement("table");
    table.className = "cm-md-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const h of this.data.headers) {
      const th = document.createElement("th");
      // Cell source is inline markdown; render it (bold, italic, code,
      // links) through the sanitized inline pipeline before insert.
      th.innerHTML = renderMarkdownInline(h);
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (const row of this.data.rows) {
      const tr = document.createElement("tr");
      for (const cell of row) {
        const td = document.createElement("td");
        td.innerHTML = renderMarkdownInline(cell);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  ignoreEvent(): boolean {
    // Click on the widget defers to CM6's default behavior - places
    // caret at the table's boundary, selection-intersect rule then
    // reveals source for editing on the next update tick.
    return false;
  }
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
      if (
        !tr.docChanged &&
        !tr.selection &&
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
  const sel = state.selection;
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
  node: import("@lezer/common").SyntaxNode,
): TableData | null {
  const headers: string[] = [];
  const rows: string[][] = [];
  const cursor = node.cursor();
  if (!cursor.firstChild()) return null;
  let foundHeader = false;
  do {
    if (cursor.name === "TableHeader") {
      foundHeader = true;
      headers.push(...extractCells(state, cursor.node));
    } else if (cursor.name === "TableRow") {
      rows.push(extractCells(state, cursor.node));
    }
    // Other children (TableDelimiter for the --- separator row) are
    // ignored.
  } while (cursor.nextSibling());
  if (!foundHeader || headers.length === 0) return null;
  return { headers, rows };
}

function extractCells(
  state: EditorView["state"],
  rowNode: import("@lezer/common").SyntaxNode,
): string[] {
  const cells: string[] = [];
  const cursor = rowNode.cursor();
  if (!cursor.firstChild()) return cells;
  do {
    if (cursor.name === "TableCell") {
      cells.push(state.doc.sliceString(cursor.from, cursor.to).trim());
    }
  } while (cursor.nextSibling());
  return cells;
}
