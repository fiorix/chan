# Terminal appearance settings do not reach a standalone terminal

Status: REGISTERED for v0.85.0, filed 2026-08-05, accepted, break located 2026-08-05. Follow-up to the custom terminal background work that ships in v0.84.1 (`6ffbe7d7`), which paints the terminal chrome from the resolved custom background in a workspace window. The owner reported that appearance settings do not take effect in a standalone terminal window. The break is two SPA boundaries, recorded below, and the fix reaches the whole terminal preference set rather than appearance alone.

Component: `workspace-app` SPA (`web/packages/workspace-app`), and whichever server surface backs a
standalone terminal tenant.

## What

A standalone terminal window is the same `workspace-app` SPA loaded in terminal-only mode, and its
terminal should honour the same appearance settings a workspace window's terminal does — font size
and the custom colour set, including the background that v0.84.1 extends to the surrounding chrome.
Today it does not, so a user who customises their terminal sees two different terminals depending on
which kind of window opened it.

## Verified current state (2026-08-05)

- A standalone terminal is not a separate app. `terminalOnly` is set once at bootstrap from the
  `?kind=terminal` query param the desktop shell puts on the URL — the only signal, with no server
  bootstrap marker (`web/packages/workspace-app/src/state/store.svelte.ts:310-318`) — and describes
  "a workspace-less standalone terminal window backed by a slim server tenant" with no workspace,
  file tree, editor, graph, file-browser, or dashboard (`:275-282`).
- Both window kinds therefore render the same `TerminalTab.svelte`, so the v0.84.1 chrome fix is
  present in both by construction.
- The settings surface is reachable in terminal-only mode: `app.settings.open` is available there,
  pinned by `web/packages/workspace-app/src/state/commands/settingsCommand.test.ts:35`. It is
  specifically NOT gated by `workspaceOnly` (`state/commands.ts:178-181`).
- The custom values come from `prefs.terminal_colors` (`components/settings/AppearanceSection.svelte:116-117`,
  typed at `api/types.ts:267`).

**Located 2026-08-05.** Of the three candidates, the second is correct: the slim tenant serves the preferences and the SPA never asks for them.

The server side is complete. `terminal_router` mounts `GET /api/config` (`crates/chan-server/src/lib.rs:1112`), and `build_terminal_app` loads the same global `EditorPrefs` and `ServerConfig` a workspace tenant loads (`:846-859`), with a comment stating the editor preferences are loaded so they can seed the SPA shell in terminal mode. `PreferencesView` is documented as the shared shape returned over both `/api/workspace` and `/api/config` (`crates/chan-server/src/routes/preferences.rs:34-69`) and carries `terminal_colors` and `terminal`.

The apply side is also complete: both window kinds render the same `TerminalTab.svelte`, whose colour derivation, live re-theme effect, and chrome binding are unconditional.

The break is two SPA boundaries. On initial load, `bootstrapTerminalOnly()` (`web/packages/workspace-app/src/state/store.svelte.ts:2019-2079`) never populates `workspace.info` and never fetches preferences, where the workspace path does at `:2087-2089`. On a live change, `config_changed` routes to `scheduleWorkspaceRefresh()` (`:844`), which returns early for terminal-only windows (`:2451`) because `/api/workspace` genuinely 404s on that tenant. Fixing either alone leaves the other broken.

Every read of `workspace.info?.preferences` in a standalone terminal therefore yields `undefined` and falls back to a default. The effect is wider than appearance: the same null source also defaults `scrollback_mb`, `mouse_capture`, `secret_masking`, the font chain, and the terminal backend (`components/TerminalTab.svelte:823-850, 888`). A user who selected the ghostty backend gets xterm.js in every standalone terminal. The fix restores the source, so standalone terminals begin honoring the selected backend, scrollback, mouse capture, and secret masking, not only appearance.

`SettingsOverlay.svelte` already reads `api.config()` for its own form (`:99-101`), with a comment naming exactly this asymmetry. That is why the bug is invisible from the settings surface: the values display and persist correctly while the terminal beside them renders defaults.

**Fixed 2026-08-05 by `fix(terminal): apply terminal preferences in standalone windows`.** The SPA gained `currentPreferences()`, backed by a standalone source that the terminal-only bootstrap fills from `/api/config` and that `config_changed` refreshes through the same path. `TerminalTab` reads it at its three preference sites. The workspace path is unchanged and still takes its payload from `/api/workspace` with no additional round trip.

## Contract

Terminal appearance settings apply to every terminal chan renders, whatever kind of window hosts it.
A standalone terminal and a workspace window's terminal, on the same machine and same user, present
the same font size and colours.

Reachable settings that silently do not apply are worse than absent ones: if some setting genuinely
cannot apply in terminal-only mode, the surface says so rather than accepting a value it ignores.

## Acceptance checks

- Set a custom terminal background, font size, and colour set. Open a standalone terminal: it
  matches the workspace window's terminal, chrome included.
- Change a setting while a standalone terminal is open: it updates live there, matching the
  workspace-window behaviour.
- Verify in both a local and a gateway-served standalone terminal, since the tenant differs.
- Regression: the workspace-window path is unchanged.

## Boundaries

Terminal-only mode's other exclusions stay as they are — no workspace, file tree, editor, graph,
file-browser, dashboard, rich prompt, or team work. This is about appearance settings reaching the
terminal that mode does render, not about restoring workspace surfaces.

## Open

- Whether the slim standalone tenant persists preferences per user or per tenant, and what it does with a preference it has no workspace to scope to. The fix does not change where the server reads configuration from, so whether a gateway-served standalone terminal's `/api/config` reflects the owner's preferences is still unsettled and remains an owner acceptance check.
- Whether any other setting reachable in terminal-only mode has the same silent no-op shape.
