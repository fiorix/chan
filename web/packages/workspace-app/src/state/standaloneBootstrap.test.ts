// @vitest-environment jsdom
//
// The standalone terminal window's boot, with and without a filesystem
// behind it. Both shapes ride the same shared tenant: it mounts no
// `/api/workspace`, no index, no graph, and no live document authority, and
// it mounts the filesystem surface only where the host could build one --
// which the served shell declares as `<meta name="chan-files">`.
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

/// Declare (or withdraw) one of the tenant's capability metas exactly the
/// way chan-server injects them into the served shell. Must run before the
/// state modules are imported: the capabilities are read once at module
/// load.
function serveMeta(name: string, on: boolean): void {
  document.head.querySelector(`meta[name="${name}"]`)?.remove();
  if (!on) return;
  const meta = document.createElement("meta");
  meta.setAttribute("name", name);
  meta.setAttribute("content", "1");
  document.head.appendChild(meta);
}

async function boot(withFiles: boolean, withDrafts = false): Promise<void> {
  serveMeta("chan-files", withFiles);
  serveMeta("chan-drafts", withDrafts);
  store = await import("./store.svelte");
  tabs = await import("./tabs.svelte");
  await store.bootstrap();
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
    drafts_dir: `${HOME}/.chan/Drafts`,
  });
  apiGetSession.mockResolvedValue(null);
  apiList.mockImplementation(async (dir?: string) => {
    if (dir === "") return [entry("home", true), entry("etc", true)];
    if (dir === "home") return [entry("home/u", true)];
    if (dir === HOME) return [entry(`${HOME}/notes.md`, false)];
    return [];
  });
  window.history.replaceState({}, "", `/?kind=terminal&w=w-term`);
  sessionStorage.clear();
  localStorage.clear();
});

describe("a standalone terminal window whose tenant serves files", () => {
  test("it reads the filesystem context and never the workspace payload", async () => {
    await boot(true);

    expect(apiFsContext).toHaveBeenCalled();
    expect(apiWorkspace).not.toHaveBeenCalled();
    // Preferences come from the route the standalone tenant serves, so the
    // window is not left on defaults.
    expect(store.currentPreferences()?.terminal.scrollback_mb).toBe(20);
  });

  test("it lists the root and the chain down to home, never recursively", async () => {
    await boot(true);

    const dirs = apiList.mock.calls.map(([dir]) => dir);
    expect(dirs).toContain("");
    expect(dirs).toContain("home");
    expect(dirs).toContain(HOME);
    // A bare call is the recursive whole-tree listing, which at a root of
    // `/` would walk the machine.
    expect(dirs.every((dir) => typeof dir === "string")).toBe(true);
  });

  test("a fresh window is one terminal, the file surface waiting behind it", async () => {
    await boot(true);

    // This is a terminal window: it opens on a shell, not on a browser. The
    // browser is a tab the user opens when they want it, which is why the
    // tree above is primed.
    const open = openTabs();
    expect(open).toHaveLength(1);
    expect(open[0]?.kind).toBe("terminal");
    // And the window is not the narrow terminals-only one: the file browser
    // and the editor are dispatchable in it.
    expect(store.isTerminalOnlyWindow()).toBe(false);
  });

  test("the window keeps a file context that translates paths without a workspace", async () => {
    const { filesContext, displayPath, wirePathFromAbsolute } = await import(
      "./fileContext.svelte"
    );

    await boot(true);

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

describe("a standalone terminal window whose tenant serves drafts", () => {
  test("the drafts wire dir lands in the choke point and classifies draft paths", async () => {
    await boot(true, true);
    // Imported AFTER boot: boot resets the module registry, and a handle
    // captured before it would watch the stale generation's state.
    const workspaceState = await import("./workspace.svelte");

    expect(workspaceState.draftsDir()).toBe(`${HOME}/.chan/Drafts`);
    expect(workspaceState.isDraftPath(`${HOME}/.chan/Drafts/untitled/draft.md`)).toBe(true);
    expect(workspaceState.isDraftPath(`${HOME}/notes.md`)).toBe(false);
  });

  test("without the meta the context field alone enables nothing", async () => {
    // The meta tag is the capability; a drafts_dir in the fs context of a
    // tenant that did not advertise one must not half-enable the feature.
    await boot(true, false);
    const workspaceState = await import("./workspace.svelte");

    expect(workspaceState.draftsDir()).toBe(null);
    expect(workspaceState.isDraftPath(`${HOME}/.chan/Drafts/untitled/draft.md`)).toBe(false);
    // In particular a real machine directory literally named `.Drafts`
    // stays an ordinary directory in a files-only window.
    expect(workspaceState.isDraftPath(".Drafts/untitled/draft.md")).toBe(false);
  });
});

describe("a standalone terminal window whose tenant serves no files", () => {
  test("it never reaches for the filesystem, and boots on a terminal", async () => {
    await boot(false);

    expect(apiFsContext).not.toHaveBeenCalled();
    expect(apiList).not.toHaveBeenCalled();
    expect(apiWorkspace).not.toHaveBeenCalled();
    const open = openTabs();
    expect(open).toHaveLength(1);
    expect(open[0]?.kind).toBe("terminal");
    // Terminals are all it can hold, which is what terminal-only means.
    expect(store.isTerminalOnlyWindow()).toBe(true);
  });
});
