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
  type CommandRequirement,
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
  requirement: CommandRequirement,
  keywords: string[],
  options: ReuseOptions = {},
): Command {
  return {
    id,
    title,
    category,
    requirement,
    ...options,
    keywords,
    available: (ctx) => allowedInWindow(id, ctx),
    run: () => dispatchChanCommand(id),
  };
}

registerCommands([
  // Global
  reuse("app.search.toggle", "Search", "Global", "workspace", ["find", "grep"]),
  {
    id: "app.pane.mode",
    title: "Enter hybrid navigation",
    category: "Global",
    requirement: "any",
    keywords: ["nav", "pane", "keyboard", "wasd"],
    // Hybrid Nav has no terminal-only guard on its chord, so it stays
    // available in every window, standalone terminals included.
    available: () => true,
    run: () => enterPaneMode(),
  },
  reuse("app.screensaver.lock", "Lock screen now", "Global", "any", [
    "screensaver",
    "lock",
  ]),

  // Apps
  reuse("app.terminal.toggle", "New terminal", "Apps", "terminal", [
    "shell",
    "console",
  ]),
  reuse("app.terminal.teamWork", "New team", "Apps", "workspace", [
    "team work",
    "agents",
  ]),
  reuse("app.draft.new", "New draft", "Apps", "drafts", [
    "markdown",
    "note",
  ]),
  reuse("app.graph.toggle", "New graph", "Apps", "workspace", [
    "links",
    "network",
  ]),
  reuse("app.files.toggle", "New file browser", "Apps", "files", [
    "files",
    "tree",
    "explorer",
  ]),
  reuse("app.dashboard.open", "New dashboard", "Apps", "workspace", [
    "slides",
    "present",
  ]),

  // Tabs
  reuse("app.tab.close", "Close tab", "Tabs", "any", ["close"], {
    confirm: {
      title: "Close the active tab?",
      message: "The tab will be removed from this pane.",
      actionLabel: "Close tab",
      danger: true,
    },
  }),
  reuse("app.tab.next", "Next tab", "Tabs", "any", ["tab", "next", "switch"]),
  reuse("app.tab.prev", "Previous tab", "Tabs", "any", [
    "tab",
    "previous",
    "switch",
    "back",
  ]),
  {
    id: "app.tab.reopenClosed",
    title: "Reopen last closed tab",
    category: "Tabs",
    // Pure client state (the closed-tab stack), so any window can restore
    // whatever kind of tab it was able to open in the first place.
    requirement: "any",
    keywords: ["undo", "restore", "tab"],
    // Only offer it when the closed-tab stack has something to restore.
    available: () => canReopenClosedTab(),
    run: () => {
      reopenClosedTab();
    },
  },

  // Panes
  reuse("app.pane.splitRight", "Split right", "Panes", "any", [
    "split",
    "vertical",
  ]),
  reuse("app.pane.splitDown", "Split bottom", "Panes", "any", [
    "split",
    "horizontal",
    "down",
  ]),
  reuse("app.pane.prev", "Previous pane", "Panes", "any", ["focus", "pane"]),
  reuse("app.pane.next", "Next pane", "Panes", "any", ["focus", "pane"]),
  reuse(
    "app.pane.closeTabs",
    "Close all tabs in pane",
    "Panes",
    "any",
    ["close"],
    {
      confirm: {
        title: "Close every tab in this pane?",
        message: "Unsaved drafts will still keep their normal safety check.",
        actionLabel: "Close tabs",
        danger: true,
      },
    },
  ),
  reuse("app.pane.kill", "Close pane", "Panes", "any", ["close", "kill"], {
    shortcutEditable: false,
    shortcutIds: ["app.tab.close", "app.window.close"],
    confirm: {
      title: "Close this pane?",
      message: "Every tab in the pane will close with it.",
      actionLabel: "Close pane",
      danger: true,
    },
  }),
  reuse("app.pane.flip", "Flip pane", "Panes", "any", [
    "flip",
    "side",
    "a",
    "b",
  ]),
]);
