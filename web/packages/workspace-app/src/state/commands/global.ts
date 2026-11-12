// Net-new commands of the window and the workspace: Open, the screen-lock
// actions (test, set PIN), the window controls (Reload window, Open
// Inspector, Hide window, New window, Close window) that mirror the WebView
// native menu, and Show transfers and Show workspace warnings, the ways to
// the transfer panel and the warnings dialog while their status bar lines
// are closed. The reuse-existing entries live in core.ts; these need a new
// action or an in-app prompt. The screen lock's own settings (on or off, its
// theme) are fields of the Settings overlay and reach the launcher through
// the settings index. Register with registerCommands. See state/commands.ts
// for the Command shape and helpers.

import {
  allowedInWindow,
  dispatchChanCommand,
  registerCommands,
  withStatus,
  workspaceOnly,
} from "../commands";
import {
  backslashRefusal,
  discardWindowSession,
  openWorkspaceWarningsDialog,
  setTransientStatus,
  typedPathRoot,
  ui,
  uiPathPrompt,
  uiPrompt,
  workspace,
  workspaceWarningsDialog,
} from "../store.svelte";
import { loadScreensaverState, lockNow } from "../screensaver.svelte";
import { hashPin } from "../screensaver";
import { api, sessionWindowId } from "../../api/client";
import { errorText } from "../../api/errors";
import { windowCaps } from "../windowCaps";
import { backslashClimbReason } from "../pathValidate";
import {
  GRAPH_LINK_PREFIX,
  openBrowserInActivePane,
  openInActivePane,
  tmuxRequestCarrier,
} from "../tabs.svelte";
import { flushAndCloseWindow, flushAndHideWindow } from "../closeConfirm.svelte";
import { isTauriDesktop, openNewWindow, openWebInspector, reloadWindow } from "../../api/desktop";
import { showTransfers, transfers } from "../transfers.svelte";
import { uploadRequestCount } from "../uploadRequest.svelte";

async function testScreenLock(): Promise<void> {
  await loadScreensaverState();
  lockNow();
}

/// Send an Open target through `POST /api/open` (Contract C): the server
/// applies the exact `cs open` semantics (dir -> browser, text -> editor,
/// missing -> create + open, graph link verbatim) and the resulting window
/// command rides /ws to its destination. A routed acknowledgment names the
/// standalone window in a transient status; local frames report themselves.
/// A refusal stays in the status pill until dismissed.
async function executeOpen(target: string): Promise<void> {
  // A standalone window has no /api/open behind it (that route applies workspace
  // semantics: link targets, drafts, create-on-missing). Resolve the plain
  // path client-side instead: a listable target is a directory and opens in
  // the browser, anything else opens as a file tab (a missing path lands on
  // the standard missing-file banner).
  if (!windowCaps.workspace) {
    const wire = target.replace(/^\/+/, "").replace(/\/+$/, "");
    try {
      await api.list(wire);
      openBrowserInActivePane({ select: wire });
    } catch {
      await openInActivePane(wire);
    }
    return;
  }
  // /api/open creates a path that is missing, so a typed path is held to the
  // backslash rule before it is sent, as the path dialog holds it. The rule
  // judges no path that climbs with `..`, which the route resolves, so one
  // that also holds a `\` is refused first; the dialog refuses any `..`
  // itself. A graph link is no path, and the server judges it.
  const refusal = target.startsWith(GRAPH_LINK_PREFIX)
    ? null
    : (backslashClimbReason(target, typedPathRoot()) ?? (await backslashRefusal(target)));
  if (refusal) {
    ui.status = `open failed: ${refusal}`;
    ui.statusKind = "persistent";
    return;
  }
  try {
    const result = await api.open({ window_id: sessionWindowId(), target });
    if (result.window !== undefined) setTransientStatus(result.message);
  } catch (err) {
    // The refusal (binary target, workspace escape, no connected window)
    // stays until dismissed.
    ui.status = `open failed: ${errorText(err)}`;
    ui.statusKind = "persistent";
  }
}

