/// Runtime detection + Tauri IPC dispatch for chan-desktop.
///
/// chan ships as both a browser SPA (served by chan-server over
/// http) and a chan-desktop Tauri webview. Most UX is identical
/// across the two; this module is the bridge where surfaces
/// need to dispatch differently (window reload, DevTools, etc.).

import {
  beginTransfer,
  cancelTransfer,
  failTransfer,
  finishTransfer,
  setTransferProgress,
  waitForTransferSlot,
} from "../state/transfers.svelte";
import { withTokenQuery } from "./client";

type TauriWindow = Window &
  typeof globalThis & {
    __TAURI_INTERNALS__?: {
      invoke?: (cmd: string, args?: unknown) => Promise<unknown>;
    };
    __TAURI__?: {
      invoke?: (cmd: string, args?: unknown) => Promise<unknown>;
      core?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> };
    };
  };

/// True when running inside chan-desktop's Tauri webview.
///
/// Tauri 2 injects `window.__TAURI_INTERNALS__`; older Tauri
/// versions injected `window.__TAURI__`. Either global means
/// the SPA is hosted by a Tauri webview.
export function isTauriDesktop(): boolean {
  const w = window as TauriWindow;
  return Boolean(w.__TAURI__ || w.__TAURI_INTERNALS__);
}

/// Thin wrapper over Tauri's invoke. Resolves whichever invoke
/// shape the running Tauri version exposes. Throws when called
/// outside a Tauri webview so callers can branch on
/// `isTauriDesktop()` before dispatching.
export async function tauriInvoke<T = unknown>(
  cmd: string,
  args?: unknown,
): Promise<T> {
  const w = window as TauriWindow;
  const invoke =
    w.__TAURI_INTERNALS__?.invoke ??
    w.__TAURI__?.core?.invoke ??
    w.__TAURI__?.invoke;
  if (!invoke) throw new Error(`tauriInvoke(${cmd}): not running under Tauri`);
  return (await invoke(cmd, args)) as T;
}

/// Read clipboard text without tripping WebKit's DOM-paste "Paste" button.
///
/// In chan-desktop's WKWebView, any programmatic clipboard read via
/// `navigator.clipboard.readText()` pops a native "Paste" permission
/// button the user must click (a WebKit privacy feature with no JS
/// opt-out). So on desktop we read it natively in Rust through the
/// `read_clipboard_text` IPC, which goes straight to the OS clipboard
/// and never shows the button. On web `navigator.clipboard.readText()`
/// is fine -- it is gesture-permitted and shows no persistent button in
/// Chrome. Returns "" when the clipboard holds no text or the read fails
/// (the caller treats empty as "nothing to paste"). Note Cmd+V does NOT
/// use this: it rides xterm's native paste event (the user's own paste
/// gesture), which is buttonless everywhere -- this is only for the
/// right-click menu's "Paste", where no paste gesture exists.
export async function readClipboardText(): Promise<string> {
  if (isTauriDesktop()) {
    try {
      return await tauriInvoke<string>("read_clipboard_text");
    } catch (err) {
      console.warn("readClipboardText: read_clipboard_text IPC failed", err);
    }
  }
  return (await navigator.clipboard?.readText()) ?? "";
}

/// Write clipboard text without needing a user gesture (the OSC 52 path).
///
/// An OSC 52 copy sequence arrives from the PTY with no user gesture, and
/// chan-desktop's WKWebView can reject a gesture-less
/// `navigator.clipboard.writeText()`. So on desktop we write it natively in
/// Rust through the `write_clipboard_text` IPC, which goes straight to the OS
/// clipboard and never needs a gesture. On web `navigator.clipboard.writeText()`
/// is the only option -- it is gesture-permitted in a foreground tab, which is
/// where the terminal lives. Best-effort: a failed native IPC logs and falls
/// back to the web API so the copy still has a chance to land.
export async function writeClipboardText(text: string): Promise<void> {
  if (isTauriDesktop()) {
    try {
      await tauriInvoke<void>("write_clipboard_text", { text });
      return;
    } catch (err) {
      console.warn("writeClipboardText: write_clipboard_text IPC failed", err);
    }
  }
  await navigator.clipboard?.writeText(text);
}

/// Write a PNG image onto the OS clipboard on desktop (`cs copy` of an
/// image). chan-desktop's WKWebView rejects a gesture-less
/// `navigator.clipboard.write()`, and `cs copy` arrives from a control
/// command with no user gesture, so on desktop we hand the PNG bytes to the
/// native `write_clipboard_image` IPC (arboard). Only meaningful on desktop;
/// the web path uses `navigator.clipboard.write` directly in the caller.
export async function writeClipboardImage(pngBytes: Uint8Array): Promise<void> {
  // Tauri serializes a Uint8Array to a number[] for a Vec<u8> arg.
  await tauriInvoke<void>("write_clipboard_image", { bytes: Array.from(pngBytes) });
}

