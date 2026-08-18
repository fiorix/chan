// Image src utilities used by the editor's image atom widget and the
// image bubble. Pure functions; no editor framework dependency.
//
// Workspace-relative srcs (`foo.png`, `./foo.png`, `../foo.png`,
// `/abs.png`) are resolved against `/api/fs/<path>` so the browser
// can fetch the bytes via the chan-server token; absolute URLs
// (http/data/blob) pass through unchanged.

import { withTokenQuery } from "../../api/client";
import { decodePercent, normalizeHref } from "../links";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg"] as const;

export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = path.slice(dot + 1).toLowerCase();
  return (IMAGE_EXTS as readonly string[]).includes(ext);
}

export function isExcalidrawImageSrc(src: string): boolean {
  const { base } = parseImageSrc(src);
  const path = base.split("#", 1)[0]!.split("?", 1)[0]!;
  return path.toLowerCase().endsWith(".excalidraw");
}

export type ImageAlign = "left" | "right";

/// Split a markdown image src into the URL portion (used to fetch
/// the file) and the optional fragment params. Width travels as
/// `#w=N`; alignment as bare `#left` / `#right` (absent fragment =
/// the default, centered). The fragment stays in the markdown so
/// other renderers see a plain `file.png` (path-only after the
/// hash is stripped); chan-workspace's link parser strips `#...` before
/// indexing, so fragments never leak into the graph.
///
/// Multiple fragment params are joined with `&` (e.g. `#w=200&left`).
/// Unknown parts are preserved on the returned `base` so they round-
/// trip through edits that don't touch them.
export function parseImageSrc(src: string): {
  base: string;
  width: number | null;
  align: ImageAlign | null;
} {
  if (!src) return { base: "", width: null, align: null };
  const hash = src.indexOf("#");
  if (hash < 0) return { base: src, width: null, align: null };
  const baseUrl = src.slice(0, hash);
  const fragment = src.slice(hash + 1);
  let width: number | null = null;
  let align: ImageAlign | null = null;
  const kept: string[] = [];
  for (const part of fragment.split("&")) {
    if (part === "left" || part === "right") {
      align = part;
      continue;
    }
    const eq = part.indexOf("=");
    const key = eq < 0 ? part : part.slice(0, eq);
    const val = eq < 0 ? "" : part.slice(eq + 1);
    if (key === "w") {
      const n = parseInt(val, 10);
      if (Number.isFinite(n) && n > 0) width = n;
      continue;
    }
    if (part) kept.push(part);
  }
  const base = kept.length === 0 ? baseUrl : `${baseUrl}#${kept.join("&")}`;
  return { base, width, align };
}

/// Rebuild an image src from its base + fragment params. Keeps any
/// unknown fragment parts the parser preserved on `base`; appends
/// `w=N` and the bare align token in a stable order so a round-trip
/// through parse/build is idempotent.
function buildImageSrc(
  base: string,
  width: number | null,
  align: ImageAlign | null,
): string {
  const parts: string[] = [];
  if (width != null) parts.push(`w=${width}`);
  if (align) parts.push(align);
  if (parts.length === 0) return base;
  return base.includes("#") ? `${base}&${parts.join("&")}` : `${base}#${parts.join("&")}`;
}

/// Resolve a markdown image src to a URL the browser can load.
/// Local workspace paths route through `/api/fs/` with the launch
/// token; absolute URLs (http/data/blob) pass through. Workspace-rooted
/// and parent-relative sources go through `normalizeHref` against
/// `fromPath`'s directory so the resolver chan-workspace uses for graph
/// edges produces the same canonical path that reaches `/api/fs/`.
/// `#w=N` width fragments are stripped before the URL is built (the
/// width is applied as inline style on the `<img>` instead).
/// Empty input returns "" so callers can omit the attribute.
export function resolveImageSrc(src: string, fromPath?: string | null): string {
  if (!src) return "";
  const { base } = parseImageSrc(src);
  if (!base) return "";
  if (/^(https?:|data:|blob:)/i.test(base)) return base;
  const sourceDir = fromPath
    ? fromPath.split("/").slice(0, -1).join("/")
    : "";
  // Decode first: the on-disk src is percent-encoded (a spaced
  // filename is written `./My%20Image.png` so pulldown-cmark produces
  // a graph edge). normalizeHref + the `/api/fs` re-encode below
  // expect the real path; without the decode a spaced name would be
  // double-encoded (`%2520`) and 404.
  const decoded = decodePercent(base);
  const workspaceRooted = normalizeHref(decoded, sourceDir) ?? decoded;
  const encoded = workspaceRooted
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
  return withTokenQuery(`/api/fs/${encoded}`);
}

/// Build the new src string for an image after resizing. `width`
/// of null strips the `#w=N` fragment; align and other fragment
/// parts round-trip untouched.
export function setImageWidth(src: string, width: number | null): string {
  const { base, align } = parseImageSrc(src);
  return buildImageSrc(base, width, align);
}

/// Build the new src string after toggling alignment. `null` clears
/// the align fragment (centered, the default); width and unknown
/// fragment parts round-trip untouched.
export function setImageAlign(src: string, align: ImageAlign | null): string {
  const { base, width } = parseImageSrc(src);
  return buildImageSrc(base, width, align);
}
