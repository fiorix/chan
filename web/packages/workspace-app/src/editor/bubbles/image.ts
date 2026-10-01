// Image bubble for the `![query` trigger.
//
// Renders two action rows + a filtered list of in-workspace image files:
//   - "Upload from disk..." opens the OS file picker; on selection,
//     uploads via api.uploadAttachment and commits the returned path.
//   - "Paste from clipboard" only enabled when the clipboard contains
//     an image (we don't pre-check; user-initiated paste handler
//     elsewhere in the editor is the better path for paste).
//   - Filtered list of in-workspace images (api.list cached, in-memory
//     filter by query substring on path).
//
// On commit, replaces `![query` with `![](path)`. Alt text is left
// empty for v1; the user can edit it via the source-reveal flow
// (selection-intersect in the image atom widget).
//
// Upload errors render in the status footer; the list stays available
// so the user can fall back to in-workspace selection.

import type { EditorView } from "@codemirror/view";
import { openBubbleShell } from "../bubble";
import { createCaretAnchor } from "./anchor";
import type { BubbleHandle } from "./types";
import { api } from "../../api/client";
import { indexStatus } from "../../state/store.svelte";
import {
  isImagePath,
  parseImageSrc,
  resolveImageSrc,
  setImageAlign,
  setImageWidth,
  type ImageAlign,
} from "../extensions/image";
import { convertHeicForUpload } from "./heic";
import { encodeRelPath, relativizePath } from "../links";
import { completionEmptyState, renderBubbleEmptyState } from "./empty_state";

export interface ImageBubbleOpts {
  view: EditorView;
  triggerStart: number;
  triggerEnd: number;
  initialQuery: string;
  /// Upload destination; defaults to the editing file's directory if
  /// known, otherwise the server's configured attachments_dir.
  uploadDir: string | null;
  /// Workspace-rooted path of the editing file. Used to relativize the
  /// committed image path so the inserted `![](src)` resolves
  /// correctly through the image widget's resolveImageSrc (which is
  /// fromPath-aware). null keeps the path workspace-rooted (no /` prefix
  /// adjustment).
  currentPath: string | null;
  /// "wrap" -> commit inserts `![](path)`; "raw" -> commit inserts
  /// just `path` (used when editing an existing image's URL portion).
  templateMode?: "wrap" | "raw";
  /// Cmd+Enter handler. Called with the selected hit's path so the
  /// host can open the image zoom modal (or do whatever "open the
  /// image" means in context). Optional - when omitted, Cmd+Enter is
  /// a no-op.
  onOpenLink?: (path: string) => void;
  onDismiss: () => void;
}

const RESULT_LIMIT = 5;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const DEFAULT_INSERT_WIDTH_PX = 250;

interface ImageBubbleHandle extends BubbleHandle {
  setTriggerEnd(end: number): void;
}

let catalogCache: string[] | null = null;
let catalogInflight: Promise<string[]> | null = null;

async function loadImageCatalog(): Promise<string[]> {
  if (catalogCache !== null) return catalogCache;
  if (catalogInflight) return catalogInflight;
  catalogInflight = api
    .list()
    .then((entries) => {
      const out = entries
        .filter((e) => !e.is_dir && isImagePath(e.path))
        .map((e) => e.path)
        .sort((a, b) => a.localeCompare(b));
      catalogCache = out;
      return out;
    })
    .finally(() => {
      catalogInflight = null;
    });
  return catalogInflight;
}

/// Allow callers to invalidate the catalog after uploads land. The
/// cache is module-scoped so subsequent bubble opens see the new file.
export function invalidateImageCatalog(): void {
  catalogCache = null;
}

