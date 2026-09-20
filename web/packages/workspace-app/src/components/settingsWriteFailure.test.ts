// @vitest-environment jsdom
//
// A settings write that the server refuses has to say so, on the field
// that failed, and leave that field showing the value the server holds.
// The overlay writes optimistically into a buffer, so a rejected PATCH
// that nobody catches leaves the refused value on screen and reports
// nothing, which reads to the user as saved.
//
// Beside it: a control commits once per user decision. The native colour
// picker fires an input event per intermediate colour of a drag, and each
// one of those is a whole GET plus PATCH of the config.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import SettingsOverlay from "./SettingsOverlay.svelte";
import ColorField from "./settings/ColorField.svelte";
import { settingsPanel } from "../state/store.svelte";
import { DATE_FORMATS } from "../editor/dateFormats";

const REFUSAL = "configuration is locked";

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
  };
}

let server: Cfg;
let patchCount: number;
const mounted: Array<Record<string, unknown>> = [];
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await tick();
    await Promise.resolve();
  }
  // An unhandled rejection is reported a macrotask later, so give the
  // loop a turn before asking whether one happened.
  await new Promise((resolve) => setTimeout(resolve, 0));
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

beforeEach(() => {
  server = { revision: 1, preferences: basePrefs(), workspaces: [] };
  patchCount = 0;
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
  settingsPanel.open = false;
  document.documentElement.dataset.theme = "dark";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url.includes("/api/config")) {
      if (method === "PATCH") {
        patchCount++;
        // What a locked configuration answers: the write is refused and
        // the server's value is unchanged.
        return new Response(JSON.stringify({ error: REFUSAL }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(server), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(null, { status: 404 });
  });
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  for (const c of mounted.splice(0)) unmount(c);
  settingsPanel.open = false;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("a settings write the server refuses", () => {
  test("reports on the field and leaves the server's value showing", async () => {
    const target = openSurface();
    await flush();
    clickTab(target, "Editor");
    await flush();
    const word = target.querySelector(
      'input[type="radio"][value="word"]',
    ) as HTMLInputElement;
    expect(word).not.toBeNull();
    word.click();
    await flush();

    expect(patchCount).toBeGreaterThan(0);
    expect(unhandled).toEqual([]);

    // The failure is visible where it happened, not swallowed and not
    // parked on the overlay's load-error line.
    const field = word.closest("section.field") as HTMLElement | null;
    expect(field, "the radio's field section").not.toBeNull();
    const alert = field!.querySelector('[role="alert"]');
    expect(alert?.textContent ?? "").not.toBe("");

    // And the control is back on what the server holds.
    const github = target.querySelector(
      'input[type="radio"][value="github"]',
    ) as HTMLInputElement;
    expect(github.checked).toBe(true);
    expect(word.checked).toBe(false);
  });
});

describe("the colour picker", () => {
  test("one drag through it commits once", async () => {
    const commits: Array<string | null> = [];
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(
      mount(ColorField, {
        target,
        props: {
          id: "c",
          label: "Accent",
          value: "#112233",
          oncommit: (hex: string | null) => commits.push(hex),
        },
      }) as Record<string, unknown>,
    );
    await tick();
    const swatch = target.querySelector('input[type="color"]') as HTMLInputElement;
    expect(swatch).not.toBeNull();
    // A drag: the native control reports every intermediate colour as it
    // moves, then one change when the user is done.
    for (const hex of ["#223344", "#334455", "#445566"]) {
      swatch.value = hex;
      swatch.dispatchEvent(new Event("input", { bubbles: true }));
    }
    swatch.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    expect(commits).toEqual(["#445566"]);
  });
});
