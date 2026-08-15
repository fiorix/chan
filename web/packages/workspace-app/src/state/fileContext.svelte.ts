// The window's filesystem identity: how wire-relative paths map onto the
// display namespace, independent of a workspace.
//
// A workspace window derives this from `workspace.info` (root = the
// workspace directory); a standalone window whose tenant serves a filesystem
// derives it from `GET /api/fs/context` (root = "/", start = canonical
// $HOME). Consumers that only translate paths (absolute display strings,
// breadcrumbs, terminal cwd conversion, drag scope, per-window local-storage
// keys) read this context instead of reaching for `workspace.info`, so they
// work identically in both modes.

import { windowLibraryId } from "../api/client";

export interface FileContext {
  /// Absolute display prefix for wire paths ("/" on the standalone
  /// filesystem, the workspace root in a workspace window).
  rootDisplay: string;
  /// The wire form of the root ("" in both modes today).
  rootWire: string;
  /// Wire-relative directory the window starts in: canonical $HOME on the
  /// standalone filesystem, "" in a workspace window.
  homeWire: string;
  /// Stable identity for caret/local-storage/drag keys. A standalone
  /// window uses `lib:<library-id>|files`; workspace windows keep their
  /// root-keyed identities so nothing persisted moves.
  identity: string;
}

/// The standalone filesystem context, set once by the standalone bootstrap
/// from `GET /api/fs/context` and never replaced afterwards. Null in a
/// workspace window, and in a standalone window whose tenant serves no
/// filesystem.
export const filesContext = $state<{ current: FileContext | null }>({
  current: null,
});

/// Build the standalone filesystem context from the server's payload.
export function filesContextFrom(home: string): FileContext {
  return {
    rootDisplay: "/",
    rootWire: "",
    homeWire: home,
    identity: `lib:${windowLibraryId()}|files`,
  };
}

/// Absolute display path for a wire-relative path under `ctx`.
export function displayPath(ctx: FileContext, wire: string): string {
  if (wire === "") return ctx.rootDisplay;
  return ctx.rootDisplay === "/" ? `/${wire}` : `${ctx.rootDisplay}/${wire}`;
}

/// Convert an absolute path (a PTY's reported cwd) back to the wire form,
/// or null when it does not sit under the context root or is not
/// expressible. The caller falls back to `homeWire` with a notice.
export function wirePathFromAbsolute(
  ctx: FileContext,
  absolute: string,
): string | null {
  if (!absolute.startsWith("/")) return null;
  if (ctx.rootDisplay === "/") {
    const wire = absolute.replace(/^\/+/, "").replace(/\/+$/, "");
    return wire;
  }
  const root = ctx.rootDisplay.replace(/\/+$/, "");
  if (absolute === root) return "";
  if (!absolute.startsWith(`${root}/`)) return null;
  return absolute.slice(root.length + 1).replace(/\/+$/, "");
}