/// Read a PNG image off the OS clipboard on desktop (`cs paste` of an image),
/// as raw PNG bytes. Returns `null` when the clipboard holds no image. Native
/// arboard read (`read_clipboard_image`) so it never trips WKWebView's paste
/// button, mirroring `readClipboardText`.
export async function readClipboardImage(): Promise<Uint8Array | null> {
  const bytes = await tauriInvoke<number[] | null>("read_clipboard_image");
  return bytes ? new Uint8Array(bytes) : null;
}

/// Write HTML (with a plain-text fallback) onto the OS clipboard on desktop
/// (`cs copy --html`). Native arboard HTML setter so a real browser reading
/// the OS clipboard (a paste into Gmail) keeps the formatting.
export async function writeClipboardHtml(html: string, altText: string): Promise<void> {
  await tauriInvoke<void>("write_clipboard_html", { html, altText });
}

/// Read HTML off the OS clipboard on desktop (`cs paste --html`). Returns
/// `null` when the clipboard holds no HTML. Native arboard read.
export async function readClipboardHtml(): Promise<string | null> {
  return await tauriInvoke<string | null>("read_clipboard_html");
}

/// Absolute paths of the OS files currently on the macOS drag
/// pasteboard (the `read_dropped_paths` IPC). Only meaningful when
/// called from inside a `drop` event handler -- the drag pasteboard
/// persists until the next drag starts. Returns `[]` in a plain
/// browser, on non-macOS desktops, when the pasteboard holds no file
/// items, or when the ACL refuses the command (remote-served window
/// kinds don't get it) -- every failure degrades to a silent no-op so
/// the drop guard's no-takeover guarantee is all that remains.
export async function readDroppedPaths(): Promise<string[]> {
  if (!isTauriDesktop()) return [];
  try {
    return await tauriInvoke<string[]>("read_dropped_paths");
  } catch {
    // ACL refusal (tunnel/outbound windows) or pre-IPC desktop build.
    return [];
  }
}

/// Reload the chan window. On chan-desktop calls the
/// `reload_window` IPC which fires `WebviewWindow::reload()`.
/// Falls back to `window.location.reload()` on web or on IPC
/// failure so the user still gets the reload they asked for.
export async function reloadWindow(): Promise<void> {
  if (isTauriDesktop()) {
    try {
      await tauriInvoke("reload_window");
      return;
    } catch (err) {
      console.warn(
        "reloadWindow: reload_window IPC failed, falling back",
        err,
      );
    }
  }
  window.location.reload();
}

/// Open another window for the invoking desktop window's connection.
/// No-op off-desktop, where the browser owns its own window lifecycle.
/// Best-effort: a failed IPC logs and leaves the current window as-is.
export async function openNewWindow(): Promise<void> {
  if (!isTauriDesktop()) return;
  try {
    await tauriInvoke("open_new_window");
  } catch (err) {
    console.warn("openNewWindow: open_new_window IPC failed", err);
  }
}

/// Close the current workspace window and return focus to the
/// launcher (the native-desktop workspace list). Called when the
/// last tab and then the last empty pane are closed. No-op
/// off-desktop: the browser owns its own window/tab lifecycle.
/// Best-effort: a failed IPC logs and leaves the window as-is
/// rather than throwing into the keymap.
export async function requestCloseWindow(): Promise<void> {
  if (!isTauriDesktop()) return;
  try {
    await tauriInvoke("request_close_window");
  } catch (err) {
    console.warn("requestCloseWindow: request_close_window IPC failed", err);
  }
}

/// Bury (hide, don't destroy) THIS workspace window: the Hide answer to the
/// desktop close-confirm overlay. The OS red-dot already fired and the host
/// prevented the close and asked the SPA; picking Hide invokes the
/// `hide_window_from_close_confirm` command, which buries the window (its
/// sessions stay warm, reopenable from the Window menu) instead of destroying
/// it. No-op off-desktop (the overlay is desktop-only by construction). INERT if
/// the ACL withholds the command (best-effort: a failed IPC logs and leaves the
/// window as-is rather than throwing into the overlay).
export async function hideWindowFromCloseConfirm(): Promise<void> {
  if (!isTauriDesktop()) return;
  try {
    await tauriInvoke("hide_window_from_close_confirm");
  } catch (err) {
    console.warn(
      "hideWindowFromCloseConfirm: hide_window_from_close_confirm IPC failed",
      err,
    );
  }
}

