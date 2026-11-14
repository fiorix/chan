// Lightweight markdown -> sanitized HTML helper for read-only
// previews that need headers / lists / code / links / paragraphs.
//
// Output is sanitized via DOMPurify before any {@html ...} insert
// so every {@html ...} insertion goes through the same chokepoint.

import DOMPurify, { type Config } from "dompurify";
import { marked } from "marked";
import { embedIframeHtml, isAllowedEmbedSrc } from "./embed";
import { parseWikiBody } from "../editor/links";

// Defaults are fine for previews: GFM (tables, strikethrough),
// auto-linking off (we don't want to silently rewrite text), no
// breaks (preserve authored paragraph boundaries).
marked.setOptions({
  gfm: true,
  breaks: false,
});

// Embeddable hosts (YouTube / Google Maps) written as a markdown image
// `![](url)` render as a sandboxed <iframe>; every other image falls
// through (the renderer returns `false`) to marked's default <img>.
// `marked` is a singleton imported only here, so this override is
// scoped to the renderMarkdown pipeline.
marked.use({
  extensions: [
    {
      name: "wikilink",
      level: "inline",
      start(src) {
        return src.indexOf("[[");
      },
      tokenizer(src) {
        // Match the editor's nonempty, line-bound bodies without nested [[.
        // An inline token leaves code spans and fenced blocks to marked.
        const match = /^\[\[((?:(?!\[\[|\]\])[^\n])+)\]\]/.exec(src);
        if (!match) return;
        return {
          type: "wikilink",
          raw: match[0],
          text: parseWikiBody(match[1]).label,
        };
      },
      renderer(token) {
        // Labels are literal text in the editor, including HTML and entities.
        return token.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
      },
    },
  ],
  renderer: {
    image(token) {
      return embedIframeHtml(token.href) ?? false;
    },
  },
});

// Allow the embed iframes through DOMPurify, but ONLY for the host
// allowlist (embed.ts). The hook is the backstop: it drops any iframe
// -- including a raw `<iframe>` in user markdown -- whose src is not an
// allowlisted embed origin, and forces the protective attributes on the
// ones that survive. `ADD_TAGS`/`ADD_ATTR` are passed per-call
// (SANITIZE_OPTS) so other DOMPurify callers keep stripping iframes.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.nodeName !== "IFRAME") return;
  const el = node as Element;
  if (!isAllowedEmbedSrc(el.getAttribute("src"))) {
    el.remove();
    return;
  }
  if (!el.getAttribute("sandbox")) {
    el.setAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-presentation allow-popups",
    );
  }
  if (!el.getAttribute("referrerpolicy")) {
    el.setAttribute("referrerpolicy", "no-referrer-when-downgrade");
  }
});

// Per-call config that admits the embed iframe (tag + its attributes).
// Scoped to renderMarkdown* so the global DOMPurify default is unchanged.
const SANITIZE_OPTS: Config = {
  ADD_TAGS: ["iframe"],
  ADD_ATTR: [
    "allow",
    "allowfullscreen",
    "frameborder",
    "scrolling",
    "sandbox",
    "loading",
    "referrerpolicy",
  ],
};

/// Render a markdown string to a sanitized HTML string suitable
/// for `{@html ...}`. Synchronous (we use marked's sync `parse`
/// and DOMPurify on the result) so callers can use it inline in
/// templates without `await`.
export function renderMarkdown(input: string): string {
  // marked.parse can return Promise<string> if any extension is
  // async; we use no async extensions, so cast through unknown.
  const raw = marked.parse(input ?? "", { async: false }) as string;
  return DOMPurify.sanitize(raw, SANITIZE_OPTS);
}

/// Like `renderMarkdown` but with `breaks: true` so a SINGLE newline
/// renders as a `<br>` (CommonMark soft-break = line break, not a space).
/// For authored multi-line bodies where line breaks are intentional --
/// e.g. a `cs terminal survey` prompt -- without changing the global
/// `breaks: false` (which preserves paragraph boundaries elsewhere). The
/// per-call options merge over the instance defaults, so `gfm` stays on.
export function renderMarkdownWithBreaks(input: string): string {
  const raw = marked.parse(input ?? "", {
    async: false,
    breaks: true,
    gfm: true,
  }) as string;
  return DOMPurify.sanitize(raw, SANITIZE_OPTS);
}

/// Render a markdown string to sanitized INLINE HTML: bold, italic,
/// inline code, links and the other inline spans, with no wrapping
/// block element (no `<p>`). For inline-only contexts like table cells
/// that need marked's inline pass but must stay in flow. Goes through
/// the same `DOMPurify.sanitize` chokepoint as the block renderers.
export function renderMarkdownInline(input: string): string {
  const raw = marked.parseInline(input ?? "", { async: false }) as string;
  return DOMPurify.sanitize(raw, SANITIZE_OPTS);
}
