import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { notify } from "../state/notify.svelte";
import { copyTextToClipboard, openGraphFromLink } from "../state/store.svelte";
import { GRAPH_LINK_PREFIX } from "../state/tabs.svelte";

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

const OPENABLE_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

type TauriWindow = Window &
  typeof globalThis & {
    __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> };
    __TAURI__?: {
      invoke?: (cmd: string, args?: unknown) => Promise<unknown>;
      core?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> };
      opener?: { openUrl?: (url: string) => Promise<unknown> };
    };
  };

export function isOpenableExternalUrl(url: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim())?.[1]?.toLowerCase();
  return scheme ? OPENABLE_SCHEMES.has(scheme) : false;
}

/// Best-effort handoff to the desktop opener. Returns true when the
/// call resolved; false when neither bridge was present or the call
/// threw (capability denied, no default browser, no app handler for
/// the scheme). Errors are logged to the console for debugging - the
/// caller decides what the user sees.
async function tryTauriOpen(w: TauriWindow, url: string): Promise<boolean> {
  try {
    if (typeof w.__TAURI__?.opener?.openUrl === "function") {
      await w.__TAURI__.opener.openUrl(url);
      return true;
    }
    const invoke =
      w.__TAURI_INTERNALS__?.invoke ??
      w.__TAURI__?.core?.invoke ??
      w.__TAURI__?.invoke;
    if (invoke) {
      await invoke("plugin:opener|open_url", { url });
      return true;
    }
  } catch (err) {
    console.warn("openExternalUrl: Tauri opener failed", err);
  }
  return false;
}

/// Fallback after a desktop opener failure: copy the URL to the
/// clipboard so the user can paste it manually, then surface a plain-
/// English status message. Never falls back to window.open inside a
/// Tauri webview - that would open the URL inside Chan.app's own
/// shell, pollute its session, and defeat "external".
async function copyAndNotifyFailure(url: string): Promise<void> {
  let copied = false;
  await copyTextToClipboard(url, {
    onSuccess: () => {
      copied = true;
    },
    onError: (msg) => console.warn("openExternalUrl: clipboard write failed", msg),
  });
  notify(
    copied
      ? "Couldn't open link in browser - URL copied to clipboard"
      : `Couldn't open link in browser - ${url}`,
  );
}

export async function openExternalUrl(url: string): Promise<boolean> {
  if (!isOpenableExternalUrl(url)) return false;
  const w = window as TauriWindow;
  // Detect the Tauri webview by either of the runtime globals.
  // Chan.app ships tauri-plugin-opener; the local desktop process
  // is the one that should call out to the OS browser so tunnelled
  // sessions still open links on the user's machine.
  const inTauri = Boolean(w.__TAURI__ || w.__TAURI_INTERNALS__);
  if (inTauri) {
    const ok = await tryTauriOpen(w, url);
    if (!ok) await copyAndNotifyFailure(url);
    return ok;
  }
  // Web build: open a new browser tab. The browser handles popup-
  // blocking on its end; nothing to fall back to here.
  window.open(url, "_blank", "noopener,noreferrer");
  return true;
}

/// The openable external URL under the given viewport coordinates, or
/// null. Backs the body-context menu's "Open link" / "Copy link" entries:
/// the menu opens at the right-click point, so it resolves the URL from
/// those coordinates rather than the caret.
export function externalUrlAtCoords(
  view: EditorView,
  x: number,
  y: number,
): string | null {
  const pos = view.posAtCoords({ x, y });
  if (pos === null) return null;
  return externalUrlAtPos(view.state, pos);
}

export function externalUrlAtPos(state: EditorState, pos: number): string | null {
  for (const side of [-1, 0, 1] as const) {
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side);
    while (node) {
      const url = externalUrlForNode(state, node);
      if (url) return url;
      node = node.parent;
    }
  }
  return null;
}

export function externalLinkClickHandler() {
  return EditorView.domEventHandlers({
    click(event, view) {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(".cm-md-link, .cm-md-link-url")) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      // In-app `chan://graph?...` links (pasted from a graph tab's "Copy
      // link to graph") open the graph tab rather than navigating out.
      // Checked before the external-URL path because `chan:` is not an
      // openable external scheme, so externalUrlAtPos would drop it.
      const raw = linkUrlAtPos(view.state, pos);
      if (raw?.startsWith(GRAPH_LINK_PREFIX) && openGraphFromLink(raw)) {
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      const url = externalUrlAtPos(view.state, pos);
      if (!url) return false;
      event.preventDefault();
      event.stopPropagation();
      void openExternalUrl(url);
      return true;
    },
  });
}

/// Raw URL string of the link / autolink / naked-URL under `pos`, any
/// scheme and unfiltered. Backs in-app scheme handling (e.g. the
/// `chan://graph?...` graph links) that the openable-external path
/// intentionally ignores. Image URLs are excluded (an image is not a
/// navigable link).
export function linkUrlAtPos(state: EditorState, pos: number): string | null {
  for (const side of [-1, 0, 1] as const) {
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side);
    while (node) {
      const url = rawUrlForNode(state, node);
      if (url) return url;
      node = node.parent;
    }
  }
  return null;
}

function externalUrlForNode(state: EditorState, node: SyntaxNode): string | null {
  const raw = rawUrlForNode(state, node);
  return raw ? openableUrl(raw) : null;
}

function rawUrlForNode(state: EditorState, node: SyntaxNode): string | null {
  if (node.name === "Link" || node.name === "Autolink") {
    return rawUrlFromChild(state, node);
  }
  if (node.name !== "URL") return null;
  const parent = node.parent;
  if (parent?.name === "Image") return null;
  if (parent?.name === "Link" || parent?.name === "Autolink") {
    return rawUrlFromChild(state, parent);
  }
  return state.doc.sliceString(node.from, node.to).trim();
}

function rawUrlFromChild(state: EditorState, node: SyntaxNode): string | null {
  const cursor = node.cursor();
  if (!cursor.firstChild()) return null;
  do {
    if (cursor.name === "URL") {
      return state.doc.sliceString(cursor.from, cursor.to).trim();
    }
  } while (cursor.nextSibling());
  return null;
}

function openableUrl(url: string): string | null {
  const trimmed = url.trim();
  return isOpenableExternalUrl(trimmed) ? trimmed : null;
}
