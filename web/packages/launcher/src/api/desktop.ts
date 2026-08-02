/// Runtime detection + Tauri event bridge for the launcher SPA.
///
/// The launcher ships as a browser SPA (served by chan-server over HTTP) and, on
/// the desktop loopback surface, as a chan-desktop Tauri webview. This module is
/// the desktop event bridge for backend events the plain-browser
/// surface never sees, such as `devserver-control-attention` when a connected
/// devserver stops responding. It uses the GLOBAL Tauri API
/// (`window.__TAURI__`, exposed by `withGlobalTauri: true`); the launcher has no
/// `@tauri-apps/api` dependency, so there is nothing to import.

type UnlistenFn = () => void;

export type NativeLauncherEntryMode = "contextual" | "computers";

export interface NativeLauncherCommandDescriptor {
  id: string;
  title: string;
  category: string;
  keywords: string[];
  icon?: string;
  shortcut?: string;
  acceptsArg: boolean;
  confirm?: {
    title: string;
    message: string;
    actionLabel: string;
    danger?: boolean;
  };
  scope: "tab" | "pane" | "window";
}

export interface NativeLauncherContext {
  commands: NativeLauncherCommandDescriptor[];
  theme: "light" | "dark";
  accent?: string;
  sourceTitle: string;
}

export interface NativeLauncherSnapshot {
  entryMode: NativeLauncherEntryMode;
  draft: unknown;
  draftRevision: number;
  context: NativeLauncherContext | null;
  sourceAlive: boolean;
}

interface TauriEvent<T> {
  payload: T;
}

interface TauriEventApi {
  listen<T>(event: string, handler: (e: TauriEvent<T>) => void): Promise<UnlistenFn>;
}

interface TauriCoreApi {
  invoke<T = unknown>(cmd: string, args?: unknown): Promise<T>;
}

type TauriWindow = Window &
  typeof globalThis & {
    __TAURI__?: { event?: TauriEventApi; core?: TauriCoreApi; invoke?: TauriCoreApi["invoke"] };
  };

/// True only when running inside chan-desktop's Tauri webview WITH the global
/// event API available. The launcher needs the event bridge specifically, so
/// this gates on `__TAURI__.event.listen` (a plain browser has neither).
export function hasTauriEvents(): boolean {
  return typeof (window as TauriWindow).__TAURI__?.event?.listen === "function";
}

/// Subscribe to a Tauri backend event, delivering its payload to `handler`.
/// Resolves to an unlisten handle (a no-op off-desktop). Best-effort: a missing
/// bridge or a failed `listen` degrades to a no-op so the launcher boot path
/// never breaks on a non-desktop surface.
export async function onTauriEvent<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  const api = (window as TauriWindow).__TAURI__?.event;
  if (!api?.listen) return () => {};
  try {
    return await api.listen<T>(event, (e) => handler(e.payload));
  } catch (err) {
    console.warn(`onTauriEvent(${event}) failed:`, err);
    return () => {};
  }
}

async function tauriInvoke<T>(cmd: string, args?: unknown): Promise<T> {
  const tauri = (window as TauriWindow).__TAURI__;
  const invoke = tauri?.core?.invoke ?? tauri?.invoke;
  if (!invoke) throw new Error(`tauriInvoke(${cmd}): not running under Tauri`);
  return (await invoke(cmd, args)) as T;
}

export function isNativeCommandOverlay(): boolean {
  return new URLSearchParams(location.search).get("command") === "1";
}

export async function openNativeCommandLauncher(
  entryMode: NativeLauncherEntryMode,
): Promise<void> {
  await tauriInvoke("open_command_launcher", { entryMode });
}

export async function nativeCommandLauncherSnapshot(): Promise<NativeLauncherSnapshot> {
  return await tauriInvoke("command_launcher_snapshot");
}

export async function saveNativeCommandLauncherDraft(
  revision: number,
  draft: unknown,
): Promise<void> {
  await tauriInvoke("save_command_launcher_draft", { revision, draft });
}

export async function hideNativeCommandLauncher(): Promise<void> {
  await tauriInvoke("hide_command_launcher");
}

export async function executeNativeCommandLauncherItem(
  commandId: string,
  arg?: string,
  itemId = commandId,
): Promise<void> {
  await tauriInvoke("execute_command_launcher_item", {
    commandId,
    arg: arg ?? null,
    itemId,
  });
}

/// Restart chan-desktop after an updater install. The narrow app command is
/// granted through `launcher-update.json`, not through the broad process plugin.
export async function restartDesktopAfterUpdate(): Promise<void> {
  await tauriInvoke("restart_desktop_after_update");
}

/// Ask chan-desktop to run its normal confirm-then-quit path. Exposed only to
/// the loopback launcher and trusted-overlay capabilities, never to an
/// untrusted browser origin.
export async function requestDesktopQuit(): Promise<void> {
  await tauriInvoke("request_app_quit");
}
