// File browser commands. Selection-scoped actions stay available only when
// a file browser tab is active. Creating an entry stays reachable anywhere
// in a workspace window, and two commands here act beyond the tab and are
// listed where they act: the side docks with the window, and Workspace
// details with the workspace.

import {
  registerCommands,
  onSurface,
  workspaceOnly,
  type CommandContext,
} from "../commands";
import {
  browserSelection,
  browserSidePanes,
  collapseAllFoldersForInstance,
  copyTextToClipboard,
  expandAllFoldersForInstance,
  fbClearSelection,
  fbClipboard,
  fbClipboardClear,
  fbClipboardPaste,
  fbClipboardSet,
  fbSelectSet,
  fbSelectSingle,
  fileOps,
  openFsGraphForDirectory,
  openFsGraphForFile,
  openImportContacts,
  persistFbTreeInstanceExpansion,
  raiseReplacePicker,
  raiseUploadPicker,
  toggleBrowserSidePane,
  tree,
} from "../store.svelte";
import {
  activeBrowserTab,
  layout,
  openBrowserInActivePane,
  openTerminalInPane,
} from "../tabs.svelte";
import { notify } from "../notify.svelte";
import { parentDir } from "../format";
import { defaultCreateDirectory } from "../fileContext.svelte";
import { terminalFromHereTarget } from "../../terminal/fromHere";

type BrowserSelection = {
  path: string;
  isDir: boolean;
};

function onBrowser(ctx: CommandContext): boolean {
  return workspaceOnly(ctx) && onSurface(ctx, "browser");
}

function inWorkspace(ctx: CommandContext): boolean {
  return workspaceOnly(ctx);
}

function selectedPath(tab = activeBrowserTab()): string | null {
  return browserSelection.path ?? tab?.selected ?? null;
}

function selectedPaths(tab = activeBrowserTab()): string[] {
  if (browserSelection.paths.length > 0) return [...browserSelection.paths];
  if (tab?.selectedPaths && tab.selectedPaths.length > 0) {
    return [...tab.selectedPaths];
  }
  const path = selectedPath(tab);
  return path ? [path] : [];
}

function entryFor(path: string) {
  return tree.entries.find((entry) => entry.path === path);
}

function activeSelection(): BrowserSelection | null {
  const path = selectedPath();
  if (!path) return null;
  return { path, isDir: entryFor(path)?.is_dir ?? false };
}

function targetDirFromSelection(): string {
  const sel = activeSelection();
  if (!sel) return defaultCreateDirectory();
  return sel.isDir ? sel.path : parentDir(sel.path);
}

function importDefaultDir(): string {
  const sel = activeSelection();
  if (!sel) return "Contacts";
  return sel.isDir ? sel.path : parentDir(sel.path);
}

function activeBrowserInstanceId(tab = activeBrowserTab()): string | null {
  return tab ? `fb-tab-${tab.id}` : null;
}

function expandedAncestors(path: string): string[] {
  const parts = path.split("/");
  const ancestors: string[] = [];
  let acc = "";
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc ? `${acc}/${parts[i]}` : parts[i];
    if (acc) ancestors.push(acc);
  }
  return ancestors;
}

function copySelectionPath(): void {
  const sel = activeSelection();
  if (!sel) return;
  void copyTextToClipboard(sel.path, {
    onSuccess: () => notify("Copied path"),
    onError: () => notify("Clipboard unavailable"),
  });
}

function openSelectionInFileBrowser(): void {
  const path = selectedPath();
  const tab = openBrowserInActivePane(path ? { select: path } : {});
  tab.inspectorOpen = true;
  if (!path) {
    tab.showWorkspace = true;
    fbClearSelection();
    browserSelection.showWorkspace = true;
    return;
  }
  tab.showWorkspace = false;
  tab.expanded = expandedAncestors(path);
  fbSelectSingle(path);
  browserSelection.showWorkspace = false;
}

/// Show the workspace's details in a file browser's inspector: the active
/// file browser tab's, or a new tab's when another surface is focused.
function showWorkspaceInfo(): void {
  const tab = activeBrowserTab() ?? openBrowserInActivePane({});
  fbClearSelection();
  browserSelection.showWorkspace = true;
  tab.showWorkspace = true;
  tab.inspectorOpen = true;
}

function expandAllForActiveBrowser(): void {
  const id = activeBrowserInstanceId();
  if (!id) return;
  expandAllFoldersForInstance(id);
  persistFbTreeInstanceExpansion(id);
}

