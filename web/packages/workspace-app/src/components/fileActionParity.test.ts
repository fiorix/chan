// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import FileInfoBody from "./FileInfoBody.svelte";
import FileTree from "./FileTree.svelte";
import { openTerminalInActivePane } from "../state/tabs.svelte";
import { fileOps } from "../state/store.svelte";

// Parity proof: the inspector (FileInfoBody) and the file browser
// context menu (FileTree) render the SAME applicable non-destructive
// actions for the same entry, because both consume
// state/fileActions' classifyFileActions. Labels and handlers are
// surface-local; the destructive + path-mutation rows (Copy Path,
// Rename / Move, Delete) and ordinary-file replacement exist only in
// the tree's separate policy.
// Store and api modules are mocked; the classifier and kind
// predicates run for real.

const fixtureEntries = vi.hoisted(() => [
  { path: "demo.mp4", is_dir: false, kind: "binary", size: 10, mtime: null },
  { path: "a.md", is_dir: false, kind: "document", size: 10, mtime: null },
  { path: "bundle.zip", is_dir: false, kind: "binary", size: 10, mtime: null },
  { path: "docs", is_dir: true, size: 0, mtime: null },
  { path: ".Drafts", is_dir: true, size: 0, mtime: null },
  { path: ".Drafts/draft.md", is_dir: false, kind: "document", size: 10, mtime: null },
]);

vi.mock("../api/client", () => ({
  api: {
    inspector: vi.fn(async () => null),
    read: vi.fn(async () => ({ content: "" })),
    reportDir: vi.fn(async () => {
      throw new Error("no report");
    }),
    reportPrefix: vi.fn(async () => {
      throw new Error("no report");
    }),
    reportFileStream: vi.fn(async () => {}),
    downloadUrl: (p: string) => `/api/files/${p}?download=1`,
  },
  withTokenQuery: (u: string) => u,
}));

vi.mock("../api/desktop", () => ({
  isTauriDesktop: () => false,
  saveBytesToDownloads: vi.fn(async () => {}),
}));

vi.mock("../api/download", () => ({ downloadBytes: vi.fn() }));

vi.mock("../api/transport", () => ({ handleDemoDownload: () => false }));

vi.mock("../state/store.svelte", () => ({
  copyTextToClipboard: vi.fn(async () => {}),
  draftsDir: () => ".Drafts",
  effectiveHybridSurfaceTheme: () => "light",
  // Mirrors the real predicate in state/workspace.svelte: the drafts
  // directory itself or a path below it.
  isDraftPath: (p: string) => p === ".Drafts" || p.startsWith(".Drafts/"),
  setTransientStatus: vi.fn(),
  ui: { status: "", statusKind: "transient" },
  workspace: { info: { root: "/ws", label: "ws" } },
  fileOps: {
    createFileOrDir: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    uploadFilesTo: vi.fn(async () => {}),
    replaceFileAt: vi.fn(async () => {}),
    downloadPathWithProgress: vi.fn(),
  },
  loadTreeDir: vi.fn(async () => {}),
  openGraphAtNode: vi.fn(),
  openGraphForContact: vi.fn(),
  openGraphForFile: vi.fn(),
  openGraphForLanguage: vi.fn(),
  openGraphForMention: vi.fn(),
  openGraphForTag: vi.fn(),
  revealPathInBrowser: vi.fn(),
  tree: { entries: fixtureEntries, loadingDirs: {}, loadedDirs: {}, dirErrors: {} },
  browserSelection: { path: null, paths: [] },
  clearTreeLoadingForPath: vi.fn(),
  fbClearSelection: vi.fn(),
  fbClipboard: { mode: "copy", paths: [] },
  fbClipboardClear: vi.fn(),
  fbClipboardPaste: vi.fn(async () => {}),
  fbClipboardSet: vi.fn(),
  fbSelectRange: vi.fn(),
  fbSelectSet: vi.fn(),
  fbSelectSingle: vi.fn(),
  fbToggle: vi.fn(),
  openFsGraphForDirectory: vi.fn(),
  openFsGraphForFile: vi.fn(),
  ensureFbTreeInstance: vi.fn(),
  fbTreeInstance: () => ({ expanded: { "": true, ".Drafts": true } }),
  persistFbTreeInstanceExpansion: vi.fn(),
}));

vi.mock("../state/tabs.svelte", () => ({
  openTerminalInActivePane: vi.fn(),
  dirtyPaths: () => new Set<string>(),
  layout: { activePaneId: "pane-1" },
  openBrowserInActivePane: vi.fn(() => ({
    inspectorOpen: false,
    showWorkspace: true,
    expanded: undefined,
  })),
  openInActivePane: vi.fn(async () => {}),
  openTerminalInPane: vi.fn(),
}));

vi.mock("../state/graphData.svelte", () => ({
  ensureGraphLoaded: vi.fn(async () => {}),
  graphData: { view: null, loading: false, error: null },
  selectionEdgesFor: () => [],
}));

vi.mock("../state/mediaOpen", () => ({
  openMediaViewer: vi.fn(() => false),
  dirImageSet: () => [],
}));

