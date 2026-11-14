// @vitest-environment jsdom
//
// A window with no workspace behind it reads its preferences from the
// `/api/config` the slim terminal tenant serves, at boot and on every
// `config_changed`. The saved shortcut table is part of them: the window's
// chords resolve with it as a workspace window's do, and a saved chord for a
// retired command id is dropped from it there too. The rest of the workspace
// window's preference mirror stays out: the docked file browsers stay off,
// since this tenant serves no `/api/fs`, and the theme follows the launcher.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Read at module load, so the window must be a standalone one before any app
// module runs.
vi.hoisted(() => {
  window.history.replaceState({}, "", "/?kind=terminal&w=w-shortcuts");
});

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinksAddonModule());

// The launcher's own light or dark choice, which a standalone window follows
// in place of the saved `theme`.
const launcherTheme = vi.hoisted(() => ({ value: "dark" as string | null }));

vi.mock("./api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api/client")>();
  return {
    ...actual,
    openLocalThemeWatch: (apply: (theme: string | null) => void) => {
      apply(launcherTheme.value);
      return () => {};
    },
  };
});

import { api } from "./api/client";
import type { Preferences } from "./api/types";
import { mountApp, press, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { hydrateOverrides, overrideChordFor } from "./state/keymapOverrides.svelte";
import { chordFor } from "./state/shortcuts";
import {
  browserSidePanes,
  closeSettings,
  dismissStatus,
  onWatchEvent,
  settingsPanel,
  ui,
} from "./state/store.svelte";
import { windowCaps } from "./state/windowCaps";

stubAppEnvironment();

/// A browser on Linux: the page reads the `web` slot, and Settings' built-in
/// chord is Ctrl+,.
const ASSIGNED: KeyboardEventInit = { key: "y", code: "KeyY", ctrlKey: true, altKey: true };
const BUILT_IN: KeyboardEventInit = { key: ",", code: "Comma", ctrlKey: true };

beforeEach(() => {
  launcherTheme.value = "dark";
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
  );
});

afterEach(async () => {
  dismissStatus();
  closeSettings();
  hydrateOverrides(null);
  await unmountApp();
  vi.restoreAllMocks();
});

/// Whether `init` opens Settings in this window. Closes it again after.
async function opensSettings(init: KeyboardEventInit): Promise<boolean> {
  closeSettings();
  press(init);
  await settle();
  const opened = settingsPanel.open;
  closeSettings();
  await settle();
  return opened;
}

/// Store `prefs` the way another window's settings write does, then deliver
/// the frame the server broadcasts after it.
async function savedElsewhere(prefs: Partial<Preferences>): Promise<void> {
  const current = await api.config();
  await api.updateConfig({ expected_revision: current.revision, preferences: prefs });
  onWatchEvent({ kind: "config_changed" });
}

function statusText(target: HTMLElement): string | undefined {
  return target.querySelector('[aria-label="status message"]')?.textContent?.trim();
}

test("the window under test has no workspace and no file surface", () => {
  expect(windowCaps.workspace).toBe(false);
  expect(windowCaps.files).toBe(false);
});

describe("a standalone terminal window resolves its chords with the saved shortcuts", () => {
  test("from its first load", async () => {
    await mountApp(undefined, {
      preferences: { shortcuts: { "app.settings.open": { web: "Ctrl+Alt+Y" } } },
    });

    expect(chordFor("app.settings.open")).toBe("Ctrl+Alt+Y");
    expect(await opensSettings(ASSIGNED), "the saved chord runs the command").toBe(true);
    expect(await opensSettings(BUILT_IN), "the built-in chord it replaced runs nothing").toBe(false);
  });

  test("after a change saved from another window, and after that change is cleared", async () => {
    await mountApp();
    expect(await opensSettings(ASSIGNED), "nothing is assigned yet").toBe(false);
    expect(await opensSettings(BUILT_IN)).toBe(true);

    await savedElsewhere({ shortcuts: { "app.settings.open": { web: "Ctrl+Alt+Y" } } });
    await vi.waitFor(() => expect(overrideChordFor("app.settings.open")).toBe("Ctrl+Alt+Y"));
    expect(await opensSettings(ASSIGNED)).toBe(true);
    expect(await opensSettings(BUILT_IN)).toBe(false);

    await savedElsewhere({ shortcuts: {} });
    await vi.waitFor(() => expect(overrideChordFor("app.settings.open")).toBeUndefined());
    expect(await opensSettings(ASSIGNED)).toBe(false);
    expect(await opensSettings(BUILT_IN)).toBe(true);
  });
});

describe("a standalone terminal window drops a saved chord for a retired command", () => {
  test("at its first load, from the saved table, and says so", async () => {
    const target = await mountApp(undefined, {
      preferences: {
        shortcuts: {
          "app.theme.dark": { web: "Mod+Alt+D" },
          "app.settings.open": { web: "Ctrl+Alt+Y" },
        },
      },
    });

    await vi.waitFor(() =>
      expect(statusText(target)).toBe("Dropped saved shortcuts for 1 removed command"),
    );
    expect((await api.config()).preferences.shortcuts).toEqual({
      "app.settings.open": { web: "Ctrl+Alt+Y" },
    });
    expect(overrideChordFor("app.theme.dark")).toBeUndefined();
    expect(overrideChordFor("app.settings.open")).toBe("Ctrl+Alt+Y");
  });

  test("when one arrives with a change saved from another window", async () => {
    const target = await mountApp();
    expect(statusText(target)).toBeUndefined();

    await savedElsewhere({
      shortcuts: {
        "app.pane.focusColor.blue": { web: "Mod+Alt+B" },
        "app.settings.open": { web: "Ctrl+Alt+Y" },
      },
    });

    await vi.waitFor(() =>
      expect(statusText(target)).toBe("Dropped saved shortcuts for 1 removed command"),
    );
    expect((await api.config()).preferences.shortcuts).toEqual({
      "app.settings.open": { web: "Ctrl+Alt+Y" },
    });
    expect(overrideChordFor("app.pane.focusColor.blue")).toBeUndefined();
    expect(overrideChordFor("app.settings.open")).toBe("Ctrl+Alt+Y");
  });
});

describe("the shortcuts come without the rest of the workspace window's preference mirror", () => {
  // Saved by a workspace window: both docks on and the light theme.
  const MIRRORED: Partial<Preferences> = {
    theme: "light",
    browser_side_panes: { left: true, right: true },
  };

  test("at its first load the docks stay off and the theme stays the launcher's", async () => {
    await mountApp(undefined, {
      preferences: { ...MIRRORED, shortcuts: { "app.settings.open": { web: "Ctrl+Alt+Y" } } },
    });

    expect(overrideChordFor("app.settings.open"), "the shortcuts did load").toBe("Ctrl+Alt+Y");
    expect(browserSidePanes).toEqual({ left: false, right: false });
    expect(ui.themeChoice).toBe("dark");
  });

  test("after a change saved from another window the docks stay off and the theme stays the launcher's", async () => {
    await mountApp();
    expect(ui.themeChoice).toBe("dark");

    await savedElsewhere({ ...MIRRORED, shortcuts: { "app.settings.open": { web: "Ctrl+Alt+Y" } } });
    await vi.waitFor(() => expect(overrideChordFor("app.settings.open")).toBe("Ctrl+Alt+Y"));
    await settle();

    expect(browserSidePanes).toEqual({ left: false, right: false });
    expect(ui.themeChoice).toBe("dark");
  });
});
