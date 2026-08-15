// Date pill widget.
//
// Detection: lezer-markdown doesn't recognize dates, so this lives in
// its own ViewPlugin (mirrors the tag pattern from widgets/tag.ts).
// We delegate matching to dateFormats.findDateMatches - the same
// matcher the legacy editor used, kept under web/packages/workspace-app/src/editor/ so date
// catalog evolution stays in one place.
//
// Rendering: per design.md #3 / #5, dates are atomic widgets.
//   - When selection intersects the date range (boundary-inclusive,
//     selectionInRange semantics - e.g. extending the selection into
//     it), suppress the widget so the user can edit the literal
//     source.
//   - When selection doesn't intersect, emit Decoration.replace with
//     a DateWidget; the widget's DOM is a styled span.
//
// EditorView.atomicRanges registered for the same ranges so caret
// motion (arrow keys) skips the pill in one keystroke.
//
// Clicking a pill does NOT place the caret (the widget owns the
// mousedown); it opens the date popover (overlays/date_popover): a
// month-grid calendar plus a format dropdown. Committing a day /
// format rewrites the date text in place, lands the caret just past
// the pill so it re-renders, and persists a format change as the new
// default. Read-only surfaces get a non-interactive calendar.

import { syntaxTree } from "@codemirror/language";
import { type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { findDateMatches, type DateFormatId } from "../dateFormats";
import { selectionInRange } from "../decorations/selection";
import { openDatePopover } from "../overlays/date_popover";
import { currentPreferences, workspace, persistDateFormat } from "../../state/store.svelte";

/// Nodes whose interior should never get pilled. Code (inline +
/// fenced) is obvious: dates in `2026-04-15` snippets are part of
/// the literal text. Link nodes cover both halves of `[label](url)`
/// so a date in the label OR in the URL stays untouched; Image is
/// the same shape. Autolink (`<https://...>`) and bare URL nodes
/// keep their date payloads literal too. WikiLinkBody covers
/// `[[Journal/2026-04-15]]` even before sentinel rules would
/// otherwise reject the body content.
const SKIP_INSIDE = new Set<string>([
  "InlineCode",
  "FencedCode",
  "CodeBlock",
  "CodeText",
  "CodeMark",
  "CodeInfo",
  "URL",
  "Link",
  "Image",
  "Autolink",
  "WikiLinkBody",
]);

class DateWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly formatId: DateFormatId,
    readonly date: Date,
  ) {
    super();
  }

  eq(other: DateWidget): boolean {
    return (
      this.text === other.text &&
      this.formatId === other.formatId &&
      this.date.getTime() === other.date.getTime()
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-md-date-pill";
    el.dataset.formatId = this.formatId;
    el.textContent = this.text;
    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      // Resolve the live source range via posAtDOM - captured `from`
      // at construction time may have shifted by upstream edits.
      const pos = view.posAtDOM(el);
      if (pos < 0) return;
      const from = pos;
      const to = pos + this.text.length;
      // Live read-only check so the same widget covers all three
      // surfaces (chat replies, user "read" toggle, fs-locked file)
      // without rebuilding decorations. The editable facet reflects
      // the current Wysiwyg.readonly state through editableCompartment.
      const editable = view.state.facet(EditorView.editable);
      openDatePopover({
        anchor: el,
        initialDate: this.date,
        initialFormatId: this.formatId,
        readonly: !editable,
        onCommit: (formatted, formatId) => {
          // Caret must always land OUTSIDE the date range so the
          // pill re-renders (anywhere inside / at the boundary
          // keeps it in source-edit mode). Two cases:
          //   - next char is a space: jump the caret past it.
          //   - next char isn't a space (or we're at EOF): insert
          //     a space so the caret has a valid landing spot one
          //     past the date.
          const after = view.state.doc.sliceString(to, to + 1);
          const needsSpace = after !== " ";
          const insert = formatted + (needsSpace ? " " : "");
          view.dispatch({
            changes: { from, to, insert },
            selection: { anchor: from + formatted.length + 1 },
          });
          // Picking a different format from the popover sticks as
          // the new default so subsequent @today / @date macros
          // honor the user's choice.
          if (formatId !== this.formatId) persistDateFormat(formatId);
          view.focus();
        },
        onDismiss: () => {},
      });
    });
    return el;
  }

  ignoreEvent(): boolean {
    // We own click via the mousedown handler above; CM6 should not
    // double-process and place the caret as a side effect.
    return true;
  }
}

export function dateDecorations(): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = scanDates(view);
      }

      update(u: ViewUpdate): void {
        if (u.docChanged || u.viewportChanged || u.selectionSet) {
          this.decorations = scanDates(u.view);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );
  return [
    plugin,
    // Atomic ranges share the same DecorationSet - caret motion
    // skips over the pill in one keystroke. When the selection
    // intersects a date and the widget gets suppressed (source
    // revealed), the corresponding atomic range disappears too,
    // so the caret can move freely through the source for editing.
    EditorView.atomicRanges.of(
      (view) => view.plugin(plugin)?.decorations ?? Decoration.none,
    ),
  ];
}

function scanDates(view: EditorView): DecorationSet {
  const { state } = view;
  const sel = state.selection;
  const { from, to } = view.viewport;
  const skip: Array<[number, number]> = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (SKIP_INSIDE.has(node.name)) skip.push([node.from, node.to]);
    },
  });
  const decos: Array<{ from: number; to: number; deco: Decoration }> = [];
  const startLine = state.doc.lineAt(from).number;
  const endLine = state.doc.lineAt(Math.min(to, state.doc.length)).number;
  for (let n = startLine; n <= endLine; n++) {
    const line = state.doc.line(n);
    const matches = findDateMatches(line.text, currentPreferences()?.date_format);
    for (const m of matches) {
      const matchFrom = line.from + m.start;
      const matchTo = line.from + m.end;
      if (overlapsAny(matchFrom, matchTo, skip)) continue;
      // Suppress the widget when the selection intersects the date
      // range; the source then becomes editable in place. The atomic
      // range ALSO disappears (since it tracks decorations) so the
      // caret can navigate through the source freely.
      if (selectionInRange(sel, matchFrom, matchTo)) continue;
      const widget = new DateWidget(m.text, m.formatId, m.date);
      decos.push({
        from: matchFrom,
        to: matchTo,
        deco: Decoration.replace({ widget }),
      });
    }
  }
  decos.sort((a, b) => a.from - b.from);
  return Decoration.set(
    decos.map((d) => d.deco.range(d.from, d.to)),
    true,
  );
}

function overlapsAny(
  from: number,
  to: number,
  ranges: Array<[number, number]>,
): boolean {
  for (const [a, b] of ranges) {
    if (from < b && to > a) return true;
  }
  return false;
}