vi.mock("../state/imageZoom", () => ({ openImageZoom: vi.fn() }));
vi.mock("../state/videoViewer", () => ({ openVideoViewer: vi.fn() }));
vi.mock("../state/audioViewer", () => ({ AUDIO_UNSUPPORTED_MESSAGE: "unsupported" }));
vi.mock("../state/notify.svelte", () => ({ notify: vi.fn() }));
vi.mock("../state/shortcuts", () => ({ chordFor: () => null }));
vi.mock("./menuClamp", () => ({ clampMenu: () => ({}) }));
vi.mock("./portal", () => ({ portal: () => ({}) }));

const mounted: Array<Record<string, any>> = [];

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  document.body.innerHTML = "";
});

function mountInspector(
  path: string,
  props: Record<string, unknown> = {},
): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(
    mount(FileInfoBody, {
      target,
      props: { path, onSetAsScope: () => {}, onOpen: () => {}, ...props } as any,
    }),
  );
  return target;
}

function inspectorActionLabels(target: HTMLElement): string[] {
  const labels: string[] = [];
  const main = target.querySelector(".pill-main");
  if (main) labels.push(main.textContent?.trim() ?? "");
  for (const item of target.querySelectorAll(".action-menu-item")) {
    labels.push(item.textContent?.trim() ?? "");
  }
  return labels;
}

async function openInspectorDropdown(target: HTMLElement): Promise<void> {
  target.querySelector<HTMLButtonElement>(".pill-caret")?.click();
  await tick();
}

function mountTreeMenu(path: string): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(FileTree, { target, props: { instanceId: "fb-test" } as any }));
  const row = [...target.querySelectorAll<HTMLElement>(".row")].find((el) => {
    const t = el.getAttribute("title") ?? "";
    // Non-editable rows carry a " (view-only)" title suffix.
    return t === path || t === `/ws/${path}` || t.startsWith(`/ws/${path} `);
  });
  expect(row, `tree row for ${path}`).toBeDefined();
  row!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
  return tick().then(() => target);
}

function treeMenuLabels(target: HTMLElement): string[] {
  return [...target.querySelectorAll(".ctx button .menu-row-label, .ctx button span:not(.menu-row-label):not(.menu-row-chord)")]
    .map((el) => el.textContent?.trim() ?? "")
    .filter((s) => s.length > 0);
}

/// Click a menu row by label, then drive the hidden file picker's
/// change event with one File. Clears the transfer mocks first so the
/// caller asserts only this invocation's effect.
const pickedFile = new File(["replacement body"], "notes.txt", {
  type: "text/plain",
});

