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
import { hostVocabulary, isAclRefusal } from "./nativeVocabulary";
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

/// Invoke a native library-window command, and describe a withheld one in
/// terms of the app instead of Tauri's vocabulary.
///
/// Running inside a Tauri webview does not mean this app grants this command.
/// A gateway-served window is delivered by the remote devserver while the ACL
/// gating its invokes belongs to the chan-desktop installed on this machine,
/// so the page and the ACL are independently versioned and the page can call a
/// command the app has never heard of. A local window cannot skew that way,
/// because chan-desktop embeds the bundle it serves.
///
/// There is no fallback to route to: `window.open` returns null in every chan
/// webview, which is the reason the native path exists at all. So what the
/// user is told is the entire remedy.
///
/// What can be said depends on what the app can say. An app that advertises
/// its vocabulary (`hostVocabulary`) turns a missing command into a definite
/// version statement before any invoke, and turns a refusal of a command it
/// DOES advertise into an authorization statement, because those call for
/// different actions. An app that cannot say leaves only the thrown refusal,
/// and a release build collapses every rejection shape into one string, so
/// that message has to hold for the whole class: a command the app has never
/// heard of, and one it grants but not for this window. Version skew is named
/// as the likely cause rather than the certain one for that reason. What is
/// certain, and worth saying because the deck offers a retry, is that
/// repeating the action cannot change the answer.
async function invokeNative(
  command: string,
  attempt: string,
  invoke: () => Promise<void>,
): Promise<void> {
  const vocabulary = await hostVocabulary();
  if (vocabulary && !vocabulary.has(command)) {
    console.error(`[chan-desktop] ${command} absent from the app's advertised vocabulary`);
    throw new Error(
      `chan-desktop cannot ${attempt}: the installed app does not have this action. ` +
        "The app and the page it is showing are different builds; update chan-desktop. " +
        "Retrying will not help.",
    );
  }
  try {
    await invoke();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isAclRefusal(command, message)) {
      throw new Error(`chan-desktop could not ${attempt}: ${message}`);
    }
    // Which command was withheld is the first thing a report of this needs and
    // the last thing the user has any use for, so it goes to the console.
    console.error(`[chan-desktop] ${command} withheld by the app ACL`, message);
    if (vocabulary?.has(command)) {
      throw new Error(
        `chan-desktop cannot ${attempt}: the installed app grants this action but refused ` +
          "it for this window. That is an authorization problem, not a version " +
          "difference; updating chan-desktop will not change the answer, and neither " +
          "will retrying.",
      );
    }
    throw new Error(
      `chan-desktop cannot ${attempt}: the installed app refused this action. ` +
        "A window served over the gateway is driven by the chan-desktop installed on this " +
        "machine, which can be older than the page it is showing; if it is, update " +
        "chan-desktop. Retrying will not help.",
    );
  }
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
    await invokeNative(
      "create_library_window",
      action.action === "new_terminal"
        ? "open a new terminal window"
        : "open a new workspace window",
      () =>
        createNativeLibraryWindow(
          action.action === "new_terminal" ? "terminal" : "workspace",
          action.action === "new_terminal" ? null : action.workspace_id,
        ),
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
    await invokeNative("focus_library_window", "bring that window to the front", () =>
      focusNativeLibraryWindow(window.window_id),
    );
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
