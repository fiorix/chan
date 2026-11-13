// Editor surface commands: available when a file tab is the active
// surface. Chorded reuse ids dispatch through the chan:command bridge so
// they share App.svelte's dispatch and its window-mode guard; net-new
// actions call their exported action function directly against the active
// file tab. A view switch the tab holds as state is a toggle named for the
// thing it shows. The find family is listed here. Its two steps serve a
// terminal tab too, whose own listener answers the same ids behind the
// terminal's own Find. See state/commands.ts for the Command shape and the
// onSurface / dispatchChanCommand / workspaceOnly helpers.
//
// The list follows the editor's menus: the tab menu's rows, the body menu's,
// the Details inspector's actions, then the rest by title. An action a menu
// row also offers is an exported function of the tab it acts on, so the row
// runs it on its own tab and the command on the active one.

import {
  registerCommands,
  dispatchChanCommand,
  onSurface,
  workspaceOnly,
  type Command,
  type CommandContext,
} from "../commands";
import {
  copyTextToClipboard,
  fileOps,
  openFsGraphForFile,
  revealPathInBrowser,
  searchPanel,
  setTransientStatus,
  ui,
} from "../store.svelte";
import { exportPathToPdf } from "../fileActionExecutors";
import { isMarkdown } from "../fileTypes";
import { editorCommandsFor } from "../mountedEditors";
import {
  activeFileTab,
  flushTabEdits,
  forceReloadFromDisk,
  isDirty,
  openTerminalInActivePane,
  saveDraftTabToWorkspace,
  saveTabEdits,
  setTabHighlightTrailingWhitespace,
  setTabInspectorOpen,
  setTabOutlineOpen,
  setTabStyleToolbarOpen,
  setTabSyntaxHighlight,
  tabHasOutline,
  tabHasStyleToolbar,
  tabLabel,
  type FileTab,
} from "../tabs.svelte";
import { notify } from "../notify.svelte";
import { isDraftPath } from "../workspace.svelte";
import { basename, parentDir } from "../format";
import { api } from "../../api/client";
import { isTauriDesktop, runDesktopDownload } from "../../api/desktop";
import { displayPath, isDraftClientPath } from "../../api/fileIdentity";
import { terminalFromHereTarget } from "../../terminal/fromHere";
import { stripTrailingWhitespaceText } from "../../editor/tools";

/// Run an action against the active file tab, a no-op when none is
/// active. onSurface already hides these when no file tab is focused; the
/// guard keeps a stale invocation (tab closed between filter and run) safe.
function onFile(fn: (tab: FileTab) => void): () => void {
  return () => {
    const tab = activeFileTab();
    if (tab) fn(tab);
  };
}

/// Whether the active file tab is on a file with a place in the workspace.
/// A workspace's draft has none: no parent directory to copy, open a
/// terminal in, scope a graph to or show in the file browser.
function onPlacedFile(ctx: CommandContext): boolean {
  const tab = activeFileTab();
  return onSurface(ctx, "file") && !(tab !== null && isDraftClientPath(tab.path));
}

/// The active file tab's value for a toggle's state, null when no file tab
/// is active.
function fileState(read: (tab: FileTab) => boolean): () => boolean | null {
  return () => {
    const tab = activeFileTab();
    return tab ? read(tab) : null;
  };
}

/// Copy the tab's path, a draft's as a person reads it. A refused clipboard
/// leaves its reason on the status line until it is dismissed.
export function copyFilePath(tab: FileTab): Promise<void> {
  return copyTextToClipboard(displayPath(tab.path), {
    onSuccess: () => setTransientStatus("Copied file path"),
    onError: (msg) => {
      ui.status = `copy failed: ${msg}`;
      // Persistent so the error pill is dismissable; a null statusKind
      // would leave it stuck with no x and no auto-clear.
      ui.statusKind = "persistent";
    },
  });
}

/// Delete the tab's file. fileOps.remove asks before it deletes. A
/// workspace's draft is discarded from its own flow, not deleted.
export async function deleteFile(tab: FileTab): Promise<void> {
  if (isDraftClientPath(tab.path)) return;
  await fileOps.remove(tab.path, false);
}

/// Duplicate the tab's file beside it and open the copy. A workspace's
/// draft is no file of the workspace and is not duplicated as one.
export async function duplicateFile(tab: FileTab): Promise<void> {
  if (isDraftClientPath(tab.path)) return;
  await fileOps.duplicateFile(tab.path);
}

