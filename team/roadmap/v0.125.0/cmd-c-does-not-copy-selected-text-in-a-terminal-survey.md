# Cmd+C does not copy selected text in a terminal survey

Status: raised by the owner on 2026-11-06, with a request to investigate and file if confirmed; confirmed in the JavaScript event path against `720b543c0` and the v0.125.0 integration snapshot `daf8a60e6`; not started. Native macOS clipboard validation remains open.

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
