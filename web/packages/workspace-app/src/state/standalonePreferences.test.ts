// @vitest-environment jsdom
//
// A standalone window has no `workspace.info`, so any surface that reads its
// preferences straight off it silently renders on defaults. It renders a full
// editor and a file browser, so every reader of a user-visible setting goes
// through `currentPreferences()`, which falls back to the machine preferences
// the standalone tenant serves from `/api/config`. Each reader is driven here
// with no workspace info and the machine preferences set.

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { flushSync, mount, tick, unmount, type ComponentProps } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { GlobalConfig, HybridSurfaceThemes, Preferences } from "../api/types";
import { __testSetStandalonePreferences, currentPreferences, workspace } from "./store.svelte";
import "./commands/install";
import { defaultDateFormatId } from "../editor/commands/date_macros";
import { chanMarkdown } from "../editor/markdown/grammar";
import { dateDecorations } from "../editor/widgets/date";
import SourceComponent from "../editor/Source.svelte";
import SettingsOverlay from "../components/SettingsOverlay.svelte";
import Pane from "../components/Pane.svelte";
import App from "../App.svelte";
import { installDemoWorkspace } from "../demo/install";
import { teardownDemoApp } from "../demo/teardown";
import { trackTimers } from "../demo/timers";
import { preferences } from "../__tests__/standalone";
import { resetLayout, terminalTab } from "../__tests__/tabs";
import { installEditorDom, mountWysiwyg, unmountWysiwygs } from "../__tests__/wysiwyg";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinksAddonModule());

installEditorDom();
HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
Object.defineProperty(document, "fonts", {
  configurable: true,
  value: { load: vi.fn(async () => [{}]), ready: Promise.resolve() },
});

const mounted: Array<Record<string, unknown>> = [];
const views: EditorView[] = [];

afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  for (const v of views.splice(0)) v.destroy();
  unmountWysiwygs();
  document.body.innerHTML = "";
  __testSetStandalonePreferences(null);
  document.documentElement.removeAttribute("data-editor-theme");
  document.documentElement.style.removeProperty("--chan-editor-body-size");
  document.documentElement.style.removeProperty("--chan-editor-source-size");
});

describe("a window with no workspace still reads its machine preferences", () => {
  test("currentPreferences falls back to what the standalone tenant served", () => {
    expect(currentPreferences()).toBeNull();
    __testSetStandalonePreferences(preferences({ date_format: "mdy-slash" }));
    expect(currentPreferences()?.date_format).toBe("mdy-slash");
  });

  test("the date macros honour the standalone date_format", () => {
    expect(defaultDateFormatId()).toBe("iso");
    __testSetStandalonePreferences(preferences({ date_format: "mdy-slash" }));
    expect(defaultDateFormatId()).toBe("mdy-slash");
  });
});

describe("each reader of a setting", () => {
  test("Wysiwyg takes its line spacing", async () => {
    __testSetStandalonePreferences(preferences({ line_spacing: "compact" }));
    const { target } = await mountWysiwyg({ value: "text" });
    expect(target.querySelector<HTMLElement>(".md-wysiwyg-cm6")?.dataset.density).toBe("compact");
  });

  test("Source takes its line spacing", () => {
    __testSetStandalonePreferences(preferences({ line_spacing: "compact" }));
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(
      mount(SourceComponent, {
        target,
        props: { autoFocus: false, path: "note.md", value: "text" } as ComponentProps<typeof SourceComponent>,
      }),
    );
    flushSync();
    expect(target.querySelector<HTMLElement>(".md-source")?.dataset.density).toBe("compact");
  });

  test("date pills read an ambiguous date in the configured format", () => {
    // 03/04/2025 is a date in both slash formats; the preference decides.
    const doc = "due 03/04/2025";
    const pillFormats = (): string[] => {
      const parent = document.createElement("div");
      document.body.append(parent);
      const view = new EditorView({
        parent,
        state: EditorState.create({ doc, extensions: [chanMarkdown(), dateDecorations()] }),
      });
      views.push(view);
      return [...parent.querySelectorAll<HTMLElement>(".cm-md-date-pill")].map((p) => p.dataset.formatId!);
    };
    __testSetStandalonePreferences(preferences({ date_format: "dmy-slash" }));
    expect(pillFormats()).toEqual(["dmy-slash"]);
    __testSetStandalonePreferences(preferences({ date_format: "mdy-slash" }));
    expect(pillFormats()).toEqual(["mdy-slash"]);
  });

  test("Settings applies the editor font size while closed", () => {
    __testSetStandalonePreferences(preferences({ editor_font_size: 18 }));
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(SettingsOverlay, { target }));
    flushSync();
    expect(document.documentElement.style.getPropertyValue("--chan-editor-body-size")).toBe("18px");
  });

  test("the pane strip hides a lone tab under pane_strip_auto_hide", () => {
    __testSetStandalonePreferences(preferences({ pane_strip_auto_hide: true }));
    const pane = resetLayout([terminalTab({ id: "lone" })]);
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(Pane, { target, props: { pane } }));
    flushSync();
    expect(target.querySelector(".tabs.auto-hidden"), "a lone tab draws no strip").not.toBeNull();
  });

  test("the app applies the editor theme", async () => {
    const timers = trackTimers();
    const app: Array<Record<string, unknown>> = [];
    try {
      installDemoWorkspace({
        metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1_700_000_000_000, fileCount: 0, textCount: 0 },
        files: [],
      });
      const target = document.createElement("div");
      document.body.append(target);
      app.push(mount(App, { target }));
      await vi.waitFor(() => expect(workspace.info).not.toBeNull());
      for (let i = 0; i < 4; i += 1) await tick();

      workspace.info = null;
      __testSetStandalonePreferences(preferences({ editor_theme: "word" }));
      for (let i = 0; i < 4; i += 1) await tick();
      expect(document.documentElement.getAttribute("data-editor-theme")).toBe("word");
    } finally {
      await teardownDemoApp({ mounted: app, timers });
    }
  });
});

