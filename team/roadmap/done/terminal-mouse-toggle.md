# A Terminal Mouse Toggle

> Status: shipped in [v0.75.0](../../release/release-v0.75.0.md): per-terminal terminal.mouse_capture toggle.

Status: accepted scope for v0.75.0, deferred out of v0.74.0 by owner ruling ("needs testing, a setting, and a command-launcher entry, not the time this round"). This is a feature, not a bug: nothing is broken today, there is simply no way to turn the terminal's mouse handling off.

## Problem

The embedded terminal (xterm.js v6) always drives every mouse mechanism it has, and there is no switch to disable them. A full-screen TUI running in the terminal (an editor, a pager, `htop`) sends DECSET mouse-reporting sequences, and the terminal honors them, so the pointer is captured by the program instead of selecting text, and the user loses ordinary click-drag selection with no way to get it back short of quitting the program.

"Mouse" is not one thing. Five independent mechanisms each contribute, and each is refused differently:

- **Reporting to the PTY.** `CoreMouseService` answers DECSET (1000/1002/1003/1006 and friends) and forwards pointer events to the PTY. xterm.js exposes no public API to refuse mouse reporting once a program enables it.
- **Selection.** `SelectionService` plus chan's `selectionBypass.ts` own click-drag text selection.
- **Wheel.** xterm's default wheel-to-scroll (and alt-screen wheel-to-arrows) behavior.
- **Links.** `WebLinksAddon` turns URLs into clickable links.
- **Context menu.** chan's own `onTerminalContextMenu` handler.

There is no existing mouse toggle anywhere in the terminal surface to extend.

## Desired contract

A per-terminal (server-configured, default on) switch that turns mouse handling off. Two variants were scoped, and the round should settle which one the setting means before implementing:

- **Stop TUIs from capturing the mouse** (the narrower, likely-intended one): drop the mouse-report escape sequences on the `routeXtermData` / `handleXtermData` `onData` path, or intercept pointer events in the capture phase, so a TUI cannot take the mouse while everything else (selection, wheel, links) keeps working. Roughly a single switch.
- **Kill all mouse handling** (the literal one): gate the four-to-five co-located sites across `TerminalTab.svelte`, `selectionBypass.ts`, and the addon load so selection, wheel, links, context menu, and reporting all go silent.

Either variant needs the same plumbing: a `terminal.*` boolean in the server config and a checkbox in `TerminalSection.svelte`, both wired exactly like the existing `scrollback_mb` and `mcp_env` settings.

## Boundaries

- Copy the `scrollback_mb` / `mcp_env` config and settings-UI wiring rather than inventing a new pattern; the value flows server config to session frame to the terminal, and the checkbox writes it back.
- Do not fork xterm.js. The reporting-refusal has to live on chan's data path or a capture-phase intercept, because xterm.js offers no public API to decline mouse reporting.
- Decide the variant first; do not ship the literal "kill all mouse" scope if the narrower "stop TUIs capturing it" is what the setting should mean.

## Acceptance

- With the setting off, a TUI that enables mouse reporting no longer captures the pointer, and ordinary text selection works over that TUI (narrow variant), or all five mechanisms are inert (literal variant), per the settled variant.
- With the setting on (default), behavior is byte-for-byte what it is today.
- The setting round-trips through the server config and the `TerminalSection.svelte` checkbox and survives a reconnect and a restart, matching `scrollback_mb`.
- A red-proof captures the pre-change capture behavior before the gate is added.
