# Off macOS the close chord discards the window where macOS closes the tab, and six layers can claim it

Status: REGISTERED 2026-08-11 as v0.89.0 scope, carried forward from a draft the owner raised the same day from using the Linux desktop app. The owner's ruling sized it "small change, wide verification", and that shape is the item rather than a note about it: the edit is a handful of lines, and proving it did not break something else on another surface is the deliverable, so the acceptance section below is a matrix over every surface that can claim the chord instead of a list of checks. Verification against `f9c2878c` before promotion corrected the draft on five counts, each recorded in place below: the number of layers that can claim the chord, the size of the edit surface, the reachability of the off-mac menubar route, the phrase "no keydown branch at all", and the last-tab question, which the draft never asked and which the code already answers for two of the four window kinds.

## What

On macOS the tab-close chord is `Cmd+W` and the window-close chord is `Cmd+Shift+W`. Off macOS the browser owns `Ctrl+W` and chan deliberately declines to claim it, because `Ctrl+W` is readline delete-word in a focused shell. The natural substitute a Linux or Windows user reaches for is `Ctrl+Shift+W`. chan spends it on window close:

```
surface            chord         command
-----------------  ------------  -----------------
mac native         Cmd+W         app.tab.close
mac native         Cmd+Shift+W   app.window.close
linux/win native   Ctrl+D        app.tab.close
linux/win native   Ctrl+Shift+W  app.window.close  <- the defect
web, all OS        Ctrl+D        app.tab.close
web, all OS        (none)        app.window.close
```

The bridge branch that spends it is `case 'KeyW'` at desktop/src-tauri/src/serve.rs:2325, whose `fire(e, 'app.window.close')` is at :2330. So the chord a Linux user reaches for to close a tab discards the whole window instead, which deletes the window's persisted session blob (`discardWindowSession`, web/packages/workspace-app/src/state/store.svelte.ts:3114) and lets the server reap its terminal sessions.

`Ctrl+D` remains bound to tab close and works, but it is not the chord anyone arrives with, and it is EOF in a shell, which is exactly why it is the one global chord deliberately excluded from the terminal-escape set (`non-flagged chords default to undefined`, web/packages/workspace-app/src/components/chordEscapeRegistry.test.ts:49-55).

The shape this item needs already exists. `app.tab.close` is already OS-divergent: `osChord` returns `Mod+W` for `(native, mac)` and the stored `Ctrl+D` everywhere else (web/packages/workspace-app/src/state/shortcuts.ts:530-532). `Ctrl+Alt+*` is the established off-mac substitute in that same function, used by `app.launcher.toggle` (shortcuts.ts:513-515), `app.launcher.computers` (:516-518), `app.tab.reopenClosed` (:541-543) and `app.search.toggle` (:544). A grep over `.ts`, `.svelte`, `.rs`, `.md` and `.html` outside the gitignored `dev/` tree returns no occurrence of `Ctrl+Alt+W` at all, so the obvious new home for window close is unclaimed.

## Every layer that can claim this chord

The draft named three layers. There are six, and the two it missed are the ones that decide whether the change is safe:

```
layer                        file:line          Ctrl+Shift+W today
---------------------------  -----------------  ----------------------
SPA keydown, onWindowKey     App.svelte:922     no, gated !e.shiftKey
SPA terminal chord escape    shortcuts.ts:713   yes, via window.close
desktop key bridge           serve.rs:2325      yes, fires window.close
connecting-screen script     connecting.js:348  yes, bridge shadows it
menubar accel, macOS         main.rs:5895       no, Cmd+W carries no shift
menubar accel, off macOS     main.rs:6122       yes, launcher window only
the browser itself, off mac  n/a                yes, its own close-window
```

The two the draft missed:

