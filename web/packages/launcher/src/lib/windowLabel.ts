// Launcher-local naming helpers. The window display name itself is shared with
// the workspace app (`@chan/web-shared/window-label`) so both surfaces spell a
// window the same way; what stays here is the launcher's own library id
// constant and its path shortening.

import { rowLabel, windowDisplayName } from "@chan/web-shared/window-label";
import type { WindowRecord } from "../api/library";

export { rowLabel };

/** The baked-in local-disk library's id; everything else is a remote library. */
export const LOCAL_LIBRARY_ID = "local";

/** Trailing path component, tolerant of a trailing slash. "" for "" or "/". */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** Convenience over a whole launcher record. */
export function windowRowLabel(w: WindowRecord): string {
  return windowDisplayName(w);
}
