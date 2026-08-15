// Compose the in-app URL a launcher-opened window navigates to, WITHOUT
// parsing the opaque `window_id` or the library-composed `title`. The launcher
// serves at the origin root and every workspace/terminal/control tenant is a
// sibling under `/{prefix}`; window.open against this URL opens the window
// in-app (same origin, inside the launcher PWA scope).
//
// The query contract mirrors what the workspace-app SPA reads on boot:
//   ?w=<window_id>    per-window session key (panes/tabs, /ws presence)
//   ?kind=terminal    terminal-only mode; ?kind=control adds the control
//                     sub-mode. Absent for a workspace window (full mode).
//   ?lib=<library_id> the owning chan-library (cross-window tab-DnD scope);
//                     the SPA defaults a missing ?lib= to "local".
//   ?t=<token>        the tenant bearer; empty when the owning tenant is off
//                     (an off tenant cannot be opened anyway).

import type { WindowRecord } from "../api/library";

/**
 * Build the same-origin, in-app URL for a window record. `origin` is the
 * serving origin (`location.origin`). `?w=` is ALWAYS stamped so a browser tab
 * keys its session on the record's id instead of minting a random per-tab id.
 */
export function windowUrl(record: WindowRecord, origin: string): string {
  const prefix = record.prefix.replace(/^\/+|\/+$/g, "");
  const url = new URL(origin);
  url.pathname = `/${prefix}/`;
  url.searchParams.set("w", record.window_id);
  if (record.kind === "terminal") {
    // The SPA reads ?kind= as its window-mode signal. A standalone window is
    // one family: whether it can also browse files is the serving tenant's
    // answer, not the launcher's, so only the control sub-mode is named here.
    url.searchParams.set("kind", record.control ? "control" : "terminal");
  }
  if (record.library_id) url.searchParams.set("lib", record.library_id);
  if (record.token) url.searchParams.set("t", record.token);
  return url.toString();
}
