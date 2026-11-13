// File browser commands. Selection-scoped actions stay available only when
// a file browser tab is active. Creating an entry stays reachable anywhere
// in a workspace window, and two commands here act beyond the tab and are
// listed where they act: the side docks with the window, and Workspace
// details with the workspace.
//
// The file browser's own menu and the tree's row menu word their rows from
// these titles. Open, View and Export to PDF are offered for a selection
// when the row menu offers them for that row: the tree hands this module the
// rule its menu reads (registerRowActions).
//
// A row of the tree's menu acts on its entry and the command of its title on
// the selection, through one function: Download through the store's
// download, Open in new file browser through the store's reveal, and Copy
// path through copyEntryPath here. Upload is the file browser's own menu
// row instead: both upload into the directory the surface is in, the one
// its New and Paste choose, and never replace a file. Replacing a file is
// the Upload of that file's own row menu alone.

import {
  dispatchChanCommand,
  registerCommands,
  onSurface,
  workspaceOnly,
  type CommandContext,
} from "../commands";
import {
  browserView,
  toggleBrowserDetails,
  toggleBrowserView,
  type BrowserView,
} from "../browserView.svelte";
import type { FileActionId, FileActionSet } from "../fileActions";
import { exportPathToPdf } from "../fileActionExecutors";
import { openMediaViewer } from "../mediaOpen";
import {
  browserSelection,
  browserSidePanes,
  collapseAllFoldersForInstance,
  copyTextToClipboard,
  expandAllFoldersForInstance,
  fbActiveInstanceId,
  fbClearSelection,
  fbClipboard,
  fbClipboardClear,
  fbClipboardPaste,
  fbClipboardSet,
  fbSelectSet,
  fileOps,
  openFsGraphForDirectory,
  openFsGraphForFile,
  openImportContacts,
  persistFbTreeInstanceExpansion,
  raiseReplacePicker,
  raiseUploadPicker,
  revealPathInBrowser,
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

/// Copy an entry's path as the workspace names it, and say on the status
/// line that it was copied or why it was not. The tree's Copy path row and
/// the command both copy through here.
export function copyEntryPath(path: string): Promise<void> {
  return copyTextToClipboard(path, {
    onSuccess: () => notify("Copied path"),
    onError: (reason) => notify(`copy failed: ${reason}`),
  });
}

/// Raise the picker that uploads into a directory, or the one that replaces
/// a file with the file picked. Every Upload, a row's, a Details panel's and
/// the command's, raises it here, so each is the desktop's own picker where
/// there is one.
export function uploadToEntry(path: string, isDir: boolean): void {
  if (isDir) raiseUploadPicker(path);
  else raiseReplacePicker(path);
}

function copySelectionPath(): void {
  const sel = activeSelection();
  if (sel) void copyEntryPath(sel.path);
}

/// The launcher reveals the selection in a new file browser: the tab lists
/// the folder that holds it, a selected directory's included, where the
/// tree's row opens a directory. With nothing selected the tab opens on the
/// workspace.
function openSelectionInFileBrowser(): void {
  revealPathInBrowser(selectedPath() ?? "");
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

/// The instance id of the file browser surface the selection commands act
/// on: the last focused one, whose selection `browserSelection` reads, or
/// the active file browser tab's while none is.
export function commandSurfaceId(): string | null {
  return fbActiveInstanceId() ?? activeBrowserInstanceId();
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

/// What a file browser's row menu offers for an entry, main action first.
export type RowActions = (path: string, isDir: boolean) => FileActionSet;

let rowActions: RowActions | null = null;

/// Hand the catalog the rule the tree's row menu draws its rows by, so the
/// launcher offers for the selection what the menu offers for its row. The
/// tree registers it as it loads. The rule reads the kind tables, which
/// import the whole icon set, and the catalog stays loadable without them;
/// until a tree has loaded, the commands that ask are offered for nothing.
export function registerRowActions(classify: RowActions): void {
  rowActions = classify;
}

function selectionOffers(action: FileActionId): boolean {
  const sel = activeSelection();
  if (!sel || !rowActions) return false;
  const { main, secondary } = rowActions(sel.path, sel.isDir);
  return main === action || secondary.includes(action);
}

/// One switch of the active file browser tab's view, null with no such tab.
function activeView(key: keyof BrowserView): boolean | null {
  const id = activeBrowserInstanceId();
  return id ? browserView(id)[key] : null;
}

function toggleActiveView(key: keyof BrowserView): void {
  const id = activeBrowserInstanceId();
  if (id) toggleBrowserView(id, key);
}

const needsSelection = (): string => "Needs a selection";
const needsClipboard = (): string => "Needs a copied or cut selection";

/// Why a command for one kind of entry cannot run: nothing is selected, or
/// the selection is not `needed`.
function needsSelected(needed: string): () => string {
  return () => (activeSelection() ? `Needs ${needed}` : needsSelection());
}

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
    id: "app.browser.open",
    title: "Open",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    order: 1,
    requirement: "files",
    keywords: ["enter", "editor", "directory"],
    available: (ctx) => onBrowser(ctx) && selectionOffers("open"),
    unavailableReason: needsSelected("a directory or a file an editor opens"),
    // Entering a directory moves the surface's own location, so the open
    // reaches the active file browser as a chan:command and runs there what
    // Enter runs on the selection.
    run: () => dispatchChanCommand("app.browser.open"),
  },
  {
    id: "app.browser.openInBrowser",
    title: "Open in new file browser",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    order: 2,
    requirement: "files",
    keywords: ["Open in new File Browser", "files", "tree", "reveal"],
    available: onBrowser,
    run: openSelectionInFileBrowser,
  },
  {
    id: "app.browser.viewMedia",
    title: "View",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    order: 3,
    requirement: "files",
    keywords: [
      "View / Zoom",
      "View Video",
      "View Audio",
      "View PDF",
      "image",
      "zoom",
      "play",
      "viewer",
    ],
    available: (ctx) => onBrowser(ctx) && selectionOffers("viewMedia"),
    unavailableReason: needsSelected("an image, a video, an audio file or a PDF"),
    run: () => {
      const sel = activeSelection();
      if (sel) openMediaViewer(sel.path);
    },
  },
  {
    id: "app.browser.uploadSelection",
    title: "Upload",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    order: 4,
    kind: "open",
    requirement: "files",
    keywords: ["import", "file", "directory", "folder"],
    available: onBrowser,
    // The directory an upload goes into is the surface's own, the folder a
    // list shows, so the upload reaches the surface the selection commands
    // act on as a chan:command and runs there what its menu's Upload runs.
    run: () => dispatchChanCommand("app.browser.uploadSelection"),
  },
  {
    id: "app.browser.downloadSelection",
    title: "Download",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    order: 5,
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
    order: 6,
    // Spawns a terminal; the selection rides along as plain spawn data.
    requirement: "terminal",
    keywords: ["New terminal", "shell", "cwd"],
    available: onBrowser,
    run: newTerminalFromSelection,
  },
  {
    id: "app.browser.exportPdf",
    title: "Export to PDF",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    order: 7,
    requirement: "files",
    keywords: ["pdf", "print", "document"],
    available: (ctx) => onBrowser(ctx) && selectionOffers("exportPdf"),
    unavailableReason: needsSelected("a markdown file"),
    run: () => {
      const sel = activeSelection();
      if (sel) void exportPathToPdf(sel.path);
    },
  },
  {
    id: "app.browser.newGraph",
    title: "New graph here",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    order: 8,
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
    order: 9,
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
    order: 10,
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
    order: 11,
    requirement: "files",
    keywords: ["Paste file browser clipboard", "copy", "cut", "move", "files"],
    available: (ctx) => onBrowser(ctx) && fbClipboard.mode !== null,
    unavailableReason: needsClipboard,
    run: () => void pasteFileBrowserClipboard(),
  },
  {
    id: "app.browser.selectMultiple",
    title: "Select multiple",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    order: 12,
    kind: "toggle",
    requirement: "files",
    keywords: ["Leave selection mode", "selection mode", "mark", "multi-select"],
    available: onBrowser,
    state: () => activeView("selectionMode"),
    run: () => toggleActiveView("selectionMode"),
  },
  {
    id: "app.browser.copyPath",
    title: "Copy path",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    order: 13,
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
    order: 14,
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
    order: 15,
    requirement: "files",
    keywords: ["remove", "trash"],
    available: (ctx) => onBrowser(ctx) && activeSelection() !== null,
    unavailableReason: needsSelection,
    run: deleteSelection,
  },
  {
    id: "app.browser.hiddenFiles",
    title: "Hidden files",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    order: 16,
    kind: "toggle",
    requirement: "files",
    keywords: ["Show hidden files", "dotfiles", "dot files"],
    available: onBrowser,
    state: () => activeView("showHidden"),
    run: () => toggleActiveView("showHidden"),
  },
  {
    // The file browser's own keys, which are not in the shortcut table; the
    // qualifier tells the row from the Keyboard Shortcuts settings.
    id: "app.browser.keyboardHelp",
    title: "Keyboard shortcuts (file browser)",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    order: 17,
    kind: "toggle",
    requirement: "files",
    keywords: ["Keyboard shortcuts", "keys", "help", "vim"],
    available: onBrowser,
    state: () => activeView("helpOpen"),
    run: () => toggleActiveView("helpOpen"),
  },
  {
    id: "app.browser.details",
    title: "Details",
    category: "File Browser",
    scope: "app",
    surface: "browser",
    order: 18,
    kind: "toggle",
    // The panel shows filesystem facts in every window with files; its index
    // sections need a workspace.
    requirement: "files",
    keywords: ["Toggle details", "inspector", "info", "metadata", "preview"],
    available: onBrowser,
    state: () => activeBrowserTab()?.inspectorOpen ?? null,
    run: () => {
      const tab = activeBrowserTab();
      if (tab) toggleBrowserDetails(tab);
    },
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
