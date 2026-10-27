# The Command launcher over a terminal has no Toggle details, though the tab menu opens Details

Status: shipped at [v0.112.0](../../release/release-v0.112.0.md); the section Closing holds the evidence.

Record before the release: raised on 2026-10-26 by the owner during the v0.112.0 round; accepted into the round by the owner's word in the lead's tab.

## What was seen

The owner's words of 2026-10-26, typed in the lead's tab: "one more item: when I call the chan-launcher over a terminal (cmd+k on mac), there's no item for toggle the Details functionality which is in the right-click button of the tab".

Read at `3a45475bc`. Paths under `web/packages/workspace-app/src/` unless named.

- The surface the owner opens with Cmd+K is the Command launcher (`components/CommandLauncher.svelte`; the shortcuts table names it "Command launcher", Cmd+K on native macOS and Ctrl+Alt+K on the web). Its catalog is the commands registered under `state/commands/`, each with an `available(ctx)` predicate over the active surface.
- The editor has the command: `state/commands/editor.ts` registers `app.editor.details`, "Toggle details", category Editor, keywords `inspector, details, info, metadata`, available on a file surface, running `setTabInspectorOpen(tab, !tab.inspectorOpen)`; `setTabInspectorOpen` in `state/tabs.svelte.ts` takes a `FileTab`. The editor tab's context menu shows the same item with a check mark when the panel is open and the command's chord in its chord cell (`components/FileEditorTab.svelte`, `chordLabel("app.editor.details")`).
- The terminal has no such command: `state/commands/terminal.ts` registers theme, backend, secret masking, broadcast, name, group, Rich Prompt, restart, copy CWD and new entry, and nothing that reaches `inspectorOpen`. The terminal tab's context menu (`components/TerminalTab.svelte`, the "Details" button) sets `tab.inspectorOpen = true`, opening the floating Details panel (program status and the session's facts) with an empty chord cell; the panel's own close button sets it back. So over a terminal the launcher offers no way to open or close Details and no chord can be bound to it.
- The design document (`design.md`, "The floating Details panel and the outline") says the terminal's Details uses the same floating frame as the editor's; it does not say how it is opened.

## Desired contract

Over a terminal tab the Command launcher lists "Toggle details" in the Terminal category, like the editor's command over a file: running it opens the terminal's Details panel when closed and closes it when open, on the active terminal tab, and the command accepts a chord like any other. The control terminal, whose chrome belongs to the connect flow, lists no such command. The tab's context menu item and the launcher command act on the same state, and the menu item shows the command's chord when one is assigned. Nothing else about the Details panel changes.

## What to do

1. `state/commands/terminal.ts`: register `app.terminal.details`, title "Toggle details", the file's Terminal category, keywords `inspector, details, info, program status`, `available` through `onTerminal` (so the control terminal is excluded), `run` on the active terminal tab flipping `inspectorOpen`. Reuse `setTabInspectorOpen` by widening its parameter from `FileTab` to the tabs that carry `inspectorOpen` rather than writing the field in a second place.
2. `components/TerminalTab.svelte`: the menu item toggles rather than only opens, shows the check mark when the panel is open and reads `chordLabel("app.terminal.details")` in its chord cell, as the editor's item does.
3. Tests, red first: `state/commands/terminal.details.test.ts` in the shape of `terminal.metadata.test.ts`: the command is in `allCommands` with a terminal tab active and absent with the control terminal active; running it opens, then closes, the active terminal tab's `inspectorOpen`. The existing terminal tab component tests gain the menu case if the menu's markup moves. `requirementTable.test.ts`'s snapshot is refreshed in the same commit if the new command appears in it.
4. `design.md` ("The floating Details panel and the outline"): one sentence that the terminal's Details opens from its tab menu and toggles from the Command launcher like the editor's. If `web/packages/marketing/src/pages/manual/terminal.html` lists the tab menu's Details item, it names the launcher command beside it.

## Boundaries

`state/commands/terminal.ts` and its new test, `state/tabs.svelte.ts` (the helper's parameter type), `components/TerminalTab.svelte` (the one menu item), `design.md` (one sentence), the manual's terminal page if it lists the item. Not changed: the editor's command, the `Inspector` frame, the Details panel's content, the browser, graph and search surfaces' Details, the shortcuts table (the command ships with no default chord).

## Acceptance

1. In chan-desktop, over a terminal tab, Cmd+K lists "Toggle details"; running it opens the Details panel, running it again closes it; over the control terminal it is not listed.
2. The terminal tab's right-click menu item shows the chord once one is assigned to the command and reflects the open state.
3. The tests above red first and green after; `make web-check` and `make shortcuts-check` green.

## Closing

- The Terminal category offers `app.terminal.details` over a terminal tab and hides it over the control terminal. The command and the tab menu toggle the active tab's Details state through `setTabInspectorOpen`; the menu reflects that state and displays an assigned chord. The manual names the Command launcher action beside the tab menu's Details item.
- The new command and menu tests first failed with three expected assertions before implementation, then passed with five tests. Removing the control-terminal exclusion failed one assertion; replacing the state flip with a same-state write failed one assertion. Both mutations were reverted. The requirement table snapshot gained the command in five capability sets.
- The first `make web-check` failed four existing program-status assertions when the menu row was renamed; retaining its `Details` label restored the existing contract. The second full run timed out in the editor keymap and welcome animation tests after 30 seconds; both files passed alone. The final `make web-check` exited 0: launcher JS 57.0/60 KiB, four clean Svelte checks and test counts 218, 659, 7765 and 20. `make shortcuts-check` exited 0; the shortcuts table gained no row because the command has no default chord.
- The first `make web-marketing-check` stopped at its dist smoke when the sandbox denied a loopback listener with EPERM; its unchanged loopback-access retry exited 0, including eight tests, the marketing build, dist routes and installer smokes.
- Alex's chan-desktop reading of Cmd+K over a terminal, including the control terminal and an assigned chord, remains open.
