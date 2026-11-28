// Lightweight markdown -> sanitized HTML helper for read-only
// previews that need headers / lists / code / links / paragraphs.
//
// Output is sanitized via DOMPurify before any {@html ...} insert
// so every {@html ...} insertion goes through the same chokepoint.
// Wikilink labels are opt-in per call: pass `{ wikilinks: true }`
// where the surface shows labels; a call without the option keeps
// the authored syntax.

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

/// Two link finders: whole documents keep the frontmatter rule, since
/// metadata can hold bracket text that is not a link (a parent's path,
/// a grid of numbers); fragments (a copy selection, a survey body, a
/// table cell) skip it, since a fragment can start at a `---` rule.
const wikiParser = parser.configure([...GFM, WikiLink, RefAwareLink]);
const wikiFrontmatterParser = parser.configure([Frontmatter, ...GFM, WikiLink, RefAwareLink]);

interface WikiSpan {
  from: number;
  to: number;
}

/// An inline `<style>` tag and its closing tag, in any case.
const STYLE_OPEN = /^<style[\s/>]/i;
const STYLE_CLOSE = /^<\/style[\s>]/i;

/// The `[[...]]` spans to label. The block parse handles emphasis and
/// the document structure; for the inline renderer the source is read
/// as one paragraph (a `| ` prefix the offsets account for), so a cell
/// that opens with a block-level tag still yields its links beside the
/// tags. The walk visits spans in order. The inline renderer's one
/// caller sends one line, so the paragraph reading holds there.
///
/// A link after an inline `<style>` tag and before its closing tag stays
/// as typed: the HTML parser reads that text as the element's rules, so a
/// label span would become part of them, and DOMPurify drops a style
/// element whose text holds markup, which Copy as HTML would otherwise keep.
function wikiLinkSpans(input: string, inline: boolean, frontmatter: boolean): WikiSpan[] {
  if (!input.includes("[[")) return [];
  const source = inline ? `| ${input}` : input;
  const base = inline ? 2 : 0;
  const finder = !inline && frontmatter ? wikiFrontmatterParser : wikiParser;
  const spans: WikiSpan[] = [];
  let inStyle = false;
  // Parse the original source so code, URLs and HTML cannot manufacture
  // wikilinks by hiding delimiters from a later Markdown pass.
  finder.parse(source).iterate({
    enter(node) {
      if (node.name === "HTMLTag") {
        const tag = source.slice(node.from, node.to);
        if (STYLE_OPEN.test(tag)) inStyle = true;
        else if (STYLE_CLOSE.test(tag)) inStyle = false;
        return false;
      }
      if (node.name === "Image") return false; // Alt text becomes an attribute; keep span markup out of it.
      if (node.name !== "WikiLink") return;
      if (!inStyle) spans.push({ from: node.from - base, to: node.to - base });
      return false;
    },
  });
  return spans;
}

/// A POSIX class in a bracket expression, such as `[[:space:]]`.
const POSIX_CLASS = /^:[a-z]+:$/;

/// A shell test on one line: `[[` and a blank, up to the first blank and
/// `]]`, which is the word that ends it.
const SHELL_TEST = /\[\[[ \t].*?[ \t]\]\]/g;

/// Whether a wikilink span is plainly a link, for prose with no note behind
/// it. A shell conditional always has a blank after its `[[`, which the
/// shell reads as a word of its own, and the link syntax has no escape for
/// a bracket, so a body that opens with whitespace or holds a bracket is a
/// shell test or a nested array, not a link chan's pickers write. The
/// grammar refuses a `[[` whose body holds another, so the `[[...]]` inside
/// a shell test (a regex's POSIX class, a pattern) reaches here alone: a
/// POSIX class anywhere and any span inside a shell test are shell text too.
function isPlainLink(input: string, span: WikiSpan): boolean {
  const body = input.slice(span.from + 2, span.to - 2);
  if (/^\s/.test(body) || /[[\]]/.test(body) || POSIX_CLASS.test(body)) return false;
  const start = input.lastIndexOf("\n", span.from) + 1;
  const newline = input.indexOf("\n", span.to);
  const line = input.slice(start, newline < 0 ? input.length : newline);
  for (const test of line.matchAll(SHELL_TEST)) {
    const from = start + test.index;
    if (from <= span.from && span.to <= from + test[0].length) return false;
  }
  return true;
}

