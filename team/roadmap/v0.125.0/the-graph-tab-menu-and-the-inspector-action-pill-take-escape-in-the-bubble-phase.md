# The graph tab menu and the inspector action pill take Escape in the bubble phase

Status: raised at the v0.124.0 close from the Escape fix for the terminal's menu; not started.

## What is there now

v0.124.0 made a terminal's and an editor's right-click menus take an Escape aimed outside them in the window's capture phase, since the surface under the menu kept focus and took the key first ([escape-does-not-close-a-terminals-right-click-menu](../done/escape-does-not-close-a-terminals-right-click-menu.md)). Two menus keep the pattern that fix replaced: `GraphPanel.svelte`'s tab menu closes on `<svelte:window onkeydown>`, and `InspectorActionPill.svelte`'s menu on a `document` keydown listener, both in the bubble phase. Nothing under them takes Escape first today, so neither misbehaves; any surface under them that stops Escape, as the terminal engines do, would leave the menu open and hand the key to that surface.

## Desired contract

Every menu that owns Escape takes it in the capture phase, or through one shared helper, so the menu closes first whatever holds focus under it, and an Escape typed in a menu's own fields still reaches them first. The v0.100.0 contract stands: an open menu owns Escape.

## Acceptance

1. Mounted tests for both menus with an element under them that stops Escape in the bubble phase: the menu closes and the element does not see the key; red on the bubble-phase listener.
2. The existing menu tests stay green.
