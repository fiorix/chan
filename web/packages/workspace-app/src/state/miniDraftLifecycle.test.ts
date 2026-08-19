// @vitest-environment jsdom
//
// The draft tab lifecycle in a standalone (mini) window: drafts live in
// the tenant's per-library store and are addressed by wire paths, and the
// same close/inspect/discard/promote machinery the workspace window uses
// must run against them once the choke point (`draftsDir`) answers. The
// window's capabilities are frozen at module load, so every test resets
// the module registry and plants the `?kind=` marker plus both capability
// metas before importing the state modules (the
// state/standaloneBootstrap.test.ts discipline).

import { beforeEach, describe, expect, test, vi } from "vitest";

// The per-file caret index is a localStorage store; mock it like
// state/tabs.test.ts so the lifecycle wiring is what gets asserted.
vi.mock("./caretIndex");

const DRAFTS_DIR = "home/u/.chan/Drafts";
const DRAFT_PATH = `${DRAFTS_DIR}/untitled/draft.md`;

/// Mirror of the server's markdown draft seed, byte-for-byte: the close
/// path silently discards a pristine seed.
const DRAFT_SEED = "# Draft\n";

function serveMeta(name: string, on: boolean): void {
  document.head.querySelector(`meta[name="${name}"]`)?.remove();
  if (!on) return;
  const meta = document.createElement("meta");
  meta.setAttribute("name", name);
  meta.setAttribute("content", "1");
  document.head.appendChild(meta);
}

let tabs: typeof import("./tabs.svelte");
let api: typeof import("../api/client").api;

async function bootMiniWindow(): Promise<void> {
  vi.resetModules();
  window.history.replaceState({}, "", "/?kind=terminal&w=w-mini");
  serveMeta("chan-files", true);
  serveMeta("chan-drafts", true);
  const workspaceState = await import("./workspace.svelte");
  const fileContext = await import("./fileContext.svelte");
  // What bootstrapStandalone would have set from GET /api/fs/context;
  // the boot wiring itself is covered by standaloneBootstrap.test.ts.
  workspaceState.standaloneDrafts.dir = DRAFTS_DIR;
  fileContext.filesContext.current = fileContext.filesContextFrom("home/u");
  tabs = await import("./tabs.svelte");
  api = (await import("../api/client")).api;
}

function draftTab(content: string, saved = content): import("./tabs.svelte").FileTab {
  return {
    kind: "file",
    fileKind: "document",
    id: "draft-tab",
    path: DRAFT_PATH,
    content,
    saved,
    savedMtime: 1,
    mode: "wysiwyg",
    loading: false,
    error: null,
    fileMissing: null,
    inspectorOpen: false,
    outlineOpen: false,
    repoRoot: null,
    readMode: false,
    fsWritable: true,
    styleToolbarOpen: false,
    syntaxHighlight: true,
    highlightTrailingWhitespace: false,
    codeBlocksCollapsed: false,
  };
}

function resetLayout(tab: import("./tabs.svelte").FileTab) {
  const pane = {
    kind: "leaf" as const,
    id: "pane-mini",
    tabs: [tab],
    activeTabId: tab.id,
  };
  tabs.layout.rootId = pane.id;
  tabs.layout.activePaneId = pane.id;
  tabs.layout.nodes = { [pane.id]: pane };
  tabs.layout.focusColor = "blue";
  return pane;
}

function inspection(overrides: Partial<{ has_attachments: boolean }> = {}) {
  return {
    path: DRAFT_PATH,
    name: "untitled",
    file_count: 1,
    dir_count: 0,
    total_size: 8,
    has_attachments: false,
    ...overrides,
  };
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe("draft tabs in a standalone window", () => {
  test("a pristine seed discards silently on close", async () => {
    await bootMiniWindow();
    const tab = draftTab(DRAFT_SEED);
    const pane = resetLayout(tab);
    vi.spyOn(api, "inspectDraft").mockResolvedValue(inspection());
    const discard = vi.spyOn(api, "discardDraft").mockResolvedValue(undefined);

    await tabs.closeTab(pane.id, tab.id);

    expect(discard).toHaveBeenCalledWith(DRAFT_PATH);
    expect(tabs.draftCloseState.open).toBe(false);
    expect(tabs.activePane().tabs).toHaveLength(0);
  });

  test("an edited draft prompts with a home-prefixed default target", async () => {
    await bootMiniWindow();
    const tab = draftTab("# Draft\n\nreal words\n");
    const pane = resetLayout(tab);
    vi.spyOn(api, "inspectDraft").mockResolvedValue(inspection());
    const discard = vi.spyOn(api, "discardDraft").mockResolvedValue(undefined);

    const close = tabs.closeTab(pane.id, tab.id);
    await vi.waitFor(() => expect(tabs.draftCloseState.open).toBe(true));
    // The default lands in the user's home, not at the machine root
    // (an empty prefix in this window would mean `/untitled.md`).
    expect(tabs.draftCloseState.target).toBe("home/u/untitled.md");
    tabs.resolveDraftClose("discard");
    await close;

    expect(discard).toHaveBeenCalledWith(DRAFT_PATH);
  });

  test("saving promotes to the chosen wire path and closes the tab", async () => {
    await bootMiniWindow();
    const tab = draftTab("# Draft\n\nkeep me\n");
    const pane = resetLayout(tab);
    vi.spyOn(api, "inspectDraft").mockResolvedValue(inspection());
    const promote = vi.spyOn(api, "promoteDraft").mockResolvedValue({
      path: "home/u/notes/kept.md",
      name: "untitled",
      mode: "file",
    });

    const close = tabs.closeTab(pane.id, tab.id);
    await vi.waitFor(() => expect(tabs.draftCloseState.open).toBe(true));
    tabs.draftCloseState.target = "home/u/notes/kept.md";
    tabs.resolveDraftClose("save");
    await close;

    expect(promote).toHaveBeenCalledWith(DRAFT_PATH, "home/u/notes/kept.md");
    expect(tabs.activePane().tabs).toHaveLength(0);
  });
});
