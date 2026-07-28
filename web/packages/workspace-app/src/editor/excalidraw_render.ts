// Lazy mermaid-to-excalidraw rendering for the excalidraw code-block flip
// card. @excalidraw/excalidraw is a large React-based dependency (and
// @excalidraw/mermaid-to-excalidraw carries its own mermaid), so both are
// DYNAMIC-IMPORTED on first use only: the initial editor bundle never pulls
// them until an excalidraw block is actually flipped to its diagram. Theme
// is fed from the editor surface's light/dark so diagrams match the page.
//
// The render is headless: parseMermaidToExcalidraw turns a mermaid
// definition into an excalidraw element SKELETON, convertToExcalidrawElements
// fleshes it out, and exportToSvg serializes it to a static SVG. No
// <Excalidraw> React editor is ever mounted; the widget injects the SVG
// exactly as it does for a mermaid render.

import {
  type DiagramRenderer,
  type DiagramResult,
  parseErrorPos,
} from "./diagram_render";
import { configureExcalidrawAssets } from "./excalidrawAssets";
import {
  renderMermaid,
  renderMermaidForClipboard,
} from "./mermaid_render";

// mermaid-to-excalidraw lays a diagram out at its own hardcoded 20px mermaid
// font while chan's plain mermaid renderer uses the 16px default, and
// Excalifont glyph width plus roughjs stroke slop inflate the boxes further,
// so a fence diagram renders about 1.5x its plain-mermaid twin. Shrink the
// exported SVG to match. exportScale touches only the SVG's pixel width and
// height, never the viewBox, so the crisp-zoom View overlay (which pins its
// base width off the viewBox) still opens at full size and sharpness.
const MERMAID_EXCALIDRAW_EXPORT_SCALE = 1 / 1.5;

// The two libraries load together on first render and memoize. `exportToSvg`
// is imported for its type so the elements cast below reads off its real
// signature rather than a hand-maintained shape.
type ExcalidrawModules = {
  convertToExcalidrawElements: typeof import("@excalidraw/excalidraw").convertToExcalidrawElements;
  exportToSvg: typeof import("@excalidraw/excalidraw").exportToSvg;
  restore: typeof import("@excalidraw/excalidraw").restore;
};

let excalidrawLoader: Promise<ExcalidrawModules> | null = null;
let mermaidToExcalidrawLoader:
  | Promise<typeof import("@excalidraw/mermaid-to-excalidraw").parseMermaidToExcalidraw>
  | null = null;

async function loadExcalidraw(): Promise<ExcalidrawModules> {
  if (!excalidrawLoader) {
    // Set before the import so the font registry resolves label fonts
    // from the self-hosted bundle rather than the esm.sh CDN.
    configureExcalidrawAssets();
    excalidrawLoader = import("@excalidraw/excalidraw").then((excalidraw) => ({
      convertToExcalidrawElements: excalidraw.convertToExcalidrawElements,
      exportToSvg: excalidraw.exportToSvg,
      restore: excalidraw.restore,
    }));
  }
  return excalidrawLoader;
}

async function loadMermaidToExcalidraw(): Promise<
  typeof import("@excalidraw/mermaid-to-excalidraw").parseMermaidToExcalidraw
> {
  if (!mermaidToExcalidrawLoader) {
    mermaidToExcalidrawLoader = import("@excalidraw/mermaid-to-excalidraw").then(
      (mod) => mod.parseMermaidToExcalidraw,
    );
  }
  return mermaidToExcalidrawLoader;
}

