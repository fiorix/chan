// Pixel and vector copy for image sources (raster files and `.svg`
// files), shared by the editor's image widget and the slide overlay's
// media chrome. Raster bytes are fetched and ride
// `writeClipboardPayload`, which re-encodes non-PNG images and enforces
// the decompression-bomb guard; an `.svg` source copies its fetched
// markup as text (the portable vector form, matching the diagram copy
// path) or rasterizes it through the shared `svgToPngBytes`.

import { writeClipboardPayload } from "../../api/clipboard";
import { parseImageSrc } from "../extensions/image";
import { svgToPngBytes } from "./diagram_copy";

/// MIME by extension, for servers that answer without a usable
/// Content-Type. Only types the clipboard path can normalize matter;
/// anything unknown falls back to PNG, which `toPngBlob` passes through
/// byte-identical (a wrong label there beats dropping the copy).
const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  svg: "image/svg+xml",
};

/// Whether a markdown-form image src points at an SVG file. The
/// `#w=`/alignment fragment grammar is parsed off first; a query string
/// (pre-resolved `/api/files/...?token=...` srcs) is ignored too.
export function isSvgImageSrc(src: string): boolean {
  const { base } = parseImageSrc(src);
  const path = base.split("?")[0] ?? "";
  return /\.svg$/i.test(path);
}

function mimeForUrl(url: string, contentType: string | null): string {
  const declared = contentType?.split(";")[0]?.trim().toLowerCase();
  if (declared?.startsWith("image/")) return declared;
  const ext = url.split("?")[0]?.split("#")[0]?.split(".").pop()?.toLowerCase();
  return (ext && EXT_MIME[ext]) || "image/png";
}

async function fetchImageResponse(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch failed: ${res.status}`);
  return res;
}

/// Copy an image file's pixels to the clipboard as PNG. `svgSource`
/// routes `.svg` files through the SVG rasterizer (fetch markup, draw to
/// canvas); everything else fetches the raw bytes and lets the clipboard
/// layer normalize the format.
export async function copyImagePixels(
  url: string,
  svgSource: boolean,
): Promise<void> {
  if (svgSource) {
    const svg = await (await fetchImageResponse(url)).text();
    await writeClipboardPayload("image/png", await svgToPngBytes(svg));
    return;
  }
  const res = await fetchImageResponse(url);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await writeClipboardPayload(
    mimeForUrl(url, res.headers.get("content-type")),
    bytes,
  );
}

/// Copy an `.svg` file's markup to the clipboard as text - the lossless
/// cross-surface form (system clipboards have no portable SVG image
/// flavor; see copyDiagramSvg).
export async function copySvgFileMarkup(url: string): Promise<void> {
  const svg = await (await fetchImageResponse(url)).text();
  await writeClipboardPayload(
    "text/plain;charset=utf-8",
    new TextEncoder().encode(svg),
  );
}
