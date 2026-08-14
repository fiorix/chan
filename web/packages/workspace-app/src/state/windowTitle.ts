// The browser tab title for THIS window.
//
// The tab is titled the same way the launcher names the row and chan-desktop
// titles the OS window -- "Terminal Window 2 [deploy shell]" -- so one window
// reads identically wherever it is named. Composition is the shared
// `windowDisplayName`; what lives here is where the naming fields come from.
//
// The workspace app has no view of the window feed: its only library access is
// the short-lived, presence-bound command capability. So the naming fields are
// read once from that snapshot at boot, and the caption is kept current
// afterwards by the targeted `window_labeled` frame the server pushes to this
// window's own socket (store.svelte.ts routes it here). `kind` and `ordinal` are
// library-owned and fixed for a window's life, so the boot read is enough for
// them.
//
// A window with no reachable library record (a capability mint that fails, a
// plain browser tab that never had a record) simply keeps the document's static
// title. The tab title is a convenience, never a correctness surface, so every
// failure here is silent.

import { windowDisplayName, type WindowKind } from "@chan/web-shared/window-label";
import { sessionWindowId } from "../api/client";
import { isTauriDesktop } from "../api/desktop";
import { loadScopedLibrarySnapshot } from "../api/libraryCommand";

interface WindowNaming {
  kind: WindowKind;
  app?: "files";
  ordinal: number;
  label: string;
  control: boolean;
}

let naming: WindowNaming | null = null;

function render(): void {
  if (!naming || typeof document === "undefined") return;
  document.title = windowDisplayName(naming);
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
  try {
    const snapshot = await loadScopedLibrarySnapshot();
    const me = snapshot.windows.find((w) => w.window_id === sessionWindowId());
    if (!me) return;
    naming = {
      kind: me.kind,
      app: me.app,
      ordinal: me.ordinal,
      label: me.label ?? "",
      control: me.control,
    };
    render();
  } catch {
    // No capability, no library, or no live presence yet. The static title
    // stands; there is nothing for the user to act on.
  }
}

/** The leader retitled this window from the launcher. */
export function applyWindowLabel(label: string): void {
  if (!naming) return;
  naming.label = label;
  render();
}

/** Test reset. */
export function __resetWindowTitle(): void {
  naming = null;
}
