# Cmd+C does not copy selected text in a terminal survey

Status: shipped in [v0.125.0](../../release/release-v0.125.0.md).

Record before the release: built for v0.125.0 and carried in its first release candidate `0.125.0-rc0` (`67fd26b38`); the owner's native macOS clipboard reading is taken from the candidate.

## What is there now

Selecting text in a per-terminal `cs terminal survey` and pressing Cmd+C reaches the terminal's copy handler. The handler cancels the browser's default copy and reads the terminal renderer's selection instead of the selected survey text. An empty renderer selection produces no clipboard write; an existing renderer selection copies unrelated terminal output.

The path in the code:

- `BubbleOverlay.svelte` (`web/packages/workspace-app/src/components/`) mounts the survey card inside `TerminalTab.svelte` for a per-terminal survey. Its `onCardKeydown` returns immediately for Ctrl, Cmd or Alt modifiers, so Cmd+C bubbles to the terminal root.
- `TerminalTab.svelte`'s `onShellKeydown` claims every matching `isTerminalCopyChord`, calls `preventDefault()` and `stopPropagation()`, and invokes `copySelectionToClipboard`. That function reads only `term.getSelection()`. Neither function checks the DOM selection or whether the event belongs to a survey or an editable descendant.
- `terminal/clipboardChord.ts` matches Cmd+C on macOS and Ctrl+Shift+C elsewhere. Both matching chords reach the same unconditional terminal-root copy path. This finding does not establish a failure for bare Ctrl+C in survey text off macOS.
- The window-wide fallback `<BubbleOverlay />` in `App.svelte` is outside the terminal root and avoids this interception. The terminal find input is an adjacent case: its `onFindKeydown` leaves Cmd+C alone, so the same ancestor handler overrides its selected input text.

A disposable jsdom probe extracted the production survey, terminal-root, copy and chord handlers and dispatched keys through their corresponding parent/child DOM structure, with the actual desktop `key_bridge.js` installed. With survey text selected, the per-terminal Cmd+C event was canceled and wrote nothing with an empty renderer selection; with an existing renderer selection it wrote that terminal text. The window-wide control left the default allowed. Ctrl+Shift+C off macOS followed the same interception path. The survey's unmodified option key still answered its option, and the actual find-input handler reproduced the selected-input case. These are handler-level results with a stubbed clipboard writer, not a mounted Svelte test or an OS clipboard smoke.

## Reproduction

1. Raise a survey over an existing terminal: `cs terminal survey --tab-name <existing-tab> --option OK "Select and copy this survey text"`.
2. Select part of the survey body, press Cmd+C on macOS, and paste into another application. The selected survey text should be copied.
3. Repeat with no terminal renderer selection and with terminal output selected before the survey opens. The latter must not replace the requested survey text with terminal output.

The investigation raised no live survey and did not exercise WKWebView or the native Edit > Copy action. Confirm the reported behavior and the eventual fix in chan-desktop on macOS; the JavaScript probe alone does not establish the native menu's dispatch behavior.

## Desired contract

Copy acts on the selected text in the surface that owns the key. Selected survey text and selected text in the terminal's find input retain their normal copy behavior. Ordinary terminal copy continues to use the renderer's selection, with no clipboard write when that selection is empty, and a copy chord never sends bytes to the PTY.

## Implementation boundary

Make terminal copy routing respect DOM selection and editable descendant ownership. Keep the fix within the terminal/survey event boundary and shared clipboard helpers as needed; preserve survey answer, follow-up and dismissal keys and the terminal renderer's existing copy semantics. The server survey protocol and CLI grammar need no change.

## Acceptance

1. Mounted regression tests select actual survey DOM text, dispatch Cmd+C from the focused survey card, and prove the terminal neither cancels a native copy without replacing it nor writes stale renderer text. Cover empty and existing renderer selections, and keep a window-wide survey control. The per-terminal cases must fail on the current implementation.
2. Selected text in the terminal find input copies correctly. Ordinary terminal Cmd+C and Ctrl+Shift+C still copy the renderer selection exactly once; an empty renderer selection remains a no-op and the chord sends no PTY input.
3. Survey option keys, F, X and Escape retain their behavior. Scope Ctrl+Shift+C coverage to the terminal-root ownership problem and preserve ordinary browser text-copy behavior on non-macOS clients.
4. In chan-desktop on macOS, select survey text, press Cmd+C, and verify the pasted result in another application with each terminal backend. Repeat with old terminal output selected, and check Edit > Copy separately. Record browser and native results distinctly.
5. Run `make web-check` for the implementation and record the macOS smoke result separately from the automated checks.

## Built

- The accepted menu Escape fix was merged as `25eaa9b14` before the survey copy change. `fix(workspace-app): copy the selection that owns the key under a terminal survey` (this commit) leaves native copy to an editable descendant or a noncollapsed DOM selection inside the terminal root but outside its renderer host; renderer-owned Cmd+C and Ctrl+Shift+C still copy only the renderer selection through the existing backend handler. The design paragraph records the ownership rule. No survey protocol, CLI grammar, dependency manifest or lockfile changed.
- Mounted tests were red first against the merged base: a per-terminal survey with no renderer selection canceled native Cmd+C, one with a stale renderer selection wrote that old terminal text, and the selected find input's Cmd+C was canceled (3 failed, 28 passed). The window-wide survey control and renderer copy controls passed there. The final focused survey, clipboard and survey-store suites passed 65/65, covering macOS Cmd+C and non-macOS Ctrl+Shift+C, exact-once renderer copy, empty renderer selection, no PTY input, and the option, F, X and Escape survey keys.
- Negative controls were restored after capture: forcing the wrong renderer selection made both renderer copy chords and the empty-selection test fail (3 failed); bypassing the survey card's unmodified key handler made its mounted option, F, X and Escape tests fail (4 failed). The final source contains neither mutation.
- The clean merge commit passed `taskset -c 0-7 make web-check`: shared 243/243, launcher 763/763, workspace 8581/8581 and profile 20/20, with clean Svelte checks and production builds. The implementation code passed the same committed-state gate on its third unchanged run: 243/243, 763/763, 8594/8594 and 20/20, clean checks and builds. Its first full run aborted during workspace Vitest without a suite summary under host load; its second timed out starting three unrelated launcher workers, which then passed alone 24/24. The final row-only amendment followed the green code gate.
- The owner's macOS check remains separate: select and copy survey text with each terminal backend, repeat with stale terminal output selected, paste into another application, then check Edit > Copy independently. No browser or native clipboard verdict is inferred from the mounted tests.
