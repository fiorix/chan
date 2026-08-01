// Embeddable-media detection for markdown `![](url)` image syntax.
//
// A small set of trusted hosts (YouTube, Google Maps) render as a
// sandboxed <iframe> instead of an <img>. Used by BOTH the read-only
// markdown renderer (api/markdown.ts) and the in-editor image atom
// widget (editor/widgets/image.ts), so it lives in the framework-free
// api layer with no editor/DOM dependency.
//
// SECURITY: only the hosts in EMBED_IFRAME_HOSTS may ever appear as an
// iframe src. The markdown sanitizer enforces this with a DOMPurify
// hook (defense in depth against a raw <iframe> in user markdown), and
// the Tauri WebView CSP `frame-src` lists the same hosts. Keep the list
// minimal -- every entry is an origin the app will frame. Local extensions
// stay on Chan's own origin and do not widen this media allowlist.

export type EmbedKind = "youtube" | "maps";

export interface EmbedInfo {
  kind: EmbedKind;
  /// The iframe src -- always https on an EMBED_IFRAME_HOSTS origin.
  src: string;
  /// Human-readable iframe title (accessibility).
  title: string;
}

export interface EmbedRender extends EmbedInfo {
  /// Display width in px (honors the `#w=N` image fragment hint).
  width: number;
  /// Display height in px (derived from the per-kind aspect ratio).
  height: number;
  /// Space-separated `sandbox` tokens.
  sandbox: string;
  /// `allow` (Permissions-Policy) attribute value.
  allow: string;
}

/// Hosts permitted as a markdown iframe src. Mirrors the external-host subset
/// of the desktop CSP `frame-src`; extension iframes use same-origin proxy paths
/// and never pass through markdown.
export const EMBED_IFRAME_HOSTS: readonly string[] = [
  "www.youtube-nocookie.com",
  "www.google.com",
];

const DEFAULT_WIDTH: Record<EmbedKind, number> = { youtube: 560, maps: 560 };
// YouTube is 16:9; a map reads better in a roomier 4:3-ish frame.
const ASPECT: Record<EmbedKind, number> = { youtube: 9 / 16, maps: 0.75 };
const SANDBOX: Record<EmbedKind, string> = {
  youtube: "allow-scripts allow-same-origin allow-presentation allow-popups",
  maps: "allow-scripts allow-same-origin allow-popups",
};
const ALLOW: Record<EmbedKind, string> = {
  youtube:
    "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen",
  maps: "fullscreen",
};

/// True when `src` is an https URL on the embed host allowlist. The
/// markdown sanitizer uses this to drop any iframe that isn't ours.
export function isAllowedEmbedSrc(src: string | null | undefined): boolean {
  if (!src) return false;
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    return false;
  }
  return (
    u.protocol === "https:" &&
    EMBED_IFRAME_HOSTS.includes(u.hostname.toLowerCase())
  );
}

const YT_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);
// YouTube video ids are exactly 11 URL-safe-base64 chars.
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

function youtubeId(u: URL): string | null {
  const host = u.hostname.toLowerCase();
  if (host === "youtu.be" || host === "www.youtu.be") {
    const id = u.pathname.split("/").filter(Boolean)[0] ?? "";
    return YT_ID.test(id) ? id : null;
  }
  const v = u.searchParams.get("v");
  if (v && YT_ID.test(v)) return v;
  const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
  if (m && YT_ID.test(m[1]!)) return m[1]!;
  return null;
}

const MAPS_HOSTS = new Set(["google.com", "www.google.com", "maps.google.com"]);

