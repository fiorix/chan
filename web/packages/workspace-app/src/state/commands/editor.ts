// Editor surface commands: available when a file tab is the active
// surface. Chorded reuse ids dispatch through the chan:command bridge so
// they share App.svelte's dispatch and its window-mode guard; net-new
// actions call their exported action function directly against the active
// file tab. A view switch the tab holds as state is a toggle named for the
// thing it shows. The find family is listed here and serves a terminal tab
// too, whose own listener answers the same ids. See state/commands.ts for
// the Command shape and the onSurface / dispatchChanCommand / workspaceOnly
// helpers.

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
} from "../store.svelte";
import { editorCommandsFor } from "../mountedEditors";
import {
  activeFileTab,
  forceReloadFromDisk,
  openTerminalInActivePane,
  saveDraftTabToWorkspace,
  setTabHighlightTrailingWhitespace,
  setTabInspectorOpen,
  setTabOutlineOpen,
  setTabStyleToolbarOpen,
  setTabSyntaxHighlight,
  tabHasOutline,
  tabHasStyleToolbar,
  type FileTab,
} from "../tabs.svelte";
import { notify } from "../notify.svelte";
import { isDraftPath } from "../workspace.svelte";
import { parentDir } from "../format";
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

/// A find-family command. App.svelte serves the ids for a file tab and the
/// focused terminal serves them for itself, so each is offered on both.
function findCommand(
  id: string,
  title: string,
  order: number | undefined,
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
    // The window-mode table lists the find family for a window that holds
    // terminals alone, so no capability gates it.
    requirement: "any",
    keywords,
    available,
    unavailableReason,
    run: () => dispatchChanCommand(id),
  };
}

function onFileOrTerminal(ctx: CommandContext): boolean {
  return onSurface(ctx, "file") || (onSurface(ctx, "terminal") && !ctx.terminalControl);
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
    run: onFile((tab) => {
      // A draft's path is copied as a person reads it.
      void copyTextToClipboard(displayPath(tab.path), {
        onSuccess: () => notify("Copied file path"),
        onError: () => notify("Clipboard unavailable"),
      });
    }),
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
    // A workspace's draft is discarded from its own flow, not deleted.
    available: onPlacedFile,
    unavailableReason: () => "Needs a file with a place in the workspace",
    // fileOps.remove asks before it deletes, so this needs no
    // launcher-side confirm gate.
    run: onFile((tab) => {
      if (isDraftClientPath(tab.path)) return;
      void fileOps.remove(tab.path, false);
    }),
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
    available: (ctx) => onSurface(ctx, "file"),
    run: onFile((tab) => {
      void fileOps.duplicateFile(tab.path);
    }),
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
  findCommand("app.find.open", "Find", 8, ["Find on page", "search", "find bar"], onFileOrTerminal),
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
    // The selection lives in the editor view's state, so it survives the
    // launcher taking focus; seed the search overlay with it, capped at
    // 100 words. With no selection this opens plain search.
    run: onFile((tab) => {
      const selection = editorCommandsFor(tab.id)?.selectionText() ?? "";
      const words = selection.trim().split(/\s+/).filter(Boolean);
      if (words.length > 0) searchPanel.query = words.slice(0, 100).join(" ");
      searchPanel.open = true;
    }),
  },
  findCommand(
    "app.find.next",
    "Find next",
    undefined,
    ["search", "next match"],
    findBarOpen,
    () => "Needs the find bar open",
  ),
  findCommand(
    "app.find.prev",
    "Find previous",
    undefined,
    ["search", "previous match"],
    findBarOpen,
    () => "Needs the find bar open",
  ),
  {
    // The terminal's bar closes on its own Escape and has no command for it.
    ...findCommand(
      "app.find.close",
      "Close find",
      undefined,
      ["search", "find bar", "dismiss"],
      (ctx) => onSurface(ctx, "file") && activeFileTab()?.find?.open === true,
      () => "Needs the find bar open",
    ),
    surface: "file",
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
    id: "app.editor.terminalFromHere",
    title: "New terminal here",
    category: "Editor",
    scope: "app",
    surface: "file",
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
    id: "app.editor.graphFromHere",
    title: "New graph here",
    category: "Editor",
    scope: "app",
    surface: "file",
    // The graph surface reads the workspace index.
    requirement: "workspace",
    keywords: ["Graph from here", "graph", "links", "scope"],
    available: onPlacedFile,
    unavailableReason: () => "Needs a file with a place in the workspace",
    run: onFile((tab) => openFsGraphForFile(tab.path)),
  },
  {
    id: "app.editor.showInBrowser",
    title: "Show in file browser",
    category: "Editor",
    scope: "app",
    surface: "file",
    requirement: "files",
    keywords: ["reveal", "files", "tree", "explorer"],
    available: onPlacedFile,
    unavailableReason: () => "Needs a file with a place in the workspace",
    run: onFile((tab) => {
      if (isDraftClientPath(tab.path)) return;
      revealPathInBrowser(tab.path, { inspectorOpen: true });
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
