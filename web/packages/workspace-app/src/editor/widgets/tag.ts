// Hashtag pill rendering.
//
// `#word` isn't a lezer-markdown node, so this lives outside the
// per-token walker as its own ViewPlugin. On every relevant update
// (doc / viewport / selection - selection so the visibility rule
// matches the rest of the editor) we scan the visible viewport's text,
// regex-match `#word`, exclude matches that fall inside InlineCode or
// FencedCode (where the `#` is literal source, not a tag), and emit a
// `Decoration.mark` with class `cm-md-tag` per surviving match.
//
// Click delegation: a single domEventHandlers handler on the editor's
// content DOM walks up from the click target to find a `.cm-md-tag`
// span and resolves the tag name from the text content. No per-mark
// listener - those don't survive remounts cleanly.
//
// Tag pattern: `(?:^|[^A-Za-z0-9_])(#[A-Za-z0-9_-]+)`. The non-capture
// boundary prefix keeps `https://x.com#section` and `foo#bar` from
// matching.

import { syntaxTree } from "@codemirror/language";
import { type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

const TAG_MARK = Decoration.mark({ class: "cm-md-tag" });
const TAG_RE = /(?:^|[^A-Za-z0-9_])(#[A-Za-z0-9_-]+)/g;

/// Names of syntax nodes inside which `#word` should NOT be tagged
/// (the `#` is literal source - code spans, code blocks, code text in
/// fenced blocks). Comment / HTML nodes also count when they appear in
/// markdown source but lezer doesn't surface them often in practice.
const SKIP_INSIDE = new Set<string>([
  "InlineCode",
  "FencedCode",
  "CodeBlock",
  "CodeText",
  "CodeMark",
  "CodeInfo",
  "URL",
  "WikiLinkBody", // inside `[[...]]`, `#` is an anchor delimiter
  "Link", // inside `[...](...)`, `#` is literal label text and the link owns the click
  "Image", // inside `![...](...)`, `#` is literal alt text
]);

export interface TagOptions {
  onTagClick: (tag: string) => void;
}

export function tagDecorations(opts: TagOptions): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
          this.decorations = scanTags(view);
        }

        update(u: ViewUpdate): void {
          if (
            u.docChanged ||
            // A syntax-tree change rescans: the creation parse can stop short
            // of the skipped code and link ranges, and the parse worker's
            // tree arrives with no document or selection change.
            syntaxTree(u.startState) !== syntaxTree(u.state) ||
            u.viewportChanged ||
            u.selectionSet
          ) {
            this.decorations = scanTags(u.view);
          }
        }
      },
      {
        decorations: (v) => v.decorations,
      },
    ),
    EditorView.domEventHandlers({
      // Suppress CM6's default caret-set on mousedown over a tag
      // pill. Without this, clicking on a tag drops the caret INSIDE
      // the `#word` range, which trips the bubble listener's tag-
      // trigger detection and pops the autocomplete picker - even
      // though the user's intent was navigation (opens the graph
      // via the click handler below). Returning true tells CM6 we
      // handled it; preventDefault keeps the browser from giving
      // the click element focus the way it normally would.
      mousedown(event, _view) {
        const target = event.target as HTMLElement | null;
        if (!target) return false;
        const el = target.closest(".cm-md-tag");
        if (!el) return false;
        event.preventDefault();
        return true;
      },
      click(event, _view) {
        const target = event.target as HTMLElement | null;
        if (!target) return false;
        const el = target.closest(".cm-md-tag");
        if (!el) return false;
        const text = el.textContent ?? "";
        if (!text.startsWith("#")) return false;
        opts.onTagClick(text.slice(1));
        event.preventDefault();
        return true;
      },
    }),
  ];
}

function scanTags(view: EditorView): DecorationSet {
  const { state } = view;
  const { from, to } = view.viewport;
  // Collect skip-ranges inside the viewport so we can skip matches that
  // fall inside them.
  const skip: Array<[number, number]> = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (SKIP_INSIDE.has(node.name)) {
        skip.push([node.from, node.to]);
      }
    },
  });
  const decos: Array<{ from: number; to: number }> = [];
  // Walk the viewport line by line so the regex doesn't span very long
  // strings (and so the `^` boundary case works at line start).
  const startLine = state.doc.lineAt(from).number;
  const endLine = state.doc.lineAt(Math.min(to, state.doc.length)).number;
  for (let n = startLine; n <= endLine; n++) {
    const line = state.doc.line(n);
    const text = line.text;
    TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TAG_RE.exec(text)) !== null) {
      const tag = m[1]!;
      const tagOffsetInLine = m.index + (m[0].length - tag.length);
      const tagFrom = line.from + tagOffsetInLine;
      const tagTo = tagFrom + tag.length;
      if (overlapsAny(tagFrom, tagTo, skip)) continue;
      decos.push({ from: tagFrom, to: tagTo });
    }
  }
  if (decos.length === 0) return Decoration.none;
  decos.sort((a, b) => a.from - b.from);
  return Decoration.set(decos.map((d) => TAG_MARK.range(d.from, d.to)));
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