**The terminal chord-escape registry.** `registryEscapeCommandId` (shortcuts.ts:707-730) walks every `SHORTCUTS` entry flagged `escapeTerminal` and resolves each through `osChord(s, platform, os)` (:713). `app.window.close` carries `escapeTerminal: true` (shortcuts.ts:246), so today `Ctrl+Shift+W` matches and `shouldEscapeTerminal` returns true, which is what makes `TerminalTab.svelte:2303` return `false` and stop xterm consuming the keystroke. Move the chord to `app.tab.close` and that stops: `app.tab.close` has no `escapeTerminal` flag (shortcuts.ts:276-283) and cannot be given one, because the flag is per entry rather than per resolved chord, and setting it would also escape the entry's `web` chord, which is `Ctrl+D`, breaking shell EOF in a browser. The draft reached the same conclusion and then assumed the bridge's capture would cover it. That assumption is plausible by reading, since `window.addEventListener('keydown', onKey, true)` (serve.rs:2355) is a window-capture listener installed by an initialization script that runs before any page script, and `fire` calls both `preventDefault` and `stopImmediatePropagation` (serve.rs:2155-2157). It is still an assumption about event ordering against two terminal backends, and the acceptance matrix below tests it rather than restating it.

**The connecting-screen page script.** desktop/src/connecting.js:348 computes `const close = ((e.metaKey || e.ctrlKey) && key === 'w') || (e.ctrlKey && key === 'd');` from a lowercased `e.key`, so it matches `Ctrl+Shift+W` as well as `Ctrl+W`. It never runs for that chord today only because the bridge registered its window-capture listener first and calls `stopImmediatePropagation`. That is a shadowing relationship the change must not disturb, and `connecting_screen_windows_close_for_real` (serve.rs:3471-3501) pins it with an exact count: `assert_eq!(SERVE_RS.matches(close_invoke).count(), 2)` at serve.rs:3495 asserts precisely two `request_close_window` routings in the bridge, one per branch, and trips the moment the branches change hands.

## Where the chord must be intercepted, given that only the launcher has a menubar off macOS

[desktop-launcher-only-menubar](../done/desktop-launcher-only-menubar.md) shipped in v0.79.0 and settles this. Off macOS there is no app-wide menu and only the Chan Launcher window carries a bar, attached per window with `Window::set_menu` (main.rs:5447); every other window is born menu-less, and the doc block on `install_app_menu` (main.rs:5815-5824) states it. macOS keeps one global menubar installed with `app.set_menu` (main.rs:5975).

Three consequences, all load bearing for this item:

1. **Off macOS the chord must be intercepted in `KEY_BRIDGE_JS`, and there is nothing else it could fight with.** A workspace, outbound, standalone-terminal or control-terminal window has no accelerator, so the bridge and the SPA's own keydown are the only claimants. That is why the fix is a bridge edit rather than a menu edit.

2. **The launcher is the one off-mac window where an accelerator does claim the chord**, `CmdOrCtrl+Shift+W` at main.rs:6122, routed by `handle_close_window` (main.rs:7278) into `close_spa_or_native_window` (main.rs:7296). The launcher label is not a workspace webview label (`is_workspace_webview_label`, serve.rs:345-355), so it takes the `else` arm at main.rs:7320 and closes natively, which the launcher's own `CloseRequested` handler turns into a hide (main.rs:5458-5460).

3. **The off-mac `app.window.close` dispatch inside `close_spa_or_native_window` (main.rs:7317) appears to be unreachable through the menu.** The accelerator lives only on the launcher's bar, so the focused window `handle_close_window` finds is the launcher, which never reaches the workspace-webview branch. This is an argument from where the menu is attached, not a demonstration; nobody has confirmed that a GTK per-window accelerator cannot fire with a different window focused, and the acceptance matrix includes that cell.

## What the draft claimed, and what survived reading the code at f9c2878c

Every `file:line` in the draft was opened. All of them resolve, and the substantive claims hold, with four corrections.

**Corrected: the edit surface is seven sites, not five.** The draft's five are right as far as they go: the `osChord` tab-close branch (shortcuts.ts:528-532), the `KeyW` keydown branch (App.svelte:914-935), the bridge's non-shift `KeyW` (serve.rs:2256-2280), the bridge's shift `KeyW` (serve.rs:2319-2331), and the launcher accelerator (main.rs:6114-6123). It omits two that decide behaviour: the `cfg!(target_os = "macos")` split in `close_spa_or_native_window` (main.rs:7314-7318), which chooses which command id the menu route dispatches and whose off-mac arm is written for the chord this item moves; and the `escapeTerminal` consequence described above, which is a decision rather than an edit but changes what a focused terminal does.