/// Abandon the devserver backing THIS workspace window: tell the desktop to
/// disconnect it. Called by the disconnect overlay's Abandon button on a
/// devserver-backed desktop window whose watcher channel has dropped. The desktop
/// resolves which devserver this window belongs to (from its window label), shows
/// the launcher, and drives the disconnect; the window then closes async via the
/// watcher. Throws on IPC/ACL failure so the reconnect overlay can surface a
/// visible error instead of leaving the action silent.
export async function abandonDevserverForWindow(): Promise<void> {
  if (!isTauriDesktop()) throw new Error("not running under Tauri");
  try {
    await tauriInvoke("abandon_devserver_for_window");
  } catch (err) {
    console.warn(
      "abandonDevserverForWindow: abandon_devserver_for_window IPC failed",
      err,
    );
    throw err;
  }
}

/// Reconnect the devserver backing THIS workspace window: tell the desktop to
/// force-close the (dead) control terminal and re-run the connect flow. Called
/// by the disconnect overlay's Reconnect button on a devserver-backed desktop
/// window. The desktop resolves which devserver this window belongs to (from
/// its window label). Throws on IPC/ACL failure so the reconnect overlay can
/// surface a visible error instead of leaving the action silent.
export async function reconnectDevserverForWindow(): Promise<void> {
  if (!isTauriDesktop()) throw new Error("not running under Tauri");
  try {
    await tauriInvoke("reconnect_devserver_for_window");
  } catch (err) {
    console.warn(
      "reconnectDevserverForWindow: reconnect_devserver_for_window IPC failed",
      err,
    );
    throw err;
  }
}

/// Drive the chan-desktop native window in or out of fullscreen. WKWebView
/// on macOS disables the HTML element Fullscreen API (`element.requestFullscreen()`
/// rejects), so the slide player's "play" mode cannot go fullscreen through the
/// DOM there. Instead it drives the native window through Tauri's built-in
/// `core:window` `set_fullscreen` command (the `plugin:window|set_fullscreen`
/// channel, `value` = the desired state, no `label` so it targets the calling
/// window). The `workspace` capability grants `core:window:allow-set-fullscreen`.
/// No-op off-desktop: the browser slide player keeps `element.requestFullscreen()`.
/// Best-effort: a failed IPC (e.g. a tunnel-origin devserver window whose remote
/// ACL withholds the command) logs and leaves the window as-is, so the player
/// still opens in-window rather than throwing into the slide keymap.
export async function setWindowFullscreen(on: boolean): Promise<void> {
  if (!isTauriDesktop()) return;
  try {
    await tauriInvoke("plugin:window|set_fullscreen", { value: on });
  } catch (err) {
    console.warn("setWindowFullscreen: set_fullscreen IPC failed", err);
  }
}

/// Open the platform's web inspector. On chan-desktop calls the
/// `open_devtools` IPC. On web returns false so the caller can
/// surface a hint pointing the user at the browser's built-in
/// DevTools.
export async function openWebInspector(): Promise<boolean> {
  if (!isTauriDesktop()) return false;
  try {
    await tauriInvoke("open_devtools");
    return true;
  } catch (err) {
    console.warn("openWebInspector: open_devtools IPC failed", err);
    return false;
  }
}

interface NativeTransferStatus {
  loaded: number;
  total: number | null;
}