/// The bare "Open" flow: a PathPromptModal in `open` mode (autocomplete,
/// no extension append, graph links allowed, "creates and opens"
/// disclosure). A cancel returns focus through the dialog's own opener: from
/// the launcher, the element the launcher opened from; from an assigned
/// chord, the control that held focus. A submitted open hands focus to the
/// opened surface instead.
async function openPathDialog(): Promise<void> {
  const target = await uiPathPrompt({
    title: "Open path or chan://graph link",
    kind: "either",
    mode: "open",
    allowAbsolute: true,
  });
  if (target === null) return;
  const trimmed = target.trim();
  if (trimmed !== "") await executeOpen(trimmed);
}

/// Prompt twice and set the screen-lock PIN. The salt is the workspace
/// root so the same digits hash differently per workspace, matching the
/// About-pane PIN dialog.
async function setScreenLockPin(): Promise<void> {
  const pin = await uiPrompt("Set screen-lock PIN");
  if (pin === null || pin === "") return;
  const again = await uiPrompt("Confirm screen-lock PIN");
  if (again === null) return;
  if (pin !== again) {
    setTransientStatus("PINs did not match");
    return;
  }
  await withStatus(
    async () => {
      const hash = await hashPin(pin, workspace.info?.root ?? "");
      await api.screensaverSetPin(hash);
    },
    "Screen-lock PIN set",
    "Could not set screen-lock PIN",
  );
}

/// The reason a desktop-only command gives in a browser.
function desktopOnlyReason(): string | null {
  return isTauriDesktop() ? null : "Needs the desktop app";
}

