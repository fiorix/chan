// Paste handling: HTML -> markdown conversion, plus a plain-text list-dedent.
//
// The paste handler covers four cases: a chan-to-chan rich paste (a
// wrapper carrying the exact source markdown + inlined images, written by
// copy_html.ts) carries images across windows / workspaces, and between a
// workspace and its drafts, which are kept outside it; image-file
// pastes defer to the image-drop handler; other rich HTML is converted to
// markdown via turndown; and a plain-text paste of a list item into an
// existing list line has its leading marker stripped (dedentListPaste) so
// a copied "- item" merges into the current bullet instead of nesting as
// "- - item". Everything else defers to CM6's default paste.
//
// When the clipboard carries an HTML representation (typical for a
// paste from another rich-text editor, a Notion / Obsidian / Office
// doc, or a browser's selection copy), convert it to markdown via
// turndown and insert the markdown instead of the raw HTML.
//
// Skip rules:
//   - No HTML in the clipboard -> defer to CM6's default plain-text
//     paste.
//   - HTML is just a wrapped plain-text run (no semantic tags) ->
//     defer (we don't want to over-process Cmd+V'd plaintext).
//   - Clipboard also contains image files -> defer to the image-drop
//     handler (image upload + ![](path) insert).
//
// turndown is lazy-imported on first paste so the converter (~25 KB
// gzip) doesn't ship in the main bundle until the user actually
// pastes rich content.

import { EditorView } from "@codemirror/view";
import type { EditorState, Extension } from "@codemirror/state";
import { parseListPrefix } from "./commands/list";
import {
  findWorkspaceImageRefs,
  type ChanClipboardContext,
  type WorkspaceImageRef,
} from "./copy_html";
import { base64ToBytes } from "../api/clipboard";
import { api } from "../api/client";
import { NO_DOCUMENT_MESSAGE } from "../api/errors";
import { draftClientPath, inSameDraft, isDraftClientPath } from "../api/fileIdentity";
import { invalidateImageCatalog } from "./bubbles/image";
import { decodePercent, encodeRelPath, normalizeHref, relativizePath } from "./links";
import { notify } from "../state/notify.svelte";

// Semantic HTML tags we treat as "this paste is actually rich" and
// worth running through turndown. Without these, a paste of bold or
// link-decorated plain text would skip conversion (current heuristic
// favors aggressive conversion). Includes definition lists, figures,
// and inline phrasing tags (mark/kbd/samp) so pastes from docs that
// rely on those don't fall back to raw HTML.
const RICH_TAG_RE =
  /<(?:a|b|blockquote|br|code|dd|del|dl|dt|em|figcaption|figure|h[1-6]|hr|i|img|kbd|li|mark|ol|p|pre|s|samp|strike|strong|sub|sup|table|td|th|tr|u|ul)\b/i;