**Corrected: "app.window.close has no keydown branch at all" needs a qualifier.** It has no in-page keydown branch, which is the draft's point and is true, and it therefore never reaches `builtInChordSuperseded`. It does have a command handler, App.svelte:1345-1349, reached from the bridge's `chan:command` event and from the OS close button. The distinction matters because the repair is not "add a handler" but "make the bridge's dispatch subject to supersession", which is a different piece of work and belongs to a different item.

**Confirmed by reading, not by running: plain `Ctrl+W` in an off-mac control-terminal window already closes that window.** `onWindowKey` computes `const meta = e.metaKey || e.ctrlKey;` at App.svelte:573, and the branch at :922 tests `meta && !e.altKey && !e.shiftKey && e.code === "KeyW"`. The `ui.terminalControl` arm at :923-928 fires `requestCloseWindow()` with no `metaKey` gate; only the tab-close arm at :929 has one. The bridge's non-shift `KeyW` case does nothing and calls no `preventDefault` when `metaKey` is absent (serve.rs:2263-2280), so off macOS the event reaches the page. This contradicts the comment at App.svelte:920-921, which says off-mac `Ctrl+W` is not claimed here. The one link that cannot be settled statically is whether a focused xterm or ghostty stops propagation before the event reaches the `document` listener, so this is a strong reading and not a demonstration. It is a latent defect in the exact branch this item edits and the acceptance matrix has a cell for it.

**Confirmed: there is no registry-wide chord-uniqueness test.** `keymapConflicts` (web/packages/workspace-app/src/state/keymapAssign.ts:31) checks a candidate user assignment against resolved entries, which is a different question. `shortcuts.test.ts:40-42` carries a comment mentioning a duplicate entry, but the assertions it guards are label regexes, not chord uniqueness. So two built-ins resolving to the same chord for some `(platform, os)` pair would ship silently, and this item moves two chords within one letter, which is precisely that case.

The rest of the draft's citations were checked and hold: `store.svelte.ts:3114` is `discardWindowSession`; the generator defaults are `--platform web` and `--os mac` (web/packages/workspace-app/scripts/shortcuts-table.mjs:54-55), which is why `app.window.close` has no row in `KEYBINDINGS_TABLE` at all and why only `app.tab.close`'s `web` chord, `label` or `note` can trip `make shortcuts-check` (Makefile:436-444); the `Close tab` row and its `(Cmd+W on macOS)` note are at crates/chan/src/lib.rs:158; and the `app.pane.kill` alias joins both ids through `shortcutIds: ["app.tab.close", "app.window.close"]` (web/packages/workspace-app/src/state/commands/core.ts:121), whose mac rendering `Cmd+W / Cmd+Shift+W` is pinned at web/packages/workspace-app/src/components/CommandChordAssign.test.ts:98.

One citation drifts: the draft's `ctrlDCloseTab.test.ts:120` is a comment line; the assertion it means is at :123-125, in the test named `does not intercept Ctrl+D inside an Excalidraw canvas tab`. Cite it by name.

## What happens when the last tab in a window closes, which the draft did not ask

The draft never raised this. The code already answers it for two of the four off-mac window kinds, and the answer is settled by precedent rather than needing an invention, because macOS `Cmd+W` runs the same path today.

**Workspace windows: closing the last tab does not close the window.** `app.tab.close` (App.svelte:1332-1337) closes the active tab when there is one and calls `closeActiveEmptyPane()` when there is not. `closeActiveEmptyPane` (App.svelte:1094-1123) returns false while the pane still has tabs, flips to the hidden side and flashes the A/B button when the visible side is empty but the other side is not (:1097-1101), and on the desktop with `leafPaneCount() <= 1` discards the session blob and closes the window (:1106-1118). So the last tab leaves an empty pane and an open window, and a second press closes the window. That two-press escalation is exactly what mac `Cmd+W` does now, so adopting it off macOS is consistency and not a new behaviour. `empty-pane close is wired through Ctrl+D, app.tab.close, and app.window.close` (web/packages/workspace-app/src/components/paneModeKeymap.test.ts:252-262) pins the wiring.

