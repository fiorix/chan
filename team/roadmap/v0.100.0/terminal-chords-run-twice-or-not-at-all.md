# Terminal chords run twice, or not at all

Status: accepted for v0.100.0 by the owner on 2026-09-20. Raised on the owner's instruction to fold the frontend review's most critical findings into this version. From the review (finding TAB-01, high, and the renderer keyboard contract of its Phase 2), re-verified against `main` at `d3de0180b` by reading. The Ctrl+F half waits on an owner ruling, named below.

## What was seen

`web/packages/workspace-app/src/components/TerminalTab.svelte` dispatches key chords from four places: the renderer's custom key handler (`handleTerminalKeyEvent`, registered for xterm and, with its return value inverted, for ghostty), the component's own `onkeydown` on the terminal root, a `svelte:window` handler for the menu, and the find bar's handler. The rule that decides when one of them must stop the event from reaching the next is written down at none of them, and both halves of it are wrong today.

**An action in the custom handler runs again when the event bubbles.** `closeExitedTabFromKey` calls `preventDefault` and never `stopPropagation`, and it is reached from the custom handler and again from the root's `onkeydown`. One Ctrl+D on an exited terminal runs two closes that race on one captured index, so an unrelated neighbouring tab is removed with no confirm, no dirty save, no document-session release and no entry in reopen-closed. Its predicate also matches `e.key` and does not exclude Shift, unlike the app-level `e.code` predicate in `App.svelte`.

**An action in a DOM handler never runs for a key the renderer encodes.** The find chord is handled only in the root's `onkeydown`, and its registry entry in `state/shortcuts.ts` is not flagged `escapeTerminal`, so the custom handler lets the renderer have it: where the modifier is Ctrl, Ctrl+F in a focused terminal is encoded as `0x06` and sent to the shell instead of opening find.

No test can see either, because every xterm mock in the suite stubs `attachCustomKeyEventHandler() {}`.

## Desired contract

Each chord the terminal claims produces exactly one action, from whichever owner sees it first, whether the renderer has focus or not. The rule is one function or one documented table that all four dispatch points go through.

## Boundaries

`web/packages/workspace-app/src/components/TerminalTab.svelte`, a small helper under `src/terminal/` if the rule becomes a function, and the tests `components/ctrlDCloseTab.test.ts`, `components/terminalCopyPasteChords.test.ts`, `components/TerminalTab.ghosttyPasteChord.test.ts`, plus a new mount test whose renderer mock attaches a real textarea keydown listener, calls the custom handler, ignores its return value and does not stop propagation, which is what upstream does. The one-line `stopPropagation` for Ctrl+D lands first and alone; the contract follows.

Which surface owns Mod+F when a terminal has focus, and whether the native key bridge keeps claiming the Ctrl form of every Mod chord on macOS (finding CMD-02: it takes Ctrl+[, Ctrl+F and Ctrl+G away from the shell), is an owner ruling. It moves `App.svelte` and `KEY_BRIDGE_JS` in `desktop/src-tauri/src/serve.rs` together, so it is ruled before the Ctrl+F half is built. This item lands before [shortcuts-ignore-the-keyboard-layout](shortcuts-ignore-the-keyboard-layout.md), whose import must preserve it.

## Acceptance

1. One Ctrl+D on an exited terminal closes that tab and no other, asserted through the realistic renderer mock, for both backends.
2. For each chord the terminal claims, dispatching it once on the renderer's textarea and once on the component root with the renderer unfocused each produce exactly one action.
3. Ctrl+Shift+D does not close an exited terminal.
4. Ctrl+D still reaches a live shell as EOF.
5. After the ruling, the chord that opens terminal find does so from a focused renderer.