export function pasteHandler(ctx?: ChanClipboardContext): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const cd = event.clipboardData;
      if (!cd) return false;
      // Image-file paste: let the image-drop handler take it.
      for (const item of Array.from(cd.items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          return false;
        }
      }
      const html = cd.getData("text/html");
      // Clipboard data is only readable during the paste event.
      const text = cd.getData("text/plain");
      const pastePlainTextOnFailure = (error: unknown) => {
        console.warn("chan paste: rich paste failed", error);
        if (!text) return;
        const sel = view.state.selection.main;
        const insert = dedentListPaste(view.state, sel.from, text);
        view.dispatch({
          changes: { from: sel.from, to: sel.to, insert },
          selection: { anchor: sel.from + insert.length },
        });
      };
      // Chan-to-chan rich paste: a wrapper carrying the exact source
      // markdown + inlined images. Parse it and apply (same-workspace
      // rebase or foreign upload). Missing / malformed attrs fall through
      // to the turndown path below (defensive).
      if (ctx && html && html.includes("data-chan-markdown")) {
        const parsed = parseChanWrapper(html);
        if (parsed) {
          event.preventDefault();
          void applyChanHtmlPaste(parsed, view, ctx).catch(pastePlainTextOnFailure);
          return true;
        }
      }
      if (html && RICH_TAG_RE.test(html)) {
        event.preventDefault();
        // Lazy import - the converter is only fetched on first rich
        // paste. Vite emits this as its own chunk.
        void (async () => {
          let md = await htmlToMarkdown(html);
          if (!md) return;
          // A rich paste from an external editor may inline images as
          // base64 data: URIs; upload them so gdocs-to-chan pastes land
          // as attachments instead of megabytes of base64 in the .md.
          if (ctx) md = await uploadInlineDataImages(md, ctx);
          const sel = view.state.selection.main;
          const insert = dedentListPaste(view.state, sel.from, md);
          view.dispatch({
            changes: { from: sel.from, to: sel.to, insert },
            selection: { anchor: sel.from + insert.length },
          });
        })().catch(pastePlainTextOnFailure);
        return true;
      }
      // Plain-text paste of a list item INTO a list line: strip the pasted
      // marker so a copied "- item" merges into the current bullet instead of
      // nesting under it (the "- - item" double-marker). Same dedent as the
      // rich path, but for the common chan-to-chan copy, which is plain text
      // (navigator.clipboard.writeText). Only intercept when the dedent
      // actually changes the text; every other paste defers to CM6's default.
      if (text) {
        const sel = view.state.selection.main;
        const insert = dedentListPaste(view.state, sel.from, text);
        if (insert !== text) {
          event.preventDefault();
          view.dispatch({
            changes: { from: sel.from, to: sel.to, insert },
            selection: { anchor: sel.from + insert.length },
          });
          return true;
        }
      }
      return false;
    },
  });
}

/// When rich content is pasted INTO a list item, turndown converts a
/// copied list-item link (clipboard HTML `<ul><li><a>...`, which is
/// what copying a link out of a list / web page yields) to
/// `-   [url](url)` - a leading bullet marker. Inserting that verbatim
/// into an existing `- ` bullet yields `- -   [url]`, which parses as a
/// stray NESTED bullet - pasting a link indented the list.
/// When the caret line is already a list item, strip a leading list
/// marker from the FIRST pasted line so the content flows into the
/// current bullet as a sibling instead of nesting under it. Only the
/// first line is touched, so a genuine multi-item paste keeps its later
/// bullets. A bare-anchor paste (turndown emits inline `[url](url)`, no
/// marker) is unaffected: `parseListPrefix` returns null and `md` passes
/// through unchanged. Exported for the unit test.
export function dedentListPaste(
  state: EditorState,
  pos: number,
  md: string,
): string {
  if (!parseListPrefix(state.doc.lineAt(pos).text)) return md;
  const nl = md.indexOf("\n");
  const first = nl === -1 ? md : md.slice(0, nl);
  const firstPrefix = parseListPrefix(first);
  if (!firstPrefix) return md;
  return first.slice(firstPrefix.length) + (nl === -1 ? "" : md.slice(nl));
}

// Exported for the vitest pin in `paste_html.test.ts`. Production
// callers go through `pasteHandler` above; the converter is
// kept exported so the escape-override behaviour can be exercised
// directly without spinning up a CM6 view.
export async function htmlToMarkdown(html: string): Promise<string> {
  const { default: TurndownService } = await import("turndown");
  const td = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    fence: "```",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });
  // Turndown's default text-node escape inserts a backslash before
  // every markdown special character (`*` / `_` / `[` / `]` /
  // `` ` `` / `#` / etc.) so a pasted "*bold*" arrives as literal
  // `\*bold\*` in the editor instead of rendering as **bold**.
  // Override the escape with identity so pasted text round-trips
  // verbatim through the parser. The accepted side effect -- literal
  // stray asterisks in pasted plain text trigger emphasis -- is
  // fine for the markdown-pipeline workflow; users who need the
  // escaped shape can flip to source mode before pasting.
  td.escape = (s: string) => s;
  // Strikethrough rule: turndown's default doesn't include strike;
  // GFM has it via ~~text~~.
  td.addRule("strikethrough", {
    filter: ["del", "s"],
    replacement: (content: string) => `~~${content}~~`,
  });
  // Task-list rule: <li> with a leading checkbox <input> becomes
  // `- [x]` / `- [ ]` markdown.
  td.addRule("taskListItem", {
    filter: (node: HTMLElement) => {
      if (node.nodeName !== "LI") return false;
      const cb = node.querySelector("input[type=checkbox]");
      return cb !== null;
    },
    replacement: (content: string, node) => {
      const el = node as HTMLElement;
      const cb = el.querySelector(
        "input[type=checkbox]",
      ) as HTMLInputElement | null;
      const mark = cb && cb.checked ? "[x]" : "[ ]";
      return `- ${mark} ${content.trim()}\n`;
    },
  });
  return td.turndown(html);
}

