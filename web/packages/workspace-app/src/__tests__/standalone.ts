// The standalone-window boot harness: the capability metas chan-server
// injects into the served shell, and a complete Preferences payload for the
// `/api/config` the slim tenant serves.

import type { Preferences } from "../api/types";

/// Declare (or withdraw) one of the tenant's capability metas exactly the
/// way chan-server injects them into the served shell. Must run before the
/// state modules are imported: the capabilities are read once at module
/// load.
export function serveMeta(name: string, on: boolean): void {
  document.head.querySelector(`meta[name="${name}"]`)?.remove();
  if (!on) return;
  const meta = document.createElement("meta");
  meta.setAttribute("name", name);
  meta.setAttribute("content", "1");
  document.head.appendChild(meta);
}

/// Every required Preferences field, so a test states only the fields its
/// case is about.
export function preferences(over: Partial<Preferences> = {}): Preferences {
  return {
    editor_theme: "github",
    attachments_dir: "attachments",
    theme: "dark",
    pane_widths: { inspector: 320, graph: 320, browser: 320, search: 320, outline: 240 },
    browser_side_panes: { left: false, right: false },
    line_spacing: "standard",
    date_format: "iso",
    strip_trailing_whitespace_on_save: false,
    search_aggression: "balanced",
    terminal: {
      idle_timeout_secs: 0,
      session_cap: 8,
      ring_bytes: 1024,
      font_size: 14,
      ghostty: false,
      scrollback_mb: 20,
      mouse_capture: false,
      secret_masking: true,
    },
    bubble_overlay_mode: "stack",
    ...over,
  };
}