// The server stores the surface-theme table it is sent whole, so a write has
// to carry every surface's stored theme, whatever the window that sends it
// holds. Each case runs a fresh store, in a window with no workspace unless
// it says otherwise, over a config route that stores a PATCH the way the
// server does.
describe("the per-surface body themes", () => {
  const href = window.location.href;
  const STORED: HybridSurfaceThemes = { editor: "light", terminal: "dark" };
  let server: GlobalConfig;
  let tables: unknown[];
  let store: typeof import("./store.svelte");

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  /// A fresh module graph for a window of `kind`: the capabilities are read
  /// from the URL once, at module load.
  async function openWindow(kind: "terminal" | "workspace"): Promise<void> {
    vi.resetModules();
    window.history.replaceState({}, "", kind === "terminal" ? "/?kind=terminal" : "/");
    store = await import("./store.svelte");
    const { windowCaps } = await import("./windowCaps");
    expect(windowCaps.workspace, `a ${kind} window`).toBe(kind === "workspace");
  }

  function liveTable(): HybridSurfaceThemes {
    const out: HybridSurfaceThemes = {};
    for (const kind of store.HYBRID_SURFACE_KINDS) {
      const value = store.surfaceThemeOverride(kind);
      if (value) out[kind] = value;
    }
    return out;
  }

  beforeEach(() => {
    server = { revision: 7, preferences: preferences({ hybrid_surface_themes: { ...STORED } }), workspaces: [] };
    tables = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/api/workspace")) {
        return json({ root: "/tmp/ws", label: "ws", metadata_key: "k", preferences: server.preferences, warnings: [] });
      }
      if (!url.includes("/api/config")) return new Response(null, { status: 404 });
      if (init?.method !== "PATCH") return json(server);
      const sent = JSON.parse(String(init.body)) as { expected_revision: number; preferences: Partial<Preferences> };
      expect(sent.expected_revision).toBe(server.revision);
      tables.push(sent.preferences.hybrid_surface_themes);
      server = {
        ...server,
        revision: server.revision + 1,
        preferences: { ...server.preferences, ...sent.preferences },
      };
      return json(server);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", href);
    vi.resetModules();
  });

  test("a Dashboard theme set in a window with no workspace keeps the other surfaces' stored themes", async () => {
    await openWindow("terminal");
    // The frame every window hears after a settings write, and the same
    // refresh this window runs at boot.
    store.onWatchEvent({ kind: "config_changed" });
    await vi.waitFor(() => expect(store.currentPreferences()).not.toBeNull());
    expect(liveTable(), "the window took the served table").toEqual(STORED);

    await store.setHybridSurfaceTheme("dashboard", "dark");

    expect(tables).toEqual([{ editor: "light", terminal: "dark", dashboard: "dark" }]);
    expect(server.preferences.hybrid_surface_themes).toEqual({ editor: "light", terminal: "dark", dashboard: "dark" });
    expect(liveTable()).toEqual({ editor: "light", terminal: "dark", dashboard: "dark" });
  });

  test("a write merges over the table the server holds, not over the window's own", async () => {
    await openWindow("terminal");
    // No refresh has run: the window's own table is empty.
    expect(liveTable()).toEqual({});

    await store.setHybridSurfaceTheme("dashboard", "dark");
    expect(tables.at(-1)).toEqual({ editor: "light", terminal: "dark", dashboard: "dark" });

    // A clear drops its own surface and nothing else.
    await store.clearHybridSurfaceTheme("terminal");
    expect(tables.at(-1)).toEqual({ editor: "light", dashboard: "dark" });
  });

  test("a config_changed frame brings a window with no workspace a theme stored elsewhere, and takes back a cleared one", async () => {
    await openWindow("terminal");
    server = { ...server, preferences: { ...server.preferences, hybrid_surface_themes: { dashboard: "dark" } } };
    store.onWatchEvent({ kind: "config_changed" });
    await vi.waitFor(() => expect(store.surfaceThemeOverride("dashboard")).toBe("dark"));

    server = { ...server, preferences: { ...server.preferences, hybrid_surface_themes: { editor: "light" } } };
    store.onWatchEvent({ kind: "config_changed" });
    await vi.waitFor(() => expect(liveTable()).toEqual({ editor: "light" }));
    expect(tables, "a refresh writes nothing").toEqual([]);
  });

  test("a workspace window sends the stored table with its one change, and keeps a theme stored since its last refresh", async () => {
    await openWindow("workspace");
    await store.refreshWorkspace();
    expect(liveTable()).toEqual(STORED);

    await store.setHybridSurfaceTheme("dashboard", "dark");
    expect(tables.at(-1)).toEqual({ editor: "light", terminal: "dark", dashboard: "dark" });

    // Another window stores a Graph theme, and this one has not heard yet.
    server = {
      ...server,
      revision: server.revision + 1,
      preferences: { ...server.preferences, hybrid_surface_themes: { ...server.preferences.hybrid_surface_themes, graph: "light" } },
    };
    await store.clearHybridSurfaceTheme("editor");
    expect(tables.at(-1)).toEqual({ terminal: "dark", dashboard: "dark", graph: "light" });
  });
});
