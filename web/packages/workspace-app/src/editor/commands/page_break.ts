import { StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import type { EditorView as EditorViewType } from "@codemirror/view";
import { lineIntersect } from "../decorations/selection";

export const PAGE_BREAK_MARKER = '<hr class="chan-page-break">';

const TRIGGERS = ["@pagebreak", "@break"] as const;
const PAGE_BREAK_LINE_RE =
  /^\s*<hr\s+class=(["'])chan-page-break\1\s*\/?>\s*$/i;

export function isPageBreakLine(text: string): boolean {
  return PAGE_BREAK_LINE_RE.test(text);
}

function detectTrigger(view: EditorViewType): {
  from: number;
  to: number;
} | null {
  const sel = view.state.selection.main;
  if (!sel.empty) return null;
  const pos = sel.head;
  const line = view.state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  for (const keyword of TRIGGERS) {
    if (!before.endsWith(keyword)) continue;
    const start = before.length - keyword.length;
    if (start > 0 && !/\s/.test(before[start - 1]!)) continue;
    return { from: line.from + start, to: pos };
  }
  return null;
}

function consumeLineBreak(state: EditorViewType["state"], to: number): number {
  return to < state.doc.length ? to + 1 : to;
}

/// Newlines to append after the marker so exactly one blank line
/// separates it from the following content. A fixed "\n\n" on top of a
/// line break or blank line the document already provides leaves a
/// 2-blank run after the marker, which slide rendering used to show as
/// a spacer band above the next slide's heading.
function separatorAfter(state: EditorViewType["state"], to: number): string {
  const doc = state.doc;
  if (to >= doc.length) return "\n\n";
  const line = doc.lineAt(to);
  // `to` at a line start: the replacement consumed the trigger line's
  // newline, so the following line's text starts here. A blank line
  // there already is the separator.
  if (to === line.from) return line.text.trim() === "" ? "\n" : "\n\n";
  // `to` at a line end: the document's own newline terminates the
  // marker line; add the blank separator only when the next line does
  // not supply one.
  if (to === line.to) {
    const next = doc.lineAt(to + 1);
    return next.text.trim() === "" ? "" : "\n";
  }
  // `to` mid-line: the rest of the line becomes the content below the
  // marker and needs both the marker's line end and the blank separator.
  return "\n\n";
}

function trimInlineSpaceAroundTrigger(
  view: EditorViewType,
  from: number,
  to: number,
): { from: number; to: number } {
  const line = view.state.doc.lineAt(from);
  let nextFrom = from;
  let nextTo = to;
  while (nextFrom > line.from) {
    const prev = view.state.doc.sliceString(nextFrom - 1, nextFrom);
    if (prev !== " " && prev !== "\t") break;
    nextFrom -= 1;
  }
  while (nextTo < line.to) {
    const next = view.state.doc.sliceString(nextTo, nextTo + 1);
    if (next !== " " && next !== "\t") break;
    nextTo += 1;
  }
  return { from: nextFrom, to: nextTo };
}

export function expandPageBreakMacro(view: EditorViewType): boolean {
  const hit = detectTrigger(view);
  if (!hit) return false;
  const line = view.state.doc.lineAt(hit.from);
  const before = line.text.slice(0, hit.from - line.from);
  const after = line.text.slice(hit.to - line.from);
  let from: number;
  let to: number;
  let insert: string;

  if (before.trim() === "") {
    from = line.from;
    to = after.trim() === ""
      ? consumeLineBreak(view.state, line.to)
      : trimInlineSpaceAroundTrigger(view, hit.from, hit.to).to;
    insert = PAGE_BREAK_MARKER;
  } else {
    const trimmed = trimInlineSpaceAroundTrigger(view, hit.from, hit.to);
    from = trimmed.from;
    to = after.trim() === "" ? line.to : trimmed.to;
    insert = `\n\n${PAGE_BREAK_MARKER}`;
  }
  insert += separatorAfter(view.state, to);

  // When the document supplies the marker's line end (empty separator
  // suffix), hop over it so the caret still lands below the marker.
  const caret = insert.endsWith("\n")
    ? from + insert.length
    : from + insert.length + 1;

  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: caret },
  });
  return true;
}

class PageBreakWidget extends WidgetType {
  eq(_other: PageBreakWidget): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-page-break";
    const rule = document.createElement("span");
    rule.className = "cm-md-page-break-rule";
    const label = document.createElement("span");
    label.className = "cm-md-page-break-label";
    label.textContent = "Page break";
    wrap.append(rule, label);
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function scanPageBreaks(state: EditorViewType["state"]): DecorationSet {
  const decos: Array<{ from: number; to: number; deco: Decoration }> = [];
  for (let lineNo = 1; lineNo <= state.doc.lines; lineNo++) {
    const line = state.doc.line(lineNo);
    if (!isPageBreakLine(line.text)) continue;
    if (lineIntersect(state, line.from, line.to, state.selection)) continue;
    decos.push({
      from: line.from,
      to: line.to,
      deco: Decoration.replace({
        widget: new PageBreakWidget(),
        block: true,
      }),
    });
  }
  return Decoration.set(
    decos.map((d) => d.deco.range(d.from, d.to)),
    true,
  );
}

export function pageBreakDecorations(): Extension {
  const field = StateField.define<DecorationSet>({
    create(state) {
      return scanPageBreaks(state);
    },
    update(decorations, tr) {
      if (!tr.docChanged && !tr.selection) return decorations;
      return scanPageBreaks(tr.state);
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