/// A parsed chan-doc wrapper: the exact source markdown, the origin
/// workspace / path, and the ordinal -> `<img>` src map (data: URIs, or an
/// absolute URL when inlining degraded). `sourcePath` is the origin as a
/// client path: a workspace path, a draft's client path built from the
/// wrapper's parts, or empty when the wrapper names none.
export interface ChanWrapperPaste {
  markdown: string;
  workspaceRoot: string;
  sourcePath: string;
  refData: Map<number, string>;
}

/// Parse a chan-doc wrapper out of pasted HTML. Returns null when the
/// markdown attribute is missing / empty (the caller then falls through to
/// the turndown path), so a corrupt or foreign wrapper degrades gracefully.
/// Exported for the unit test.
export function parseChanWrapper(html: string): ChanWrapperPaste | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return null;
  }
  const root = doc.querySelector("[data-chan-markdown]");
  if (!root) return null;
  const markdown = root.getAttribute("data-chan-markdown");
  if (markdown == null || markdown === "") return null;
  const refData = new Map<number, string>();
  for (const img of Array.from(root.querySelectorAll("img[data-chan-ref]"))) {
    const ord = Number(img.getAttribute("data-chan-ref"));
    if (!Number.isInteger(ord)) continue;
    const src = img.getAttribute("src");
    if (src) refData.set(ord, src);
  }
  return {
    markdown,
    workspaceRoot: root.getAttribute("data-chan-workspace") ?? "",
    sourcePath: wrapperSourcePath(root),
    refData,
  };
}

/// The origin a wrapper names, as a client path. A draft's is named by its
/// parts (`data-chan-root`, the path inside the drafts, the id of its
/// lifetime) and its client path is built here from them. A path attribute
/// is never taken as a client path itself: one that holds the mark names
/// nothing, and neither does a draft's without its id.
function wrapperSourcePath(root: Element): string {
  const path = root.getAttribute("data-chan-path") ?? "";
  if (path === "" || path.includes(String.fromCharCode(0))) return "";
  if (root.getAttribute("data-chan-root") !== "draft") return path;
  const draftId = root.getAttribute("data-chan-draft-id") ?? "";
  return draftId === "" ? "" : draftClientPath({ path, draft_id: draftId });
}

/// One in-place src rewrite: replace `[start, end)` with `text`.
interface SrcRewrite {
  start: number;
  end: number;
  text: string;
}

/// Apply src rewrites right-to-left so earlier offsets stay valid.
function applyRewritesRTL(source: string, rewrites: SrcRewrite[]): string {
  let out = source;
  for (const r of [...rewrites].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, r.start) + r.text + out.slice(r.end);
  }
  return out;
}

/// Directory of a workspace-rooted path (POSIX, no leading slash), or ""
/// for a file at the workspace root. Matches `normalizeHref`'s sourceDir
/// contract.
function dirOfPath(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? "" : path.slice(0, idx);
}

