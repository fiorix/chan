// @@mention pill rendering.
//
// `@@name` mirrors chan-workspace's mention extractor: prev char must
// not be a word char (so emails like `foo@@bar.com` don't trip it),
// `name` is `[A-Za-z0-9_-]+`, no slash. Inside code spans / fenced
// blocks the source is literal - skip those ranges.
//
// Click delegation: a single `mousedown` + `click` pair on the
// content DOM walks up to the matched span. Mousedown prevents
// CM6's default caret-set so a click on a pill doesn't drop the
// caret inside the mention text (which would pop the contact
// autocomplete bubble in write mode).
//
// Resolution: `@@bob` doesn't tell us where `Bob Smith.md` lives.
// We query `api.contacts(name, 1)` on click; the first match's
// path opens (or in read-only contexts, previews via the popover).
// Cache hits stick for the editor's lifetime so a click on the
// same mention twice doesn't re-fetch.

import { syntaxTree } from "@codemirror/language";
import { type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { api } from "../../api/client";
import { openPreviewPopover } from "../overlays/preview_popover";

const MENTION_MARK = Decoration.mark({ class: "cm-md-mention" });
const MENTION_RE = /(?:^|[^A-Za-z0-9_])(@@[A-Za-z0-9_-]+)/g;

/// Same skip-set as `tagDecorations`: code spans / fenced code /
/// URLs / inside wiki bodies / link and image labels. `@@` is literal
/// source in those.
const SKIP_INSIDE = new Set<string>([
  "InlineCode",
  "FencedCode",
  "CodeBlock",
  "CodeText",
  "CodeMark",
  "CodeInfo",
  "URL",
  "WikiLinkBody",
  "Link", // the link owns the click on its label
  "Image",
]);

export interface MentionClickArgs {
  /// Mention text without the `@@` prefix.
  name: string;
  /// Resolved workspace-relative path of the contact file, or null
  /// when the name didn't match any contact in the workspace.
  path: string | null;
  /// True when the user held Cmd/Ctrl to ask for a new pane.
  openInNewPane: boolean;
}

export interface MentionOptions {
  /// Fires after the contact file is resolved (or comes back as
  /// `null`). In read-only contexts the widget pops a preview
  /// popover INSTEAD of firing this; the popover's onOpen calls
  /// onMentionClick on commit.
  onMentionClick: (args: MentionClickArgs) => void;
}

/// Cache resolved `@@name -> path` lookups for the editor's
/// lifetime so repeat clicks on the same mention don't re-fetch.
/// Null entries mean "no such contact" - also cached so we don't
/// loop the network on a stale mention.
const resolveCache = new Map<string, string | null>();

async function resolveContact(name: string): Promise<string | null> {
  const cached = resolveCache.get(name);
  if (cached !== undefined) return cached;
  try {
    const rows = await api.contacts(name, 1);
    const path = rows[0]?.path ?? null;
    resolveCache.set(name, path);
    return path;
  } catch {
    // Network / server error: don't cache the failure (so a transient
    // hiccup doesn't permanently sink this mention) but return null
    // so the click degrades gracefully.
    return null;
  }
}

export function mentionDecorations(opts: MentionOptions): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
          this.decorations = scanMentions(view);
        }

        update(u: ViewUpdate): void {
          if (u.docChanged || u.viewportChanged || u.selectionSet) {
            this.decorations = scanMentions(u.view);
          }
        }
      },
      {
        decorations: (v) => v.decorations,
      },
    ),
    EditorView.domEventHandlers({
      mousedown(event, _view) {
        const target = event.target as HTMLElement | null;
        if (!target) return false;
        const el = target.closest(".cm-md-mention");
        if (!el) return false;
        event.preventDefault();
        return true;
      },
      click(event, view) {
        const target = event.target as HTMLElement | null;
        if (!target) return false;
        const el = target.closest<HTMLElement>(".cm-md-mention");
        if (!el) return false;
        const text = el.textContent ?? "";
        if (!text.startsWith("@@")) return false;
        event.preventDefault();
        const name = text.slice(2);
        const newPane = event.metaKey || event.ctrlKey;
        const editable = view.state.facet(EditorView.editable);
        // Both modes need the resolved path. We do the lookup
        // first; readonly opens a preview, writable navigates
        // straight away.
        void resolveContact(name).then((path) => {
          if (!editable) {
            if (!path) {
              // Nothing to preview. Drop a synthetic mention-click
              // so the consumer can show a "no contact" notify
              // if it wants.
              opts.onMentionClick({ name, path: null, openInNewPane: newPane });
              return;
            }
            openPreviewPopover({
              anchor: el,
              path,
              onOpen: (openInNewPane) =>
                opts.onMentionClick({ name, path, openInNewPane }),
            });
            return;
          }
          opts.onMentionClick({ name, path, openInNewPane: newPane });
        });
        return true;
      },
    }),
  ];
}

function scanMentions(view: EditorView): DecorationSet {
  const { state } = view;
  const { from, to } = view.viewport;
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
  const startLine = state.doc.lineAt(from).number;
  const endLine = state.doc.lineAt(Math.min(to, state.doc.length)).number;
  for (let n = startLine; n <= endLine; n++) {
    const line = state.doc.line(n);
    const text = line.text;
    MENTION_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MENTION_RE.exec(text)) !== null) {
      const token = m[1]!;
      const offsetInLine = m.index + (m[0].length - token.length);
      const mFrom = line.from + offsetInLine;
      const mTo = mFrom + token.length;
      if (overlapsAny(mFrom, mTo, skip)) continue;
      decos.push({ from: mFrom, to: mTo });
    }
  }
  if (decos.length === 0) return Decoration.none;
  decos.sort((a, b) => a.from - b.from);
  return Decoration.set(decos.map((d) => MENTION_MARK.range(d.from, d.to)));
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