function googleMapsEmbed(u: URL): string | null {
  if (!/^\/maps(\/|$)/.test(u.pathname)) return null;
  // Already the keyless share-embed form (Maps "Share → Embed a map").
  // The origin is host-validated above; normalize and pass it through.
  if (u.pathname === "/maps/embed" && u.searchParams.has("pb")) {
    return u.toString();
  }
  // A place / search link → the keyless `output=embed` form, which
  // needs no API key. Prefer an explicit `q`; fall back to the
  // `@lat,lng` viewport centre in the path.
  const q = u.searchParams.get("q");
  if (q) {
    return `https://www.google.com/maps?q=${encodeURIComponent(q)}&output=embed`;
  }
  const at = u.pathname.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (at) {
    return `https://www.google.com/maps?q=${at[1]},${at[2]}&output=embed`;
  }
  return null;
}

/// Detect an embeddable host from a bare URL (fragment already
/// stripped). Returns null for anything not on the allowlist.
export function detectEmbed(rawUrl: string): EmbedInfo | null {
  if (!rawUrl) return null;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (YT_HOSTS.has(host)) {
    const id = youtubeId(u);
    return id
      ? {
          kind: "youtube",
          src: `https://www.youtube-nocookie.com/embed/${id}`,
          title: "YouTube video",
        }
      : null;
  }
  if (MAPS_HOSTS.has(host)) {
    const src = googleMapsEmbed(u);
    return src ? { kind: "maps", src, title: "Google Map" } : null;
  }
  return null;
}

/// Resolve display dimensions for an embed, honoring the `#w=N` width
/// hint shared with images (height derived from the per-kind aspect).
export function embedDimensions(
  kind: EmbedKind,
  width: number | null,
): { width: number; height: number } {
  const w = width && width > 0 ? width : DEFAULT_WIDTH[kind];
  return { width: w, height: Math.round(w * ASPECT[kind]) };
}

/// Full render spec from an EmbedInfo + width hint (used by the editor
/// widget, which already parsed the `#w=` fragment via parseImageSrc).
export function embedRenderFromInfo(
  info: EmbedInfo,
  width: number | null,
): EmbedRender {
  const { width: w, height: h } = embedDimensions(info.kind, width);
  return {
    ...info,
    width: w,
    height: h,
    sandbox: SANDBOX[info.kind],
    allow: ALLOW[info.kind],
  };
}

// Local copy of the image `#w=` fragment split. parseImageSrc lives
// under editor/, which depends on the api layer; duplicating this tiny
// width parse here avoids an api→editor import cycle.
function splitImageFragment(src: string): { base: string; width: number | null } {
  const hash = src.indexOf("#");
  if (hash < 0) return { base: src, width: null };
  const base = src.slice(0, hash);
  let width: number | null = null;
  for (const part of src.slice(hash + 1).split("&")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === "w") {
      const n = parseInt(part.slice(eq + 1), 10);
      if (Number.isFinite(n) && n > 0) width = n;
    }
  }
  return { base, width };
}

/// Full embed render spec from a markdown image src (URL + optional
/// `#w=`/align fragment), or null when the URL is not embeddable.
export function embedFromSrc(src: string): EmbedRender | null {
  const { base, width } = splitImageFragment(src);
  const info = detectEmbed(base);
  return info ? embedRenderFromInfo(info, width) : null;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/// Build a sanitizer-friendly `<iframe>` HTML string for an embeddable
/// markdown image src, or null when the URL is not embeddable. Every
/// attribute value is controlled here (src is allowlisted); the
/// markdown sanitizer's iframe hook is the backstop for raw markup.
export function embedIframeHtml(src: string): string | null {
  const r = embedFromSrc(src);
  if (!r) return null;
  return (
    `<iframe class="md-embed md-embed-${r.kind}" src="${escapeAttr(r.src)}" ` +
    `width="${r.width}" height="${r.height}" title="${escapeAttr(r.title)}" ` +
    `loading="lazy" referrerpolicy="no-referrer-when-downgrade" ` +
    `sandbox="${r.sandbox}" allow="${escapeAttr(r.allow)}" allowfullscreen ` +
    `style="max-width:100%;border:0;border-radius:8px"></iframe>`
  );
}
