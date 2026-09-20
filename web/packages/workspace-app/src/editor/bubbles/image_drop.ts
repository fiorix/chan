// Editor-level drop / paste handlers for image files.
//
// Separate from the image bubble: drop / paste fire on the EditorView
// itself (no `![` typing required). On a successful upload the file is
// written into the doc as a `![](path)` embed at the drop / paste position; the
// image atom widget renders it on the next decoration tick.
//
// This module only handles IMAGE files. Plain text drops / pastes
// fall through to CM6's defaults (markdown text, etc.).

import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { api } from "../../api/client";
import { notify } from "../../state/notify.svelte";
import { convertHeicForUpload, isHeicFile } from "./heic";
import { invalidateImageCatalog } from "./image";
import { encodeRelPath, relativizePath } from "../links";
import { listLineAt } from "../commands/list";
import { IMAGE_MOVE_MIME } from "../widgets/image";
import {
  clearImageDragIndicator,
  imageDragSource,
  hideImageDropTarget,
  updateImageDropTarget,
} from "../image_drag_indicator";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const DEFAULT_INSERT_WIDTH_PX = 250;

export interface ImageDropOptions {
  /// Upload destination; defaults to the editing file's directory if
  /// known, otherwise the server's configured attachments_dir. Read
  /// lazily so swapping tabs picks up the new path.
  getUploadDir: () => string | null;
  /// Editing file's workspace-rooted path. The uploaded `path` is relativized
  /// against this so the inserted `![](src)` resolves through resolveImageSrc.
  getCurrentPath?: () => string | null;
}

/// The drop / paste handlers read the lazy `ImageDropOptions` getters at
/// event time into this resolved snapshot, which rides through the
/// sequential upload loop.
interface InsertCtx {
  uploadDir: string | null;
  currentPath: string | null;
}

function resolveInsertCtx(opts: ImageDropOptions): InsertCtx {
  return {
    uploadDir: opts.getUploadDir(),
    currentPath: opts.getCurrentPath?.() ?? null,
  };
}

export function imageDropHandlers(opts: ImageDropOptions): Extension {
  return EditorView.domEventHandlers({
    dragover(event, view) {
      // An internal image-move drag must show the move cursor and,
      // crucially, the editor must accept the drop (the default is to
      // reject). Without preventDefault on dragover the `drop` never
      // fires. We only opt in for our own move type; OS file drags
      // keep CM6's / the browser's default handling.
      if (event.dataTransfer?.types?.includes(IMAGE_MOVE_MIME)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        // Refresh the live source-row indicator under the pointer.
        updateImageDropTarget(view, event.clientX, event.clientY);
        return true;
      }
      return false;
    },
    dragleave(event, view) {
      // Hide the indicator when the pointer truly leaves the editor (not
      // when it merely crosses into a child node). The source range is
      // kept so re-entering re-arms on the next dragover.
      const related = event.relatedTarget as Node | null;
      if (!related || !view.dom.contains(related)) {
        hideImageDropTarget(view);
      }
      return false;
    },
    drop(event, view) {
      // Internal image-move: a rendered image atom was dragged to a
      // new row. Relocate its `![alt](src)` source to the drop row;
      // the image dropdown still owns left/center/right.
      const moveData = event.dataTransfer?.getData(IMAGE_MOVE_MIME);
      if (moveData) {
        event.preventDefault();
        // The payload's offsets belong to the document that armed the
        // drag, in the view that armed it. Ask that view's live drag
        // state instead of trusting them: a drop in another pane, or
        // after a change has shifted the source, moves nothing.
        const source = imageDragSource(view);
        if (source) moveImageSource(view, source, posFromEvent(view, event));
        // A real move clears the indicator via docChanged; a no-op drop
        // (own row) leaves the doc untouched, so clear it explicitly.
        clearImageDragIndicator(view);
        return true;
      }
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) return false;
      // HEIC drops from Chrome / Firefox on non-Apple OSes often
      // arrive with empty `File.type`. `isHeicFile` peeks at the
      // extension so those files don't slip through the MIME check.
      const images = Array.from(files).filter(
        (f) => f.type.startsWith("image/") || isHeicFile(f),
      );
      if (images.length === 0) return false;
      event.preventDefault();
      const pos = posFromEvent(view, event);
      uploadAndInsertAll(view, images, pos, resolveInsertCtx(opts));
      return true;
    },
    paste(event, view) {
      const items = event.clipboardData?.items;
      if (!items) return false;
      const images: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind !== "file") continue;
        if (item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) images.push(f);
          continue;
        }
        // HEIC pastes from a screenshot tool / Files.app may come
        // through with an empty MIME; the extension check rescues
        // those before they get dropped on the floor.
        const f = item.getAsFile();
        if (f && isHeicFile(f)) images.push(f);
      }
      if (images.length === 0) return false;
      event.preventDefault();
      const pos = pasteInsertPos(view);
      uploadAndInsertAll(view, images, pos, resolveInsertCtx(opts));
      return true;
    },
  });
}