export function openImageBubble(opts: ImageBubbleOpts): ImageBubbleHandle {
  // Anchor at the START of the editable range - for raw mode that's
  // the URL slot's open boundary (just after `(`), for wrap mode
  // it's the `!` of `![`. Stable across typing inside the trigger:
  // unlike the live caret, this doesn't shift as the user edits,
  // so the bubble stays put. Matches the legacy editor's "bubble
  // under the `(` of `![](`" placement.
  const anchorPos = (): number => opts.triggerStart;
  const anchor = createCaretAnchor(opts.view, anchorPos());
  const shell = openBubbleShell({
    host: anchor.el,
    className: "md-image-bubble cm-bubble",
  });
  let query = opts.initialQuery;
  let triggerEnd = opts.triggerEnd;
  let catalog: string[] = [];
  let hits: string[] = [];
  let selectedIndex = 0;
  let alive = true;

  const actions = document.createElement("div");
  actions.className = "md-bubble-actions";
  shell.wrap.appendChild(actions);
  const uploadBtn = document.createElement("div");
  uploadBtn.className = "md-bubble-row md-bubble-action";
  uploadBtn.textContent = "Upload from disk...";
  uploadBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    triggerUpload();
  });
  actions.appendChild(uploadBtn);

  // Preview row above the result list: a thumbnail of the currently
  // highlighted path. Empty / invisible when nothing is highlighted.
  const preview = document.createElement("div");
  preview.className = "md-image-preview";
  shell.wrap.appendChild(preview);

  // Alignment row, only visible in raw mode (editing an existing
  // image). Three buttons cycle the `#left` / `#right` fragment on
  // the URL - commits an edit to the source URL directly (no
  // bubble dismiss). Center is "no fragment".
  let alignRow: HTMLDivElement | null = null;
  if (opts.templateMode === "raw") {
    alignRow = document.createElement("div");
    alignRow.className = "md-image-align-row";
    const mkBtn = (label: string, target: ImageAlign | null): HTMLElement => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "md-image-align-btn";
      btn.dataset.align = target ?? "center";
      btn.textContent = label;
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const url = opts.view.state.doc.sliceString(
          opts.triggerStart,
          triggerEnd,
        );
        const next = setImageAlign(url, target);
        if (next === url) return;
        opts.view.dispatch({
          changes: {
            from: opts.triggerStart,
            to: triggerEnd,
            insert: next,
          },
        });
        // triggerEnd shifts by the length delta; setTriggerEnd will
        // get called by the next spec update, but for the
        // back-to-back-click case we update locally too.
        triggerEnd = opts.triggerStart + next.length;
        renderAlign();
      });
      return btn;
    };
    alignRow.appendChild(mkBtn("◧", "left"));
    alignRow.appendChild(mkBtn("▢", null));
    alignRow.appendChild(mkBtn("◨", "right"));
    shell.wrap.appendChild(alignRow);
  }

  function renderAlign(): void {
    if (!alignRow) return;
    const url = opts.view.state.doc.sliceString(
      opts.triggerStart,
      triggerEnd,
    );
    const { align } = parseImageSrc(url);
    for (const btn of Array.from(
      alignRow.querySelectorAll(".md-image-align-btn"),
    )) {
      const a = (btn as HTMLElement).dataset.align;
      const active =
        (align === null && a === "center") || align === a;
      btn.classList.toggle("md-image-align-btn-active", active);
    }
  }
  renderAlign();

  const list = document.createElement("div");
  list.className = "md-bubble-list";
  shell.wrap.appendChild(list);
  const status = document.createElement("div");
  status.className = "md-bubble-status";
  shell.wrap.appendChild(status);

  function renderPreview(): void {
    preview.innerHTML = "";
    // In raw mode (editing an existing image's URL), the preview is
    // ALWAYS the live URL the user is editing - never a catalog hit.
    // Using `hits[selectedIndex]` here is wrong: after an align
    // toggle, the URL length changes, caret collapses to slot start,
    // query becomes "", filter() picks the first catalog image, and
    // the preview suddenly shows an unrelated image. Pulling the
    // text straight from the doc keeps preview locked to the source.
    let src: string | null;
    if (opts.templateMode === "raw") {
      const url = opts.view.state.doc.sliceString(
        opts.triggerStart,
        triggerEnd,
      );
      src = url || null;
    } else {
      src = hits[selectedIndex] ?? null;
    }
    if (!src) return;
    // Raw mode passes the live doc URL through here - that text is
    // authored source-relative, so resolve against currentPath.
    // Catalog hits are already workspace-rooted, so pass `null` to skip
    // the sourceDir prepend that would turn "attachments/smile.png"
    // for a file at "Contacts/Bob Smith.md" into
    // "Contacts/attachments/smile.png" (404).
    const resolveFrom =
      opts.templateMode === "raw" ? opts.currentPath : null;
    const url = resolveImageSrc(src, resolveFrom);
    if (!url) return;
    const img = document.createElement("img");
    img.src = url;
    img.alt = src;
    preview.appendChild(img);
  }

  function filter(): void {
    const q = query.toLowerCase();
    hits = q.length === 0
      ? catalog.slice(0, RESULT_LIMIT)
      : catalog.filter((p) => p.toLowerCase().includes(q)).slice(0, RESULT_LIMIT);
    if (selectedIndex >= hits.length) selectedIndex = 0;
    render();
  }

  function render(): void {
    list.innerHTML = "";
    list.classList.remove("md-bubble-empty-state");
    if (hits.length === 0) {
      if (catalog.length === 0 && query.trim() !== "") {
        status.textContent = "Loading images...";
        status.classList.remove("md-bubble-status-empty");
      } else {
        renderBubbleEmptyState(list, completionEmptyState(query, indexStatus.value));
        status.textContent = "";
        status.classList.add("md-bubble-status-empty");
      }
      // Still render the preview even with empty hits - in raw mode
      // the fallback uses the current URL slot text, so the user
      // sees the image they're editing even when the catalog
      // doesn't match.
      renderPreview();
      shell.reposition();
      return;
    }
    status.classList.remove("md-bubble-status-empty");
    const openHint = opts.onOpenLink ? " - ⌘↵ open" : "";
    status.textContent = `${hits.length} result${hits.length === 1 ? "" : "s"} - ↵ insert${openHint}`;
    for (let i = 0; i < hits.length; i++) {
      const path = hits[i]!;
      const row = document.createElement("div");
      row.className = "md-bubble-row";
      if (i === selectedIndex) row.classList.add("md-bubble-row-selected");
      row.textContent = path;
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        commitPath(path);
      });
      list.appendChild(row);
    }
    renderPreview();
    shell.reposition();
  }

  function commitPath(path: string): void {
    // Relativize against the editing file's directory so the inserted
    // `![](src)` resolves correctly. The api.search / api.list /
    // api.uploadAttachment endpoints all return workspace-rooted paths
    // without leading slash; inserted verbatim those would be
    // interpreted as relative-to-currentPath-dir by the image widget's
    // resolver (resolveImageSrc → normalizeHref), doubling the dir
    // when the editing file isn't at workspace root.
    const pathArg = opts.currentPath
      ? relativizePath(path, opts.currentPath)
      : path;
    // Percent-encode the path portion (leaving any `#...` fragment
    // alone) so a filename with a space round-trips: an unencoded
    // `![](./My Photo.png)` truncates at the space on the backend graph
    // scan and resolves wrong. resolveImageSrc decodes on read. Mirrors
    // the [[ wiki-link writer (links.ts encodeRelPath).
    const hashIdx = pathArg.indexOf("#");
    const encArg =
      hashIdx >= 0
        ? encodeRelPath(pathArg.slice(0, hashIdx)) + pathArg.slice(hashIdx)
        : encodeRelPath(pathArg);
    // Replacing a URL slot, including after a broken-image upload,
    // keeps its width and alignment. A fresh insert uses the picked
    // path's width or the small default.
    let sized: string;
    if (opts.templateMode === "raw") {
      const previous = parseImageSrc(opts.view.state.doc.sliceString(opts.triggerStart, triggerEnd));
      const picked = parseImageSrc(encArg);
      sized = setImageAlign(
        setImageWidth(encArg, previous.width ?? picked.width ?? DEFAULT_INSERT_WIDTH_PX),
        previous.align,
      );
    } else {
      sized = /#w=\d+/.test(encArg) ? encArg : `${encArg}#w=${DEFAULT_INSERT_WIDTH_PX}`;
    }
    const insert = opts.templateMode === "raw" ? sized : `![](${sized})`;
    opts.view.dispatch({
      changes: { from: opts.triggerStart, to: triggerEnd, insert },
      selection: { anchor: opts.triggerStart + insert.length },
    });
    dismiss();
  }

  function triggerUpload(): void {
    const input = document.createElement("input");
    input.type = "file";
    // `image/*` covers the standard formats; the explicit
    // `.heic,.heif` is a fallback for browsers (Chrome on Windows)
    // that don't surface HEIC under the MIME filter. We convert
    // post-pick before upload either way.
    input.accept = "image/*,.heic,.heif";
    input.addEventListener("change", () => {
      const picked = input.files?.[0];
      if (!picked) return;
      if (picked.size > MAX_UPLOAD_BYTES) {
        status.textContent = `File too large (max ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)`;
        return;
      }
      void (async () => {
        let file: File;
        try {
          file = await convertHeicForUpload(picked, (msg) => {
            if (!alive) return;
            // Surface "Converting <name>..." in the bubble's status
            // pill; convertHeicForUpload clears it (msg === null)
            // once the encode completes. For non-HEIC inputs the
            // callback never fires.
            if (msg) status.textContent = msg;
          });
        } catch (err) {
          if (!alive) return;
          status.textContent = `HEIC conversion failed: ${(err as Error).message ?? err}`;
          return;
        }
        if (!alive) return;
        status.textContent = "Uploading...";
        try {
          const res = await api.uploadAttachment(file, opts.uploadDir);
          if (!alive) return;
          invalidateImageCatalog();
          commitPath(res.path);
        } catch (err) {
          if (!alive) return;
          status.textContent = `Upload failed: ${(err as Error).message ?? err}`;
        }
      })();
    });
    input.click();
  }

  function dismiss(): void {
    if (!alive) return;
    alive = false;
    shell.dismiss();
    anchor.dismiss();
    opts.onDismiss();
  }

  loadImageCatalog()
    .then((cat) => {
      if (!alive) return;
      catalog = cat;
      filter();
    })
    .catch((err) => {
      if (!alive) return;
      status.textContent = `Catalog failed: ${err.message ?? err}`;
    });
  filter();

  return {
    handleKey(event) {
      if (event.key === "Escape") {
        dismiss();
        return true;
      }
      if (event.key === "Enter") {
        if (event.metaKey || event.ctrlKey) {
          // Cmd/Ctrl+Enter -> "open" the selected (or queried) path.
          // For images this is the host's zoom modal.
          if (!opts.onOpenLink) return false;
          const path = hits[selectedIndex] ?? query;
          if (!path) return false;
          opts.onOpenLink(path);
          dismiss();
          return true;
        }
        const path = hits[selectedIndex];
        if (path) {
          commitPath(path);
          return true;
        }
        return false;
      }
      if (event.key === "ArrowDown") {
        if (hits.length === 0) return false;
        selectedIndex = (selectedIndex + 1) % hits.length;
        render();
        return true;
      }
      if (event.key === "ArrowUp") {
        if (hits.length === 0) return false;
        selectedIndex = (selectedIndex - 1 + hits.length) % hits.length;
        render();
        return true;
      }
      return false;
    },
    setQuery(q) {
      anchor.update(opts.view, anchorPos());
      shell.reposition();
      if (q === query) return;
      query = q;
      filter();
    },
    setTriggerEnd(end) {
      triggerEnd = end;
    },
    reposition() {
      anchor.update(opts.view, anchorPos());
      shell.reposition();
    },
    dismiss,
  };
}
