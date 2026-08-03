# Unified command launcher, SPA-only prototype

Status: SHIPPED in [v0.83.0](../release/release-v0.83.0.md). One searchable command deck rendered inline by the SPA that owns the focused window; no Tauri overlay window. An earlier overlay implementation was built and withdrawn.

## Decision

Build one searchable command-deck interaction model, rendered inline by the SPA that owns the focused window. Do not create a Tauri command-launcher window or transparent overlay.

Authority follows the rendering SPA:

- The Computers launcher SPA can command the library inventory its existing root bearer exposes. In Chan Desktop that is the aggregate local, devserver, and gateway inventory.
- A workspace or terminal SPA can command its contextual tab, pane, and window catalog plus only the library serving that window.
- A remote workspace cannot use its tenant token to inspect or control Chan Desktop's other libraries. The user returns to Computers for aggregate control.

`@chan/web-shared` owns the deck model, keyboard behavior, confirmation states, motion, and serializable per-tab draft. Each SPA owns its command targets and execution thunks.

## Scoped library capability

A workspace tenant bearer cannot call the root Computers API. It may instead mint a five-minute opaque command capability by presenting its tenant prefix and live `window_id`. The server verifies that the same tenant owns that live window, filters snapshots to its own `library_id`, redacts tenant and window tokens, and revokes the capability when the invoking `/ws` presence ends. Gateway grantees may inspect but not mutate.

New windows inherit the invoking window record's affinity: browser creates browser, native creates native. Browser windows navigate through a capability-checked redirect; native records are reconciled by the existing desktop watcher.

## Direct standalone tenant

`chan open --standalone` does not build a `WorkspaceHost` or install the root launcher router: it serves one workspace tenant directly. A 404/405 from the capability mint is therefore a topology signal, not permission to fabricate a library snapshot. The workspace adapter switches to a narrower same-tenant provider with only two targets:

- `New terminal` opens this tenant's `index.html` with a fresh `w` and `kind=terminal`.
- `New window` opens this tenant's `index.html` with a fresh `w` and workspace mode.

Both use same-origin browser navigation and clear only the cloned launcher draft. The adapter has no roster and offers no focus, hide, show, remote workspace, or remote terminal action. Aggregate control still requires the Computers launcher SPA.

## Prototype acceptance

- The existing command shortcut opens the deck inline in workspace, terminal, and Computers SPAs.
- Empty workspace search is contextual-first; typed search crosses contextual and current-library leaves.
- A direct standalone terminal can open another view of its own workspace, but cannot name or reach a devserver library.
- Computers search reaches aggregate machines, workspaces, and windows through the launcher SPA only.
- Hide, show, create, connect, disconnect, and workspace power operations use existing owners and confirmation paths.
- Launcher drafts survive hide/reopen and reload in the same browser tab, but credentials and pending/success operations do not persist.
- Browser smoke covers launcher-to-terminal, standalone-terminal-to-workspace, devserver-launcher-to-workspace, both cross-library refusals, scope navigation, and the no-native-overlay invariant.