/// Where a pasted image should land. A paste carries no coordinates,
/// so the natural target is the caret. But `selection.main.head` is 0
/// for a freshly-opened document the user hasn't clicked into yet - /// pasting a screenshot right after opening a note would drop the image
/// at the very top, above the title (the reported bug). Only trust the
/// caret when the editor actually has focus; otherwise append at the
/// end of the document, which is the least-surprising landing spot for
/// "paste with no active caret" and never clobbers the first row.
export function pasteInsertPos(view: EditorView): number {
  if (view.hasFocus) return view.state.selection.main.head;
  return view.state.doc.length;
}

/// Relocate a dragged image's `![alt](src)` source to the drop row.
/// `moveData` is the JSON `{from,to}` source range captured at
/// dragstart; `dropPos` is the document offset under the cursor at
/// drop. Left/center/right alignment is unchanged (it rides in the
/// `src` fragment, which moves verbatim). Width (`#w=N`) likewise
/// round-trips.
export function moveImageSource(
  view: EditorView,
  range: { from: number; to: number },
  dropPos: number,
): void {
  if (range.from >= range.to) return;
  const doc = view.state.doc;
  if (range.to > doc.length) return;
  // Dropping back inside (or immediately adjacent to) the source is a
  // no-op; nothing moved.
  if (dropPos >= range.from && dropPos <= range.to) return;

  const markdown = doc.sliceString(range.from, range.to);
  const srcLine = doc.lineAt(range.from);
  const lineText = doc.sliceString(srcLine.from, srcLine.to);
  // Whether the image is the ONLY content on its source line.
  const imageWasStandalone = lineText.trim() === markdown.trim();
  const targetLine = doc.lineAt(dropPos);

  // CM6 applies the whole transaction against ORIGINAL positions, so we
  // express the deletion + insertion in original coordinates and let it
  // reconcile. Both branches swallow the source line's trailing break so
  // no blank row is stranded where the content used to be.
  let delFrom: number;
  let delTo: number;
  let insertText: string;
  if (imageWasStandalone) {
    // Bare image on its own line: move just the `![](..)` atom and land
    // it at the START of the drop row - inline with the bullet (trailing
    // space, no newline) on a list target, else on its own line.
    const onListLine = listLineAt(view.state, dropPos) !== null;
    insertText = onListLine ? `${markdown} ` : `${markdown}\n`;
    delFrom = srcLine.from;
    delTo = Math.min(srcLine.to + 1, doc.length);
  } else {
    // The image is embedded in a row with other text
    // (`text ![](..) text`) or inside a bullet item. Move the
    // ENTIRE row - the surrounding text + image + any list marker
    // - as its own line so they travel together, instead of
    // stranding the text and relocating only the atom. Exactly one
    // source line: multi-line prose paragraphs are out of scope.
    // Dropping anywhere on the source line itself is a no-op (a
    // row can't move onto itself).
    if (dropPos >= srcLine.from && dropPos <= srcLine.to) return;
    insertText = `${lineText}\n`;
    delFrom = srcLine.from;
    delTo = Math.min(srcLine.to + 1, doc.length);
  }

  const insertAt = targetLine.from;
  // Guard against the insertion point sitting inside the deletion span
  // (the whole-line widening above can pull delFrom/delTo around it).
  if (insertAt >= delFrom && insertAt < delTo) return;

  view.dispatch({
    changes: [
      { from: delFrom, to: delTo, insert: "" },
      { from: insertAt, to: insertAt, insert: insertText },
    ],
    // Place the caret just after the moved text at its new home.
    selection: {
      anchor:
        insertAt < delFrom
          ? insertAt + insertText.length
          : insertAt + insertText.length - (delTo - delFrom),
    },
    scrollIntoView: true,
  });
}

