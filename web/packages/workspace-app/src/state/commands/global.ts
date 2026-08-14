// Net-new Global commands: theme (system / light / dark), the screen-lock
// family (enable / disable / test / set pin / theme), and the window
// controls (Reload, Open Inspector, Hide window, New window, Close window)
// that mirror the WebView native menu. The reuse-existing Global entries
// live in core.ts; these need a new action or an in-app prompt. Theme,
// screen lock, and Reload are machine-global; the other window controls
// are desktop-only. Register with registerCommands. See state/commands.ts
// for the Command shape and helpers.

import { allowedInWindow, registerCommands, workspaceOnly } from "../commands";
import {
  launcherReturnFocus,
  setThemeChoice,
  setTransientStatus,
  ui,
  uiPathPrompt,
  uiPrompt,
  workspace,
} from "../store.svelte";
import { loadScreensaverState, lockNow } from "../screensaver.svelte";
import { hashPin } from "../screensaver";
import { api, sessionWindowId } from "../../api/client";
import {
  hideWindowFromCloseConfirm,
  isTauriDesktop,
  openNewWindow,
  openWebInspector,
  reloadWindow,
  requestCloseWindow,
} from "../../api/desktop";

/// Run a config write and report the outcome as a transient pill, so a
/// launcher command that mutates state still gives feedback without an
/// inline settings panel.
async function withStatus(
  fn: () => Promise<unknown>,
  ok: string,
  fail: string,
): Promise<void> {
  try {
    await fn();
    setTransientStatus(ok);
  } catch {
    setTransientStatus(fail);
  }
}

async function testScreenLock(): Promise<void> {
  await loadScreensaverState();
  lockNow();
}

/// Send an Open target through `POST /api/open` (Contract C): the server
/// applies the exact `cs open` semantics (dir -> browser, text -> editor,
/// missing -> create + open, graph link verbatim) and the resulting window
/// command rides /ws back to THIS window. Success needs no pill of its own
/// - the arriving frame's handler already reports; a refusal lands in the
/// status pill persistently so it survives until the user has seen it.
async function executeOpen(target: string): Promise<void> {
  try {
    await api.open({ window_id: sessionWindowId(), target });
  } catch (err) {
    // Persistent so the pill gets a dismiss control; a bare `ui.status =`
    // leaves statusKind null, and the refusal (binary target, workspace
    // escape, no connected window) then sticks forever with no way to
    // clear it.
    ui.status = `open failed: ${err instanceof Error ? err.message : String(err)}`;
    ui.statusKind = "persistent";
  }
}

