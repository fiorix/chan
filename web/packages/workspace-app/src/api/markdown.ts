// Lightweight markdown -> sanitized HTML helper for read-only
// previews that need headers / lists / code / links / paragraphs.
//
// Output is sanitized via DOMPurify before any {@html ...} insert
// so every {@html ...} insertion goes through the same chokepoint.

import DOMPurify, { type Config } from "dompurify";
import { marked } from "marked";
import { GFM, parser } from "@lezer/markdown";
import { embedIframeHtml, isAllowedEmbedSrc } from "./embed";
import { parseWikiBody } from "../editor/links";
import { Frontmatter } from "../editor/markdown/frontmatter";
import { RefAwareLink } from "../editor/markdown/refAwareLink";
import { WikiLink } from "../editor/markdown/wikilink";

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
  renderer: {
    image(token) {
      return embedIframeHtml(token.href) ?? false;
    },
  },
});

const wikiParser = parser.configure([Frontmatter, ...GFM, WikiLink, RefAwareLink]);

function renderWikiLabels(input: string): string {
  let output = "";
  let end = 0;
  // Parse the original source so code, URLs and HTML cannot manufacture
  // wikilinks by hiding delimiters from a later Markdown pass.
  wikiParser.parse(input).iterate({
    enter(node) {
      if (node.name === "Image") return false; // Alt text becomes an attribute; keep span markup out of it.
      if (node.name !== "WikiLink") return;
      const { label } = parseWikiBody(input.slice(node.from + 2, node.to - 2));
      // Character references keep every label literal to marked, including
      // emphasis and URL syntax. The span preserves the inline boundary
      // even for an empty alias; it carries no export-control attributes.
      const text = Array.from(label, (char) => `&#${char.codePointAt(0)};`).join("");
      output += input.slice(end, node.from) + `<span>${text}</span>`;
      end = node.to;
      return false;
    },
  });
  return output + input.slice(end);
}

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
/// Slides and printable documents opt into editor wikilink labels; other
/// callers keep the authored syntax.
export function renderMarkdown(input: string, opts: { wikilinks?: boolean } = {}): string {
  // marked.parse can return Promise<string> if any extension is
  // async; we use no async extensions, so cast through unknown.
  const source = input ?? "";
  const raw = marked.parse(opts.wikilinks ? renderWikiLabels(source) : source, { async: false }) as string;
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