function posFromEvent(view: EditorView, event: DragEvent): number {
  const coords = { x: event.clientX, y: event.clientY };
  const pos = view.posAtCoords(coords);
  if (pos !== null) return pos;
  return view.state.selection.main.head;
}

function uploadAndInsertAll(
  view: EditorView,
  files: File[],
  pos: number,
  ctx: InsertCtx,
): void {
  // Upload sequentially so we can chain the inserts at adjacent
  // positions (each insert shifts subsequent positions; we map
  // through view.state.tr.changes' resolution after each).
  let cursor = pos;
  void (async () => {
    for (const original of files) {
      if (original.size > MAX_UPLOAD_BYTES) continue;
      // HEIC -> WebP conversion happens here so a mixed batch
      // (some PNG, some HEIC) converts only the ones that need it
      // without blocking the others; non-HEIC inputs return from
      // `convertHeicForUpload` untouched and synchronously.
      let file: File;
      try {
        file = await convertHeicForUpload(original, (msg) => {
          if (msg) notify(msg);
        });
      } catch (err) {
        console.error("[chan] HEIC conversion failed", err);
        notify(`HEIC conversion failed for ${original.name}; skipped`);
        continue;
      }
      try {
        const res = await api.uploadAttachment(file, ctx.uploadDir);
        invalidateImageCatalog();
        const onListLine = listLineAt(view.state, cursor) !== null;
        const { text: insert, caret } = buildImageInsert(res.path, {
          currentPath: ctx.currentPath,
          onListLine,
        });
        view.dispatch({
          changes: { from: cursor, to: cursor, insert },
          selection: { anchor: cursor + caret },
          // Scroll the doc so the new caret stays in view. Pasting /
          // dropping at the bottom can push the cursor off-screen;
          // `scrollIntoView: true` tells CM6 to correct that immediately.
          scrollIntoView: true,
        });
        cursor += insert.length;
      } catch (err) {
        console.error("[chan] image upload failed", err);
        return;
      }
    }
  })();
}

/// Build the text inserted for an uploaded image plus the caret offset
/// within it. `uploadedPath` is the server's workspace-rooted upload path.
///
/// The path is relativized against `currentPath` and percent-encoded so a name
/// with a space (or other URL-special char) round-trips -- an unencoded
/// `![](./My Photo.png)` truncates at the space on the backend graph scan and
/// resolves wrong (resolveImageSrc decodes on read); the `#w=N` fragment is
/// appended after encoding. New images default to 250px wide (the widget reads
/// `#w=N` and clamps via CSS; the corner handle resizes) because a dropped /
/// pasted image is almost always too big at intrinsic size. A trailing separator
/// keeps the next keystroke off the image (a space inline on a list line, a
/// newline as its own block); the caret lands just past the atom, BEFORE that
/// separator, so it stays on the image's line (the atomic widget renders the
/// caret at its end boundary -- see caret_mapping.ts).
export function buildImageInsert(
  uploadedPath: string,
  ctx: {
    currentPath: string | null;
    onListLine: boolean;
  },
): { text: string; caret: number } {
  const pathArg = ctx.currentPath
    ? relativizePath(uploadedPath, ctx.currentPath)
    : uploadedPath;
  const imageMarkdown = `![](${encodeRelPath(pathArg)}#w=${DEFAULT_INSERT_WIDTH_PX})`;
  const text = ctx.onListLine ? `${imageMarkdown} ` : `${imageMarkdown}\n`;
  return { text, caret: imageMarkdown.length };
}