function collapseAllForActiveBrowser(): void {
  const id = activeBrowserInstanceId();
  if (!id) return;
  collapseAllFoldersForInstance(id);
  persistFbTreeInstanceExpansion(id);
}

function newTerminalFromSelection(): void {
  const sel = activeSelection();
  const path = sel?.path ?? "";
  const isDir = sel?.isDir ?? true;
  openTerminalInPane(layout.activePaneId, terminalFromHereTarget(path, isDir));
}

function newGraphFromSelection(): void {
  const sel = activeSelection();
  if (!sel) {
    openFsGraphForDirectory("");
    return;
  }
  if (sel.isDir) openFsGraphForDirectory(sel.path);
  else openFsGraphForFile(sel.path);
}

function uploadToSelection(): void {
  const sel = activeSelection();
  if (!sel) {
    raiseUploadPicker(defaultCreateDirectory());
    return;
  }
  if (sel.isDir) raiseUploadPicker(sel.path);
  else raiseReplacePicker(sel.path);
}

function downloadSelection(): void {
  const sel = activeSelection();
  if (sel) fileOps.downloadPathWithProgress(sel.path, sel.isDir);
}

function renameSelection(): void {
  const sel = activeSelection();
  if (sel) void fileOps.rename(sel.path, sel.isDir);
}

function deleteSelection(): void {
  const paths = selectedPaths();
  if (paths.length > 1) {
    void fileOps.removeSelection(paths);
    return;
  }
  const sel = activeSelection();
  if (sel) void fileOps.remove(sel.path, sel.isDir);
}

function copyFileBrowserSelection(): void {
  const paths = selectedPaths();
  if (paths.length > 0) fbClipboardSet("copy", paths);
}

function cutFileBrowserSelection(): void {
  const paths = selectedPaths();
  if (paths.length > 0) fbClipboardSet("cut", paths);
}

async function pasteFileBrowserClipboard(): Promise<void> {
  const landed = await fbClipboardPaste(targetDirFromSelection());
  if (landed.length > 0) fbSelectSet(landed);
}

const needsSelection = (): string => "Needs a selection";
const needsClipboard = (): string => "Needs a copied or cut selection";