function dataUriImageMetadata(dataUri: string): { mime: string; extension: string } {
  const comma = dataUri.indexOf(",");
  const meta = comma < 0 ? "" : dataUri.slice(5, comma);
  const mime = meta.split(";")[0] || "";
  const extension = mime === "image/svg+xml" ? "svg"
    : mime === "image/jpeg" ? "jpg"
    : mime.split("/")[1] || "png";
  return { mime: mime || "application/octet-stream", extension };
}

/// Decode a base64 data: URI into a File. Non-base64 (`;charset` /
/// percent) payloads decode through decodeURIComponent.
function dataUriToFile(dataUri: string, name: string): File {
  const comma = dataUri.indexOf(",");
  const meta = comma < 0 ? "" : dataUri.slice(5, comma);
  const { mime } = dataUriImageMetadata(dataUri);
  const payload = comma < 0 ? "" : dataUri.slice(comma + 1);
  const bytes = /;base64/i.test(meta)
    ? base64ToBytes(payload)
    : new TextEncoder().encode(decodeURIComponent(payload));
  // Copy into a fresh ArrayBuffer: a Uint8Array may be backed by a
  // SharedArrayBuffer, which the DOM BlobPart type rejects.
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new File([buffer], name, { type: mime });
}

/// A filename for an uploaded pasted image: the ref's basename, else a
/// generic name with the data: URI's mime extension.
function uploadNameFor(ref: WorkspaceImageRef, dataUri: string): string {
  const base = decodePercent(ref.base).split("/").pop() ?? "";
  if (base) return base;
  return `pasted-image.${dataUriImageMetadata(dataUri).extension}`;
}

/// Same-workspace paste: no uploads. Rebase each ref from the SOURCE
/// document's directory to the DESTINATION document's directory, keeping
/// the `#...` fragment verbatim. Refs that can't resolve stay verbatim.
function rebaseSameWorkspace(
  markdown: string,
  refs: WorkspaceImageRef[],
  sourcePath: string,
  destPath: string | null,
): string {
  if (!sourcePath || !destPath) return markdown;
  const sourceDir = dirOfPath(sourcePath);
  const rewrites: SrcRewrite[] = [];
  for (const ref of refs) {
    const wsRooted = normalizeHref(decodePercent(ref.base), sourceDir);
    if (!wsRooted) continue;
    const rel = relativizePath(wsRooted, destPath);
    rewrites.push({
      start: ref.srcStart,
      end: ref.srcEnd,
      text: encodeRelPath(rel) + ref.fragment,
    });
  }
  return applyRewritesRTL(markdown, rewrites);
}

/// What a paste that carries images says where no document is open: there
/// is nowhere to copy them to, so the text lands with its references as
/// they were written.
const REFS_KEPT_MESSAGE = `${NO_DOCUMENT_MESSAGE}; pasted images keep their references`;

/// Whether a paste from `sourcePath` into `destPath` stays in one place,
/// so its image references can be rebased and nothing copied: both in the
/// workspace, or both files of one draft lifetime. A draft is kept outside
/// the workspace and apart from every other draft, and an image belongs to
/// its document's place, so every other crossing copies the images.
function inOnePlace(sourcePath: string, destPath: string | null): boolean {
  if (destPath === null) return !isDraftClientPath(sourcePath);
  if (isDraftClientPath(sourcePath) || isDraftClientPath(destPath)) {
    return inSameDraft(sourcePath, destPath);
  }
  return true;
}