**Standalone terminal windows: closing the last tab does close the window.** The `$effect` at App.svelte:1129-1142 fires when `ui.terminalOnly && ui.terminalArmed` and no terminal tabs remain, discarding the blob and closing the window.

**Control-terminal windows: open, and it needs a ruling.** Today `Ctrl+Shift+W` there fires `app.window.close`, which runs `discardWindowSession()` then `requestCloseWindow()` (App.svelte:1345-1349); the Rust side documents that route as the one that reaps the control row and tenant (main.rs:7289-7295). After the move it would fire `app.tab.close`. `terminalControl` implies `terminalOnly` (store.svelte.ts:295-300), `app.tab.close` is in `TERMINAL_ONLY_COMMANDS` (web/packages/workspace-app/src/state/windowMode.ts:32) and is not in `CONTROL_TERMINAL_BLOCKED` (:52-56), so it would dispatch, close the one terminal tab, and let the terminal-only effect close the window. Same visible outcome, different path, and whether the control row and tenant are reaped identically on the second path is not answerable by reading. **This is open and needs the owner's ruling, not a guess.**

**The launcher window: open, and it needs a ruling.** The launcher has no tabs, so "close the tab" has no meaning there, and off macOS it is the one window whose accelerator claims `Ctrl+Shift+W`. Either the accelerator moves to `CmdOrCtrl+Alt+W` with the rest of window close, or `Ctrl+Shift+W` means two different things depending on which window has focus. **Open.**

## Contract

- The tab-close chord on each platform is the chord a user of that platform reaches for, and window close and tab close never resolve to the same chord on any `(platform, os)` pair.
- The registry, the in-page keymap and the native key bridge agree on every chord, and a disagreement fails a test rather than shipping. `osChord`'s own doc block already says it is declarative only and that App.svelte and `KEY_BRIDGE_JS` branch on the same rule at the raw-event layer (shortcuts.ts:501-504); nothing enforces the agreement it describes.
- A chord that closes something states what it closes on the surface where it is pressed, and a chord that closes a window never fires where the user asked to close a tab.
- Every chord the app claims off macOS is claimed at the one layer that exists for every window kind, since only the launcher has a menubar there.

## Boundaries

In scope: the two registry entries (`app.tab.close` at shortcuts.ts:276-283 and `app.window.close` at :240-247), the `osChord` divergence rules for both ids, the two bridge `KeyW` branches, the launcher accelerator and its `close_spa_or_native_window` routing, the in-page `KeyW` branch at App.svelte:922-935 including its unguarded `ui.terminalControl` arm, the chord-escape consequence, and the registry-uniqueness test the change needs in order to be safe. Plus the doc and test fallout listed under acceptance.

Deliberately out, and named so the next reader does not pull them in:

- **The built-in supersession gaps.** `App.svelte:922-935` does not consult `builtInChordSuperseded`, and `app.window.close` is dispatched unconditionally from the bridge, so a user who rebinds either command still has the built-in firing. Both sit inside this item's blast radius and neither is caused by it. They are the subject of a separate draft, `built-in-chord-supersession-is-checked-inconsistently`, which names `App.svelte:922` and `serve.rs:2325` by line and is not accepted scope as of this writing. If that draft is not promoted, these two defects stay open and this item does not close them; say so rather than fixing them here and leaving five other branches unfixed.
- **The web's `Ctrl+Shift+W`.** The change is native-only. In a browser off macOS chan claims nothing on this chord: `app.window.close` has no `web` chord (shortcuts.ts:240-247), and App.svelte:922 is the only `KeyW` branch anywhere in `workspace-app` or `launcher`, guarded `!e.shiftKey`. Whether a page can `preventDefault` `Ctrl+Shift+W` in Chrome and Firefox on Linux is not asserted anywhere in the repo, and this item does not settle it; if the answer turns out to be yes, revisiting the web's `Ctrl+D` is a separate decision.
- **The chord-uniqueness question beyond this change.** The test this item asks for covers the registry. Chords dispatched outside the registry, by CodeMirror keymaps or by hardcoded component branches, are a different population and a different item.