registerCommands([
  {
    id: "app.browser.newFsEntry",
    title: "New file or directory",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    order: 0,
    kind: "open",
    requirement: "files",
    keywords: ["create", "file", "folder"],
    available: inWorkspace,
    run: () => void fileOps.createFileOrDir(targetDirFromSelection()),
  },
  {
    id: "app.browser.openInBrowser",
    title: "Open in new file browser",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    order: 1,
    requirement: "files",
    keywords: ["Open in new File Browser", "files", "tree", "reveal"],
    available: onBrowser,
    run: openSelectionInFileBrowser,
  },
  {
    id: "app.browser.uploadSelection",
    title: "Upload",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    order: 2,
    kind: "open",
    requirement: "files",
    keywords: ["import", "replace", "file"],
    available: onBrowser,
    run: uploadToSelection,
  },
  {
    id: "app.browser.downloadSelection",
    title: "Download",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    order: 3,
    requirement: "files",
    keywords: ["export", "save"],
    available: (ctx) => onBrowser(ctx) && activeSelection() !== null,
    unavailableReason: needsSelection,
    run: downloadSelection,
  },
  {
    id: "app.browser.newTerminal",
    title: "New terminal here",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    order: 4,
    // Spawns a terminal; the selection rides along as plain spawn data.
    requirement: "terminal",
    keywords: ["New terminal", "shell", "cwd"],
    available: onBrowser,
    run: newTerminalFromSelection,
  },
  {
    id: "app.browser.newGraph",
    title: "New graph here",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    order: 5,
    // The graph surface reads the workspace index.
    requirement: "workspace",
    keywords: ["New graph", "graph", "network", "scope"],
    available: onBrowser,
    run: newGraphFromSelection,
  },
  {
    id: "app.browser.copySelection",
    title: "Copy",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    order: 6,
    requirement: "files",
    keywords: ["Copy selection", "clipboard", "files", "duplicate"],
    available: (ctx) => onBrowser(ctx) && selectedPaths().length > 0,
    unavailableReason: needsSelection,
    run: copyFileBrowserSelection,
  },
  {
    id: "app.browser.cutSelection",
    title: "Cut",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    order: 7,
    requirement: "files",
    keywords: ["Cut selection", "clipboard", "move", "files"],
    available: (ctx) => onBrowser(ctx) && selectedPaths().length > 0,
    unavailableReason: needsSelection,
    run: cutFileBrowserSelection,
  },
  {
    id: "app.browser.pasteSelection",
    title: "Paste",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    order: 8,
    requirement: "files",
    keywords: ["Paste file browser clipboard", "copy", "cut", "move", "files"],
    available: (ctx) => onBrowser(ctx) && fbClipboard.mode !== null,
    unavailableReason: needsClipboard,
    run: () => void pasteFileBrowserClipboard(),
  },
  {
    id: "app.browser.copyPath",
    title: "Copy path",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    order: 9,
    requirement: "files",
    keywords: ["clipboard", "file", "directory"],
    available: (ctx) => onBrowser(ctx) && activeSelection() !== null,
    unavailableReason: needsSelection,
    run: copySelectionPath,
  },
  {
    id: "app.browser.renameSelection",
    title: "Rename or move",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    order: 10,
    kind: "open",
    requirement: "files",
    keywords: ["Rename / move", "rename", "move", "path"],
    available: (ctx) => onBrowser(ctx) && activeSelection() !== null,
    unavailableReason: needsSelection,
    run: renameSelection,
  },
  {
    id: "app.browser.deleteSelection",
    title: "Delete",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    order: 11,
    requirement: "files",
    keywords: ["remove", "trash"],
    available: (ctx) => onBrowser(ctx) && activeSelection() !== null,
    unavailableReason: needsSelection,
    run: deleteSelection,
  },
  {
    id: "app.browser.clearClipboard",
    title: "Clear clipboard",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    requirement: "files",
    keywords: ["Clear file browser clipboard", "copy", "cut", "paste"],
    available: (ctx) => onBrowser(ctx) && fbClipboard.mode !== null,
    unavailableReason: needsClipboard,
    run: () => fbClipboardClear(),
  },
  {
    id: "app.browser.clearSelection",
    title: "Clear selection",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    requirement: "files",
    keywords: ["deselect", "files"],
    available: (ctx) => onBrowser(ctx) && selectedPaths().length > 0,
    unavailableReason: needsSelection,
    run: () => fbClearSelection(),
  },
  {
    id: "app.browser.collapseAll",
    title: "Collapse all directories",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    requirement: "files",
    keywords: ["folders", "tree"],
    available: onBrowser,
    run: collapseAllForActiveBrowser,
  },
  {
    id: "app.browser.expandAll",
    title: "Expand all directories",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    requirement: "files",
    keywords: ["folders", "tree"],
    available: onBrowser,
    run: expandAllForActiveBrowser,
  },
  {
    id: "app.browser.importContacts",
    title: "Import contacts",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    kind: "open",
    // Contacts are workspace metadata, beyond the filesystem routes.
    requirement: "workspace",
    keywords: ["contacts", "csv", "google"],
    available: onBrowser,
    run: () => openImportContacts(importDefaultDir()),
  },
  {
    id: "app.browser.showWorkspaceInfo",
    title: "Workspace details",
    category: "File Browser",
    scope: "workspace",
    order: 8,
    kind: "open",
    // Workspace details come from the workspace tenant, not the tree.
    requirement: "workspace",
    keywords: ["Show workspace details", "info", "root"],
    available: inWorkspace,
    run: showWorkspaceInfo,
  },
  {
    id: "app.browser.toggleLeftDock",
    title: "Left file browser dock",
    category: "File Browser",
    scope: "window",
    order: 8,
    kind: "toggle",
    requirement: "files",
    keywords: [
      "Toggle left file browser dock",
      "Stick to left",
      "Unstick left",
      "side pane",
      "Left pane",
    ],
    available: inWorkspace,
    state: () => browserSidePanes.left,
    run: () => toggleBrowserSidePane("left"),
  },
  {
    id: "app.browser.toggleRightDock",
    title: "Right file browser dock",
    category: "File Browser",
    scope: "window",
    order: 9,
    kind: "toggle",
    requirement: "files",
    keywords: [
      "Toggle right file browser dock",
      "Stick to right",
      "Unstick right",
      "side pane",
      "Right pane",
    ],
    available: inWorkspace,
    state: () => browserSidePanes.right,
    run: () => toggleBrowserSidePane("right"),
  },
]);
