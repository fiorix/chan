// Lezer-markdown extension that lets `[label](path)` form when the label
// contains a balanced inner bracket pair, e.g. `[[foo] bar](path)`.
//
// @lezer/markdown greedily forms a shortcut reference Link for the inner
// `[foo]` (two LinkMarks, no URL). Its no-nested-links rule then marks the
// enclosing `[` opener invalid (`side = 0`), so the outer `[..](path)` never
// forms and the whole construct stays raw text. Downstream decoration code
// (the `linkMarks.length < 4` guards) correctly punts on the broken shape.
//
// A surgical pre-`LinkEnd` interceptor (not a full LinkEnd replacement): at a
// `]` that would only close as a shortcut reference while
// nested inside another open link/image start, drop the inner opener and
// consume the `]` as text so the enclosing `](...)` forms a real link.

import { InlineContext, type MarkdownConfig } from "@lezer/markdown";

const CLOSE_BRACKET = 93; // ']'
const OPEN_BRACKET = 91; // '['
const OPEN_PAREN = 40; // '('

// The exact @lezer/markdown pin protects these @internal parts and side fields;
// the parser test checks their runtime shape before a version is accepted.
type LinkDelim = { type: unknown; from: number; to: number; side: number };
type PartsView = { parts: Array<{ type: unknown; side?: number } | null> };

/**
 * Ref-aware Link interceptor. @lezer/markdown greedily forms a shortcut
 * reference for an inner `[..]` and the no-nested-links rule then kills an
 * enclosing `[label](path)` link. At a `]` that would close as a shortcut ref
 * while nested inside another open link/image start, drop the inner opener and
 * consume the `]` as text so the enclosing `](...)` forms a real link.
 */
export const RefAwareLink: MarkdownConfig = {
  parseInline: [
    {
      name: "RefAwareLink",
      before: "LinkEnd",
      parse(cx, next, start) {
        if (next !== CLOSE_BRACKET) return -1;
        const after = cx.char(start + 1);
        // A following '(' or '[' is an inline / reference link: the built-in
        // LinkEnd already does the right thing.
        if (after === OPEN_PAREN || after === OPEN_BRACKET) return -1;

        const linkStart = InlineContext.linkStart;
        const imageStart = InlineContext.imageStart;
        const parts = (cx as unknown as PartsView).parts;
        const isStart = (p: { type: unknown } | null) =>
          !!p && (p.type === linkStart || p.type === imageStart);

        // Nearest link/image start (mirror the built-in scan, incl. invalid).
        let innerIdx = -1;
        for (let i = parts.length - 1; i >= 0; i--) {
          if (isStart(parts[i])) {
            innerIdx = i;
            break;
          }
        }
        if (innerIdx < 0) return -1;
        const inner = parts[innerIdx] as unknown as LinkDelim;
        if (!inner.side) return -1; // built-in would bail
        if (cx.skipSpace(inner.to) === start) return -1; // empty label

        // Enclosing OPEN link/image start below the inner one?
        let enclosingOpen = false;
        for (let j = innerIdx - 1; j >= 0; j--) {
          const p = parts[j];
          if (isStart(p) && (p as unknown as LinkDelim).side) {
            enclosingOpen = true;
            break;
          }
        }
        if (!enclosingOpen) return -1; // standalone shortcut ref -- leave as-is

        // Suppress the inner shortcut ref so the enclosing link forms.
        parts[innerIdx] = null;
        return start + 1;
      },
    },
  ],
};
