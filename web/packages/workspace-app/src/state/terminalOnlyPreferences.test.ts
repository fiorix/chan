// @vitest-environment jsdom
//
// A standalone terminal window is the same SPA in terminal-only mode, served
// by the slim tenant. That tenant mounts no /api/workspace, so the window
// never receives the preference payload a workspace window gets for free, and
// every `workspace.info?.preferences` read falls back to a default: not only
// the custom colours and font size, but the selected backend, scrollback,
// mouse capture, and secret masking too. The tenant does serve /api/config,
// which returns the same `Preferences` shape.
//
// Two boundaries, one per test, deliberately not merged into one case. Fixing
// initial load without the refresh path leaves a live settings change inert;
// fixing the refresh path without initial load leaves a fresh window on
// defaults. Each test fails on its own boundary so a half fix cannot go green.

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { GlobalConfig, Preferences } from "../api/types";
import { ApiError } from "../api/errors";

function preferences(overrides: Partial<Preferences> = {}): Preferences {
  return {
    editor_theme: "github",
    attachments_dir: "attachments",
    theme: "dark",
    pane_widths: { inspector: 320, graph: 320, browser: 320, search: 320, outline: 240 },
    line_spacing: "normal",
    date_format: "iso",
    strip_trailing_whitespace_on_save: false,
    search_aggression: "balanced",
    terminal: {
      idle_timeout_secs: 0,
      session_cap: 8,
      ring_bytes: 1024,
      font_size: 20,
      ghostty: true,
      scrollback_mb: 80,
      mouse_capture: false,
      secret_masking: true,
    },
    terminal_colors: {
      mode: "custom",
      custom: {
        background: "#101820",
        foreground: "#e8e8ea",
        cursor: "#ffb000",
        contrast: "dark",
      },
    },
    ...overrides,
  } as unknown as Preferences;
}

function config(prefs: Preferences): GlobalConfig {
  return { revision: 1, preferences: prefs, workspaces: [] };
}

const apiConfig = vi.fn<() => Promise<GlobalConfig>>();
const apiWorkspace = vi.fn<() => Promise<never>>();

// Partial mock: the store also imports ApiError from this module and does an
// `instanceof` check on it, so the real class has to stay reachable and be the
// same class object the test constructs.
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      config: () => apiConfig(),
      // The slim tenant really does 404 here. Rejecting rather than resolving
      // keeps a fix that reaches for the wrong endpoint from passing quietly.
      workspace: () => apiWorkspace(),
      getSession: () => Promise.resolve(null),
      putSession: () => Promise.resolve(),
    },
    openWatchSocket: () => () => {},
  };
});

let store: typeof import("./store.svelte");

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  apiWorkspace.mockRejectedValue(new ApiError(404, "not found"));
  window.history.replaceState({}, "", "/?kind=terminal");
  sessionStorage.clear();
  localStorage.clear();
  store = await import("./store.svelte");
});

describe("a standalone terminal loads its preferences at boot", () => {
  test("bootstrap seeds the preference source from /api/config", async () => {
    apiConfig.mockResolvedValue(config(preferences()));

    await store.bootstrap();

    // Assert the values, not merely that a source exists: seeding an empty
    // or default Preferences object would satisfy a non-null check while
    // still showing the user a 14px standard-colour xterm.
    const prefs = store.currentPreferences();
    expect(prefs?.terminal.font_size).toBe(20);
    expect(prefs?.terminal_colors?.mode).toBe("custom");
    expect(prefs?.terminal_colors?.custom?.background).toBe("#101820");
    // The whole payload arrives, not an appearance slice of it, so every
    // setting the same source feeds reaches the terminal. A user who picked
    // ghostty previously got xterm.js in every standalone window.
    expect(prefs?.terminal.ghostty).toBe(true);
    expect(prefs?.terminal.scrollback_mb).toBe(80);
    expect(prefs?.terminal.mouse_capture).toBe(false);
    expect(prefs?.terminal.secret_masking).toBe(true);
    expect(apiWorkspace).not.toHaveBeenCalled();
  });
});

describe("a standalone terminal follows a live settings change", () => {
  test("a config_changed frame refreshes the preference source", async () => {
    // Seed the source directly rather than relying on the boot fix, so this
    // test fails on the refresh boundary alone and stays red even if initial
    // load is fixed first.
    apiConfig.mockResolvedValue(config(preferences()));
    await store.bootstrap();
    store.__testSetStandalonePreferences(preferences());

    apiConfig.mockResolvedValue(
      config(
        preferences({
          terminal_colors: {
            mode: "custom",
            custom: {
              background: "#fdf6e3",
              foreground: "#073642",
              cursor: "#268bd2",
              contrast: "light",
            },
          },
        } as unknown as Partial<Preferences>),
      ),
    );

    store.onWatchEvent({ kind: "config_changed" });
    await vi.waitFor(() => {
      expect(store.currentPreferences()?.terminal_colors?.custom?.background).toBe(
        "#fdf6e3",
      );
    });

    expect(store.currentPreferences()?.terminal_colors?.custom?.contrast).toBe("light");
    expect(apiWorkspace).not.toHaveBeenCalled();
  });
});

describe("the workspace path is unchanged", () => {
  test("a workspace window still sources preferences from /api/workspace", async () => {
    window.history.replaceState({}, "", "/");
    vi.resetModules();
    const fresh = await import("./store.svelte");
    apiWorkspace.mockResolvedValue({
      root: "/tmp/ws",
      label: "ws",
      metadata_key: "k",
      drafts_dir: ".Drafts",
      preferences: preferences({ terminal: { font_size: 11 } } as unknown as Partial<Preferences>),
      warnings: [],
    } as never);

    await fresh.bootstrap();

    expect(fresh.currentPreferences()?.terminal.font_size).toBe(11);
    // The workspace payload already carries preferences, so the window must
    // not pay for a second round-trip it does not need.
    expect(apiConfig).not.toHaveBeenCalled();
  });
});