/// Whether a download or an export of the tab may read the server's copy,
/// saving a draft first. Both actions read that copy, and every surface that
/// offers them on an open tab (the commands, the Details panel and a draft's
/// action pill) runs them through `downloadFile` and `exportFileToPdf`, so
/// this is the one place their rule lives. A draft saves by the classic
/// autosave alone, so its server copy trails the editor by the autosave's
/// delay and for as long as a save keeps failing: its mounted editor commits
/// the input it buffers, and a draft that then holds unsaved text is saved
/// and waited for. A save that fails leaves its reason on the status line
/// (`saveTabEdits`) and so does a commit that throws, and either answers no:
/// the action is refused rather than run on the older text. A file that is
/// no draft is read as the server holds it, as a selection in the file
/// browser is. A tab that needs no save answers `true` itself, with no
/// promise to wait on, so its action starts inside the gesture that asked.
function saveDraftFirst(tab: FileTab): boolean | Promise<boolean> {
  if (!isDraftPath(tab.path)) return true;
  try {
    flushTabEdits([tab]);
  } catch (err) {
    notify(`${tabLabel(tab)} was not saved because its editor could not commit its input (${(err as Error).message}).`);
    return false;
  }
  return isDirty(tab) ? saveTabEdits(tab) : true;
}

/// Download the tab's file, a draft's too, as the server holds it once a
/// draft is saved (`saveDraftFirst`): the desktop's Downloads folder with the
/// transfer bubble's progress, the browser's own download elsewhere. A
/// standalone window's draft is a file of the machine and downloads as one.
/// A workspace's is asked for by its draft identity.
export async function downloadFile(tab: FileTab): Promise<void> {
  const path = tab.path;
  const ready = saveDraftFirst(tab);
  if (ready !== true && !(await ready)) return;
  if (!isDraftClientPath(path)) {
    fileOps.downloadPathWithProgress(path, false);
    return;
  }
  // The desktop's transfer record keeps a download's path in session
  // storage to offer Retry after a reload, and a workspace draft's client
  // path is never stored. So the desktop downloads one with no source to
  // retry from, and the browser's own download keeps no record at all.
  if (isTauriDesktop()) {
    const url = new URL(api.downloadUrl(path), window.location.href).toString();
    void runDesktopDownload(url, basename(path)).catch(() => {});
    return;
  }
  fileOps.downloadPath(path, false);
}

/// Render the tab's Markdown file to PDF, a draft's too, as the server holds
/// it once a draft is saved (`saveDraftFirst`); exportPathToPdf reports
/// progress and failure on the status line.
export async function exportFileToPdf(tab: FileTab): Promise<void> {
  const path = tab.path;
  if (!isMarkdown(path)) return;
  const ready = saveDraftFirst(tab);
  if (ready !== true && !(await ready)) return;
  await exportPathToPdf(path);
}

/// Open workspace search on the text selected in the tab's editor, capped
/// at 100 words; plain search with no selection. The selection lives in the
/// editor view's state, so it is still there after a menu or the launcher
/// took focus.
export function searchSelection(tab: FileTab): void {
  const selection = editorCommandsFor(tab.id)?.selectionText() ?? "";
  const words = selection.trim().split(/\s+/).filter(Boolean);
  if (words.length > 0) searchPanel.query = words.slice(0, 100).join(" ");
  searchPanel.open = true;
}

/// Show the tab's file in a file browser tab, selected, with its details
/// open. A workspace's draft has no row there.
export function showInFileBrowser(tab: FileTab): void {
  if (isDraftClientPath(tab.path)) return;
  revealPathInBrowser(tab.path, { inspectorOpen: true });
}

/// A find-family command. App.svelte serves the ids for a file tab and the
/// focused terminal serves the open and the two steps for itself. A step is
/// offered on both tabs; Find and Close find narrow the surface to a file
/// tab, since a terminal lists its own Find and closes its bar on Escape.
function findCommand(
  id: string,
  title: string,
  order: number,
  keywords: string[],
  available: (ctx: CommandContext) => boolean,
  unavailableReason?: () => string,
): Command {
  return {
    id,
    title,
    category: "Editor",
    scope: "app",
    surface: ["file", "terminal"],
    order,
    icon: "search",
    // The window-mode table lists the find family for a window that holds
    // terminals alone, so no capability gates it.
    requirement: "any",
    keywords,
    available,
    unavailableReason,
    run: () => dispatchChanCommand(id),
  };
}

