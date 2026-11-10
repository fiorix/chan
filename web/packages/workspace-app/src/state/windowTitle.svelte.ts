// The browser tab title and pane tree's window name for THIS window.
//
// The tab is titled the same way the launcher names the row and chan-desktop
// titles the OS window -- "Terminal Window 2 [deploy shell]" -- so one window
// reads identically wherever it is named. Composition is the shared
// `windowDisplayName`; what lives here is where the naming fields come from.
//
// The workspace app has no view of the window feed: its only library access is
// the short-lived, presence-bound command capability. So the naming fields are
// read from that snapshot when first needed (at boot in a browser, at the pane
// tree's first open in title bar tab mode on the desktop; a failed read is
// tried again at the next open), and the caption is kept current afterwards by
// the targeted `window_labeled` frame the server pushes to this window's own
// socket on every surface (store.svelte.ts routes it here). `kind` and
// `ordinal` are library-owned and fixed for a window's life, so one read is
// enough for them.
//
// Only a browser's document title follows the naming fields. A chan-desktop
// window's name is its OS titlebar, which the window watcher retitles, so its
// document keeps the static title and the fields serve the pane tree alone.
//
// A window with no reachable library record (a capability mint that fails, a
// plain browser tab that never had a record) simply keeps the document's static
// title. The tab title is a convenience, never a correctness surface, so every
// failure here is silent.

import { rowLabel, windowDisplayName, type WindowKind } from "@chan/web-shared/window-label";
import { privacy, privateText } from "@chan/web-shared/privacy";
import { sessionWindowId } from "../api/client";
import { isTauriDesktop } from "../api/desktop";
import { loadScopedLibrarySnapshot } from "../api/libraryCommand";

interface WindowNaming {
  kind: WindowKind;
  ordinal: number;
  label: string;
  control: boolean;
}

let naming = $state<WindowNaming | null>(null);
let pending: Promise<void> | null = null;
let latestLabel: string | undefined;

/** The launcher's window name, including its privacy fallback; unknown until loaded. */
export function windowName(): string | null {
  return naming ? privateText(windowDisplayName(naming), rowLabel(naming.kind, naming.ordinal)) : null;
}

export function refreshWindowTitle(): void {
  if (typeof document === "undefined") return;
  if (privacy.enabled) document.title = "Chan (privacy mode)";
  // A desktop document keeps the static title even once the pane tree has
  // loaded the naming fields (see above).
  else if (!isTauriDesktop() && naming) document.title = windowDisplayName(naming);
  else document.title = "Chan";
}

/**
 * Read this window's naming fields from the scoped library snapshot and title
 * the tab. Safe to call when no library is reachable: the title is left alone.
 */
export async function initWindowTitle(): Promise<void> {
  // A chan-desktop webview shows no tab title -- its name is the OS titlebar,
  // which the window watcher owns. Minting a library capability per window for
  // a string nobody can see is pure cost.
  if (isTauriDesktop()) return;
  await loadWindowTitle();
  if (naming) refreshWindowTitle();
}

/** Load the naming fields on demand, sharing an in-flight read and retrying a failed one. */
export function loadWindowTitle(): Promise<void> {
  if (naming) return Promise.resolve();
  if (!pending) pending = readWindowNaming().finally(() => { pending = null; });
  return pending;
}

async function readWindowNaming(): Promise<void> {
  try {
    const snapshot = await loadScopedLibrarySnapshot();
    const me = snapshot.windows.find((w) => w.window_id === sessionWindowId());
    if (!me) return;
    naming = {
      kind: me.kind,
      ordinal: me.ordinal,
      // A rename delivered while the snapshot was in flight is newer.
      label: latestLabel ?? me.label ?? "",
      control: me.control,
    };
  } catch {
    // No capability, no library, or no live presence yet. The static title
    // stands; there is nothing for the user to act on.
  }
}

/** The leader retitled this window from the launcher. */
export function applyWindowLabel(label: string): void {
  latestLabel = label;
  if (!naming) return;
  naming.label = label;
  refreshWindowTitle();
}

/** Test reset. */
export function __resetWindowTitle(): void {
  naming = null;
  pending = null;
  latestLabel = undefined;
}
