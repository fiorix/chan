// Rich copy of a doc selection that carries its workspace images across
// windows / workspaces (draft "Editor copy/paste").
//
// A plain-text copy of a selection stays byte-identical to CM6's default:
// this module only engages when the selection holds at least one workspace
// image ref (`![](rel#w=N)`). In that case the copy writes TWO flavors:
//
//   - text/plain: the exact selected markdown, unchanged, so a plain
//     consumer (a code editor, a terminal) gets the same text as today.
//   - text/html: a wrapper `<div data-chan-doc data-chan-workspace
//     data-chan-path data-chan-markdown=...>` containing the
//     `renderMarkdown` body with each workspace `<img>` src swapped to a
//     data: URI and tagged `data-chan-ref="<ordinal>"`. The markdown
//     attribute makes a chan-to-chan paste LOSSLESS (no turndown round
//     trip); the data: URIs make the payload self-contained across a
//     server / auth boundary and render in external apps (gdocs, Mail).
//
// The copy is a sync-baseline + async-upgrade: the DOM copy event
// synchronously sets both flavors with the workspace `<img>` srcs rewritten
// to ABSOLUTE URLs carrying no session bearer (no fetch needed, always
// correct), then a fire-and-forget pass inlines data: URIs and rewrites the
// clipboard (the native `write_clipboard_html` IPC on desktop,
// `navigator.clipboard.write` on web). If the async upgrade is rejected the
// sync baseline persists, so what an external consumer keeps is a URL it
// cannot authenticate rather than a working credential (see toAbsoluteUrl).
//
// Ordinals for the ref tags come from ONE shared scan function
// (`findWorkspaceImageRefs`) used by both copy and paste, so nothing
// depends on how marked serializes srcs.
//
// Out of scope, by design (documented so the boundary is explicit):
//   - Non-image attachments and wiki links: only raster image refs are
//     carried; other refs stay verbatim in the markdown attribute.
//   - Excalidraw embeds (`.excalidraw`): not raster images, left verbatim.
//   - Source mode: the source editor keeps the plain writeText path.
//
// Guardrails: a total inline budget (~20 MiB raw per copy) leaves
// over-budget or failed-fetch images on their absolute URL (the builder
// never rejects); an ordinal count guard skips ref tagging when the
// resolvable `<img>` count differs from the regex ref count (the markdown
// attribute still carries everything).

import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { renderMarkdown } from "../api/markdown";
import { isTauriDesktop, writeClipboardHtml } from "../api/desktop";
import { isImagePath, parseImageSrc, resolveImageSrc } from "./extensions/image";

/// Largest raw image bytes we inline as data: URIs per copy. Images over
/// this budget (or ones that fail to fetch) keep their absolute,
/// bearer-free URL; the builder never rejects.
const MAX_INLINE_BYTES = 20 * 1024 * 1024;

/// Lazy getters the copy path reads at event time. Shared with the paste
/// path (paste_html.ts) so both surfaces build the same context.
export interface ChanClipboardContext {
  /// The editing file's workspace-rooted path (data-chan-path; also the
  /// base for relativizing / resolving image srcs).
  getCurrentPath: () => string | null;
  /// Upload destination for a foreign paste (the file's directory).
  getUploadDir: () => string | null;
  /// The absolute workspace root (data-chan-workspace; the same-workspace
  /// short-circuit compares this against the pasted wrapper's root).
  getWorkspaceRoot: () => string | null;
}

/// One `![alt](src)` markdown image ref that resolves to a workspace
/// raster image. Offsets index into the scanned markdown string; `srcStart`
/// / `srcEnd` bound just the URL inside the parens for in-place rewrite.
export interface WorkspaceImageRef {
  /// 0-based index among workspace image refs (external / non-image refs
  /// do not consume an ordinal). Matches the DOM tag order.
  ordinal: number;
  alt: string;
  /// The full src as written, including any `#...` fragment.
  src: string;
  /// The src with the `#...` fragment removed.
  base: string;
  /// The `#...` fragment including the leading hash, or "" when absent.
  fragment: string;
  /// Offset of the full `![...](...)` match start / end (exclusive).
  start: number;
  end: number;
  /// Offset of the URL portion inside the parens (for in-place rewrite).
  srcStart: number;
  srcEnd: number;
}

/// Split an image src into its base and its `#...` fragment (including the
/// leading hash). Never rebuilds the fragment, so `w=`, alignment, and
/// unknown params round-trip verbatim.
export function splitImageSrc(src: string): { base: string; fragment: string } {
  const hash = src.indexOf("#");
  if (hash < 0) return { base: src, fragment: "" };
  return { base: src.slice(0, hash), fragment: src.slice(hash) };
}

