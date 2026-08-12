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
import {
  SCROLLBACK_MB_DEFAULT,
  SCROLLBACK_MB_MAX,
  SCROLLBACK_MB_MIN,
} from "../terminal/scrollback";

type Cfg = {
  revision: number;
  preferences: Record<string, unknown>;
  workspaces: unknown[];
};

function basePrefs(): Record<string, unknown> {
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
    cs_dismissed: false,
  };
}

let server: Cfg;
let patches: Cfg[];
/// The wire bodies of every PATCH /api/config, as sent. `patches`
/// records post-merge server state (useful for reconciliation checks),
/// but an assertion about what a control WRITES belongs on these:
/// owner checks and "exactly that slice" checks read `patchBodies`.
let patchBodies: Record<string, unknown>[];
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

function clickTab(target: HTMLElement, label: string): void {
  const tab = [...target.querySelectorAll(".section-tab")].find(
    (e) => e.textContent?.trim() === label,
  ) as HTMLElement;
  expect(tab, `section tab ${label}`).not.toBeNull();
  tab.click();
}

/// Mirror of `PreferencesPatch::owner`
/// (crates/chan-server/src/routes/preferences.rs): `terminal`,
/// `attachments_dir` and `search_aggression` are Server-owned; every
/// other field is Editor-owned. A patch carrying both owners is a 400,
/// which is what the per-section drive below must never produce.
const SERVER_OWNED = new Set(["terminal", "attachments_dir", "search_aggression"]);

function ownersOf(body: Record<string, unknown>): Set<string> {
  const owners = new Set<string>();
  for (const key of Object.keys(body)) {
    owners.add(SERVER_OWNED.has(key) ? "server" : "editor");
  }
  return owners;
}

beforeEach(() => {
  server = { revision: 1, preferences: basePrefs(), workspaces: [] };
  patches = [];
  patchBodies = [];
  settingsPanel.open = false;
  document.documentElement.dataset.theme = "dark";
  document.documentElement.style.setProperty("--bg", "#1C1C1E");
  document.documentElement.style.setProperty("--text", "#EBEBF0");
  document.documentElement.style.setProperty("--link", "#58A6FF");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url.includes("/api/config")) {
      if (method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as {
          expected_revision: number;
          preferences: Record<string, unknown>;
        };
        patchBodies.push(body.preferences);
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
    return new Response(null, { status: 404 });
  });
});

afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  document.body.innerHTML = "";
  document.documentElement.style.removeProperty("--bg");
  document.documentElement.style.removeProperty("--text");
  document.documentElement.style.removeProperty("--link");
  document.documentElement.style.removeProperty("--chan-editor-body-size");
  document.documentElement.style.removeProperty("--chan-editor-source-size");
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
    expect(tabs).toContain("Global");
    expect(tabs).toContain("Terminal");
    expect(tabs).toContain("Graph");
    expect(tabs).toContain("Dashboard");
    expect(tabs).toContain("Keyboard Shortcuts");
    // Global is the default section; its app-theme pills rendered,
    // which means the buffer loaded (not the loading/error state).
    expect(target.querySelector(".state")).toBeNull();
    const labels = [...target.querySelectorAll(".pill span")].map((e) =>
      e.textContent,
    );
    expect(labels).toContain("System");
  });

  test("focuses itself on open, roves section focus, and pulses focus on close", async () => {
    const target = openSurface();
    await flush();

    const settings = target.querySelector<HTMLElement>(".settings");
    expect(document.activeElement).toBe(settings);

    const first = target.querySelector<HTMLButtonElement>(".section-tab");
    expect(first?.textContent?.trim()).toBe("Global");
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
    clickTab(target, "Editor");
    await flush();
    const wordRadio = target.querySelector(
      'input[type="radio"][value="word"]',
    ) as HTMLInputElement;
    expect(wordRadio).not.toBeNull();
    wordRadio.click();
    await flush();
    expect(patchBodies.length).toBeGreaterThanOrEqual(1);
    const body = patchBodies[patchBodies.length - 1]!;
    // The wire body carries exactly the slice, not a whole-form clobber.
    expect(Object.keys(body)).toEqual(["editor_theme"]);
    expect(body.editor_theme).toBe("word");
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
    // The editor surface row lives in the Editor section. Pin the
    // editor body to Dark.
    clickTab(target, "Editor");
    await flush();
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

  test("terminal font size clamps on blur and PATCHes the terminal owner", async () => {
    const target = openSurface();
    await flush();
    const terminalTab = [...target.querySelectorAll(".section-tab")].find(
      (e) => e.textContent?.trim() === "Terminal",
    ) as HTMLElement;
    terminalTab.click();
    await flush();
    const input = target.querySelector(
      'input[aria-label="Terminal font size"]',
    ) as HTMLInputElement;
    input.value = "99";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    await flush();

    const body = patchBodies[patchBodies.length - 1]!;
    // The terminal owner is patched as one composite.
    expect(Object.keys(body)).toEqual(["terminal"]);
    expect((body.terminal as { font_size: number }).font_size).toBe(32);
    expect(input.value).toBe("32");
  });

  test("editor 20 applies live and Use theme clears both CSS variables", async () => {
    const target = openSurface();
    await flush();
    const editorTab = [...target.querySelectorAll(".section-tab")].find(
      (e) => e.textContent?.trim() === "Editor",
    ) as HTMLElement;
    editorTab.click();
    await flush();
    const input = target.querySelector(
      'input[aria-label="Editor font size"]',
    ) as HTMLInputElement;
    expect(input.placeholder).toMatch(/px$/);
    input.value = "20";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    await flush();

    expect(patches[patches.length - 1]!.preferences.editor_font_size).toBe(20);
    expect(
      document.documentElement.style.getPropertyValue("--chan-editor-body-size"),
    ).toBe("20px");
    expect(
      document.documentElement.style.getPropertyValue("--chan-editor-source-size"),
    ).toBe("18px");

    const useTheme = [...target.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Use theme",
    ) as HTMLButtonElement;
    useTheme.click();
    await flush();
    expect(patches[patches.length - 1]!.preferences.editor_font_size).toBeNull();
    expect(
      document.documentElement.style.getPropertyValue("--chan-editor-body-size"),
    ).toBe("");
    expect(
      document.documentElement.style.getPropertyValue("--chan-editor-source-size"),
    ).toBe("");
  });

  test("first custom activation snapshots standard colours atomically", async () => {
    const target = openSurface();
    await flush();
    clickTab(target, "Terminal");
    await flush();
    const customPill = [...target.querySelectorAll("label.pill")].find(
      (label) => label.textContent?.trim() === "Custom terminal colours",
    ) as HTMLLabelElement;
    const checkbox = customPill.querySelector("input") as HTMLInputElement;
    checkbox.click();
    await flush();

    const colors = patches[patches.length - 1]!.preferences.terminal_colors as {
      mode: string;
      custom: Record<string, string>;
    };
    expect(colors).toEqual({
      mode: "custom",
      custom: {
        background: "#1c1c1e",
        foreground: "#ebebf0",
        cursor: "#58a6ff",
        contrast: "auto",
      },
    });

    const patchCount = patches.length;
    const foreground = target.querySelector(
      "#terminal-colour-foreground",
    ) as HTMLInputElement;
    foreground.value = "invalid";
    foreground.dispatchEvent(new Event("input", { bubbles: true }));
    foreground.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    await flush();
    expect(patches).toHaveLength(patchCount);
    expect(foreground.getAttribute("aria-invalid")).toBe("true");

    checkbox.click();
    await flush();
    checkbox.click();
    await flush();
    const restoredForeground = target.querySelector(
      "#terminal-colour-foreground",
    ) as HTMLInputElement;
    expect(restoredForeground.value).toBe("#ebebf0");
    expect(restoredForeground.getAttribute("aria-invalid")).toBeNull();

    const lightContrast = target.querySelector(
      'input[name="settings-terminal-contrast"][value="light"]',
    ) as HTMLInputElement;
    lightContrast.click();
    await flush();
    const manual = patches[patches.length - 1]!.preferences.terminal_colors as {
      mode: string;
      custom: Record<string, string>;
    };
    expect(manual.custom.contrast).toBe("light");

    checkbox.click();
    await flush();
    const dormant = patches[patches.length - 1]!.preferences.terminal_colors as {
      mode: string;
      custom: Record<string, string>;
    };
    expect(dormant.mode).toBe("standard");
    expect(dormant.custom).toEqual(manual.custom);

    document.documentElement.style.setProperty("--bg", "#223344");
    document.documentElement.style.setProperty("--text", "#F0F1F2");
    document.documentElement.style.setProperty("--link", "#AABBCC");
    checkbox.click();
    await flush();
    const restored = patches[patches.length - 1]!.preferences.terminal_colors as {
      mode: string;
      custom: Record<string, string>;
    };
    expect(restored.custom).toEqual(manual.custom);

    const reset = [...target.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Reset to current standard",
    ) as HTMLButtonElement;
    reset.click();
    await flush();
    expect(patches[patches.length - 1]!.preferences.terminal_colors).toEqual({
      mode: "custom",
      custom: {
        background: "#223344",
        foreground: "#f0f1f2",
        cursor: "#aabbcc",
        contrast: "auto",
      },
    });
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
    const body = patchBodies[patchBodies.length - 1]!;
    expect(Object.keys(body)).toEqual(["terminal"]);
    const terminal = body.terminal as {
      mouse_capture: boolean;
      mcp_env: boolean;
      default_term: string;
    };
    expect(terminal.mouse_capture).toBe(false);
    // Sibling terminal fields survive the composite the body carries.
    expect(terminal.mcp_env).toBe(false);
    expect(terminal.default_term).toBe("xterm-256color");
  });

  test("the File browser section toggles one side pane at a time", async () => {
    const target = openSurface();
    await flush();
    clickTab(target, "File browser");
    await flush();
    const pill = [...target.querySelectorAll("label.pill")].find(
      (e) => e.textContent?.trim() === "Left pane",
    ) as HTMLLabelElement;
    expect(pill, "Left pane pill").not.toBeNull();
    (pill.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    await flush();
    expect(patchBodies[patchBodies.length - 1]!.browser_side_panes).toEqual({
      left: true,
      right: false,
    });
  });

  test("secret masking PATCHes terminal.secret_masking with the xterm scope stated", async () => {
    const target = openSurface();
    await flush();
    clickTab(target, "Terminal");
    await flush();
    // The row states its xterm.js-only scope (post linux-terminal-grid it
    // does nothing under the ghostty default).
    expect(target.textContent).toContain("xterm.js terminals only");
    const pill = [...target.querySelectorAll("label.pill")].find((e) =>
      e.textContent?.includes("Mask secrets in new terminals"),
    ) as HTMLLabelElement;
    expect(pill, "secret masking pill").not.toBeNull();
    const checkbox = pill.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    checkbox.click();
    await flush();
    const body = patchBodies[patchBodies.length - 1]!;
    expect(Object.keys(body)).toEqual(["terminal"]);
    const terminal = body.terminal as {
      secret_masking: boolean;
      default_term: string;
    };
    expect(terminal.secret_masking).toBe(true);
    expect(terminal.default_term).toBe("xterm-256color");
  });

  test("the scrollback slider renders the server's real ceiling and default", async () => {
    // Asserted against the rendered DOM, not the source text: before the
    // reorganisation the slider offered 500 against a server that clamps
    // to [10, 50], and the absent-field fallback was 50 against a
    // documented default of 10.
    const target = openSurface();
    await flush();
    clickTab(target, "Terminal");
    await flush();
    const slider = target.querySelector(
      'input[aria-label="Terminal scrollback megabytes"]',
    ) as HTMLInputElement;
    expect(slider.max).toBe(String(SCROLLBACK_MB_MAX));
    expect(slider.min).toBe(String(SCROLLBACK_MB_MIN));
    expect(slider.value).toBe("50"); // the fixture's stored value
  });

  test("the scrollback fallback is SCROLLBACK_MB_DEFAULT when the field is absent", async () => {
    const terminal = server.preferences.terminal as Record<string, unknown>;
    delete terminal.scrollback_mb;
    const target = openSurface();
    await flush();
    clickTab(target, "Terminal");
    await flush();
    const slider = target.querySelector(
      'input[aria-label="Terminal scrollback megabytes"]',
    ) as HTMLInputElement;
    expect(slider.value).toBe(String(SCROLLBACK_MB_DEFAULT));
  });

  test("every pill renders inside a SettingField .control scope", async () => {
    // The pill CSS lives once in SettingField as :global descendant
    // rules, so a pill mounted outside a SettingField renders unstyled
    // (bare radio circles) and nothing reddens: the failure is silent
    // and visual only. This asserts the ancestor contract the single
    // block design makes cheap to check, including inside the
    // expandable colour blocks where the regression shipped.
    const target = openSurface();
    await flush();

    function expectPillsScoped(tab: string): void {
      const pills = target.querySelectorAll("label.pill");
      expect(pills.length, `${tab} mounts at least one pill`).toBeGreaterThan(0);
      for (const pill of pills) {
        expect(
          pill.closest(".control"),
          `label.pill "${pill.textContent?.trim()}" in ${tab} sits outside a SettingField`,
        ).not.toBeNull();
      }
    }

    for (const tab of [
      "Global",
      "Editor",
      "Terminal",
      "File browser",
      "Graph",
      "Dashboard",
      "Search",
    ]) {
      clickTab(target, tab);
      await flush();
      expectPillsScoped(tab);
    }

    // Open the two expandable colour blocks and re-check: their
    // pickers mount only then.
    clickTab(target, "Terminal");
    await flush();
    const termPill = [...target.querySelectorAll("label.pill")].find((e) =>
      e.textContent?.includes("Custom terminal colours"),
    ) as HTMLLabelElement;
    (termPill.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    await flush();
    expectPillsScoped("Terminal (custom colours open)");

    clickTab(target, "Graph");
    await flush();
    const graphPill = [...target.querySelectorAll("label.pill")].find((e) =>
      e.textContent?.includes("Custom graph colours"),
    ) as HTMLLabelElement;
    (graphPill.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    await flush();
    expectPillsScoped("Graph (custom colours open)");
  });

  test("one control per section writes a body falling on exactly one owner", async () => {
    const target = openSurface();
    await flush();

    // Drive one control in the named section and return its wire body,
    // asserting the body is single-owner (a mixed-owner patch is a 400
    // server-side). This holds today because nothing batches; the check
    // is here so it still holds with one section rendering both owners
    // (Terminal shows the Server `terminal` composite and the Editor
    // `terminal_colors` / `hybrid_surface_themes` slices side by side).
    async function drive(tab: string, act: () => void): Promise<Record<string, unknown>> {
      clickTab(target, tab);
      await flush();
      const before = patchBodies.length;
      act();
      await flush();
      expect(
        patchBodies.length,
        `expected a PATCH from the ${tab} drive`,
      ).toBeGreaterThan(before);
      const body = patchBodies[patchBodies.length - 1]!;
      expect(
        [...ownersOf(body)],
        `${tab} patch carries a single owner; keys: ${Object.keys(body)}`,
      ).toHaveLength(1);
      return body;
    }

    expect(
      Object.keys(
        await drive("Global", () =>
          (target.querySelector(
            'input[name="settings-theme"][value="dark"]',
          ) as HTMLInputElement).click(),
        ),
      ),
    ).toEqual(["theme"]);

    expect(
      Object.keys(
        await drive("Editor", () =>
          (target.querySelector(
            'input[name="settings-line-spacing"][value="compact"]',
          ) as HTMLInputElement).click(),
        ),
      ),
    ).toEqual(["line_spacing"]);

    expect(
      Object.keys(
        await drive("Terminal", () => {
          const pill = [...target.querySelectorAll("label.pill")].find((e) =>
            e.textContent?.includes("Allow in new terminals"),
          ) as HTMLLabelElement;
          (pill.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
        }),
      ),
    ).toEqual(["terminal"]);

    expect(
      Object.keys(
        await drive("File browser", () => {
          const pill = [...target.querySelectorAll("label.pill")].find(
            (e) => e.textContent?.trim() === "Right pane",
          ) as HTMLLabelElement;
          (pill.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
        }),
      ),
    ).toEqual(["browser_side_panes"]);

    expect(
      Object.keys(
        await drive("Graph", () => {
          const pill = [...target.querySelectorAll("label.pill")].find((e) =>
            e.textContent?.includes("Custom graph colours"),
          ) as HTMLLabelElement;
          (pill.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
        }),
      ),
    ).toEqual(["graph_colors"]);

    expect(
      Object.keys(
        await drive("Dashboard", () =>
          (target.querySelector(
            'input[name="settings-surface-theme-dashboard"][value="dark"]',
          ) as HTMLInputElement).click(),
        ),
      ),
    ).toEqual(["hybrid_surface_themes"]);

    expect(
      Object.keys(
        await drive("Search", () =>
          (target.querySelector(
            'input[name="settings-search"][value="aggressive"]',
          ) as HTMLInputElement).click(),
        ),
      ),
    ).toEqual(["search_aggression"]);
  });

  test("a stored invalid graph hue is dropped from the PATCH body", async () => {
    // The server serves stored hues unvalidated but rejects the whole
    // graph_colors object with a 400 on any invalid hex, and
    // preferences.toml is hand-editable: without the commit-path
    // sanitize in GraphSection, one bad stored hue silently fails every
    // palette write until the TOML is fixed out of band.
    server.preferences.graph_colors = {
      mode: "custom",
      dark: { doc: "chartreuse", tag: "#6cd07a" },
      light: { source: "#2851c4" },
    };
    const target = openSurface();
    await flush();
    clickTab(target, "Graph");
    await flush();

    const img = target.querySelector("#graph-colour-img") as HTMLInputElement;
    expect(img, "media colour row").not.toBeNull();
    img.value = "#112233";
    img.dispatchEvent(new Event("input", { bubbles: true }));
    img.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    await flush();

    expect(patchBodies.length).toBeGreaterThanOrEqual(1);
    const body = patchBodies[patchBodies.length - 1]!;
    expect(Object.keys(body)).toEqual(["graph_colors"]);
    // The invalid stored hue (doc) is gone; its valid neighbour, the
    // dormant light palette and the new edit all survive.
    expect(body.graph_colors).toEqual({
      mode: "custom",
      dark: { tag: "#6cd07a", img: "#112233" },
      light: { source: "#2851c4" },
    });
  });
});
