# Terminal appearance settings do not reach a standalone terminal

Status: REGISTERED for v0.85.0, filed 2026-08-05, accepted, not specced. Follow-up to the custom
terminal background work that ships in v0.84.1 (`6ffbe7d7`), which paints the terminal chrome from
the resolved custom background in a workspace window. The owner reports the appearance settings do
not take effect in a standalone terminal window; the break has not yet been located, which is the
first task.

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

NOT established, and the first thing to settle: where the chain breaks. The candidates are that the
slim tenant does not serve or persist the preference, that the SPA does not load preferences in
terminal-only mode, or that it loads them and the surface does not apply them. These have different
fixes, so the investigation precedes the spec — the same discipline the
[`desktop-library-window-open-unavailable`](desktop-library-window-open-unavailable.md) item earned
the hard way.

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

- Whether the slim standalone tenant persists preferences per user or per tenant, and what it does
  with a preference it has no workspace to scope to.
- Whether any other setting reachable in terminal-only mode has the same silent no-op shape.
