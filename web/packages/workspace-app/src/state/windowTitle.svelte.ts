// The browser tab title and the window tab bar's title for THIS window.
//
// A browser's tab is titled the way the launcher names the window's row: the
// generated name and the caption, "Terminal Window 2 [deploy shell]".
// Composition is the shared `windowDisplayName`; what lives here is where the
// naming fields come from. chan-desktop titles the OS window with the machine
// before that name, an arrow and "local" or the devserver's name, and for a
// workspace window the workspace too ("local / chan Window 1").
//
// The workspace app has no view of the window feed: its only library access is
// the short-lived, presence-bound command capability. So the naming fields are
// read from that snapshot when first needed (at boot in a browser and, on the
// desktop, when the window tab bar needs them for its title), and the caption
// is kept current afterwards by the targeted `window_labeled` frame the server
// pushes to this window's own socket on every surface (store.svelte.ts routes
// it here). `kind` and `ordinal` are library-owned and fixed for a window's
// life, so one read is enough for them.
//
// Only a browser's document title follows the naming fields. A chan-desktop
// window's name is its OS titlebar, which the window watcher retitles, so its
// document keeps the static title. In title bar tab mode the title bar hides
// that title, so the desktop sends it to the page (`windowTabBar.title`) and
// the window tab bar shows it; it names the devserver as no naming field can.
// The fields give the bar its privacy form and stand in where no title has
// arrived. A browser has no such title, so a bar forced on there names the
// window as Computers does.
//
// A window with no reachable library record (a capability mint that fails, a
// plain browser tab that never had a record) simply keeps the document's static
// title. The tab title is a convenience, never a correctness surface, so every
// failure here is silent.

import { windowDisplayName, type WindowKind } from "@chan/web-shared/window-label";
import { privacy } from "@chan/web-shared/privacy";
import { sessionWindowId } from "../api/client";
import { isTauriDesktop } from "../api/desktop";
import { loadScopedLibrarySnapshot } from "../api/libraryCommand";
import { windowTabBar } from "./windowTabBar.svelte";

interface WindowNaming {
  kind: WindowKind;
  ordinal: number;
  label: string;
  control: boolean;
}

let naming = $state<WindowNaming | null>(null);
let pending: Promise<void> | null = null;
let latestLabel: string | undefined;

/**
 * The window tab bar's title for this window: the title chan-desktop gives it
 * when the desktop has sent one, else the launcher's name for it; unknown
 * until one of them is. Privacy mode drops the caption and shows the
 * generated name alone, or a control terminal's fixed name, which holds
 * nothing to conceal.
 */
export function windowName(): string | null {
  // The page's own setting decides rather than the desktop's mask: the title
  // held from before privacy mode turned on is the full one until the masked
  // one arrives.
  if (privacy.enabled) return naming ? windowDisplayName({ ...naming, label: "" }) : null;
  if (windowTabBar.title !== "") return windowTabBar.title;
  return naming ? windowDisplayName(naming) : null;
}

export function refreshWindowTitle(): void {
  if (typeof document === "undefined") return;
  if (privacy.enabled) document.title = "Chan (privacy mode)";
  // A desktop document keeps the static title even once the window tab bar
  // has loaded the naming fields (see above).
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
  if (!pending) {
    // The server stores a caption before it sends the frame, so a read that
    // starts after a frame sees that caption or a newer one: only a frame
    // heard during this read outranks its snapshot.
    latestLabel = undefined;
    pending = readWindowNaming().finally(() => {
      pending = null;
    });
  }
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
