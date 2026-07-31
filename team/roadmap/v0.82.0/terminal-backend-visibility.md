# Make the terminal backend visible and switchable

Status: REGISTERED for v0.82.0; grounded 2026-07-31 against the shipped ghostty-web backend.

## What

`terminal.ghostty` selects the ghostty-web VT engine for newly opened terminals, defaulting off. Two things are missing around it.

A program running inside a chan terminal cannot tell which engine is rendering it. The terminal exports `CHAN_TAB_NAME`, `CHAN_WINDOW_ID`, `CHAN_WORKSPACE_PATH`, and the `CHAN_MCP_*` discovery set, but nothing names the backend. An agent or script that wants to adapt its output, or a user filing a rendering bug, has no way to read it.

The setting is also reachable only from the Settings pane. `web/packages/workspace-app/src/state/commands/settings.ts` registers a single command that opens Settings, and the terminal command group in `state/commands/terminal.ts` carries theme, broadcast, name, group, Rich Prompt, restart, and `$CWD` actions but nothing for the backend. Every other frequently flipped terminal preference is reachable from the launcher.

## Two readers, two surfaces

The backend has two audiences, and they are served differently.

A program inside the terminal reads `CHAN_TERMINAL` from its environment. That value comes from the `terminal.ghostty` preference the server already persists, so it is written at spawn with no extra wire traffic and no ordering constraint.

A human reads the terminal's own context menu. The SPA holds the resolved backend after its lazy WASM load has either succeeded or fallen back to xterm, so the menu reports what is actually rendering.

The two can disagree in one case: the ghostty kit fails to load and the SPA falls back to xterm while the preference still reads true. `ghostty-web` is a plain dependency whose WASM is bundled into the SPA and embedded in the binary, so it is served from the same origin as the page that already loaded; a failure means a broken build or a transient loopback fetch error. The environment variable therefore reports the configured backend, and the context menu is the authority on what is running. Threading a client-resolved value back through session creation is not worth the cost on every terminal spawn to close a gap this narrow.

## Contract

- A terminal exports `CHAN_TERMINAL`, whose value is `xterm` or `ghostty`, taken from the `terminal.ghostty` preference at spawn.
- The variable reports the configured backend. Its documentation says so plainly, so a reader is never misled into treating it as an observation.
- The variable is present in workspace terminals and standalone terminals alike, on the same footing as the other `CHAN_` discovery variables.
- Restarting a terminal re-reads the preference, consistent with the existing spawn-time contract for scrollback, mouse capture, font, and the backend itself.
- The terminal's right-click context menu opens with a non-interactive row naming the engine actually in use, followed by a separator, above the existing items. It reflects the post-fallback value, so a terminal that fell back to xterm says xterm.
- The Command Launcher carries a terminal-backend command in the Terminal category, following the shape of the existing terminal preference commands.
- The launcher command states the current value and makes the spawn-time contract explicit, because flipping it affects only newly opened terminals. It does not imply the running terminal changes.
- `chan dump-skill` documents `CHAN_TERMINAL` wherever the other terminal environment variables are described, so an agent can discover it.

## Acceptance

- A terminal opened with `terminal.ghostty` off reports `CHAN_TERMINAL=xterm`.
- A terminal opened with `terminal.ghostty` on reports `CHAN_TERMINAL=ghostty`.
- Restarting a session after flipping the preference reports the new value; the pre-existing session keeps its original value until restarted.
- The context menu names the engine in use, and names xterm when a forced kit-load failure has fallen the session back.
- The launcher command appears in the Terminal category, is discoverable by searching for the engine name, and flipping it changes the stored preference.
- A test pins the variable name, since it becomes a public discovery surface the moment it ships.

## Rough size

Small. All three pieces follow established patterns: the variable joins the existing spawn-time environment set, the launcher command mirrors the other terminal preference commands, and the context-menu header reads a value the component already holds.