/// True when `src` addresses a workspace raster image (not an absolute
/// http/data/blob URL, not a non-image file). The raster-extension gate
/// excludes `.excalidraw`, `.md`, and other non-image attachments so the
/// scanner and the DOM tagger agree on the set by construction.
export function isWorkspaceImageSrc(src: string): boolean {
  const { base } = splitImageSrc(src);
  if (!base) return false;
  if (/^(https?:|data:|blob:)/i.test(base)) return false;
  return isImagePath(base);
}

// `![alt](url)` with a non-nested URL. chan never emits titles, so the URL
// runs to the first `)`.
const IMAGE_REF_RE = /!\[([^\]]*)\]\(([^)]*)\)/g;

/// Scan `markdown` for workspace image refs in document order. Shared by
/// copy (to number the ref tags) and paste (to rewrite the srcs), so the
/// two surfaces never disagree on which refs exist or their ordering.
export function findWorkspaceImageRefs(markdown: string): WorkspaceImageRef[] {
  const refs: WorkspaceImageRef[] = [];
  IMAGE_REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let ordinal = 0;
  while ((m = IMAGE_REF_RE.exec(markdown)) !== null) {
    const alt = m[1] ?? "";
    const src = m[2] ?? "";
    if (!isWorkspaceImageSrc(src)) continue;
    // `![` + alt + `](` precede the URL.
    const srcStart = m.index + 2 + alt.length + 2;
    const srcEnd = srcStart + src.length;
    const { base, fragment } = splitImageSrc(src);
    refs.push({
      ordinal: ordinal++,
      alt,
      src,
      base,
      fragment,
      start: m.index,
      end: m.index + m[0].length,
      srcStart,
      srcEnd,
    });
  }
  return refs;
}

/// Resolve an editor-relative image URL to an absolute one against the
/// current document location, WITHOUT the session bearer, so a
/// cross-window consumer can still address the bytes and an external one
/// is handed no credential.
///
/// `resolveImageSrc` builds the `<img>` src through `withTokenQuery`,
/// which appends `?t=<bearer>`; that query is a full bearer on its own
/// (chan-server reads it before the Authorization header), and the
/// clipboard is outside the app. Stripping it means an external paste
/// that falls back to this URL is refused with 401 on a tokened serve
/// and renders broken, which is why the data: upgrade below is what
/// makes such a paste show the image.
function toAbsoluteUrl(url: string): string {
  if (!url) return "";
  try {
    const absolute = new URL(url, window.location.href);
    absolute.searchParams.delete("t");
    return absolute.href;
  } catch {
    return url;
  }
}

/// Render the selected markdown to a sanitized body, resolve every
/// workspace `<img>` to an absolute, bearer-free URL, apply its width, and
/// tag it with its ref ordinal when the resolvable `<img>` count matches
/// the regex ref count (the count guard). Returns the body plus the
/// workspace imgs so the inliner can upgrade their srcs to data: URIs.
function renderBody(
  markdown: string,
  fromPath: string | null,
): { body: HTMLDivElement; imgs: HTMLImageElement[] } {
  const body = document.createElement("div");
  body.innerHTML = renderMarkdown(markdown);
  const refs = findWorkspaceImageRefs(markdown);
  const imgs = Array.from(body.querySelectorAll("img")).filter((img) =>
    isWorkspaceImageSrc(img.getAttribute("src") ?? ""),
  );
  const countOk = imgs.length === refs.length;
  imgs.forEach((img, i) => {
    const raw = img.getAttribute("src") ?? "";
    const abs = toAbsoluteUrl(resolveImageSrc(raw, fromPath));
    if (abs) img.setAttribute("src", abs);
    const { width } = parseImageSrc(raw);
    if (width != null) {
      img.style.maxWidth = "100%";
      img.style.width = `${width}px`;
    }
    // Only tag when the two counts agree; otherwise the index would not
    // line up with the paste-side scan, so we skip tagging and let the
    // markdown attribute carry everything.
    if (countOk) img.dataset.chanRef = String(i);
  });
  return { body, imgs };
}

/// Wrap a rendered body in the chan-doc envelope. `setAttribute` handles
/// attribute-value escaping, so the markdown round-trips through the paste
/// side's `getAttribute` exactly.
function wrapBody(
  body: HTMLDivElement,
  markdown: string,
  workspaceRoot: string | null,
  path: string | null,
): string {
  const wrap = document.createElement("div");
  wrap.setAttribute("data-chan-doc", "1");
  wrap.setAttribute("data-chan-workspace", workspaceRoot ?? "");
  wrap.setAttribute("data-chan-path", path ?? "");
  wrap.setAttribute("data-chan-markdown", markdown);
  wrap.append(...Array.from(body.childNodes));
  return wrap.outerHTML;
}