/// Foreign paste: upload each ref's inlined bytes next to the destination
/// document, then rewrite its src to the returned (relativized) path plus
/// the ORIGINAL fragment. A per-image failure keeps the original ref, and
/// with no document open every ref is kept and nothing is uploaded.
async function uploadForeignRefs(
  markdown: string,
  refs: WorkspaceImageRef[],
  refData: Map<number, string>,
  ctx: ChanClipboardContext,
): Promise<string> {
  const destPath = ctx.getCurrentPath();
  const uploadDir = ctx.getUploadDir();
  if (uploadDir === null) {
    if (refs.length > 0) notify(REFS_KEPT_MESSAGE);
    return markdown;
  }
  const rewrites: SrcRewrite[] = [];
  let anyFailure = false;
  for (const ref of refs) {
    const dataSrc = refData.get(ref.ordinal);
    if (!dataSrc || !dataSrc.startsWith("data:")) {
      anyFailure = true;
      continue;
    }
    try {
      const file = dataUriToFile(dataSrc, uploadNameFor(ref, dataSrc));
      const res = await api.uploadAttachment(file, uploadDir);
      const rel = destPath ? relativizePath(res.path, destPath) : res.path;
      rewrites.push({
        start: ref.srcStart,
        end: ref.srcEnd,
        text: encodeRelPath(rel) + ref.fragment,
      });
    } catch (err) {
      console.warn("chan paste: image upload failed", err);
      anyFailure = true;
    }
  }
  invalidateImageCatalog();
  if (anyFailure) notify("Some pasted images couldn't be copied over");
  return applyRewritesRTL(markdown, rewrites);
}

/// Apply a parsed chan-doc wrapper: a rebase with zero uploads when origin
/// and destination are one workspace and one place in it (`inOnePlace`),
/// else a foreign upload; then a single dispatch reading the live selection
/// AFTER the awaits and the list-dedent, matching the turndown branch.
/// Exported for the unit test.
export async function applyChanHtmlPaste(
  parsed: ChanWrapperPaste,
  view: EditorView,
  ctx: ChanClipboardContext,
): Promise<void> {
  const refs = findWorkspaceImageRefs(parsed.markdown);
  const destRoot = ctx.getWorkspaceRoot();
  const sameWorkspace =
    parsed.workspaceRoot !== "" &&
    destRoot !== null &&
    parsed.workspaceRoot === destRoot;
  const out = sameWorkspace && inOnePlace(parsed.sourcePath, ctx.getCurrentPath())
    ? rebaseSameWorkspace(
        parsed.markdown,
        refs,
        parsed.sourcePath,
        ctx.getCurrentPath(),
      )
    : await uploadForeignRefs(parsed.markdown, refs, parsed.refData, ctx);
  const sel = view.state.selection.main;
  const insert = dedentListPaste(view.state, sel.from, out);
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: sel.from + insert.length },
  });
}

// `![alt](data:...)` inline base64 images from an external rich paste.
const DATA_IMAGE_RE = /!\[[^\]]*\]\((data:[^)]*)\)/g;

/// Upload any `![](data:...)` images turndown produced and rewrite their
/// srcs to the returned attachment paths, so an external paste with inline
/// base64 lands as files instead of megabytes of base64 in the doc. A
/// per-image failure keeps the base64 ref, and with no document open every
/// ref is kept and nothing is uploaded.
async function uploadInlineDataImages(
  md: string,
  ctx: ChanClipboardContext,
): Promise<string> {
  DATA_IMAGE_RE.lastIndex = 0;
  const matches: Array<{ start: number; end: number; src: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = DATA_IMAGE_RE.exec(md)) !== null) {
    const src = m[1] ?? "";
    const srcStart = m.index + m[0].indexOf(src);
    matches.push({ start: srcStart, end: srcStart + src.length, src });
  }
  if (matches.length === 0) return md;
  const destPath = ctx.getCurrentPath();
  const uploadDir = ctx.getUploadDir();
  if (uploadDir === null) {
    notify(REFS_KEPT_MESSAGE);
    return md;
  }
  const rewrites: SrcRewrite[] = [];
  for (const match of matches) {
    try {
      const { extension } = dataUriImageMetadata(match.src);
      const file = dataUriToFile(match.src, `pasted-image.${extension}`);
      const res = await api.uploadAttachment(file, uploadDir);
      const rel = destPath ? relativizePath(res.path, destPath) : res.path;
      rewrites.push({ start: match.start, end: match.end, text: encodeRelPath(rel) });
    } catch (err) {
      console.warn("chan paste: inline data image upload failed", err);
    }
  }
  if (rewrites.length > 0) invalidateImageCatalog();
  return applyRewritesRTL(md, rewrites);
}
