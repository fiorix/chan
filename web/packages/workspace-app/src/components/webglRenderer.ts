// What draws the page's WebGL2 contexts, as far as the engine says.

export type WebglRendererKind =
  | "hardware"
  | "software"
  | "unidentified"
  | "none";

export interface WebglRendererReading {
  /// The renderer string the engine reports; null when a `webgl2` request
  /// answers with no context.
  renderer: string | null;
  kind: WebglRendererKind;
}

// A CPU rasterizer names itself in the renderer string: Chrome's
// SwiftShader, Mesa's llvmpipe, softpipe and lavapipe, Apple's software
// renderer, and the Windows WARP adapter (Microsoft Basic Render Driver).
const SOFTWARE_RENDERERS =
  /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render driver/i;

// What an engine answers when it will not say what it draws on. WebKit
// reports these on every machine, with a GPU or without one.
const MASKED_RENDERERS = /^apple gpu$|^webkit webgl$|^apple inc/i;

export function classifyWebglRenderer(
  renderer: string | null,
): WebglRendererKind {
  if (renderer === null) return "none";
  const name = renderer.trim();
  if (SOFTWARE_RENDERERS.test(name)) return "software";
  if (name === "" || MASKED_RENDERERS.test(name)) return "unidentified";
  return "hardware";
}

function readWebglRenderer(): string | null {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return null;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer: unknown = info
      ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    // Browsers cap the live WebGL contexts of a page; the reading gives
    // its own back rather than hold one against the animations.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return typeof renderer === "string" ? renderer : "";
  } catch {
    // A canvas that refuses the request is a page with no WebGL2 context.
    return null;
  }
}

let pageReading: WebglRendererReading | undefined;

/// The page's reading, taken on the first call and kept: taking it creates
/// a WebGL2 context, and the answer holds for the life of the page unless
/// the browser's GPU process restarts on another renderer.
export function pageWebglRenderer(): WebglRendererReading {
  if (!pageReading) {
    const renderer = readWebglRenderer();
    pageReading = { renderer, kind: classifyWebglRenderer(renderer) };
  }
  return pageReading;
}
