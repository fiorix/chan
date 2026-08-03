// Reuse-existing Global, Apps, Tabs, and Panes commands: each maps a launcher
// entry to an action that already runs through a chord. Chorded ids
// dispatch a chan:command so they share App.svelte's dispatch and its
// window-mode guard; the two chordless entries (Hybrid Nav, Reopen closed
// tab) have no runCommand case, so they call their exported action
// directly and gate visibility themselves.

import {
  registerCommands,
  dispatchChanCommand,
  allowedInWindow,
  type Command,
  type CommandCategory,
} from "../commands";
import {
  enterPaneMode,
  reopenClosedTab,
  canReopenClosedTab,
} from "../tabs.svelte";

type ReuseOptions = Pick<Command, "shortcutEditable" | "shortcutIds" | "confirm">;

/// A reuse-existing chorded command: run() dispatches the id, available()
/// mirrors runCommand's window-mode guard so the launcher hides it in the
/// same windows runCommand would drop it.
function reuse(
  id: string,
  title: string,
  category: CommandCategory,
  keywords: string[],
  options: ReuseOptions = {},
): Command {
  return {
    id,
    title,
    category,
    ...options,
    keywords,
    available: (ctx) => allowedInWindow(id, ctx),
    run: () => dispatchChanCommand(id),
  };
}

registerCommands([
  // Global
  reuse("app.search.toggle", "Search", "Global", ["find", "grep"]),
  {
    id: "app.pane.mode",
    title: "Enter hybrid navigation",
    category: "Global",
    keywords: ["nav", "pane", "keyboard", "wasd"],
    // Hybrid Nav has no terminal-only guard on its chord, so it stays
    // available in every window, standalone terminals included.
    available: () => true,
    run: () => enterPaneMode(),
  },
  reuse("app.screensaver.lock", "Lock screen now", "Global", [
    "screensaver",
    "lock",
  ]),

  // Apps
  reuse("app.terminal.toggle", "New terminal", "Apps", ["shell", "console"]),
  reuse("app.terminal.teamWork", "New team", "Apps", ["team work", "agents"]),
  reuse("app.draft.new", "New draft", "Apps", ["markdown", "note"]),
  reuse("app.graph.toggle", "New graph", "Apps", ["links", "network"]),
  reuse("app.files.toggle", "New file browser", "Apps", [
    "files",
    "tree",
    "explorer",
  ]),
  reuse("app.dashboard.open", "New dashboard", "Apps", ["slides", "present"]),

  // Tabs
  reuse("app.tab.close", "Close tab", "Tabs", ["close"], {
    confirm: {
      title: "Close the active tab?",
      message: "The tab will be removed from this pane.",
      actionLabel: "Close tab",
      danger: true,
    },
  }),
  reuse("app.tab.next", "Next tab", "Tabs", ["tab", "next", "switch"]),
  reuse("app.tab.prev", "Previous tab", "Tabs", [
    "tab",
    "previous",
    "switch",
    "back",
  ]),
  {
    id: "app.tab.reopenClosed",
    title: "Reopen last closed tab",
    category: "Tabs",
    keywords: ["undo", "restore", "tab"],
    // Only offer it when the closed-tab stack has something to restore.
    available: () => canReopenClosedTab(),
    run: () => {
      reopenClosedTab();
    },
  },

  // Panes
  reuse("app.pane.splitRight", "Split right", "Panes", ["split", "vertical"]),
  reuse("app.pane.splitDown", "Split bottom", "Panes", [
    "split",
    "horizontal",
    "down",
  ]),
  reuse("app.pane.prev", "Previous pane", "Panes", ["focus", "pane"]),
  reuse("app.pane.next", "Next pane", "Panes", ["focus", "pane"]),
  reuse("app.pane.closeTabs", "Close all tabs in pane", "Panes", ["close"], {
    confirm: {
      title: "Close every tab in this pane?",
      message: "Unsaved drafts will still keep their normal safety check.",
      actionLabel: "Close tabs",
      danger: true,
    },
  }),
  reuse("app.pane.kill", "Close pane", "Panes", ["close", "kill"], {
    shortcutEditable: false,
    shortcutIds: ["app.tab.close", "app.window.close"],
    confirm: {
      title: "Close this pane?",
      message: "Every tab in the pane will close with it.",
      actionLabel: "Close pane",
      danger: true,
    },
  }),
  reuse("app.pane.flip", "Flip pane", "Panes", [
    "flip",
    "side",
    "a",
    "b",
  ]),
]);
