// @vitest-environment jsdom

// Runtime smoke for the settings surface: mounting it, opening it, and
// driving a control must not trip a Svelte 5 reactivity fault
// (effect_update_depth_exceeded from the buffer re-hydrate effects), and
// a field change must PATCH exactly that slice through /api/config. A
// static gate (svelte-check) can't see these; a mount can.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import SettingsOverlay from "./SettingsOverlay.svelte";
import { settingsPanel } from "../state/store.svelte";
import { tabFocusPulse } from "../state/tabs.svelte";
import { DATE_FORMATS } from "../editor/dateFormats";

type Cfg = {
  revision: number;
  preferences: Record<string, unknown>;
  workspaces: unknown[];
};

function basePrefs(): Record<string, unknown> {
  return {
    editor_theme: "github",
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
      mcp_env: false,
      mouse_capture: true,
    },
    bubble_overlay_mode: "stack",
    empty_pane_carousel_cycling: true,
    page_width_ratio: 0.8,
    overlay_maximized: false,
    cs_dismissed: false,
  };
}

let server: Cfg;
let patches: Cfg[];
const mounted: Array<Record<string, unknown>> = [];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// Let the open effect's reload() fetch chain settle: several
// tick + microtask cycles, since the buffer loads over an awaited GET.
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await tick();
    await Promise.resolve();
  }
}

function openSurface(): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(SettingsOverlay, { target }) as Record<string, unknown>);
  settingsPanel.open = true;
  return target;
}

beforeEach(() => {
  server = { revision: 1, preferences: basePrefs(), workspaces: [] };
  patches = [];
  settingsPanel.open = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url.includes("/api/config")) {
      if (method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as {
          expected_revision: number;
          preferences: Record<string, unknown>;
        };
        server = {
          ...server,
          revision: server.revision + 1,
          preferences: { ...server.preferences, ...body.preferences },
        };
        patches.push(server);
        return jsonResponse(server);
      }
      return jsonResponse(server);
    }
    if (url.includes("/api/fonts/source-code-pro/download")) {
      return jsonResponse({ dir: "fonts", files: [] });
    }
    return new Response(null, { status: 404 });
  });
});

afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  document.body.innerHTML = "";
  settingsPanel.open = false;
  vi.restoreAllMocks();
});