function nativeTransferId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ? `native-${random}` : `native-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pollNativeProgress(nativeId: string, transferId: string): () => void {
  let stopped = false;
  let polling = false;
  const poll = async (): Promise<void> => {
    if (stopped || polling) return;
    polling = true;
    try {
      const status = await tauriInvoke<NativeTransferStatus | null>(
        "native_transfer_status",
        { transferId: nativeId },
      );
      if (status) {
        const fraction =
          status.total !== null && status.total > 0
            ? Math.min(1, status.loaded / status.total)
            : null;
        setTransferProgress(transferId, fraction);
      }
    } catch {
      // The main invoke owns the error surface. A missed progress poll is
      // harmless and must not fail an otherwise healthy transfer.
    } finally {
      polling = false;
    }
  };
  void poll();
  const timer = window.setInterval(() => void poll(), 100);
  return () => {
    stopped = true;
    window.clearInterval(timer);
  };
}

/// Desktop-native download for the inspector's Download button. Rust performs
/// the authenticated same-origin request and streams it to a temp file; the
/// webview sees only bounded progress snapshots and the final saved path.
///
/// `url` is the absolute tokenized download URL (the caller computes it
/// from `api.downloadUrl(path)` resolved against `window.location`).
/// `filename` is the suggested name (the FileTree `downloadFilename`).
/// Resolves to the saved absolute path on success; rejects on error.
/// The store carries progress / cancel / savedPath / error so the
/// inspector can render the indicator without re-deriving anything.
export async function runDesktopDownload(
  url: string,
  filename: string,
  source: { path: string; isDir: boolean } | null = null,
): Promise<string> {
  if (!isTauriDesktop()) {
    throw new Error("runDesktopDownload called outside chan-desktop");
  }
  const nativeId = nativeTransferId();
  const cancel = (): void => {
    void tauriInvoke<boolean>("cancel_native_transfer", { transferId: nativeId });
  };
  const xferId = beginTransfer({
    kind: "download",
    filename,
    cancel,
    source,
  });
  let stopProgress: (() => void) | null = null;
  try {
    if (!(await waitForTransferSlot(xferId))) {
      throw new Error("download cancelled");
    }
    stopProgress = pollNativeProgress(nativeId, xferId);
    const saved = await tauriInvoke<{ path: string }>("download_file_native", {
      transferId: nativeId,
      url,
      filename,
    });
    finishTransfer(xferId, saved.path);
    return saved.path;
  } catch (err) {
    const message = errorMessage(err);
    if (message.includes("download cancelled")) cancelTransfer(xferId);
    else {
      const retry = source
        ? () => {
            void runDesktopDownload(url, filename, source).catch(() => {});
          }
        : null;
      failTransfer(xferId, message, retry);
    }
    throw err instanceof Error ? err : new Error(message);
  } finally {
    stopProgress?.();
  }
}

export interface NativeUploadedFile {
  path: string;
  size: number;
}

export async function runDesktopUpload(
  target: { dir?: string; path?: string; multiple: boolean },
  label: string,
): Promise<NativeUploadedFile[]> {
  if (!isTauriDesktop()) {
    throw new Error("runDesktopUpload called outside chan-desktop");
  }
  const nativeId = nativeTransferId();
  const cancel = (): void => {
    void tauriInvoke<boolean>("cancel_native_transfer", { transferId: nativeId });
  };
  const xferId = beginTransfer({ kind: "upload", filename: label, cancel });
  let stopProgress: (() => void) | null = null;
  try {
    if (!(await waitForTransferSlot(xferId))) return [];
    stopProgress = pollNativeProgress(nativeId, xferId);
    const url = new URL(
      withTokenQuery("/api/files/upload"),
      window.location.href,
    ).toString();
    const uploaded = await tauriInvoke<NativeUploadedFile[]>("upload_files_native", {
      transferId: nativeId,
      url,
      target,
    });
    if (uploaded.length === 0) {
      cancelTransfer(xferId);
      return [];
    }
    finishTransfer(xferId);
    return uploaded;
  } catch (err) {
    const message = errorMessage(err);
    if (message.includes("upload cancelled")) cancelTransfer(xferId);
    else failTransfer(xferId, message);
    throw err instanceof Error ? err : new Error(message);
  } finally {
    stopProgress?.();
  }
}

/// Save SPA-generated bytes (for example, a rendered PDF) through a bounded
/// 64 KiB IPC chunk sink. The full byte array never becomes one IPC payload.
export async function saveBytesToDownloads(
  bytes: Uint8Array,
  filename: string,
): Promise<string> {
  if (!isTauriDesktop()) {
    throw new Error("saveBytesToDownloads called outside chan-desktop");
  }
  let handle: string | null = null;
  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
    if (handle) void tauriInvoke<boolean>("cancel_generated_download", { handle });
  };
  const xferId = beginTransfer({ kind: "download", filename, cancel });
  try {
    if (!(await waitForTransferSlot(xferId))) {
      throw new Error("download cancelled");
    }
    const begun = await tauriInvoke<{ handle: string }>("begin_generated_download", {
      filename,
    });
    handle = begun.handle;
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      if (cancelled) throw new Error("download cancelled");
      const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + 64 * 1024));
      await tauriInvoke<void>("append_generated_download", {
        handle,
        bytes: [...chunk],
      });
      setTransferProgress(xferId, bytes.length > 0 ? (offset + chunk.length) / bytes.length : 1);
    }
    if (cancelled) throw new Error("download cancelled");
    const saved = await tauriInvoke<{ path: string }>("finish_generated_download", {
      handle,
    });
    handle = null;
    finishTransfer(xferId, saved.path);
    return saved.path;
  } catch (err) {
    if (handle) await tauriInvoke<boolean>("cancel_generated_download", { handle }).catch(() => {});
    const message = errorMessage(err);
    if (message.includes("download cancelled")) cancelTransfer(xferId);
    else failTransfer(xferId, message);
    throw err instanceof Error ? err : new Error(message);
  }
}
