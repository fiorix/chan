// Slide-page DOM builders shared by two consumers: the fullscreen slide
// preview (fire-and-forget hydration inside its viewport-sized wrapper)
// and the PDF export engine (fixed pixel page boxes that await the
// returned completion promises so every diagram and image is painted
// before rasterization).

import { renderMarkdown } from "../api/markdown";
import { type DiagramResult } from "./diagram_render";
import {
  isExcalidrawImageSrc,
  parseImageSrc,
  resolveImageSrc,
} from "./extensions/image";
import {
  renderExcalidraw,
  renderExcalidrawFile,
} from "./excalidraw_render";
import { renderMermaid } from "./mermaid_render";

export type SlideDomTheme = "light" | "dark";

type SlideMediaAlign = "left" | "center" | "right";
type SlideDiagramKind = "mermaid" | "excalidraw";
type SlideDiagramSpec = {
  kind: SlideDiagramKind;
  align: SlideMediaAlign;
};

const BLANK_LINE_SPACER =
  '<div class="chan-slide-blank-line" aria-hidden="true"></div>';

const EDITOR_VARS = [
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

export type EditorTokens = {
  bg: string;
  fg: string;
  bodyFamily: string;
  bodySize: string;
  vars: string;
};

/// Resolve the editor theme tokens for a slide/document surface by
/// probing a hidden element under `styleSource` with the requested
/// theme, so light/dark values resolve independently of the live UI
/// theme. `varNames` selects which custom properties ride along in
/// `vars` (inline-style ready; defaults to the slide set).
export function editorTokens(
  styleSource: Element | null | undefined,
  theme: SlideDomTheme,
  varNames: readonly string[] = EDITOR_VARS,
): EditorTokens {
  const host = styleSource ?? document.body ?? document.documentElement;
  const probe = document.createElement("div");
  probe.dataset.theme = theme;
  probe.style.cssText =
    "position:fixed;left:-9999px;top:-9999px;width:0;height:0;" +
    "overflow:hidden;visibility:hidden;pointer-events:none;" +
    "background:var(--chan-editor-bg);" +
    "color:var(--chan-editor-body-color);" +
    "font-family:var(--chan-editor-body-family);" +
    "font-size:var(--chan-editor-body-size);";
  host.appendChild(probe);
  const style = getComputedStyle(probe);
  const vars = varNames
    .map((name) => {
      const value = style.getPropertyValue(name).trim();
      return value ? `${name}:${value};` : "";
    })
    .filter(Boolean)
    .join("");
  const tokens = {
    bg: style.backgroundColor || (theme === "dark" ? "#111827" : "#fff"),
    fg: style.color || (theme === "dark" ? "#f3f4f6" : "#1f2328"),
    bodyFamily:
      style.fontFamily || "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    bodySize: style.fontSize || "16px",
    vars,
  };
  probe.remove();
  return tokens;
}

export function renderSlideMarkdown(markdown: string): string {
  return renderMarkdown(preserveExtraBlankLines(markdown));
}

function preserveExtraBlankLines(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let blankRun = 0;
  let inFence = false;
  let fenceMarker: "`" | "~" | null = null;

  // Blank runs at the slide boundaries are page-separator whitespace
  // left behind by the deck split, not authored in-slide spacing, so
  // they collapse to a plain blank line instead of emitting spacers.
  function flushBlankRun(atBoundary: boolean): void {
    if (blankRun === 0) return;
    out.push("");
    if (!atBoundary) {
      for (let i = 1; i < blankRun; i++) out.push(BLANK_LINE_SPACER);
      if (blankRun > 1) out.push("");
    }
    blankRun = 0;
  }

  for (const line of lines) {
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (!inFence && line.trim() === "") {
      blankRun++;
      continue;
    }

    // An empty `out` means no content line was emitted yet, so the
    // pending run is the leading boundary.
    flushBlankRun(out.length === 0);
    out.push(line);

    if (!fence) continue;
    const marker = fence[1]![0] as "`" | "~";
    if (!inFence) {
      inFence = true;
      fenceMarker = marker;
    } else if (fenceMarker === marker) {
      inFence = false;
      fenceMarker = null;
    }
  }

  flushBlankRun(true);
  return out.join("\n");
}

/// Replace mermaid / mermaid-to-excalidraw fences under `root` with
/// rendered diagram shells. The returned promise resolves once every
/// render settled and painted (or reported its error); the preview
/// discards it, the export path awaits it. `isCurrent` guards against
/// applying a stale render after the caller moved on.
export function renderSlideDiagrams(
  root: ParentNode,
  markdown: string,
  theme: SlideDomTheme,
  isCurrent: () => boolean,
): Promise<void> {
  const specs = slideDiagramSpecs(markdown);
  const renders: Promise<void>[] = [];
  let specIndex = 0;
  for (const code of Array.from(root.querySelectorAll("pre > code"))) {
    const kind = slideDiagramKind(code);
    if (!kind) continue;
    const align = specs[specIndex]?.align ?? "center";
    specIndex++;
    const pre = code.parentElement;
    if (!(pre instanceof HTMLElement)) continue;

    const source = code.textContent ?? "";
    const shell = document.createElement("div");
    shell.className = "md-slide-diagram";
    applySlideAlignClass(shell, align);
    const body = document.createElement("div");
    body.className = "md-slide-diagram-body";
    body.textContent = "rendering...";
    shell.append(body);
    pre.replaceWith(shell);

    const render =
      kind === "excalidraw" ? renderExcalidraw : renderMermaid;
    const label = kind === "excalidraw" ? "Excalidraw" : "Mermaid";
    renders.push(
      render(source, theme === "dark").then((res) => {
        if (!isCurrent()) return;
        if (res.ok && res.svg) {
          body.classList.remove("md-slide-diagram-error");
          body.innerHTML = res.svg;
          normalizeDiagramSvgSizing(body);
        } else {
          renderSlideDiagramError(body, source, res, label);
        }
      }),
    );
  }
  return Promise.all(renders).then(() => undefined);
}

function slideDiagramKind(code: Element): "mermaid" | "excalidraw" | null {
  if (code.classList.contains("language-mermaid-to-excalidraw")) {
    return "excalidraw";
  }
  if (code.classList.contains("language-mermaid")) return "mermaid";
  return null;
}

function slideDiagramSpecs(markdown: string): SlideDiagramSpec[] {
  const specs: SlideDiagramSpec[] = [];
  const lines = markdown.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const open = lines[i]?.match(/^\s*(`{3,}|~{3,})\s*([^\r\n]*)$/);
    if (!open) continue;

    const marker = open[1]!;
    const info = open[2] ?? "";
    const spec = slideDiagramSpecFromInfo(info);
    if (spec) specs.push(spec);

    const close = new RegExp(
      `^\\s*${escapeRegExp(marker[0]!)}{${marker.length},}\\s*$`,
    );
    for (i = i + 1; i < lines.length; i++) {
      if (close.test(lines[i] ?? "")) break;
    }
  }

  return specs;
}

function slideDiagramSpecFromInfo(info: string): SlideDiagramSpec | null {
  const parts = info.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const lang = parts[0];
  const kind =
    lang === "mermaid"
      ? "mermaid"
      : lang === "mermaid-to-excalidraw"
        ? "excalidraw"
        : null;
  if (!kind) return null;

  return {
    kind,
    align: slideAlignFromTokens(parts.slice(1)) ?? "center",
  };
}

function slideAlignFromTokens(tokens: readonly string[]): SlideMediaAlign | null {
  for (const token of tokens) {
    const normalized = token.replace(/^[{#]+|[},]+$/g, "");
    if (
      normalized === "left" ||
      normalized === "center" ||
      normalized === "right"
    ) {
      return normalized;
    }
    const align = normalized.match(/^align[:=](left|center|right)$/)?.[1];
    if (align === "left" || align === "center" || align === "right") {
      return align;
    }
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderSlideDiagramError(
  body: HTMLElement,
  source: string,
  res: DiagramResult,
  label: "Mermaid" | "Excalidraw",
): void {
  body.classList.add("md-slide-diagram-error");
  body.replaceChildren();
  if (res.errorLine) {
    const head = document.createElement("div");
    head.className = "md-slide-diagram-error-head";
    head.textContent = `${label} error - line ${res.errorLine}`;
    body.append(head);
    const lineText = source.split("\n")[res.errorLine - 1];
    if (lineText !== undefined) {
      const code = document.createElement("div");
      code.className = "md-slide-diagram-error-src";
      code.textContent = lineText;
      body.append(code);
    }
  }
  const reason = document.createElement("div");
  reason.textContent = res.error ?? "render failed";
  body.append(reason);
}

/// Normalize an Excalidraw export SVG so it shrinks to its container but
/// never past its native size. The export bakes fixed pixel `width` and
/// `height` attributes; during the PDF `foreignObject` rasterization a
/// nested fixed-size SVG lays out at that native size and a percentage
/// `max-width` does not constrain it, so the diagram overflows the page.
/// An absolute pixel `max-width` survives that path and `width:100%`
/// gives the same shrink the preview applies, so export matches preview
/// at min(container, native). Mermaid exports carry `width="100%"` and
/// fall through untouched; the `viewBox` is preserved so the crisp-zoom
/// viewer still opens at full size.
function normalizeDiagramSvgSizing(body: HTMLElement): void {
  const svg = body.querySelector("svg");
  if (!svg) return;
  const width = svg.getAttribute("width")?.trim();
  if (!width || width.endsWith("%")) return;
  const nativePx = parseFloat(width);
  if (!Number.isFinite(nativePx) || nativePx <= 0) return;
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.style.width = "100%";
  svg.style.height = "auto";
  svg.style.maxWidth = `${nativePx}px`;
}

/// Resolve image srcs (including the #w=/#left/#right grammar), replace
/// Excalidraw image embeds with rendered SVG, and retarget links. The
/// synchronous work happens before this returns; the returned promise
/// resolves once the async Excalidraw renders settled as well.
export function prepareSlideImages(
  root: ParentNode,
  fromPath: string | null,
  theme: SlideDomTheme,
  isCurrent: () => boolean,
): Promise<void> {
  const renders: Promise<void>[] = [];
  for (const img of Array.from(root.querySelectorAll("img"))) {
    const raw = img.getAttribute("src") ?? "";
    const { width, align } = parseImageSrc(raw);
    if (isExcalidrawImageSrc(raw)) {
      renders.push(
        renderSlideExcalidraw(img, raw, width, align, fromPath, theme, isCurrent),
      );
      continue;
    }
    const resolved = resolveImageSrc(raw, fromPath);
    if (resolved) img.setAttribute("src", resolved);
    if (width != null) img.style.width = `${width}px`;
    applySlideMediaAlignment(img, align ?? "center");
  }
  for (const link of Array.from(root.querySelectorAll("a"))) {
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noreferrer");
  }
  return Promise.all(renders).then(() => undefined);
}

function renderSlideExcalidraw(
  img: HTMLImageElement,
  raw: string,
  width: number | null,
  align: "left" | "right" | null,
  fromPath: string | null,
  theme: SlideDomTheme,
  isCurrent: () => boolean,
): Promise<void> {
  const shell = document.createElement("div");
  shell.className = "md-slide-excalidraw";
  applySlideAlignClass(shell, align ?? "center");
  const body = document.createElement("div");
  body.className = "md-slide-excalidraw-body";
  body.textContent = "rendering...";
  if (width != null) body.style.width = `${width}px`;
  shell.append(body);
  img.replaceWith(shell);
  applyStandaloneMediaParentAlignment(shell, align ?? "center");

  const resolved = resolveImageSrc(raw, fromPath);
  if (!resolved) {
    renderSlideExcalidrawError(body, "cannot resolve Excalidraw file");
    return Promise.resolve();
  }
  return renderExcalidrawFile(resolved, theme === "dark").then((res) => {
    if (!isCurrent()) return;
    if (res.ok && res.svg) {
      body.classList.remove("md-slide-excalidraw-error");
      body.innerHTML = res.svg;
      normalizeDiagramSvgSizing(body);
    } else {
      renderSlideExcalidrawError(body, res.error ?? "render failed");
    }
  });
}

function renderSlideExcalidrawError(body: HTMLElement, message: string): void {
  body.classList.add("md-slide-excalidraw-error");
  body.textContent = `Excalidraw render failed: ${message}`;
}

function applySlideMediaAlignment(el: HTMLElement, align: SlideMediaAlign): void {
  applySlideAlignClass(el, align);
  applyStandaloneMediaParentAlignment(el, align);
}

function applySlideAlignClass(el: HTMLElement, align: SlideMediaAlign): void {
  el.classList.add(`chan-slide-align-${align}`);
}

function applyStandaloneMediaParentAlignment(
  el: HTMLElement,
  align: SlideMediaAlign,
): void {
  const parent = el.parentElement;
  if (!parent || parent.tagName !== "P") return;
  if (!isOnlySignificantChild(parent, el)) return;
  parent.classList.add("chan-slide-media");
  applySlideAlignClass(parent, align);
}

function isOnlySignificantChild(parent: HTMLElement, child: Node): boolean {
  return Array.from(parent.childNodes).every((node) => {
    return (
      node === child ||
      (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim())
    );
  });
}

/// Inline style for the zoomable slide content element.
export function contentStyle(zoomFactor: number): string {
  const zoom = positiveZoomFactor(zoomFactor);
  return [
    "display:block",
    `zoom:${cssNumber(zoom)}`,
    "width:100%",
    "min-height:100%",
    "transform-origin:top left",
  ].join(";");
}

function positiveZoomFactor(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 2;
}

export function cssNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export type SlidePageBox = { widthPx: number; heightPx: number };

/// Inline style for a slide page at an explicit pixel box (the PDF
/// raster path). Mirrors the preview page surface - same editor tokens,
/// fonts, and padding rule - with the viewport-relative pieces resolved
/// against the box width instead of the viewport. A caller that lays
/// out at a known reference viewport passes `paddingPx` with the
/// preview's clamp resolved against that viewport instead.
export function slidePageBoxStyle(
  box: SlidePageBox,
  styleSource: Element | null | undefined,
  theme: SlideDomTheme,
  paddingPx?: number,
): string {
  const tokens = editorTokens(styleSource, theme);
  const padding = paddingPx ?? Math.max(22, Math.min(54, 0.04 * box.widthPx));
  return [
    tokens.vars,
    "box-sizing:border-box",
    `color-scheme:${theme}`,
    `width:${box.widthPx}px`,
    `height:${box.heightPx}px`,
    "overflow:hidden",
    `padding:${cssNumber(padding)}px`,
    `background:${tokens.bg}`,
    `color:${tokens.fg}`,
    `font-family:${tokens.bodyFamily}`,
    `font-size:${tokens.bodySize}`,
    "line-height:1.55",
  ].join(";");
}

/// Media and diagram rules shared by every slide/document surface,
/// scoped under `scope`. Margins and other rhythm stay per-surface.
export function slideMediaCss(scope: string): string {
  return `
${scope} .chan-slide-media {
  display: flex;
}
${scope} .chan-slide-align-left { justify-content: flex-start; }
${scope} .chan-slide-align-center { justify-content: center; }
${scope} .chan-slide-align-right { justify-content: flex-end; }
${scope} img.chan-slide-align-left { margin-left: 0; margin-right: auto; }
${scope} img.chan-slide-align-right { margin-left: auto; margin-right: 0; }
${scope} .md-slide-diagram-body {
  display: flex;
  justify-content: center;
  min-height: 40px;
  padding: 8px 0;
  color: var(--text-secondary, currentColor);
}
${scope} .md-slide-diagram.chan-slide-align-left .md-slide-diagram-body {
  justify-content: flex-start;
}
${scope} .md-slide-diagram.chan-slide-align-right .md-slide-diagram-body {
  justify-content: flex-end;
}
${scope} .md-slide-diagram-body svg {
  max-width: 100%;
  height: auto;
}
${scope} .md-slide-excalidraw {
  display: flex;
  justify-content: center;
}
${scope} .md-slide-excalidraw-body {
  display: flex;
  justify-content: center;
  max-width: 100%;
  min-height: 40px;
  padding: 8px 0;
  color: var(--text-secondary, currentColor);
}
${scope} .md-slide-excalidraw-body svg {
  max-width: 100%;
  height: auto;
}
${scope} .md-slide-excalidraw-body.md-slide-excalidraw-error {
  display: block;
  color: var(--danger-text, #d33);
  font-family: ui-monospace, monospace;
  font-size: 12px;
  white-space: pre-wrap;
}
${scope} .md-slide-diagram-body.md-slide-diagram-error {
  display: block;
  color: var(--danger-text, #d33);
  font-family: ui-monospace, monospace;
  font-size: 12px;
  white-space: pre-wrap;
}
${scope} .md-slide-diagram-error-head {
  font-weight: 600;
  margin-bottom: 2px;
}
${scope} .md-slide-diagram-error-src {
  padding: 2px 6px;
  margin-bottom: 4px;
  border-left: 2px solid var(--danger-text, #d33);
  background: var(--bg-card, rgba(0, 0, 0, 0.04));
  white-space: pre;
  overflow-x: auto;
}
`;
}

/// Typographic and rhythm rules for a slide page, scoped under the
/// preview page class. Both the fullscreen preview and the export
/// engine reuse the same class names so slides render identically.
export function slidePreviewCss(): string {
  return `
.md-slide-preview-content {
  min-width: 0;
}
.md-slide-preview-page h1,
.md-slide-preview-page h2,
.md-slide-preview-page h3,
.md-slide-preview-page h4,
.md-slide-preview-page h5,
.md-slide-preview-page h6 {
  color: var(--chan-editor-heading-color, currentColor);
  font-family: var(--chan-editor-heading-family, var(--chan-editor-body-family, inherit));
  line-height: 1.2;
  margin: 0 0 0.55em;
}
.md-slide-preview-page h1 {
  font-size: var(--chan-editor-h1-size, 2em);
  font-weight: var(--chan-editor-h1-weight, 700);
  border-bottom: var(--chan-editor-h1-border-bottom, none);
  padding-bottom: var(--chan-editor-h1-padding-bottom, 0);
}
.md-slide-preview-page h2 {
  font-size: var(--chan-editor-h2-size, 1.55em);
  font-weight: var(--chan-editor-h2-weight, 650);
}
.md-slide-preview-page h3 { font-size: var(--chan-editor-h3-size, 1.25em); }
.md-slide-preview-page p,
.md-slide-preview-page ul,
.md-slide-preview-page ol,
.md-slide-preview-page blockquote,
.md-slide-preview-page pre,
.md-slide-preview-page table {
  margin: 0 0 0.8em;
}
.md-slide-preview-content > :last-child { margin-bottom: 0; }
.md-slide-preview-page .chan-slide-blank-line {
  height: 1.55em;
}
.md-slide-preview-page .chan-slide-media {
  margin: 0 0 0.8em;
}
.md-slide-preview-page img {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 0.7em auto;
}
.md-slide-preview-page .chan-slide-media > img { margin: 0.7em 0; }
.md-slide-preview-page pre {
  overflow: auto;
  padding: 0.7em 0.8em;
  border-radius: 6px;
  background: var(--chan-editor-code-block-bg, rgba(127,127,127,0.12));
  color: var(--chan-editor-code-block-color, inherit);
}
.md-slide-preview-page code {
  font-family: var(--chan-editor-code-family, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--chan-editor-code-size, 0.92em);
  background: var(--chan-editor-inline-code-bg, rgba(127,127,127,0.12));
  color: var(--chan-editor-inline-code-color, inherit);
}
.md-slide-preview-page pre code { background: transparent; color: inherit; }
.md-slide-preview-page .md-slide-diagram {
  margin: 0.7em 0 0.9em;
}
.md-slide-preview-page .md-slide-excalidraw {
  margin: 0.7em 0 0.9em;
}
.md-slide-preview-page a { color: var(--chan-editor-link-color, var(--link, #0969da)); }
.md-slide-preview-page blockquote {
  color: var(--chan-editor-quote-color, inherit);
  border-left: 3px solid var(--chan-editor-quote-border, rgba(127,127,127,0.4));
  padding-left: 0.8em;
}
.md-slide-preview-page table {
  width: 100%;
  border-collapse: collapse;
}
.md-slide-preview-page th,
.md-slide-preview-page td {
  border: 1px solid var(--chan-editor-table-border, rgba(127,127,127,0.35));
  padding: 0.35em 0.5em;
}
${slideMediaCss(".md-slide-preview-page")}`;
}
