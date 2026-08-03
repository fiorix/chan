// Printable document DOM for the PDF export engine: renders a markdown
// document into a themed container whose CSS is scoped under
// `.chan-print-page`, so it can live inside the app document (offscreen)
// without leaking styles. Diagram fences, Excalidraw embeds, and image
// resolution hydrate through the same editor/slide_dom renderers the
// slide preview uses; the completion promise resolves when every async
// render settled.

import { renderMarkdown } from "../api/markdown";
import {
  editorTokens,
  prepareSlideImages,
  renderSlideDiagrams,
  slideMediaCss,
  type SlideDomTheme,
} from "./slide_dom";

export const DOC_CONTAINER_CLASS = "chan-print-page";

// Editor tokens a printable document consumes: the slide set plus the
// body/background tokens and the h2 border pair that document headings
// use (slides restyle those two).
const DOC_EDITOR_VARS = [
  "--chan-editor-body-family",
  "--chan-editor-body-color",
  "--chan-editor-bg",
  "--chan-editor-heading-family",
  "--chan-editor-heading-color",
  "--chan-editor-h1-size",
  "--chan-editor-h1-weight",
  "--chan-editor-h1-line-height",
  "--chan-editor-h1-border-bottom",
  "--chan-editor-h1-padding-bottom",
  "--chan-editor-h2-size",
  "--chan-editor-h2-weight",
  "--chan-editor-h2-line-height",
  "--chan-editor-h2-border-bottom",
  "--chan-editor-h2-padding-bottom",
  "--chan-editor-h3-size",
  "--chan-editor-h3-weight",
  "--chan-editor-h3-line-height",
  "--chan-editor-h4-size",
  "--chan-editor-h4-weight",
  "--chan-editor-h4-line-height",
  "--chan-editor-h5-size",
  "--chan-editor-h5-weight",
  "--chan-editor-h5-line-height",
  "--chan-editor-h6-size",
  "--chan-editor-h6-weight",
  "--chan-editor-h6-line-height",
  "--chan-editor-h6-color",
  "--chan-editor-code-family",
  "--chan-editor-code-size",
  "--chan-editor-inline-code-bg",
  "--chan-editor-inline-code-color",
  "--chan-editor-code-block-bg",
  "--chan-editor-code-block-color",
  "--chan-editor-code-block-border",
  "--chan-editor-link-color",
  "--chan-editor-quote-color",
  "--chan-editor-quote-border",
  "--chan-editor-hr-color",
  "--chan-editor-table-border",
  "--chan-editor-table-header-bg",
  "--chan-editor-table-stripe-bg",
] as const;

export type DocDomOptions = {
  markdown: string;
  /// Workspace path of the markdown source; resolves relative image srcs.
  path: string;
  theme: SlideDomTheme;
  styleSource?: Element | null;
  /// Printable content width in CSS px; the container is exactly this
  /// wide so block measurement and pagination see final geometry.
  contentWidthPx: number;
};

export type DocDom = {
  /// The container element, ready to insert (offscreen) for measurement.
  root: HTMLElement;
  /// The content element holding the rendered markdown blocks.
  content: HTMLElement;
  /// Resolves when every diagram and Excalidraw render settled.
  completion: Promise<void>;
};

/// Build the printable document container: themed inline tokens on the
/// root, scoped stylesheet, rendered markdown, and async hydration of
/// diagrams and images.
export function buildDocDom(opts: DocDomOptions): DocDom {
  const tokens = editorTokens(opts.styleSource, opts.theme, DOC_EDITOR_VARS);
  const root = document.createElement("div");
  root.className = DOC_CONTAINER_CLASS;
  root.style.cssText = [
    tokens.vars,
    "box-sizing:border-box",
    `color-scheme:${opts.theme}`,
    `width:${opts.contentWidthPx}px`,
    `background:${tokens.bg}`,
    `color:${tokens.fg}`,
    `font-family:${tokens.bodyFamily}`,
    `font-size:var(--chan-editor-body-size,${tokens.bodySize})`,
    "line-height:1.65",
  ].join(";");

  const style = document.createElement("style");
  style.textContent = docCss();
  root.appendChild(style);

  const content = document.createElement("div");
  content.className = "chan-print-content";
  // flow-root keeps child margins inside the content box, so block
  // offsets measured against it hold in any container: page clones clip
  // inside a BFC, and a collapsed-through margin would shift every
  // measured cut by the first block's margin.
  content.style.display = "flow-root";
  content.innerHTML = renderMarkdown(opts.markdown);
  root.appendChild(content);

  const completion = Promise.all([
    prepareSlideImages(content, opts.path, opts.theme, () => true),
    renderSlideDiagrams(content, opts.markdown, opts.theme, () => true),
  ]).then(() => undefined);

  return { root, content, completion };
}