registerCommands([
  {
    // The global Open: bare invocation pops the path dialog; "Open <path>"
    // typed in the launcher forwards the remainder straight to /api/open
    // (acceptsArg). workspaceOnly hides it in standalone-terminal windows
    // (precedent "New file"): the route only mounts on workspace tenants
    // and the control socket refuses opens there anyway, so the launcher
    // simply never offers it. It closes the New tab group: what it opens
    // lands in the active pane as a tab.
    id: "app.open.path",
    title: "Open...",
    category: "Global",
    scope: "pane",
    group: "New tab",
    order: 2000,
    kind: "open",
    // Open resolves to a file or directory surface; a graph link target
    // still needs a workspace window to render, and run() reports the
    // server refusal there.
    requirement: "files",
    keywords: ["Open", "file", "path", "folder", "go to", "goto", "graph link"],
    icon: "folder",
    available: workspaceOnly,
    acceptsArg: true,
    run: (arg?: string) => {
      const target = arg?.trim();
      if (target) void executeOpen(target);
      else void openPathDialog();
    },
  },
  {
    id: "app.screensaver.test",
    title: "Test screen lock",
    category: "Global",
    scope: "workspace",
    order: 5,
    requirement: "workspace",
    keywords: ["Screen lock: test", "screensaver", "lock", "preview"],
    available: () => true,
    run: () => void testScreenLock(),
  },
  {
    id: "app.screensaver.setPin",
    title: "Set screen lock PIN",
    category: "Global",
    scope: "workspace",
    order: 6,
    kind: "open",
    requirement: "workspace",
    keywords: ["Screen lock: set PIN", "screensaver", "lock", "password", "passcode"],
    available: () => true,
    run: () => void setScreenLockPin(),
  },
  {
    // Desktop-only: the host routes by the invoking window's label, and the
    // browser has no equivalent. The native host owns Cmd+Shift+N, so this
    // launcher entry stays chordless.
    id: "app.window.new",
    title: "New window",
    category: "Global",
    scope: "window",
    order: 0,
    requirement: "any",
    keywords: ["new", "window", "open", "create"],
    available: (ctx) =>
      isTauriDesktop() && allowedInWindow("app.window.new", ctx),
    unavailableReason: desktopOnlyReason,
    run: () => void openNewWindow(),
  },
  {
    // A tmux window's own New window: a new tmux window in a chan window of
    // its own, the request the desktop's New Window makes there. Offered
    // while this window shows a tmux pane to carry the request.
    id: "app.tmux.newWindow",
    title: "New tmux window",
    category: "Global",
    scope: "window",
    order: 1,
    requirement: "terminal",
    keywords: ["tmux", "window", "new"],
    available: () => tmuxRequestCarrier() !== null,
    unavailableReason: () => "Needs a tmux window",
    run: () => dispatchChanCommand("app.tmux.newWindow"),
  },
  {
    // Desktop-only: the browser owns its window lifecycle and the wrapper
    // no-ops there. Shares the SHORTCUTS id so the row renders its chord;
    // allowedInWindow keeps the launcher aligned with the host bridge. The
    // close discards the window's session, as the close-window command does,
    // once the desktop has not refused it: the discard deletes the session
    // and stops every later save of it by the page, which would otherwise
    // write back the record the desktop's close removes.
    id: "app.window.close",
    title: "Close window",
    category: "Global",
    scope: "window",
    order: 2,
    requirement: "any",
    keywords: ["close", "window", "discard", "destroy"],
    confirm: {
      title: "Close this window?",
      message: "Its tabs and terminal sessions will close.",
      actionLabel: "Close window",
      danger: true,
    },
    available: (ctx) =>
      isTauriDesktop() && allowedInWindow("app.window.close", ctx),
    unavailableReason: desktopOnlyReason,
    run: () => void flushAndCloseWindow({ discard: () => discardWindowSession() }),
  },
  {
    // The close-confirm overlay's Hide answer without the prompt: bury THIS
    // window (sessions stay warm, the record persists hidden and reopens from
    // the launcher). Shares the SHORTCUTS id so the row renders its chord.
    // Desktop-only: the bury IPC is an explicit no-op in a plain browser, so
    // the entry is not offered there.
    id: "app.window.hide",
    title: "Hide window",
    category: "Global",
    scope: "window",
    order: 3,
    requirement: "any",
    keywords: ["hide", "window", "bury", "minimize"],
    available: () => isTauriDesktop(),
    unavailableReason: desktopOnlyReason,
    run: () => flushAndHideWindow(),
  },
  {
    // Shares the SHORTCUTS id so the launcher row renders its chord read
    // only. reloadWindow works on web (location.reload) and desktop (IPC).
    id: "app.window.reload",
    title: "Reload window",
    category: "Global",
    scope: "window",
    order: 4,
    requirement: "any",
    keywords: ["Reload", "refresh", "window"],
    available: () => true,
    run: () => void reloadWindow(),
  },
  {
    // Desktop-only: on web the browser owns DevTools and openWebInspector
    // no-ops, so it is not offered there. Cmd+Opt+I is a Tauri-native chord
    // that bypasses the SPA, so this launcher entry stays chordless.
    id: "app.window.devtools",
    title: "Open Inspector",
    category: "Global",
    scope: "window",
    order: 5,
    kind: "open",
    requirement: "any",
    keywords: ["devtools", "inspector", "console", "javascript", "debug"],
    available: () => isTauriDesktop(),
    unavailableReason: desktopOnlyReason,
    run: () => void openWebInspector(),
  },
  {
    // The status bar's Transfers launcher can be closed while a transfer
    // runs; this keeps the panel, and a running transfer's Cancel, reachable.
    id: "app.transfers.show",
    title: "Show transfers",
    category: "Global",
    scope: "window",
    order: 11,
    kind: "open",
    requirement: "files",
    keywords: ["transfers", "upload", "download", "progress", "cancel"],
    available: () => transfers.items.length > 0 || uploadRequestCount() > 0,
    unavailableReason: () => "No transfers to show",
    run: showTransfers,
  },
  {
    // The warnings dialog otherwise opens only from the status bar's
    // warnings line, which can be closed.
    id: "app.workspace.showWarnings",
    title: "Show workspace warnings",
    category: "Global",
    scope: "workspace",
    order: 7,
    kind: "open",
    requirement: "workspace",
    keywords: ["warnings", "broken", "draft", "problems"],
    available: () => workspaceWarningsDialog.warnings.length > 0,
    unavailableReason: () => "No workspace warnings",
    run: openWorkspaceWarningsDialog,
  },
]);
