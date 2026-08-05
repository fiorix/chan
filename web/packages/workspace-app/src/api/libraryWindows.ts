// The command deck's library-window actions, branched for chan-desktop.
//
// A browser manages these windows itself: open a popup, point it at the new
// window's launch path, focus it. chan-desktop cannot. `window.open` returns
// null in every chan webview, and the scoped HTTP action mints a
// browser-origin record whose native twin the desktop's window watcher
// deliberately never opens, so a desktop branch that only skipped the popup
// would create records with no window behind them.
//
// So the two surfaces need genuinely different mechanisms, not one mechanism
// with a guard: on desktop the native host mints and raises, on the browser
// the popup dance stays exactly as it was. This module owns that split so it
// can be driven directly by tests, rather than only through the deck UI.

import { clearClonedSessionDeckDrafts } from "@chan/web-shared/command-deck";
import {
  blockedWindowMessage,
  createNativeLibraryWindow,
  focusNativeLibraryWindow,
  isTauriDesktop,
} from "./desktop";
import type {
  ScopedLibraryAction,
  ScopedLibraryActionResult,
  ScopedLibraryWindow,
} from "./libraryCommand";

/// The two actions that bring a new library window into being.
export type CreateLibraryWindowAction =
  | { action: "new_terminal" }
  | { action: "new_workspace_window"; workspace_id: string };

/// What these functions need from the surface that hosts them. Injected rather
/// than imported so the deck keeps ownership of its capability lifecycle and
/// its snapshot state, and so the branch is testable without mounting the deck.
export interface LibraryWindowBridge {
  /// POST a scoped action to the library that serves this window.
  runAction: (action: ScopedLibraryAction) => Promise<ScopedLibraryActionResult | undefined>;
  /// Re-read the scoped snapshot after a mutation.
  refresh: () => Promise<void>;
  /// This window's own library window id, so a self-targeting action reuses
  /// this window instead of asking for a second handle on it.
  currentWindowId: () => string;
}

function popupFor(window: ScopedLibraryWindow, bridge: LibraryWindowBridge): Window {
  if (window.window_id === bridge.currentWindowId()) return globalThis.window;
  const popup = globalThis.window.open("", window.window_id);
  if (!popup) throw new Error(blockedWindowMessage("The browser blocked the Chan window"));
  return popup;
}

function popupNeedsNavigation(popup: Window): boolean {
  try {
    return popup.location.href === "about:blank" || popup.location.href === "";
  } catch {
    return true;
  }
}

/// Create a terminal or workspace window in this window's library.
export async function createLibraryWindow(
  bridge: LibraryWindowBridge,
  action: CreateLibraryWindowAction,
): Promise<void> {
  if (isTauriDesktop()) {
    // The native mint is the whole action: it produces a native-origin record
    // and the window watcher opens the OS window from it. Running the scoped
    // HTTP action as well would mint a second, browser-origin record that
    // nothing ever opens.
    await createNativeLibraryWindow(
      action.action === "new_terminal" ? "terminal" : "workspace",
      action.action === "new_terminal" ? null : action.workspace_id,
    );
    await bridge.refresh();
    return;
  }
  // Must happen before the first await so keyboard activation retains the
  // browser's popup grant.
  const popup = globalThis.window.open("", "_blank");
  if (!popup) throw new Error(blockedWindowMessage("The browser blocked the new Chan window"));
  clearClonedSessionDeckDrafts(popup);
  try {
    const result = await bridge.runAction(action);
    if (!result?.window) throw new Error("Chan did not return the new window");
    popup.name = result.window.window_id;
    popup.location.href = result.window.launch_path;
    popup.focus();
    await bridge.refresh();
  } catch (error) {
    popup.close();
    throw error;
  }
}

/// Bring an existing library window to the front, un-hiding it if needed.
export async function focusLibraryWindow(
  bridge: LibraryWindowBridge,
  window: ScopedLibraryWindow,
): Promise<void> {
  if (isTauriDesktop()) {
    // The native command persists the un-hide as part of raising, so this path
    // does not also send the scoped visibility action: one authority, not two
    // that can disagree.
    await focusNativeLibraryWindow(window.window_id);
    await bridge.refresh();
    return;
  }
  const popup = popupFor(window, bridge);
  if (window.hidden && window.can_act) {
    await bridge.runAction({
      action: "set_window_visibility",
      window_id: window.window_id,
      hidden: false,
    });
  }
  if (popup !== globalThis.window && popupNeedsNavigation(popup)) {
    popup.location.href = window.launch_path;
  }
  popup.focus();
  await bridge.refresh();
}

/// Hide a library window, or close it outright.
export async function buryLibraryWindow(
  bridge: LibraryWindowBridge,
  window: ScopedLibraryWindow,
  close: boolean,
): Promise<void> {
  const action: ScopedLibraryAction = close
    ? { action: "close_window", window_id: window.window_id }
    : { action: "set_window_visibility", window_id: window.window_id, hidden: true };
  if (isTauriDesktop()) {
    // No native command needed: both mutations make the record fail the
    // watcher's show test, and the reconcile closes the OS window. The browser
    // path needs a handle only because it has to close the popup itself, and
    // acquiring one here would throw on the null `window.open` returns.
    await bridge.runAction(action);
    await bridge.refresh();
    return;
  }
  // Acquiring the named context is also synchronous for keyboard popup rules.
  // If no such window exists the browser creates a blank one, which is closed
  // after the server mutation.
  const popup = popupFor(window, bridge);
  await bridge.runAction(action);
  popup.close();
  if (popup !== globalThis.window) await bridge.refresh();
}
