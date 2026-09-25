// Mount the Settings surface over a served global config and drive it: open
// a section, change a control, and read back the preference slice each write
// sent. Pair `openSettings` with `closeSettings` in `afterEach`.

import { mount, tick, unmount } from "svelte";

import type { Preferences } from "../api/types";
import SettingsOverlay from "../components/SettingsOverlay.svelte";
import { DATE_FORMATS } from "../editor/dateFormats";
import { settingsPanel } from "../state/store.svelte";
import { json, recordRequests, stopRecordingRequests, type RecordedRequest } from "./fetch";

/// A whole preferences record, as a fresh config holds it.
export function settingsPreferences(): Preferences {
  return {
    editor_theme: "github",
    editor_font_size: null,
    terminal_colors: { mode: "standard" },
    attachments_dir: "attachments",
    theme: "system",
    hybrid_surface_themes: {},
    pane_widths: { inspector: 280, graph: 280, browser: 280, search: 280, outline: 240 },
    browser_side_panes: { left: false, right: false },
    line_spacing: "standard",
    date_format: DATE_FORMATS[0]!.id,
    strip_trailing_whitespace_on_save: false,
    search_aggression: "balanced",
    terminal: {
      idle_timeout_secs: 900,
      session_cap: 20,
      ring_bytes: 1048576,
      scrollback_mb: 50,
      default_term: "xterm-256color",
      font: "os-default",
      font_size: 14,
      mcp_env: false,
      mouse_capture: true,
    },
    bubble_overlay_mode: "stack",
    empty_pane_carousel_cycling: true,
    page_width_ratio: 0.8,
    overlay_maximized: false,
  };
}

export interface OpenSettings {
  target: HTMLElement;
  /// The `preferences` slice of every PATCH /api/config, in order.
  writes: Record<string, unknown>[];
  /// Every request Settings sent, reads included.
  requests: RecordedRequest[];
}

let view: Record<string, unknown> | null = null;

/// Serve `preferences` as the global config, mount Settings, open it and
/// switch to `section`.
export async function openSettings(
  section: string,
  preferences: Record<string, unknown> = settingsPreferences(),
): Promise<OpenSettings> {
  let revision = 1;
  let prefs = preferences;
  const writes: Record<string, unknown>[] = [];
  const requests = recordRequests((request) => {
    if (request.path !== "/api/config") return new Response(null, { status: 404 });
    if (request.method === "PATCH") {
      const slice = (request.body as { preferences: Record<string, unknown> }).preferences;
      writes.push(slice);
      prefs = { ...prefs, ...slice };
      revision += 1;
    }
    return json({ revision, preferences: prefs, workspaces: [] });
  });
  const target = document.createElement("div");
  document.body.append(target);
  view = mount(SettingsOverlay, { target });
  settingsPanel.open = true;
  await settleSettings();
  const tab = [...target.querySelectorAll<HTMLElement>(".section-tab")].find(
    (candidate) => candidate.textContent?.trim() === section,
  );
  if (!tab) throw new Error(`Settings has no ${section} section`);
  tab.click();
  await settleSettings();
  return { target, writes, requests };
}

/// Let the config load and a write's round trip land.
export async function settleSettings(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await tick();
    await Promise.resolve();
  }
}

export function closeSettings(): void {
  if (view) unmount(view);
  view = null;
  settingsPanel.open = false;
  stopRecordingRequests();
  document.body.innerHTML = "";
}
