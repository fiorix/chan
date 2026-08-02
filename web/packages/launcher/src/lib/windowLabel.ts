// Compose the display label for a window row WITHOUT parsing the
// library-composed `title` or the opaque `window_id`. The library titles every
// window from its own (local) perspective; the launcher recomposes each row's
// label from `kind`, `ordinal`, and `workspace_path` alone.

import type { WindowKind, WindowRecord } from "../api/library";

/** The baked-in local-disk library's id; everything else is a remote library. */
export const LOCAL_LIBRARY_ID = "local";

/** Trailing path component, tolerant of a trailing slash. "" for "" or "/". */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/**
 * A row's label: "Window N" for a workspace window (its card already names the
 * workspace, so the base is not repeated here) or "Terminal Window N" for a
 * standalone terminal. No icon here; the icon is the machine's (the block
 * carries it), so a row reads the same under any library.
 */
export function rowLabel(kind: WindowKind, ordinal: number): string {
  if (kind === "terminal") return `Terminal Window ${ordinal}`;
  return `Window ${ordinal}`;
}

/** Convenience over a whole record. The devserver's connect control terminal
 * reads as "Control terminal" rather than the recomposed "Terminal Window 0". */
export function windowRowLabel(w: WindowRecord): string {
  if (w.control) return "Control terminal";
  const generated = rowLabel(w.kind, w.ordinal);
  const label = w.label?.trim();
  return label ? `${generated} [${label}]` : generated;
}
