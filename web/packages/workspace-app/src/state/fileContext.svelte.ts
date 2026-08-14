// The window's filesystem identity: how wire-relative paths map onto the
// display namespace, independent of a workspace.
//
// A workspace window derives this from `workspace.info` (root = the
// workspace directory); a Files window derives it from `GET /api/fs/context`
// (root = "/", start = canonical $HOME). Consumers that only translate
// paths (absolute display strings, breadcrumbs, terminal cwd conversion,
// drag scope, per-window local-storage keys) read this context instead of
// reaching for `workspace.info`, so they work identically in both modes.

import { windowLibraryId } from "../api/client";

export interface FileContext {
  /// Absolute display prefix for wire paths ("/" in Files mode, the
  /// workspace root in workspace mode).
  rootDisplay: string;
  /// The wire form of the root ("" in both modes today).
  rootWire: string;
  /// Wire-relative directory the window starts in: canonical $HOME in
  /// Files mode, "" in workspace mode.
  homeWire: string;
  /// Stable identity for caret/local-storage/drag keys. Files windows use
  /// `lib:<library-id>|files`; workspace windows keep their root-keyed
  /// identities so nothing persisted moves.
  identity: string;
}

/// Files-mode context, set once by the Files bootstrap from
/// `GET /api/fs/context` and never replaced afterwards. Null in every
/// other mode.
export const filesContext = $state<{ current: FileContext | null }>({
  current: null,
});

/// Build the Files-mode context from the server's fs context payload.
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
