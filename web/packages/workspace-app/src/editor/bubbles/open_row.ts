// The OPEN row of a link drop-down: the row that opens a link's target as
// written rather than searching for a replacement. The editor's link picker
// shows it first in a `[label](url)` slot (wiki.ts); content that cannot be
// edited shows it alone, in the read-only drop-down `openLinkBubble` opens
// under a pressed link.
//
// An openable external URL or a graph link opens here. A workspace path
// only the host can open, so a host without a path opener gets no row for
// one. Anything else (another scheme, a bare fragment, a path that climbs
// out of the workspace) gets no row.

import { openBubbleShell } from "../bubble";
import type { BubbleHandle } from "./types";
import { copyTextToClipboard, openGraphFromLink } from "../../state/store.svelte";
import { GRAPH_LINK_PREFIX } from "../../state/tabs.svelte";
import { isOpenableExternalUrl, openExternalUrl } from "../external_links";
import "../copy_button.css";
import { parseInternalLink } from "../widgets/wikilink";

/// Opens a workspace path at an anchor (the text after the link's `#`, or
/// null without one).
export type OpenPath = (target: string, anchor: string | null) => void;

export interface OpenRow {
  kind: "Open";
  /// The resolved workspace path, or for an external row the URL as written.
  target: string;
  anchor: string | null;
  /// The target as written, shown in the row.
  url: string;
  /// An openable URL or a graph link, which opens without the host.
  external: boolean;
}

export function isOpenRow(hit: unknown): hit is OpenRow {
  return (hit as { kind?: string } | null)?.kind === "Open";
}

/// The footer under an OPEN row that Enter opens.
export const OPEN_ROW_HINT = "↵ open";

/// The row for a link's target as written, or null when it opens nothing.
/// A workspace path gets a row only when `opensPaths`, resolved against the
/// directory of `fromPath` (workspace-rooted, no leading slash), or the
/// workspace root when it is null.
export function openRowFor(url: string, fromPath: string | null, opensPaths: boolean): OpenRow | null {
  if (isOpenableExternalUrl(url) || url.startsWith(GRAPH_LINK_PREFIX)) {
    return { kind: "Open", target: url, anchor: null, url, external: true };
  }
  if (!opensPaths) return null;
  const parsed = parseInternalLink(url, "", fromPath);
  if (!parsed) return null;
  return {
    kind: "Open",
    target: parsed.target,
    anchor: parsed.anchor ? parsed.anchor : null,
    url,
    external: false,
  };
}

/// Fill `row` with the OPEN tag and the target as written, and for an
/// external row the copy button, which reports into `status`.
export function renderOpenRow(row: HTMLElement, hit: OpenRow, status: HTMLElement): void {
  const tag = document.createElement("span");
  tag.className = "md-bubble-row-level";
  tag.textContent = "OPEN";
  const text = document.createElement("span");
  text.textContent = hit.url;
  row.appendChild(tag);
  row.appendChild(text);
  if (!hit.external) return;
  row.classList.add("md-bubble-row-external");
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy-btn";
  copy.title = "Copy URL to clipboard";
  copy.setAttribute("aria-label", "Copy URL to clipboard");
  copy.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
  copy.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  copy.addEventListener("click", (e) => {
    e.stopPropagation();
    void copyTextToClipboard(hit.url, {
      onSuccess: () => { status.textContent = "Copied URL"; },
      onError: (msg) => { status.textContent = `Copy failed: ${msg}`; },
    });
  });
  row.appendChild(copy);
}

/// Open the row: a graph link in the graph, a URL through
/// `openExternalUrl`, a workspace path through `openPath`.
export function openRowTarget(hit: OpenRow, openPath?: OpenPath): void {
  if (hit.external) {
    if (hit.url.startsWith(GRAPH_LINK_PREFIX)) openGraphFromLink(hit.url);
    else void openExternalUrl(hit.url);
  } else {
    openPath?.(hit.target, hit.anchor);
  }
}

export interface LinkBubbleOpts {
  /// The element the drop-down sits under: the pressed link.
  host: HTMLElement;
  /// The link's target as written.
  url: string;
  /// Opens a workspace path; without it a path link gets no drop-down.
  onOpenLink?: OpenPath;
  /// Called once when the drop-down closes, whatever closed it.
  onDismiss?: () => void;
}

/// Show the read-only drop-down for a link in content that cannot be
/// edited: the link's OPEN row alone, with the editor's footer for it.
/// Such content has no source file, so a relative path resolves against
/// the workspace root. Returns null, showing nothing, when the
/// target opens nothing. The handle answers Escape (close) and Enter with
/// or without a modifier (open, then close), as the editor's picker does
/// for its OPEN row, and leaves every other key to the caller. The
/// drop-down never takes the keyboard.
export function openLinkBubble(opts: LinkBubbleOpts): BubbleHandle | null {
  const hit = openRowFor(opts.url, null, Boolean(opts.onOpenLink));
  if (!hit) return null;
  const shell = openBubbleShell({ host: opts.host, className: "md-wiki-bubble cm-bubble" });
  const list = document.createElement("div");
  list.className = "md-bubble-list";
  const row = document.createElement("div");
  row.className = "md-bubble-row md-bubble-row-selected";
  const status = document.createElement("div");
  status.className = "md-bubble-status";
  status.textContent = OPEN_ROW_HINT;
  renderOpenRow(row, hit, status);
  list.appendChild(row);
  shell.wrap.append(list, status);
  shell.reposition();
  let alive = true;

  const dismiss = (): void => {
    if (!alive) return;
    alive = false;
    document.removeEventListener("mousedown", onOutsidePress, true);
    shell.dismiss();
    opts.onDismiss?.();
  };
  const open = (): void => {
    openRowTarget(hit, opts.onOpenLink);
    dismiss();
  };
  // The shell removes itself on a press outside it and its host but tells
  // no one, so the same rule closes the handle too, or its owner would keep
  // routing keys to a drop-down that is gone. Deferred a tick, as the
  // shell's, so the press that opened the drop-down does not close it.
  const onOutsidePress = (e: MouseEvent): void => {
    const t = e.target as Node | null;
    if (t && (shell.wrap.contains(t) || opts.host.contains(t))) return;
    dismiss();
  };
  window.setTimeout(() => {
    if (alive) document.addEventListener("mousedown", onOutsidePress, true);
  }, 0);

  row.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    open();
  });

  return {
    handleKey(event: KeyboardEvent): boolean {
      if (!alive) return false;
      if (event.key === "Escape") {
        dismiss();
        return true;
      }
      if (event.key === "Enter") {
        open();
        return true;
      }
      return false;
    },
    setQuery(): void {},
    reposition(): void {
      if (alive) shell.reposition();
    },
    dismiss,
  };
}