describe("settings surface render", () => {
  test("mounts, loads the config, and shows the section rail without an effect loop", async () => {
    const target = openSurface();
    await flush();
    const tabs = [...target.querySelectorAll(".section-tab")].map((e) =>
      e.textContent?.trim(),
    );
    expect(tabs).toContain("Appearance");
    expect(tabs).toContain("Terminal");
    expect(tabs).toContain("Keyboard Shortcuts");
    // Appearance is the default section; its editor-theme pills rendered,
    // which means the buffer loaded (not the loading/error state).
    expect(target.querySelector(".state")).toBeNull();
    const labels = [...target.querySelectorAll(".pill span")].map((e) =>
      e.textContent,
    );
    expect(labels).toContain("GitHub");
  });

  test("focuses itself on open, roves section focus, and pulses focus on close", async () => {
    const target = openSurface();
    await flush();

    const settings = target.querySelector<HTMLElement>(".settings");
    expect(document.activeElement).toBe(settings);

    const first = target.querySelector<HTMLButtonElement>(".section-tab");
    expect(first?.textContent?.trim()).toBe("Appearance");
    first?.focus();
    first?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    await tick();
    await Promise.resolve();

    const active = target.querySelector<HTMLButtonElement>(
      '.section-tab[aria-current="page"]',
    );
    expect(active?.textContent?.trim()).toBe("Editor");
    expect(document.activeElement).toBe(active);

    const pulse = tabFocusPulse.value;
    settingsPanel.open = false;
    await flush();
    expect(tabFocusPulse.value).toBe(pulse + 1);
  });

  test("changing a field PATCHes exactly that slice", async () => {
    const target = openSurface();
    await flush();
    const wordRadio = target.querySelector(
      'input[type="radio"][value="word"]',
    ) as HTMLInputElement;
    expect(wordRadio).not.toBeNull();
    wordRadio.click();
    await flush();
    expect(patches.length).toBeGreaterThanOrEqual(1);
    const last = patches[patches.length - 1]!;
    expect(last.preferences.editor_theme).toBe("word");
    // The unrelated slice is preserved (single-field overlay, not a
    // whole-form clobber).
    expect(
      (last.preferences.terminal as { default_term: string }).default_term,
    ).toBe("xterm-256color");
  });

  test("switching sections renders the target section's controls", async () => {
    const target = openSurface();
    await flush();
    const terminalTab = [...target.querySelectorAll(".section-tab")].find(
      (e) => e.textContent?.trim() === "Terminal",
    ) as HTMLElement;
    terminalTab.click();
    await flush();
    const ranges = target.querySelectorAll('input[type="range"]');
    expect(ranges.length).toBeGreaterThanOrEqual(1);
    const labels = [...target.querySelectorAll("h3")].map((e) => e.textContent);
    expect(labels).toContain("Scrollback");
    expect(labels).toContain("MCP discovery");
  });

  test("the Keyboard Shortcuts section mounts the assignment grid", async () => {
    const target = openSurface();
    await flush();
    const shortcutsTab = [...target.querySelectorAll(".section-tab")].find(
      (e) => e.textContent?.trim() === "Keyboard Shortcuts",
    ) as HTMLElement;
    shortcutsTab.click();
    await flush();
    // KeymapSettings (the per-OS assign grid) renders its
    // own filter toolbar; its presence proves the mount seam works.
    expect(target.querySelector(".keymap")).not.toBeNull();
    expect(
      target.querySelector('input[aria-label="Filter commands"]'),
    ).not.toBeNull();
  });

  test("the per-surface body theme sets then clears the override key", async () => {
    const target = openSurface();
    await flush();
    // Appearance is the default section. Pin the editor body to Dark.
    const darkRadio = target.querySelector(
      'input[name="settings-surface-theme-editor"][value="dark"]',
    ) as HTMLInputElement;
    expect(darkRadio).not.toBeNull();
    darkRadio.click();
    await flush();
    const afterSet = patches[patches.length - 1]!;
    expect(
      (afterSet.preferences.hybrid_surface_themes as Record<string, string>)
        .editor,
    ).toBe("dark");
    // Unrelated slice preserved (single-field overlay, not a clobber).
    expect(
      (afterSet.preferences.terminal as { default_term: string }).default_term,
    ).toBe("xterm-256color");
    // Inherit drops the key entirely.
    const inheritRadio = target.querySelector(
      'input[name="settings-surface-theme-editor"][value="inherit"]',
    ) as HTMLInputElement;
    inheritRadio.click();
    await flush();
    const afterClear = patches[patches.length - 1]!;
    expect(
      (afterClear.preferences.hybrid_surface_themes as Record<string, string>)
        .editor,
    ).toBeUndefined();
  });

  test("selecting Source Code Pro downloads then PATCHes terminal.font", async () => {
    const target = openSurface();
    await flush();
    const terminalTab = [...target.querySelectorAll(".section-tab")].find(
      (e) => e.textContent?.trim() === "Terminal",
    ) as HTMLElement;
    terminalTab.click();
    await flush();
    const fontSelect = target.querySelector(
      'select[aria-label="Terminal font"]',
    ) as HTMLSelectElement;
    expect(fontSelect).not.toBeNull();
    fontSelect.value = "source-code-pro";
    fontSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    const last = patches[patches.length - 1]!;
    expect((last.preferences.terminal as { font: string }).font).toBe(
      "source-code-pro",
    );
    // The MCP-env slice (a sibling terminal field) is preserved.
    expect((last.preferences.terminal as { mcp_env: boolean }).mcp_env).toBe(
      false,
    );
  });

  test("toggling mouse capture PATCHes terminal.mouse_capture and keeps siblings", async () => {
    const target = openSurface();
    await flush();
    const terminalTab = [...target.querySelectorAll(".section-tab")].find(
      (e) => e.textContent?.trim() === "Terminal",
    ) as HTMLElement;
    terminalTab.click();
    await flush();
    const pill = [...target.querySelectorAll("label.pill")].find((e) =>
      e.textContent?.includes("Allow in new terminals"),
    ) as HTMLLabelElement;
    expect(pill).not.toBeNull();
    const checkbox = pill.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    checkbox.click();
    await flush();
    const last = patches[patches.length - 1]!;
    expect(
      (last.preferences.terminal as { mouse_capture: boolean }).mouse_capture,
    ).toBe(false);
    // Sibling terminal fields survive the spread.
    expect((last.preferences.terminal as { mcp_env: boolean }).mcp_env).toBe(
      false,
    );
    expect(
      (last.preferences.terminal as { default_term: string }).default_term,
    ).toBe("xterm-256color");
  });
});
