// Reuse-existing commands: each maps a launcher entry to an action that
// already runs through a chord. Chorded ids dispatch a chan:command so they
// share App.svelte's dispatch and its window-mode guard; the two chordless
// entries (Hybrid Nav, Reopen closed tab) have no runCommand case, so they
// call their exported action directly and gate visibility themselves.
//
// The Pane scope is assembled here: the spawners of its New tab group, then
// the Tab and Pane groups, each in the order the launcher lists them. The
// Pane group leaves room between Flip pane and the two closes for the
// divider commands of panes.ts.

import {
  registerCommands,
  dispatchChanCommand,
  allowedInWindow,
  dashboardOpenAllowed,
  openChoice,
  type Command,
} from "../commands";
import {
  enterPaneMode,
  panesHaveSides,
  reopenClosedTab,
  canReopenClosedTab,
} from "../tabs.svelte";
import { shellProfiles } from "../shellProfiles.svelte";
// The extension tab's own commands, loaded with the catalog's core so the
// App scope of an extension tab is never short of them.
import "./extension";

type ReuseSpec = Omit<Command, "available" | "run"> & Partial<Pick<Command, "available">>;

/// A reuse-existing chorded command: run() dispatches the id, available()
/// mirrors runCommand's window-mode guard so the launcher hides it in the
/// same windows runCommand would drop it.
function reuse(spec: ReuseSpec): Command {
  const { id } = spec;
  return {
    available: (ctx) => allowedInWindow(id, ctx),
    ...spec,
    run: () => dispatchChanCommand(id),
  };
}