/// Document typography, scoped under the container class. Media and
/// diagram rules come from the shared slide_dom block.
export function docCss(): string {
  return `
.${DOC_CONTAINER_CLASS} h1,
.${DOC_CONTAINER_CLASS} h2,
.${DOC_CONTAINER_CLASS} h3,
.${DOC_CONTAINER_CLASS} h4,
.${DOC_CONTAINER_CLASS} h5,
.${DOC_CONTAINER_CLASS} h6 {
  color: var(--chan-editor-heading-color, currentColor);
  font-family: var(--chan-editor-heading-family, var(--chan-editor-body-family, inherit));
}
.${DOC_CONTAINER_CLASS} h1 {
  font-size: var(--chan-editor-h1-size, 2em);
  font-weight: var(--chan-editor-h1-weight, 700);
  line-height: var(--chan-editor-h1-line-height, 1.25);
  border-bottom: var(--chan-editor-h1-border-bottom, none);
  padding-bottom: var(--chan-editor-h1-padding-bottom, 0);
}
.${DOC_CONTAINER_CLASS} h2 {
  font-size: var(--chan-editor-h2-size, 1.6em);
  font-weight: var(--chan-editor-h2-weight, 700);
  line-height: var(--chan-editor-h2-line-height, 1.3);
  border-bottom: var(--chan-editor-h2-border-bottom, none);
  padding-bottom: var(--chan-editor-h2-padding-bottom, 0);
}
.${DOC_CONTAINER_CLASS} h3 {
  font-size: var(--chan-editor-h3-size, 1.3em);
  font-weight: var(--chan-editor-h3-weight, 600);
  line-height: var(--chan-editor-h3-line-height, 1.35);
}
.${DOC_CONTAINER_CLASS} h4 {
  font-size: var(--chan-editor-h4-size, 1.15em);
  font-weight: var(--chan-editor-h4-weight, 600);
  line-height: var(--chan-editor-h4-line-height, 1.4);
}
.${DOC_CONTAINER_CLASS} h5 {
  font-size: var(--chan-editor-h5-size, 1em);
  font-weight: var(--chan-editor-h5-weight, 600);
  line-height: var(--chan-editor-h5-line-height, 1.4);
}
.${DOC_CONTAINER_CLASS} h6 {
  color: var(--chan-editor-h6-color, currentColor);
  font-size: var(--chan-editor-h6-size, 0.95em);
  font-weight: var(--chan-editor-h6-weight, 600);
  line-height: var(--chan-editor-h6-line-height, 1.4);
}
.${DOC_CONTAINER_CLASS} a {
  color: var(--chan-editor-link-color, #0969da);
}
.${DOC_CONTAINER_CLASS} blockquote {
  border-left: 3px solid var(--chan-editor-quote-border, #d0d7de);
  color: var(--chan-editor-quote-color, currentColor);
  margin-left: 0;
  padding-left: 1em;
}
.${DOC_CONTAINER_CLASS} code {
  background: var(--chan-editor-inline-code-bg, rgba(175, 184, 193, 0.2));
  color: var(--chan-editor-inline-code-color, currentColor);
  font-family: var(--chan-editor-code-family, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--chan-editor-code-size, 0.92em);
  padding: 0.12em 0.28em;
  border-radius: 4px;
}
.${DOC_CONTAINER_CLASS} pre {
  background: var(--chan-editor-code-block-bg, #f6f8fa);
  border: 1px solid var(--chan-editor-code-block-border, transparent);
  color: var(--chan-editor-code-block-color, currentColor);
  overflow-wrap: anywhere;
  padding: 12px;
  white-space: pre-wrap;
}
.${DOC_CONTAINER_CLASS} pre code {
  background: transparent;
  border-radius: 0;
  padding: 0;
}
.${DOC_CONTAINER_CLASS} hr {
  border: 0;
  border-top: 1px solid var(--chan-editor-hr-color, #d0d7de);
}
.${DOC_CONTAINER_CLASS} table {
  border-collapse: collapse;
  width: 100%;
}
.${DOC_CONTAINER_CLASS} th,
.${DOC_CONTAINER_CLASS} td {
  border: 1px solid var(--chan-editor-table-border, #d0d7de);
  padding: 6px 8px;
  overflow-wrap: normal;
  word-break: normal;
}
.${DOC_CONTAINER_CLASS} th {
  background: var(--chan-editor-table-header-bg, #f6f8fa);
}
.${DOC_CONTAINER_CLASS} tr:nth-child(even) td {
  background: var(--chan-editor-table-stripe-bg, transparent);
}
.${DOC_CONTAINER_CLASS} img {
  display: block;
  height: auto;
  max-width: 100%;
  margin: 1em auto;
}
.${DOC_CONTAINER_CLASS} .chan-slide-media > img { margin: 1em 0; }
.${DOC_CONTAINER_CLASS} hr.chan-page-break {
  border: 0;
  margin: 0;
}
${slideMediaCss(`.${DOC_CONTAINER_CLASS}`)}`;
}