## Acceptance: the matrix, because the risk is not the edit

Every cell below is checked in a running desktop build on the named OS, not by reading the bridge source. That is the whole cost of the item.

### What `Ctrl+Shift+W` must do

```
surface / os                 window shape             Ctrl+Shift+W
---------------------------  -----------------------  ----------------------
desktop workspace, lin/win   pane has 2+ tabs         close the active tab
desktop workspace, lin/win   pane has exactly 1 tab   close it, window stays
desktop workspace, lin/win   pane empty, 1 leaf pane  discard, close window
desktop workspace, lin/win   visible side empty,      flip and flash, do not
                             hidden side has tabs     close
desktop terminal, lin/win    2+ terminal tabs         close the active tab
desktop terminal, lin/win    1 terminal tab           close tab, then window
desktop control, lin/win     one PTY, no tab strip    OPEN, needs a ruling
desktop launcher, lin/win    no tabs, has a menubar   OPEN, needs a ruling
desktop connecting, lin/win  no tabs, SPA bus dead    cancel, destroy window
desktop any window, macOS    any                      unchanged, not bound
browser, any os              any                      unchanged, not claimed
```

### What must not change

```
surface / os                 chord         must do
---------------------------  ------------  -----------------------------
desktop any, lin/win         Ctrl+Alt+W    what Ctrl+Shift+W does today
desktop workspace, macOS     Cmd+W         close the active tab
desktop workspace, macOS     Cmd+Shift+W   discard and close the window
desktop launcher, macOS      Cmd+W         hide the launcher
desktop terminal, all os     Ctrl+D        EOF to the shell, no tab close
web, all os                  Ctrl+D        close the active non-term tab
web, lin/win                 Ctrl+Shift+W  nothing from chan
```

### The cells that are not about which command fires

- `Ctrl+Shift+W` closes the tab while a terminal has focus, on **both** the xterm and the ghostty backend, on Linux and on Windows. This is the cell that tests the chord-escape reasoning above, and it must be run rather than argued: `app.tab.close` cannot carry `escapeTerminal`, so the only thing standing between the chord and the shell is the bridge's window-capture `stopImmediatePropagation`. Pin the backend explicitly in the record, because the Linux terminal renderer default is being changed on `origin/feat/linux-terminal-grid` under this item.
- No `^W` byte reaches the shell on that press.
- `Ctrl+D` still sends EOF in a focused terminal on every surface, and still closes a focused non-terminal tab.
- Plain `Ctrl+W` in an off-mac control-terminal window: record what it does today before the edit and after it. The reading above says it closes the window through App.svelte:923-928; if that reproduces, the unguarded `ui.terminalControl` arm is repaired with this change, and if it does not, the reading is wrong and the item says so.
- The off-mac menu route: with a workspace window focused and the launcher unfocused, `Ctrl+Shift+W` must not reach `handle_close_window`. This is the cell that tests whether main.rs:7317 is reachable off macOS.

### Tests and docs

- A test asserts that no two registry entries resolve to the same chord for any `(platform, os)` pair. No such test exists today, and this change moves two chords within one letter.
- `chan open --help` names both chords correctly with `make shortcuts-check` green. The generator defaults to `web` and `mac` and drops rows with no chord for that surface, so `app.window.close`'s native chord change does not trip the gate on its own; only `app.tab.close`'s `web` chord, `label` or `note` does. The note at shortcuts.ts:282 reads `"Cmd+W on macOS"` and must gain the off-mac chord, which forces a hand regeneration of `KEYBINDINGS_TABLE` and makes the SPA and Rust edits one commit.
- The `app.pane.kill` alias label renders correctly on the linux and windows slots as well as the mac one, which `CommandChordAssign.test.ts:89-100` pins today only for mac.
- Updated and still green: `shortcuts.windows.test.ts:59` and `:62`, `shortcuts.test.ts:72-77` and `:93-96`, `paneModeKeymap.test.ts:252-262`, `chordEscapeRegistry.test.ts:23-55`, `ctrlDCloseTab.test.ts:106` and the Excalidraw-canvas test at `:119-126`, `key_bridge_keeps_independent_chords` (serve.rs:2932-2959) and `connecting_screen_windows_close_for_real` (serve.rs:3471-3501), whose count of two `request_close_window` routings at serve.rs:3495 is the assertion most likely to trip.
- Docs corrected in the same commit: crates/chan/src/lib.rs:158 (CI-gated), web/packages/marketing/src/pages/manual.html:56-57, [desktop/design.md](../../../desktop/design.md) at :170, :175 and :213, and the comments naming the chord at crates/chan-library/src/terminal_sessions.rs:1903 and crates/chan-server/src/routes/sessions.rs:177.
- `make pre-push` green, including `host-build-check`, which builds the native desktop package.

