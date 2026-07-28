// Lazy mermaid rendering for the mermaid code-block flip card. mermaid
// is a large dependency, so it is DYNAMIC-IMPORTED on first use only:
// the initial editor bundle never pulls it until a mermaid block is
// actually flipped to its diagram. Theme is fed from the editor
// surface's light/dark so diagrams match the page.

import { type DiagramResult, parseErrorPos } from "./diagram_render";

type MermaidApi = typeof import("mermaid").default;

let loader: Promise<MermaidApi> | null = null;
let seq = 0;

async function loadMermaid(): Promise<MermaidApi> {
  if (!loader) {
    loader = import("mermaid").then((m) => m.default);
  }
  return loader;
}

/// Render mermaid source to an SVG string. A parse/render failure (bad
/// diagram source) resolves to { ok:false, error } rather than throwing,
/// so the caller can show the message on the card's back face.
async function renderMermaidWithLabels(
  source: string,
  dark: boolean,
  htmlLabels: boolean,
): Promise<DiagramResult> {
  try {
    const mermaid = await loadMermaid();
    // Theme is a global init option; set it per render so a surface
    // theme flip is honoured on the next render. securityLevel "strict"
    // keeps mermaid's own sanitizer on.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "default",
      htmlLabels,
    });
    const id = `chan-mermaid-${seq++}`;
    const { svg } = await mermaid.render(id, source.trim());
    return { ok: true, svg };
  } catch (err) {
    const error = (err as Error)?.message ?? String(err);
    const { line, col } = parseErrorPos(source, error);
    return { ok: false, error, errorLine: line, errorCol: col };
  }
}

export function renderMermaid(
  source: string,
  dark: boolean,
): Promise<DiagramResult> {
  return renderMermaidWithLabels(source, dark, true);
}

/// Copy-only render without Mermaid's HTML `<foreignObject>` labels.
/// WebKit deliberately taints a canvas after drawing an SVG containing a
/// foreignObject (https://bugs.webkit.org/show_bug.cgi?id=156176), so the
/// ordinary rendered face cannot be exported with canvas.toBlob in
/// chan-desktop. Pure SVG text keeps the visible face unchanged while giving
/// the rasterizer a portable source.
export function renderMermaidForClipboard(
  source: string,
  dark: boolean,
): Promise<DiagramResult> {
  return renderMermaidWithLabels(source, dark, false);
}