/// Build the sync baseline HTML: the rendered body with workspace `<img>`
/// srcs rewritten to absolute, bearer-free URLs. No fetches, so it is safe
/// to produce inside a DOM copy event.
export function buildBaselineHtml(
  markdown: string,
  fromPath: string | null,
  workspaceRoot: string | null,
): string {
  const { body } = renderBody(markdown, fromPath);
  return wrapBody(body, markdown, workspaceRoot, fromPath);
}

/// Read a Blob as a base64 data: URL. FileReader preserves the source
/// bytes verbatim (no canvas re-encode), so the image keeps its format.
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error ?? new Error("readAsDataURL failed"));
    fr.readAsDataURL(blob);
  });
}

/// Build the self-contained HTML: the baseline body with each tagged
/// workspace `<img>` upgraded from an absolute URL to a data: URI, up to
/// the inline budget. Over-budget or failed-fetch images keep their
/// absolute URL. Never rejects.
export async function buildInlinedHtml(
  markdown: string,
  fromPath: string | null,
  workspaceRoot: string | null,
): Promise<string> {
  const { body, imgs } = renderBody(markdown, fromPath);
  // Only the tagged imgs (count guard passed) are eligible; an untagged
  // set means the paste side can't map ordinals anyway.
  let budget = MAX_INLINE_BYTES;
  for (const img of imgs) {
    if (img.dataset.chanRef === undefined) continue;
    const abs = img.getAttribute("src") ?? "";
    if (!abs || abs.startsWith("data:")) continue;
    try {
      const resp = await fetch(abs);
      if (!resp.ok) continue;
      const blob = await resp.blob();
      if (blob.size > budget) continue;
      budget -= blob.size;
      img.setAttribute("src", await blobToDataUrl(blob));
    } catch {
      // Keep the absolute URL. It addresses the bytes without
      // authenticating for them, which is all a clipboard payload may
      // carry; a chan-to-chan paste never loads it anyway (paste_html
      // re-uploads data: refs and refuses anything else).
    }
  }
  return wrapBody(body, markdown, workspaceRoot, fromPath);
}

/// Build the inlined payload and write it to the clipboard, HTML + plain.
/// Desktop routes through the native arboard IPC (no user gesture needed,
/// sidesteps WKWebView async-clipboard quirks); web uses the async
/// clipboard API. Used by the copy event's async upgrade and by the
/// context-menu copy (which has no sync event to fall back on).
export async function writeDocSelectionToClipboard(
  markdown: string,
  ctx: ChanClipboardContext,
): Promise<void> {
  const html = await buildInlinedHtml(
    markdown,
    ctx.getCurrentPath(),
    ctx.getWorkspaceRoot(),
  );
  if (isTauriDesktop()) {
    await writeClipboardHtml(html, markdown);
    return;
  }
  await navigator.clipboard.write([
    new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([markdown], { type: "text/plain" }),
    }),
  ]);
}

/// Handle a DOM copy / cut event. Text-only selections `return false`
/// (CM6's default copy runs, byte-identical to today). A selection with at
/// least one workspace image ref writes both flavors synchronously, then
/// fires the async data: URI upgrade. Cut deletes the selection only when
/// the view is editable. Exported for the unit test.
export function handleClipboardCopy(
  view: EditorView,
  event: ClipboardEvent,
  ctx: ChanClipboardContext,
  isCut: boolean,
): boolean {
  const sel = view.state.selection.main;
  if (sel.empty) return false;
  const markdown = view.state.sliceDoc(sel.from, sel.to);
  if (findWorkspaceImageRefs(markdown).length === 0) return false;
  const cd = event.clipboardData;
  if (!cd) return false;
  event.preventDefault();
  const fromPath = ctx.getCurrentPath();
  const workspaceRoot = ctx.getWorkspaceRoot();
  cd.setData("text/plain", markdown);
  cd.setData("text/html", buildBaselineHtml(markdown, fromPath, workspaceRoot));
  if (isCut && view.state.facet(EditorView.editable)) {
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: "" },
      selection: EditorSelection.cursor(sel.from),
    });
  }
  // Fire-and-forget upgrade to self-contained data: URIs. The sync
  // baseline above stays correct if this is rejected.
  void writeDocSelectionToClipboard(markdown, ctx).catch((err) => {
    console.warn("clipboard rich copy upgrade failed", err);
  });
  return true;
}

/// Always-on copy / cut DOM handlers. In the base extension bundle (not
/// the write-side compartment) so read-only docs still copy rich.
export function copyHandlers(ctx: ChanClipboardContext): Extension {
  return EditorView.domEventHandlers({
    copy(event, view) {
      return handleClipboardCopy(view, event, ctx, false);
    },
    cut(event, view) {
      return handleClipboardCopy(view, event, ctx, true);
    },
  });
}