registerCommands([
  // Workspace
  reuse({
    id: "app.search.toggle",
    title: "Search workspace",
    category: "Global",
    scope: "workspace",
    kind: "open",
    order: 0,
    requirement: "workspace",
    keywords: ["Search", "find", "grep"],
  }),
  // The lock and the `app.screensaver.*` rows beside it in global.ts call
  // per-workspace routes and read state a workspace window loads, so a window
  // without one can offer them but never run them.
  reuse({
    id: "app.screensaver.lock",
    title: "Lock screen now",
    category: "Global",
    scope: "workspace",
    order: 4,
    requirement: "workspace",
    keywords: ["screensaver", "lock"],
  }),

  // Window
  {
    id: "app.pane.mode",
    title: "Hybrid Nav",
    category: "Global",
    scope: "window",
    order: 6,
    requirement: "any",
    keywords: ["Enter hybrid navigation", "nav", "pane", "keyboard", "wasd"],
    // Hybrid Nav has no terminal-only guard on its chord, so it stays
    // available in every window, standalone terminals included.
    available: () => true,
    run: () => enterPaneMode(),
  },

  // Pane: New tab
  reuse({
    id: "app.terminal.toggle",
    title: "New terminal",
    category: "Apps",
    scope: "pane",
    group: "New tab",
    order: 0,
    requirement: "terminal",
    keywords: ["shell", "console"],
  }),
  {
    // The shell profiles the pane menu lists under New terminal. Offered
    // when the server names more than one: with a single shell there is
    // nothing to choose.
    id: "app.terminal.profile",
    title: "New terminal with profile",
    category: "Apps",
    scope: "pane",
    group: "New tab",
    order: 1,
    kind: "choice",
    requirement: "terminal",
    keywords: ["shell", "profile", "console"],
    available: (ctx) => allowedInWindow("app.terminal.toggle", ctx) && shellProfiles().length > 1,
    unavailableReason: () => "Needs more than one shell profile",
    options: () =>
      shellProfiles().map((profile) => ({
        id: profile.id,
        label: profile.name,
        checked: false,
        dismiss: true,
        run: () => dispatchChanCommand("app.terminal.toggle", { profile: profile.id }),
      })),
    run: () => openChoice("app.terminal.profile"),
  },
  reuse({
    id: "app.terminal.teamWork",
    title: "New team",
    category: "Apps",
    scope: "pane",
    group: "New tab",
    order: 2,
    requirement: "workspace",
    keywords: ["team work", "agents"],
  }),
  reuse({
    id: "app.draft.new",
    title: "New draft",
    category: "Apps",
    scope: "pane",
    group: "New tab",
    order: 3,
    requirement: "drafts",
    keywords: ["markdown", "note"],
  }),
  reuse({
    id: "app.graph.toggle",
    title: "New graph",
    category: "Apps",
    scope: "pane",
    group: "New tab",
    order: 4,
    requirement: "workspace",
    keywords: ["links", "network"],
  }),
  reuse({
    id: "app.files.toggle",
    title: "New file browser",
    category: "Apps",
    scope: "pane",
    group: "New tab",
    order: 5,
    requirement: "files",
    keywords: ["files", "tree", "explorer"],
  }),
  reuse({
    id: "app.dashboard.open",
    title: "New dashboard",
    category: "Apps",
    scope: "pane",
    group: "New tab",
    order: 6,
    requirement: "any",
    keywords: ["slides", "present"],
    // runCommand refuses it in a pane showing a tmux pane, which draws no
    // tab strip, so the launcher does not offer it there either.
    available: dashboardOpenAllowed,
    unavailableReason: () => "Needs a pane with a tab strip",
  }),

  // Pane: Tab
  reuse({
    id: "app.tab.close",
    title: "Close tab",
    category: "Tabs",
    scope: "pane",
    group: "Tab",
    order: 0,
    requirement: "any",
    keywords: ["close"],
    confirm: {
      title: "Close the active tab?",
      message: "The tab will be removed from this pane.",
      actionLabel: "Close tab",
      danger: true,
    },
  }),
  reuse({
    id: "app.tab.next",
    title: "Next tab",
    category: "Tabs",
    scope: "pane",
    group: "Tab",
    order: 1,
    requirement: "any",
    keywords: ["tab", "next", "switch"],
  }),
  reuse({
    id: "app.tab.prev",
    title: "Previous tab",
    category: "Tabs",
    scope: "pane",
    group: "Tab",
    order: 2,
    requirement: "any",
    keywords: ["tab", "previous", "switch", "back"],
  }),
  {
    id: "app.tab.reopenClosed",
    title: "Reopen closed tab",
    category: "Tabs",
    scope: "pane",
    group: "Tab",
    order: 3,
    // Pure client state (the closed-tab stack), so any window can restore
    // whatever kind of tab it was able to open in the first place.
    requirement: "any",
    keywords: ["Reopen last closed tab", "undo", "restore", "tab"],
    // Only offer it when the closed-tab stack has something to restore.
    available: () => canReopenClosedTab(),
    unavailableReason: () => "No closed tab to reopen",
    run: () => {
      reopenClosedTab();
    },
  },

  // Pane: Pane
  reuse({
    id: "app.pane.splitRight",
    title: "Split right",
    category: "Panes",
    scope: "pane",
    group: "Pane",
    order: 0,
    requirement: "any",
    keywords: ["split", "vertical"],
  }),
  reuse({
    id: "app.pane.splitDown",
    title: "Split down",
    category: "Panes",
    scope: "pane",
    group: "Pane",
    order: 1,
    requirement: "any",
    keywords: ["Split bottom", "split", "horizontal"],
  }),
  reuse({
    id: "app.pane.next",
    title: "Next pane",
    category: "Panes",
    scope: "pane",
    group: "Pane",
    order: 2,
    requirement: "any",
    keywords: ["focus", "pane"],
  }),
  reuse({
    id: "app.pane.prev",
    title: "Previous pane",
    category: "Panes",
    scope: "pane",
    group: "Pane",
    order: 3,
    requirement: "any",
    keywords: ["focus", "pane"],
  }),
  reuse({
    id: "app.pane.flip",
    title: "Flip pane",
    category: "Panes",
    scope: "pane",
    group: "Pane",
    order: 4,
    requirement: "any",
    keywords: ["Flip", "Flip pane side", "side", "a", "b"],
    available: (ctx) => allowedInWindow("app.pane.flip", ctx) && panesHaveSides(),
    unavailableReason: () => "Needs a pane with two sides",
  }),
  reuse({
    id: "app.pane.closeTabs",
    title: "Close all tabs in pane",
    category: "Panes",
    scope: "pane",
    group: "Pane",
    order: 10,
    requirement: "any",
    keywords: ["close"],
    confirm: {
      title: "Close every tab in this pane?",
      message: "Unsaved drafts will still keep their normal safety check.",
      actionLabel: "Close tabs",
      danger: true,
    },
  }),
  reuse({
    id: "app.pane.kill",
    title: "Close pane",
    category: "Panes",
    scope: "pane",
    group: "Pane",
    order: 11,
    requirement: "any",
    keywords: ["close", "kill"],
    shortcutEditable: false,
    shortcutIds: ["app.tab.close", "app.window.close"],
    confirm: {
      title: "Close this pane?",
      message: "Every tab in the pane will close with it.",
      actionLabel: "Close pane",
      danger: true,
    },
  }),
]);