## Collisions with the chord items being decided beside this one

**The deck-chords item does not collide on chords and does collide on files.** Its chords are `Mod+Enter` and `Mod+Shift+Enter`; this item's is `KeyW`. Both, however, add or change `SHORTCUTS` entries and both force a hand regeneration of `KEYBINDINGS_TABLE` in crates/chan/src/lib.rs, which is a gate step, so two lanes running at once will conflict textually in shortcuts.ts and in that const, and each lane's SPA and Rust edits must land in one commit. Sequence them rather than parallelize them.

**This chord should not be registered by that item, because it already is.** `app.tab.close` and `app.window.close` are both registry entries with ids, labels, groups and per-OS resolution. The deck item's subject is chords the app dispatches with no registry entry at all; that description does not fit this one. The right home for this divergence is `osChord` (shortcuts.ts:505-546), the registry's own OS-divergence mechanism, which already carries eleven such rules, so nothing here is a special case. What this item surfaces and does not own is that `osChord` is declarative only and nothing enforces that it, App.svelte and `KEY_BRIDGE_JS` agree; the registry-uniqueness test asked for above is the first half of closing that, and the second half is a separate item if anyone wants one.

**The supersession draft owns the two live defects in this blast radius**, as recorded under Boundaries.

**The already-held-chord draft touches the user-facing half.** Both ids here are individually assignable through the keymap grid, so a user who wants to swap tab close and window close back after this change hits the refusal that draft describes and has no way forward from where they are standing. That is a reason to prefer getting the shipped defaults right, which is what this item does, and not a dependency.

**`origin/feat/linux-terminal-grid` does not touch chord code and does touch the surface the matrix measures.** `git diff --stat main...origin/feat/linux-terminal-grid` shows 23 files; the only overlap with this item's surface is web/packages/workspace-app/src/components/TerminalTab.svelte, and its 16 changed lines add `clearGhosttyRecycledGrid` on the ghostty open path and thread a `webglRendererOverride()` into `shouldUseWebglRenderer`. No keydown, chord or escape code changes, and shortcuts.ts is untouched, so there is no textual conflict. The interaction is in the acceptance matrix rather than the edit: that branch changes which renderer a Linux terminal tab gets by default, so the two terminal-focus cells must record the backend and renderer they ran against instead of saying "the Linux default", which is moving.

## Rough size

The change is small and I agree with the owner there: seven edit sites rather than the draft's five, none of them more than a few lines, and two registry entries.

The verification is larger than the draft's framing suggests, and larger than the code diff would predict, for a reason that is structural rather than incidental: the matrix above has cells on three operating systems, and the answer to each lives in a running native desktop build. There is no Rust or Node toolchain on the maintainer's host and the gate's `host-build-check` builds the native package on one host, so this needs three machines or three VMs, and none of the matrix can be discharged by the test suite. That is the cost, and it is the reason the item exists in this shape.

Two things must be settled before the design is fixed, and both are rulings rather than investigations: what `Ctrl+Shift+W` does in an off-mac control-terminal window, and whether the launcher's accelerator moves with window close or stays. A third question, whether a page can `preventDefault` `Ctrl+Shift+W` in Chrome and Firefox on Linux, is out of scope here but decides whether the web should ever follow; the repo asserts nothing either way.

The test and doc fallout is wide and shallow: nine test files, four docs and two source comments, all of them string or table updates. It is not where the time goes.
