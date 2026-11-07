# The graph tab menu and the inspector action pill take Escape in the bubble phase

Status: shipped in [v0.125.0](../../release/release-v0.125.0.md).

Record before the release: built for v0.125.0 and carried in its first release candidate `0.125.0-rc0` (`67fd26b38`); the rendered inspector pill was compared with the removed inline pill and not inspected in a browser.

## What is there now

v0.124.0 made a terminal's and an editor's right-click menus take an Escape aimed outside them in the window's capture phase, since the surface under the menu kept focus and took the key first ([escape-does-not-close-a-terminals-right-click-menu](../done/escape-does-not-close-a-terminals-right-click-menu.md)). Two menus keep the pattern that fix replaced: `GraphPanel.svelte`'s tab menu closes on `<svelte:window onkeydown>`, and `InspectorActionPill.svelte`'s menu on a `document` keydown listener, both in the bubble phase. Nothing under them takes Escape first today, so neither misbehaves; any surface under them that stops Escape, as the terminal engines do, would leave the menu open and hand the key to that surface.

## Desired contract

Every menu that owns Escape takes it in the capture phase, or through one shared helper, so the menu closes first whatever holds focus under it, and an Escape typed in a menu's own fields still reaches them first. The v0.100.0 contract stands: an open menu owns Escape.

## Acceptance

1. Mounted tests for both menus with an element under them that stops Escape in the bubble phase: the menu closes and the element does not see the key; red on the bubble-phase listener.
2. The existing menu tests stay green.

## Built

- `53df2dbf5` shares `menuEscape` between terminal and editor menus: capture closes an open menu before an outside focused surface sees Escape, while an Escape from a menu field reaches that field before the menu closes in the bubble phase. `ab0d4d513` applies the same ownership to the graph tab menu and inspector action pill; the pill replaces the matching inline copy in `FileInfoBody`, removing its third document bubble listener while retaining the pill's markup, attributes and menu actions.
- The mounted graph and pill outside-Escape arms failed against their original bubble listeners because the focused surface consumed the key and the menu stayed open. A graph depth-slider arm failed when the inside-menu exception was removed, and the pill's outside arm failed again when its window listener was temporarily moved back to the bubble phase. After restoration, the helper, terminal and editor focused run passed 119/119; the graph, pill and file-info focused run passed 50/50. Closed-menu and non-Escape controls passed through.
- At `53df2dbf5`, the first `make web-check` run had one unrelated debounced-write failure in `RichPrompt.chrome.test.ts`; that file passed alone 22/22, and the unchanged commit's full rerun passed with shared 243/243, launcher 763/763, workspace 8575/8575 and profile 20/20. At `ab0d4d513`, `make web-check` passed with shared 243/243, launcher 763/763, workspace 8581/8581 and profile 20/20; all Svelte checks had zero errors and warnings and both production bundles built. A second isolated gate at that fix commit passed in 315 seconds.
- In the guest, check 207 passed: xterm and Ghostty body and strip menu Escape arms closed the menu, left terminal focus in place and delivered only the typed PTY marker `78`; their no-menu controls delivered Escape `1b` followed by `78`. The editor body and strip arms closed the menu and kept editor focus and the selection `[2,6]`; its no-menu control collapsed the selection to `[6,6]`. Check 206 passed with the empty-body, strip and empty-side pane menus showing Commands and Reload, the terminal body menu ending in Commands, and the welcome or terminal retaining focus. The six focused guest suites passed 169/169 with a clean Svelte check.
- The rendered inspector pill was not separately inspected in a browser; its shared markup and CSS were compared with the removed inline pill and its attributes and Escape behavior passed mounted tests.