/// Stepping a search needs the file tab's find bar open. A terminal holds
/// its own bar's state, so there the step is offered and the terminal
/// ignores it while the bar is closed.
function findBarOpen(ctx: CommandContext): boolean {
  if (onSurface(ctx, "terminal")) return !ctx.terminalControl;
  return onSurface(ctx, "file") && activeFileTab()?.find?.open === true;
}

registerCommands([
  {
    // The draft tab menu's Save: a path dialog, then the draft becomes a
    // file at the chosen place. It leads the list on a draft, as it leads
    // that menu.
    id: "app.draft.save",
    title: "Save draft",
    category: "Editor",
    scope: "app",
    surface: "file",
    order: -1,
    kind: "open",
    requirement: "drafts",
    keywords: ["Save to Workspace", "Save to Disk", "promote", "keep"],
    available: (ctx) => {
      const tab = activeFileTab();
      return onSurface(ctx, "file") && tab !== null && isDraftPath(tab.path);
    },
    unavailableReason: () => "Needs a draft",
    run: onFile((tab) => {
      void saveDraftTabToWorkspace(tab);
    }),
  },
  {
    id: "app.file.rename",
    title: "Rename file",
    category: "Editor",
    scope: "app",
    surface: "file",
    order: 0,
    kind: "open",
    requirement: "files",
    keywords: ["move", "rename"],
    available: (ctx) => onSurface(ctx, "file"),
    run: onFile((tab) => {
      void fileOps.rename(tab.path, false);
    }),
  },
  {
    id: "app.editor.outline",
    title: "Outline",
    category: "Editor",
    scope: "app",
    surface: "file",
    order: 1,
    kind: "toggle",
    requirement: "files",
    keywords: ["Toggle outline", "headings", "toc"],
    available: (ctx) => {
      const tab = activeFileTab();
      return onSurface(ctx, "file") && tab !== null && tabHasOutline(tab);
    },
    unavailableReason: () => "Needs a file with headings",
    state: fileState((tab) => tab.outlineOpen),
    run: onFile((tab) => setTabOutlineOpen(tab, !tab.outlineOpen)),
  },
  {
    id: "app.editor.details",
    title: "Details",
    category: "Editor",
    scope: "app",
    surface: "file",
    order: 2,
    kind: "toggle",
    // Filesystem facts work in every file window; index sections need a workspace.
    requirement: "files",
    keywords: ["Toggle details", "inspector", "info", "metadata"],
    available: (ctx) => onSurface(ctx, "file"),
    state: fileState((tab) => tab.inspectorOpen),
    run: onFile((tab) => setTabInspectorOpen(tab, !tab.inspectorOpen)),
  },
  {
    id: "app.editor.styleToolbar",
    title: "Style toolbar",
    category: "Editor",
    scope: "app",
    surface: "file",
    order: 3,
    kind: "toggle",
    requirement: "files",
    keywords: ["Toggle style toolbar", "format", "markdown", "toolbar"],
    available: (ctx) => {
      const tab = activeFileTab();
      return onSurface(ctx, "file") && tab !== null && tabHasStyleToolbar(tab);
    },
    unavailableReason: () => "Needs a Markdown file",
    state: fileState((tab) => tab.styleToolbarOpen),
    run: onFile((tab) => setTabStyleToolbarOpen(tab, !tab.styleToolbarOpen)),
  },
  {
    id: "app.editor.copyPath",
    title: "Copy file path",
    category: "Editor",
    scope: "app",
    surface: "file",
    order: 4,
    requirement: "files",
    keywords: ["Copy path to file", "clipboard", "path"],
    available: (ctx) => onSurface(ctx, "file"),
    run: onFile((tab) => void copyFilePath(tab)),
  },
  {
    id: "app.file.delete",
    title: "Delete file",
    category: "Editor",
    scope: "app",
    surface: "file",
    order: 5,
    requirement: "files",
    keywords: ["Delete", "remove", "trash"],
    available: onPlacedFile,
    unavailableReason: () => "Needs a file with a place in the workspace",
    // deleteFile asks before it deletes, so this needs no launcher-side
    // confirm gate.
    run: onFile((tab) => void deleteFile(tab)),
  },
  {
    id: "app.file.duplicate",
    title: "Duplicate file",
    category: "Editor",
    scope: "app",
    surface: "file",
    order: 6,
    requirement: "files",
    keywords: ["copy", "clone"],
    available: onPlacedFile,
    unavailableReason: () => "Needs a file with a place in the workspace",
    run: onFile((tab) => void duplicateFile(tab)),
  },
  {
    id: "app.editor.reloadFromDisk",
    title: "Reload from disk",
    category: "Editor",
    scope: "app",
    surface: "file",
    order: 7,
    requirement: "files",
    keywords: ["reload", "revert", "discard", "disk", "refresh"],
    available: (ctx) => onSurface(ctx, "file"),
    // forceReloadFromDisk runs its own confirm when the buffer would lose
    // unsaved edits, so this needs no launcher-side confirm gate.
    run: onFile((tab) => {
      void forceReloadFromDisk(tab.id);
    }),
  },
  // The find family lists together, in the order a search runs. The three
  // that follow Find take orders just past its own and short of the next
  // whole number, where every other row of the editor and of the terminal
  // sits, so the family stays adjacent on either tab. On a terminal tab the
  // two steps follow the terminal's own Find, which holds this Find's order.
  {
    // A terminal lists its own Find in this row's place, under the id of the
    // chord that opens its bar; it still answers this id when the desktop
    // sends it.
    ...findCommand("app.find.open", "Find", 8, ["Find on page", "search", "find bar"], (ctx) =>
      onSurface(ctx, "file"),
    ),
    surface: "file",
  },
  findCommand(
    "app.find.next",
    "Find next",
    8.1,
    ["search", "next match"],
    findBarOpen,
    () => "Needs the find bar open",
  ),
  findCommand(
    "app.find.prev",
    "Find previous",
    8.2,
    ["search", "previous match"],
    findBarOpen,
    () => "Needs the find bar open",
  ),
  {
    // The terminal's bar closes on its own Escape and has no command for it.
    ...findCommand(
      "app.find.close",
      "Close find",
      8.3,
      ["search", "find bar", "dismiss"],
      (ctx) => onSurface(ctx, "file") && activeFileTab()?.find?.open === true,
      () => "Needs the find bar open",
    ),
    surface: "file",
  },
  {
    id: "app.editor.searchSelection",
    title: "Search selection",
    category: "Editor",
    scope: "app",
    surface: "file",
    order: 9,
    kind: "open",
    // Seeds the global search panel, which queries the workspace index.
    requirement: "workspace",
    keywords: ["search", "find", "selection"],
    available: (ctx) => onSurface(ctx, "file"),
    run: onFile(searchSelection),
  },
  {
    // The Details inspector's actions on the open file, in its order.
    id: "app.editor.showInBrowser",
    title: "Show in file browser",
    category: "Editor",
    scope: "app",
    surface: "file",
    order: 10,
    requirement: "files",
    keywords: ["Show file", "reveal", "files", "tree", "explorer"],
    available: onPlacedFile,
    unavailableReason: () => "Needs a file with a place in the workspace",
    run: onFile(showInFileBrowser),
  },
  {
    id: "app.editor.download",
    title: "Download",
    category: "Editor",
    scope: "app",
    surface: "file",
    order: 11,
    requirement: "files",
    keywords: ["Download file", "save", "export"],
    available: (ctx) => onSurface(ctx, "file"),
    run: onFile(downloadFile),
  },
  {
    id: "app.editor.terminalFromHere",
    title: "New terminal here",
    category: "Editor",
    scope: "app",
    surface: "file",
    order: 12,
    // Spawns a terminal; the file path rides along as plain spawn data.
    requirement: "terminal",
    keywords: ["Terminal from here", "shell", "console", "cwd"],
    available: onPlacedFile,
    unavailableReason: () => "Needs a file with a place in the workspace",
    run: onFile((tab) => {
      if (isDraftClientPath(tab.path)) return;
      openTerminalInActivePane(terminalFromHereTarget(tab.path, false));
    }),
  },
  {
    id: "app.editor.exportPdf",
    title: "Export to PDF",
    category: "Editor",
    scope: "app",
    surface: "file",
    order: 13,
    requirement: "files",
    keywords: ["print", "save as"],
    available: (ctx) => onSurface(ctx, "file") && isMarkdown(activeFileTab()?.path ?? ""),
    unavailableReason: () => "Needs a Markdown file",
    run: onFile((tab) => void exportFileToPdf(tab)),
  },
  {
    id: "app.editor.graphFromHere",
    title: "New graph here",
    category: "Editor",
    scope: "app",
    surface: "file",
    order: 14,
    // The graph surface reads the workspace index.
    requirement: "workspace",
    keywords: ["Graph from here", "graph", "links", "scope"],
    available: onPlacedFile,
    unavailableReason: () => "Needs a file with a place in the workspace",
    run: onFile((tab) => openFsGraphForFile(tab.path)),
  },
  {
    id: "app.editor.toggleMode",
    title: "Source mode",
    category: "Editor",
    scope: "app",
    surface: "file",
    kind: "toggle",
    requirement: "files",
    keywords: ["Show source code", "source", "raw", "markdown", "wysiwyg", "toggle"],
    available: (ctx) => onSurface(ctx, "file"),
    state: fileState((tab) => tab.mode === "source"),
    run: () => dispatchChanCommand("app.editor.toggleMode"),
  },
  {
    id: "app.file.new",
    title: "New file",
    category: "Editor",
    scope: "app",
    surface: "file",
    kind: "open",
    requirement: "files",
    keywords: ["create", "file"],
    // Offered in every window that serves files, including standalone Files;
    // a terminal-only window has no file surface to create in.
    available: (ctx) => workspaceOnly(ctx),
    run: () => dispatchChanCommand("app.file.new"),
  },
  {
    id: "app.editor.toggleCollapse",
    title: "Collapse code blocks",
    category: "Editor",
    scope: "app",
    surface: "file",
    kind: "toggle",
    requirement: "files",
    keywords: ["Toggle collapse code blocks", "fold", "code", "expand", "blocks"],
    available: (ctx) => onSurface(ctx, "file"),
    // The tab records what was last asked for; the editor view owns the
    // fold ranges, so reach it through the mounted editor registry. A no-op
    // on files without foldable code blocks.
    state: fileState((tab) => tab.codeBlocksCollapsed),
    run: onFile((tab) => editorCommandsFor(tab.id)?.toggleCodeBlocks()),
  },
  {
    id: "app.editor.copyParentPath",
    title: "Copy parent directory path",
    category: "Editor",
    scope: "app",
    surface: "file",
    requirement: "files",
    keywords: ["Copy path to parent directory", "clipboard", "directory", "folder", "parent"],
    available: onPlacedFile,
    unavailableReason: () => "Needs a file with a place in the workspace",
    run: onFile((tab) => {
      if (isDraftClientPath(tab.path)) return;
      void copyTextToClipboard(parentDir(tab.path), {
        onSuccess: () => notify("Copied directory path"),
        onError: () => notify("Clipboard unavailable"),
      });
    }),
  },
  {
    id: "app.editor.toggleTrailingWs",
    title: "Highlight trailing whitespace",
    category: "Editor",
    scope: "app",
    surface: "file",
    kind: "toggle",
    requirement: "files",
    keywords: ["Toggle highlight trailing whitespace", "whitespace", "trailing"],
    available: (ctx) => onSurface(ctx, "file"),
    state: fileState((tab) => tab.highlightTrailingWhitespace),
    run: onFile((tab) =>
      setTabHighlightTrailingWhitespace(tab, !tab.highlightTrailingWhitespace),
    ),
  },
  {
    id: "app.editor.stripTrailingWs",
    title: "Remove trailing whitespace",
    category: "Editor",
    scope: "app",
    surface: "file",
    requirement: "files",
    keywords: ["whitespace", "trailing", "strip", "clean"],
    available: (ctx) => onSurface(ctx, "file"),
    run: onFile((tab) => {
      tab.content = stripTrailingWhitespaceText(tab.content);
    }),
  },
  {
    id: "app.editor.syntaxHighlight",
    title: "Syntax highlighting",
    category: "Editor",
    scope: "app",
    surface: "file",
    kind: "toggle",
    requirement: "files",
    keywords: ["Toggle syntax highlighting", "syntax", "highlight", "colors", "source", "code"],
    available: (ctx) => onSurface(ctx, "file"),
    // The flag persists per tab and Source mode honours it, so without this
    // entry a tab switched off in an older build could never switch back on.
    state: fileState((tab) => tab.syntaxHighlight),
    run: onFile((tab) => setTabSyntaxHighlight(tab, !tab.syntaxHighlight)),
  },
]);
