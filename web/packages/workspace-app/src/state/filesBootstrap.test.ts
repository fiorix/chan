// @vitest-environment jsdom
//
// A Files window (`?kind=files`) is the same SPA served by the shared
// standalone tenant plus the Files filesystem surface. That tenant mounts no
// `/api/workspace`, no index, no graph, and no live document authority, so
// the boot has to reach exactly five things: preferences, the filesystem
// context, the layout blob, the root listing, and the listings down to the
// window's home directory.
//
// The api mock therefore defines ONLY the calls the boot is allowed to make.
// Any other `api.*` call throws rather than resolving, so a boot that reaches
// for a workspace endpoint fails loudly here instead of 404ing at runtime in
// a window the user is looking at.

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { GlobalConfig, Preferences, TreeEntry } from "../api/types";
import { ApiError } from "../api/errors";

const HOME = "home/u";

function preferences(): Preferences {
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
      font_size: 14,
      ghostty: false,
      scrollback_mb: 20,
      mouse_capture: false,
      secret_masking: true,
    },
  } as unknown as Preferences;
}

function entry(path: string, isDir: boolean): TreeEntry {
  return { path, is_dir: isDir, mtime: 1, size: 0 } as TreeEntry;
}

const apiConfig = vi.fn<() => Promise<GlobalConfig>>();
const apiWorkspace = vi.fn<() => Promise<never>>();
const apiFsContext = vi.fn();
const apiList = vi.fn<(dir?: string) => Promise<TreeEntry[]>>();
const apiGetSession = vi.fn<() => Promise<unknown | null>>();

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      config: () => apiConfig(),
      // The standalone tenant really does 404 here; rejecting keeps a boot
      // that reaches for it from passing quietly.
      workspace: () => apiWorkspace(),
      fsContext: () => apiFsContext(),
      list: (dir?: string) => apiList(dir),
      getSession: () => apiGetSession(),
      putSession: () => Promise.resolve(),
    },
    openWatchSocket: () => () => {},
  };
});

let store: typeof import("./store.svelte");
let tabs: typeof import("./tabs.svelte");

function openTabs(): { kind: string; selected?: string | null }[] {
  const out: { kind: string; selected?: string | null }[] = [];
  for (const node of Object.values(tabs.layout.nodes)) {
    if (node.kind !== "leaf") continue;
    for (const tab of tabs.allPaneTabs(node)) {
      out.push({
        kind: tab.kind,
        selected: tab.kind === "browser" ? tab.selected : undefined,
      });
    }
  }
  return out;
}

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  apiWorkspace.mockRejectedValue(new ApiError(404, "not found"));
  apiConfig.mockResolvedValue({ revision: 1, preferences: preferences(), workspaces: [] });
  apiFsContext.mockResolvedValue({
    protocol: 1,
    root: "/",
    home: HOME,
    path_style: "posix",
  });
  apiGetSession.mockResolvedValue(null);
  apiList.mockImplementation(async (dir?: string) => {
    if (dir === "") return [entry("home", true), entry("etc", true)];
    if (dir === "home") return [entry("home/u", true)];
    if (dir === HOME) return [entry(`${HOME}/notes.md`, false)];
    return [];
  });
  window.history.replaceState({}, "", `/?kind=files&w=w-files`);
  sessionStorage.clear();
  localStorage.clear();
  store = await import("./store.svelte");
  tabs = await import("./tabs.svelte");
});

describe("a files window boots against the standalone tenant only", () => {
  test("it reads the filesystem context and never the workspace payload", async () => {
    await store.bootstrap();

    expect(apiFsContext).toHaveBeenCalled();
    expect(apiWorkspace).not.toHaveBeenCalled();
    // Preferences come from the route the standalone tenant serves, so the
    // window is not left on defaults.
    expect(store.currentPreferences()?.terminal.scrollback_mb).toBe(20);
  });

  test("it lists the root and the chain down to home, never recursively", async () => {
    await store.bootstrap();

    const dirs = apiList.mock.calls.map(([dir]) => dir);
    expect(dirs).toContain("");
    expect(dirs).toContain("home");
    expect(dirs).toContain(HOME);
    // A bare call is the recursive whole-tree listing, which at a root of
    // `/` would walk the machine.
    expect(dirs.every((dir) => typeof dir === "string")).toBe(true);
  });

  test("a fresh window is one file browser opened at home, and nothing else", async () => {
    await store.bootstrap();

    const open = openTabs();
    expect(open).toHaveLength(1);
    expect(open[0]?.kind).toBe("browser");
    // Opened AT home, not merely selecting it under a collapsed root.
    expect(open[0]?.selected).toBe(HOME);
  });

  test("the window keeps a file context that translates paths without a workspace", async () => {
    const { filesContext, displayPath, wirePathFromAbsolute } = await import(
      "./fileContext.svelte"
    );

    await store.bootstrap();

    const ctx = filesContext.current;
    expect(ctx?.homeWire).toBe(HOME);
    expect(ctx?.rootDisplay).toBe("/");
    expect(ctx && displayPath(ctx, `${HOME}/notes.md`)).toBe(`/${HOME}/notes.md`);
    // A terminal reports an absolute cwd; the context is what turns it back
    // into the wire form the file routes take.
    expect(ctx && wirePathFromAbsolute(ctx, `/${HOME}/notes`)).toBe(`${HOME}/notes`);
    expect(ctx && wirePathFromAbsolute(ctx, "/")).toBe("");
  });
});