/// Render a mermaid definition to an excalidraw SVG string. When the
/// excalidraw conversion fails on a source the plain mermaid renderer can
/// still draw, it degrades to that renderer so the block shows a diagram
/// instead of an error (WebKit/WKWebView cannot convert a flowchart with a
/// `subgraph`; see the catch below). A genuine parse failure resolves to
/// { ok:false, error } rather than throwing, so the caller can show the
/// message on the card's back face. mermaid-to-excalidraw parses mermaid
/// underneath, so its errors carry the same "line N" format the mermaid
/// renderer surfaces.
async function renderExcalidrawWithFallback(
  source: string,
  dark: boolean,
  renderFallback: DiagramRenderer,
): Promise<DiagramResult> {
  try {
    const [parseMermaidToExcalidraw, { convertToExcalidrawElements, exportToSvg }] =
      await Promise.all([loadMermaidToExcalidraw(), loadExcalidraw()]);
    const { elements: skeleton, files } = await parseMermaidToExcalidraw(source.trim());
    // convertToExcalidrawElements returns OrderedExcalidrawElement[]; exportToSvg
    // wants NonDeleted<ExcalidrawElement>[]. The freshly converted elements are
    // never deleted, so cast off exportToSvg's own parameter type rather than
    // pulling in excalidraw's internal element types.
    const elements = convertToExcalidrawElements(skeleton);
    const svg = await exportToSvg({
      elements: elements as Parameters<typeof exportToSvg>[0]["elements"],
      // Transparent background so the diagram sits on the editor surface;
      // exportWithDarkMode flips excalidraw's palette so strokes and text read
      // on a dark page (light-editor renders keep the default palette).
      files: files ?? null,
      appState: {
        exportBackground: false,
        exportWithDarkMode: dark,
        exportScale: MERMAID_EXCALIDRAW_EXPORT_SCALE,
      },
      exportPadding: 10,
    });
    return { ok: true, svg: svg.outerHTML };
  } catch (err) {
    // mermaid-to-excalidraw's cluster lookup throws "SubGraph element not
    // found" in WebKit/WKWebView (chan-desktop): a flowchart with a
    // `subgraph` converts in Blink but its cluster elements are not found
    // here. Degrade to the plain mermaid renderer so the block still shows
    // the diagram; only when mermaid ALSO fails (genuinely bad source) do we
    // surface the excalidraw error, so the failing source line is accented.
    const fallback = await renderFallback(source, dark);
    if (fallback.ok) return fallback;
    const error = (err as Error)?.message ?? String(err);
    const { line, col } = parseErrorPos(source, error);
    return { ok: false, error, errorLine: line, errorCol: col };
  }
}

export function renderExcalidraw(
  source: string,
  dark: boolean,
): Promise<DiagramResult> {
  return renderExcalidrawWithFallback(source, dark, renderMermaid);
}

/// Copy-only variant whose WebKit fallback uses pure SVG labels. The ordinary
/// Excalidraw export is already SVG-native; this only differs when conversion
/// falls back to Mermaid (notably subgraphs in WKWebView).
export function renderExcalidrawForClipboard(
  source: string,
  dark: boolean,
): Promise<DiagramResult> {
  return renderExcalidrawWithFallback(
    source,
    dark,
    renderMermaidForClipboard,
  );
}

type ExcalidrawScene = {
  elements?: unknown;
  appState?: unknown;
  files?: unknown;
};

export async function renderExcalidrawFile(
  url: string,
  dark: boolean,
): Promise<DiagramResult> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return { ok: false, error: `fetch ${resp.status}` };
    const scene = parseExcalidrawFileResponse(await resp.text());
    return renderExcalidrawScene(scene, dark);
  } catch (err) {
    return {
      ok: false,
      error: (err as Error)?.message ?? String(err),
    };
  }
}

function parseExcalidrawFileResponse(text: string): ExcalidrawScene {
  const payload = JSON.parse(text) as ExcalidrawScene & { content?: unknown };
  if (typeof payload.content === "string") {
    return JSON.parse(payload.content) as ExcalidrawScene;
  }
  return payload;
}

export async function renderExcalidrawScene(
  scene: ExcalidrawScene,
  dark: boolean,
): Promise<DiagramResult> {
  try {
    const { restore, exportToSvg } = await loadExcalidraw();
    type RestoreInput = NonNullable<Parameters<typeof restore>[0]>;
    const data: RestoreInput = {
      elements: (Array.isArray(scene.elements) ? scene.elements : []) as RestoreInput["elements"],
      appState: (
        scene.appState && typeof scene.appState === "object" ? scene.appState : {}
      ) as RestoreInput["appState"],
      files: (
        scene.files && typeof scene.files === "object" ? scene.files : {}
      ) as RestoreInput["files"],
    };
    const restored = restore(data, null, null, { repairBindings: true });
    const elements = restored.elements.filter((el) => !el.isDeleted);
    if (elements.length === 0) {
      return { ok: false, error: "empty Excalidraw scene" };
    }
    const svg = await exportToSvg({
      elements: elements as Parameters<typeof exportToSvg>[0]["elements"],
      files: restored.files ?? null,
      appState: {
        ...restored.appState,
        exportBackground: false,
        exportWithDarkMode: dark,
      },
      exportPadding: 16,
      renderEmbeddables: true,
    });
    return { ok: true, svg: svg.outerHTML };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error)?.message ?? String(err),
    };
  }
}