/// The bare "Open" flow: a PathPromptModal in `open` mode (autocomplete,
/// no extension append, graph links allowed, ruling-6 "creates and opens"
/// disclosure). Cancel restores focus to the element captured when the
/// launcher opened (the launcher itself is long dismissed by now); a
/// submitted open hands focus to the opened surface instead.
async function openPathDialog(): Promise<void> {
  const returnFocus = launcherReturnFocus();
  const target = await uiPathPrompt({
    title: "Open path or chan://graph link",
    kind: "either",
    mode: "open",
    allowAbsolute: true,
  });
  if (target === null) {
    if (returnFocus?.isConnected) returnFocus.focus();
    return;
  }
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

registerCommands([
  {
    // The global Open: bare invocation pops the path dialog; "Open <path>"
    // typed in the launcher forwards the remainder straight to /api/open
    // (acceptsArg). workspaceOnly hides it in standalone-terminal windows
    // (precedent "New file"): the route only mounts on workspace tenants
    // and the control socket refuses opens there anyway, so the launcher
    // simply never offers it.
    id: "app.open.path",
    title: "Open",
    category: "Global",
    // Open resolves to a file or directory surface; a graph link target
    // still needs a workspace window to render, and run() reports the
    // server refusal there.
    requirement: "files",
    keywords: ["open", "file", "path", "folder", "go to", "goto", "graph link"],
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
    id: "app.theme.system",
    title: "Theme: system",
    category: "Global",
    requirement: "any",
    keywords: ["appearance", "auto", "dark", "light"],
    available: () => true,
    run: () => setThemeChoice("system"),
  },
  {
    id: "app.theme.light",
    title: "Theme: light",
    category: "Global",
    requirement: "any",
    keywords: ["appearance"],
    available: () => true,
    run: () => setThemeChoice("light"),
  },
  {
    id: "app.theme.dark",
    title: "Theme: dark",
    category: "Global",
    requirement: "any",
    keywords: ["appearance"],
    available: () => true,
    run: () => setThemeChoice("dark"),
  },
  {
    id: "app.screensaver.enable",
    title: "Screen lock: on",
    category: "Global",
    requirement: "any",
    keywords: ["screensaver", "lock", "privacy"],
    available: () => true,
    run: () =>
      void withStatus(
        () => api.screensaverPatch({ enabled: true }),
        "Screen lock on",
        "Screen lock update failed",
      ),
  },
  {
    id: "app.screensaver.disable",
    title: "Screen lock: off",
    category: "Global",
    requirement: "any",
    keywords: ["screensaver", "lock", "privacy"],
    available: () => true,
    run: () =>
      void withStatus(
        () => api.screensaverPatch({ enabled: false }),
        "Screen lock off",
        "Screen lock update failed",
      ),
  },
  {
    id: "app.screensaver.test",
    title: "Screen lock: test",
    category: "Global",
    requirement: "any",
    keywords: ["screensaver", "lock", "preview"],
    available: () => true,
    run: () => void testScreenLock(),
  },
  {
    id: "app.screensaver.setPin",
    title: "Screen lock: set PIN",
    category: "Global",
    requirement: "any",
    keywords: ["screensaver", "lock", "password", "passcode"],
    available: () => true,
    run: () => void setScreenLockPin(),
  },
  {
    id: "app.screensaver.theme.plain",
    title: "Screen lock theme: default",
    category: "Global",
    requirement: "any",
    keywords: ["screensaver", "plain"],
    available: () => true,
    run: () =>
      void withStatus(
        () => api.screensaverPatch({ theme: "plain" }),
        "Screen lock theme: default",
        "Screen lock update failed",
      ),
  },
  {
    id: "app.screensaver.theme.matrix",
    title: "Screen lock theme: matrix",
    category: "Global",
    requirement: "any",
    keywords: ["screensaver", "matrix", "rain"],
    available: () => true,
    run: () =>
      void withStatus(
        () => api.screensaverPatch({ theme: "matrix" }),
        "Screen lock theme: matrix",
        "Screen lock update failed",
      ),
  },
  {
    // Shares the SHORTCUTS id so the launcher row renders its chord read
    // only. reloadWindow works on web (location.reload) and desktop (IPC).
    id: "app.window.reload",
    title: "Reload",
    category: "Global",
    requirement: "any",
    keywords: ["reload", "refresh", "window"],
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
    requirement: "any",
    keywords: ["devtools", "inspector", "console", "javascript", "debug"],
    available: () => isTauriDesktop(),
    run: () => void openWebInspector(),
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
    requirement: "any",
    keywords: ["hide", "window", "bury", "minimize"],
    available: () => isTauriDesktop(),
    run: () => void hideWindowFromCloseConfirm(),
  },
  {
    // Desktop-only: the host routes by the invoking window's label, and the
    // browser has no equivalent. The native host owns Cmd+Shift+N, so this
    // launcher entry stays chordless.
    id: "app.window.new",
    title: "New window",
    category: "Global",
    requirement: "any",
    keywords: ["new", "window", "open", "create"],
    available: (ctx) =>
      isTauriDesktop() && allowedInWindow("app.window.new", ctx),
    run: () => void openNewWindow(),
  },
  {
    // Desktop-only: the browser owns its window lifecycle and the wrapper
    // no-ops there. Shares the SHORTCUTS id so the row renders its chord;
    // allowedInWindow keeps the launcher aligned with the host bridge.
    id: "app.window.close",
    title: "Close window",
    category: "Global",
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
    run: () => void requestCloseWindow(),
  },
]);