async function pickUpload(target: HTMLElement, label: string): Promise<void> {
  const button = [...target.querySelectorAll<HTMLButtonElement>(".ctx button")].find(
    (b) => b.textContent?.trim() === label,
  );
  expect(button, `menu row "${label}"`).toBeDefined();
  vi.mocked(fileOps.uploadFilesTo).mockClear();
  vi.mocked(fileOps.replaceFileAt).mockClear();
  button!.click();
  await tick();
  const input = target.querySelector<HTMLInputElement>("input.file-picker");
  expect(input, "hidden file picker").toBeDefined();
  Object.defineProperty(input, "files", { value: [pickedFile], configurable: true });
  // Bubbles so Svelte's delegated change listener sees it.
  input!.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("inspector vs tree menu action parity", () => {
  test("video: both surfaces offer view, download, terminal, graph", async () => {
    const inspector = mountInspector("demo.mp4");
    await tick();
    await openInspectorDropdown(inspector);
    const inspectorLabels = inspectorActionLabels(inspector);
    expect(inspectorLabels).toEqual([
      "View Video",
      "Download file",
      "New terminal here",
      "Graph from here",
    ]);

    const tree = await mountTreeMenu("demo.mp4");
    const menuLabels = treeMenuLabels(tree);
    for (const label of ["View Video", "Download", "New Terminal", "New Graph"]) {
      expect(menuLabels).toContain(label);
    }
  });

  test("markdown: both surfaces offer open, download, terminal, export pdf, graph", async () => {
    const inspector = mountInspector("a.md", { onReveal: () => {} });
    await tick();
    await openInspectorDropdown(inspector);
    expect(inspectorActionLabels(inspector)).toEqual([
      "Open",
      "Show file",
      "Download file",
      "New terminal here",
      "Export to PDF",
      "Graph from here",
    ]);

    const tree = await mountTreeMenu("a.md");
    const menuLabels = treeMenuLabels(tree);
    for (const label of ["Open", "Open in File Browser", "Download", "New Terminal", "Export to PDF", "New Graph"]) {
      expect(menuLabels).toContain(label);
    }
  });

  test("binary: both surfaces offer download plus graph, no view or open", async () => {
    const inspector = mountInspector("bundle.zip");
    await tick();
    await openInspectorDropdown(inspector);
    expect(inspectorActionLabels(inspector)).toEqual(["Download file", "Graph from here"]);

    const tree = await mountTreeMenu("bundle.zip");
    const menuLabels = treeMenuLabels(tree);
    expect(menuLabels).toContain("Download");
    expect(menuLabels).toContain("New Graph");
    expect(menuLabels).not.toContain("Open");
    expect(menuLabels.some((l) => l.startsWith("View"))).toBe(false);
  });

  test("drafts: shared classifier rows collapse to terminal only; the tree keeps its own policy rows", async () => {
    const inspector = mountInspector(".Drafts");
    await tick();
    await openInspectorDropdown(inspector);
    expect(inspectorActionLabels(inspector)).toEqual(["Terminal from here"]);

    // The collapse applies to the SHARED classifier rows only. The
    // tree intentionally retains its separate policy for drafts:
    // New File or Directory, Copy Path, Rename / Move, and Delete
    // still render here and keep their own confirmation flow.
    const tree = await mountTreeMenu(".Drafts");
    const menuLabels = treeMenuLabels(tree);
    expect(menuLabels).toContain("New Terminal");
    expect(menuLabels).not.toContain("Upload");
    expect(menuLabels).not.toContain("Download");
    expect(menuLabels).not.toContain("New Graph");
    for (const label of ["New File or Directory", "Copy Path", "Rename / Move", "Delete"]) {
      expect(menuLabels).toContain(label);
    }
  });
});

describe("draft terminal routing", () => {
  test("clicking the .Drafts inspector action opens a terminal rooted in the directory", async () => {
    vi.mocked(openTerminalInActivePane).mockClear();

    const inspector = mountInspector(".Drafts");
    await tick();

    const main = inspector.querySelector<HTMLButtonElement>(".pill-main");
    expect(main?.textContent?.trim()).toBe("Terminal from here");
    main!.click();
    await tick();

    // A draft directory routes through newTerminalHere: the terminal
    // is rooted in the directory itself, with no file-path seed.
    expect(openTerminalInActivePane).toHaveBeenCalledTimes(1);
    expect(openTerminalInActivePane).toHaveBeenCalledWith({ cwd: ".Drafts" });
  });
});

describe("destructive-action separation", () => {
  test("the tree menu keeps Delete and Rename outside the shared actions", async () => {
    const tree = await mountTreeMenu("a.md");
    const menuLabels = treeMenuLabels(tree);
    expect(menuLabels).toContain("Delete");
    expect(menuLabels).toContain("Rename / Move");
    expect(menuLabels).toContain("Copy Path");
  });

  test("the inspector never renders destructive actions", async () => {
    const inspector = mountInspector("a.md", { onReveal: () => {} });
    await tick();
    await openInspectorDropdown(inspector);
    const text = inspector.textContent ?? "";
    expect(text).not.toContain("Delete");
    expect(text).not.toContain("Rename");
  });
});

describe("plain-directory parity", () => {
  test("both surfaces offer open, upload, download, terminal, and graph", async () => {
    const inspector = mountInspector("docs");
    await tick();
    await openInspectorDropdown(inspector);
    expect(inspectorActionLabels(inspector)).toEqual([
      "Open",
      "Upload file here",
      "Download tarball",
      "New terminal here",
      "Graph from here",
    ]);

    const tree = await mountTreeMenu("docs");
    const menuLabels = treeMenuLabels(tree);
    for (const label of [
      "Open in File Browser",
      "New File or Directory",
      "Upload",
      "Download",
      "New Terminal",
      "New Graph",
    ]) {
      expect(menuLabels).toContain(label);
    }
  });

  test("the tree upload row pipes the picked files to uploadFilesTo for the directory", async () => {
    const tree = await mountTreeMenu("docs");
    await pickUpload(tree, "Upload");

    await vi.waitFor(() => {
      expect(fileOps.uploadFilesTo).toHaveBeenCalledWith("docs", [pickedFile]);
    });
    expect(fileOps.replaceFileAt).not.toHaveBeenCalled();
  });
});

describe("ordinary-file replacement (tree-only)", () => {
  test("the file menu has a replacement Upload row; the inspector does not", async () => {
    const tree = await mountTreeMenu("a.md");
    expect(treeMenuLabels(tree)).toContain("Upload");

    const inspector = mountInspector("a.md", { onReveal: () => {} });
    await tick();
    await openInspectorDropdown(inspector);
    expect(inspectorActionLabels(inspector)).not.toContain("Upload file here");
  });

  test("invoking it drives the picker and calls fileOps.replaceFileAt with path and file", async () => {
    const tree = await mountTreeMenu("a.md");
    await pickUpload(tree, "Upload");

    await vi.waitFor(() => {
      expect(fileOps.replaceFileAt).toHaveBeenCalledWith("a.md", pickedFile);
    });
    expect(fileOps.uploadFilesTo).not.toHaveBeenCalled();
  });

  test("drafts never get the replacement row", async () => {
    // The fileOps contract refuses writes under the drafts directory,
    // so neither the drafts dir nor a draft file shows the row.
    const draftFile = await mountTreeMenu(".Drafts/draft.md");
    expect(treeMenuLabels(draftFile)).not.toContain("Upload");
  });
});