function renderWikiLabels(
  input: string,
  inline: boolean,
  frontmatter: boolean,
  isLink: (input: string, span: WikiSpan) => boolean = () => true,
): string {
  let output = "";
  let end = 0;
  for (const span of wikiLinkSpans(input, inline, frontmatter)) {
    // A span left out stays in the source as typed, up to the next label.
    if (!isLink(input, span)) continue;
    const { label } = parseWikiBody(input.slice(span.from + 2, span.to - 2));
    // Character references keep every label literal to marked, including
    // emphasis and URL syntax. The span preserves the inline boundary
    // even for an empty alias; it carries no export-control attributes.
    const text = Array.from(label, (char) => `&#${char.codePointAt(0)};`).join("");
    output += input.slice(end, span.from) + `<span>${text}</span>`;
    end = span.to;
  }
  return output + input.slice(end);
}

// Allow the embed iframes through DOMPurify, but ONLY for the host
// allowlist (embed.ts). The hook is the backstop: it drops any iframe
// -- including a raw `<iframe>` in user markdown -- whose src is not an
// allowlisted embed origin, and forces the protective attributes on the
// ones that survive. `ADD_TAGS`/`ADD_ATTR` are passed per call
// (EMBED_OPTS, which SANITIZE_OPTS extends) so other DOMPurify callers
// keep stripping iframes.
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
const EMBED_OPTS: Config = {
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

// The rendered HTML enters the app's own document, where a `<style>`
// element's rules reach every element, not only the ones beside it, so the
// renderers drop it. `FORBID_TAGS` drops every spelling DOMPurify would
// otherwise keep (after other content, inside an inline SVG) with its
// rules, since `style` is one of the tags whose content it removes too.
const SANITIZE_OPTS: Config = { ...EMBED_OPTS, FORBID_TAGS: ["style"] };

/// Render a markdown string to a sanitized HTML string suitable
/// for `{@html ...}`. Synchronous (we use marked's sync `parse`
/// and DOMPurify on the result) so callers can use it inline in
/// templates without `await`.
/// Pass `{ wikilinks: true }` where the surface shows editor wikilink
/// labels; a call without the option keeps the authored syntax.
/// Whole documents also pass `{ frontmatter: true }` so metadata keeps
/// its brackets; fragments never do. `keepStyleElements` keeps a
/// `<style>` element, for HTML that leaves the app without entering its
/// document.
export function renderMarkdown(
  input: string,
  opts: { wikilinks?: boolean; frontmatter?: boolean; keepStyleElements?: boolean } = {},
): string {
  // marked.parse can return Promise<string> if any extension is
  // async; we use no async extensions, so cast through unknown.
  const source = input ?? "";
  const raw = marked.parse(opts.wikilinks ? renderWikiLabels(source, false, !!opts.frontmatter) : source, { async: false }) as string;
  return DOMPurify.sanitize(raw, opts.keepStyleElements ? EMBED_OPTS : SANITIZE_OPTS);
}

/// Like `renderMarkdown` but with `breaks: true` so a SINGLE newline
/// renders as a `<br>` (CommonMark soft-break = line break, not a space).
/// For authored multi-line bodies where line breaks are intentional --
/// e.g. a `cs terminal survey` prompt -- without changing the global
/// `breaks: false` (which preserves paragraph boundaries elsewhere). The
/// per-call options merge over the instance defaults, so `gfm` stays on.
/// Pass `{ wikilinks: true }` where the surface shows editor wikilink
/// labels; a call without the option keeps the authored syntax.
/// `{ wikilinks: "strict" }` labels only a plain link and keeps as typed a
/// `[[...]]` whose body opens with whitespace, holds a bracket or is a
/// POSIX class (`[[:space:]]`), and any `[[...]]` inside a shell test: for
/// prose with no note behind it, such as a survey body, where double
/// brackets are as likely a shell test as a link.
export function renderMarkdownWithBreaks(input: string, opts: { wikilinks?: boolean | "strict" } = {}): string {
  const source = input ?? "";
  const labelled = opts.wikilinks
    ? renderWikiLabels(source, false, false, opts.wikilinks === "strict" ? isPlainLink : undefined)
    : source;
  const raw = marked.parse(labelled, {
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
/// Pass `{ wikilinks: true }` where the surface shows editor wikilink
/// labels; a call without the option keeps the authored syntax.
/// The labels assume one line, as a table cell is: the label pass reads
/// the input as one paragraph, so in input holding a blank line a link on
/// a later line that Markdown reads as an indented code block or an HTML
/// block keeps its brackets, though this renderer shows that line as
/// inline text.
export function renderMarkdownInline(input: string, opts: { wikilinks?: boolean } = {}): string {
  const source = input ?? "";
  const raw = marked.parseInline(opts.wikilinks ? renderWikiLabels(source, true, false) : source, { async: false }) as string;
  return DOMPurify.sanitize(raw, SANITIZE_OPTS);
}
