// File Browser commands. Selection-scoped actions stay available only when
// a File Browser tab is active; workspace-scoped actions such as opening the
// side docks or creating an entry stay reachable from the launcher anywhere
// in a workspace window.

import {
  registerCommands,
  dispatchChanCommand,
  onSurface,
  workspaceOnly,
  type CommandContext,
} from "../commands";
import {
  browserSelection,
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
  setHybridSurfaceTheme,
  toggleBrowserSidePane,
  tree,
} from "../store.svelte";
import {
  activeBrowserTab,
  canReopenClosedTab,
  layout,
  openBrowserInActivePane,
  openTerminalInPane,
  reopenClosedTab,
} from "../tabs.svelte";
import { notify } from "../notify.svelte";
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

function parentDir(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "" : path.slice(0, slash);
}

function targetDirFromSelection(): string {
  const sel = activeSelection();
  if (!sel) return "";
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

function showWorkspaceInfo(): void {
  const tab = activeBrowserTab();
  if (!tab) return;
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
    raiseUploadPicker("");
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

registerCommands([
  {
    id: "app.browser.surfaceTheme.light",
    title: "File Browser theme: light",
    category: "File Browser",
    requirement: "files",
    keywords: ["theme", "light", "appearance", "files"],
    available: onBrowser,
    run: () => setHybridSurfaceTheme("browser", "light"),
  },
  {
    id: "app.browser.surfaceTheme.dark",
    title: "File Browser theme: dark",
    category: "File Browser",
    requirement: "files",
    keywords: ["theme", "dark", "appearance", "files"],
    available: onBrowser,
    run: () => setHybridSurfaceTheme("browser", "dark"),
  },
  {
    id: "app.browser.clearClipboard",
    title: "Clear file browser clipboard",
    category: "File Browser",
    requirement: "files",
    keywords: ["copy", "cut", "paste", "clipboard"],
    available: (ctx) => onBrowser(ctx) && fbClipboard.mode !== null,
    run: () => fbClipboardClear(),
  },
  {
    id: "app.browser.clearSelection",
    title: "Clear selection",
    category: "File Browser",
    requirement: "files",
    keywords: ["deselect", "files"],
    available: (ctx) => onBrowser(ctx) && selectedPaths().length > 0,
    run: () => fbClearSelection(),
  },
  {
    id: "app.browser.closeTab",
    title: "Close file browser tab",
    category: "File Browser",
    requirement: "files",
    keywords: ["close", "tab"],
    available: onBrowser,
    run: () => dispatchChanCommand("app.tab.close"),
  },
  {
    id: "app.browser.collapseAll",
    title: "Collapse all directories",
    category: "File Browser",
    requirement: "files",
    keywords: ["folders", "tree"],
    available: onBrowser,
    run: collapseAllForActiveBrowser,
  },
  {
    id: "app.browser.copyPath",
    title: "Copy path",
    category: "File Browser",
    requirement: "files",
    keywords: ["clipboard", "file", "directory"],
    available: (ctx) => onBrowser(ctx) && activeSelection() !== null,
    run: copySelectionPath,
  },
  {
    id: "app.browser.copySelection",
    title: "Copy selection",
    category: "File Browser",
    requirement: "files",
    keywords: ["clipboard", "files", "duplicate"],
    available: (ctx) => onBrowser(ctx) && selectedPaths().length > 0,
    run: copyFileBrowserSelection,
  },
  {
    id: "app.browser.cutSelection",
    title: "Cut selection",
    category: "File Browser",
    requirement: "files",
    keywords: ["clipboard", "move", "files"],
    available: (ctx) => onBrowser(ctx) && selectedPaths().length > 0,
    run: cutFileBrowserSelection,
  },
  {
    id: "app.browser.deleteSelection",
    title: "Delete",
    category: "File Browser",
    requirement: "files",
    keywords: ["remove", "trash"],
    available: (ctx) => onBrowser(ctx) && activeSelection() !== null,
    run: deleteSelection,
  },
  {
    id: "app.browser.downloadSelection",
    title: "Download",
    category: "File Browser",
    requirement: "files",
    keywords: ["export", "save"],
    available: (ctx) => onBrowser(ctx) && activeSelection() !== null,
    run: downloadSelection,
  },
  {
    id: "app.browser.expandAll",
    title: "Expand all directories",
    category: "File Browser",
    requirement: "files",
    keywords: ["folders", "tree"],
    available: onBrowser,
    run: expandAllForActiveBrowser,
  },
  {
    id: "app.browser.importContacts",
    title: "Import contacts",
    category: "File Browser",
    // Contacts are workspace metadata, beyond the filesystem routes.
    requirement: "workspace",
    keywords: ["contacts", "csv", "google"],
    available: onBrowser,
    run: () => openImportContacts(importDefaultDir()),
  },
  {
    id: "app.browser.newFsEntry",
    title: "New file or directory",
    category: "File Browser",
    requirement: "files",
    keywords: ["create", "file", "folder"],
    available: inWorkspace,
    run: () => void fileOps.createFileOrDir(targetDirFromSelection()),
  },
  {
    id: "app.browser.newGraph",
    title: "New graph",
    category: "File Browser",
    // The graph surface reads the workspace index.
    requirement: "workspace",
    keywords: ["graph", "network", "scope"],
    available: onBrowser,
    run: newGraphFromSelection,
  },
  {
    id: "app.browser.newTerminal",
    title: "New terminal",
    category: "File Browser",
    // Spawns a terminal; the selection rides along as plain spawn data.
    requirement: "terminal",
    keywords: ["shell", "cwd"],
    available: onBrowser,
    run: newTerminalFromSelection,
  },
  {
    id: "app.browser.openInBrowser",
    title: "Open in new File Browser",
    category: "File Browser",
    requirement: "files",
    keywords: ["files", "tree", "reveal"],
    available: onBrowser,
    run: openSelectionInFileBrowser,
  },
  {
    id: "app.browser.pasteSelection",
    title: "Paste file browser clipboard",
    category: "File Browser",
    requirement: "files",
    keywords: ["copy", "cut", "move", "files"],
    available: (ctx) => onBrowser(ctx) && fbClipboard.mode !== null,
    run: () => void pasteFileBrowserClipboard(),
  },
  {
    id: "app.browser.renameSelection",
    title: "Rename / move",
    category: "File Browser",
    requirement: "files",
    keywords: ["rename", "move", "path"],
    available: (ctx) => onBrowser(ctx) && activeSelection() !== null,
    run: renameSelection,
  },
  {
    id: "app.browser.reopenClosed",
    title: "Reopen last closed tab",
    category: "File Browser",
    requirement: "files",
    keywords: ["undo", "restore", "tab"],
    available: (ctx) => onBrowser(ctx) && canReopenClosedTab(),
    run: () => reopenClosedTab(),
  },
  {
    id: "app.browser.settings",
    title: "Flip",
    category: "File Browser",
    requirement: "files",
    keywords: ["flip", "side"],
    available: onBrowser,
    run: () => dispatchChanCommand("app.pane.flip"),
  },
  {
    id: "app.browser.showWorkspaceInfo",
    title: "Show workspace details",
    category: "File Browser",
    // Workspace details come from the workspace tenant, not the tree.
    requirement: "workspace",
    keywords: ["info", "details", "root"],
    available: onBrowser,
    run: showWorkspaceInfo,
  },
  {
    id: "app.browser.toggleLeftDock",
    title: "Toggle left file browser dock",
    category: "File Browser",
    requirement: "files",
    keywords: ["stick", "unstick", "side pane", "dock"],
    available: inWorkspace,
    run: () => toggleBrowserSidePane("left"),
  },
  {
    id: "app.browser.toggleRightDock",
    title: "Toggle right file browser dock",
    category: "File Browser",
    requirement: "files",
    keywords: ["stick", "unstick", "side pane", "dock"],
    available: inWorkspace,
    run: () => toggleBrowserSidePane("right"),
  },
  {
    id: "app.browser.uploadSelection",
    title: "Upload",
    category: "File Browser",
    requirement: "files",
    keywords: ["import", "replace", "file"],
    available: onBrowser,
    run: uploadToSelection,
  },
]);
