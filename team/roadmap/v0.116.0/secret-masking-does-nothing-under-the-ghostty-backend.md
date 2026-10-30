# Secret masking does nothing under the ghostty backend

Status: accepted for v0.116.0 by the owner's word of 2026-10-30; not started.

## What was asked

The owner's words of 2026-10-30: "is it still not possible to support the secret masking in the ui for ghostty, like we do for xterm?", and after a read of what it would take: "i want you to put the secret masking for ghostty in a roadmap item for the next version, not for now..".

## Evidence

Read at `cff4cb0a1` on `desktop/terminal-prototypes`; the masking code is the same on `main` at `a4b5844b9`.

- The xterm masker (`web/packages/workspace-app/src/terminal/secretMasking.ts`, `TerminalSecretMasker`) reads buffer lines through `translateToString`, `getCell(x).getWidth()` / `getChars()` and `isWrapped`, finds `NAME=value` values with `SecretAssignmentMatcher` and `findSecretMaskSpans`, and covers each span with an xterm decoration anchored to a marker (`registerMarker`, `registerDecoration`, the decoration's `onRender`). The buffer stays copyable.
- `TerminalTab.svelte` builds the masker only when the backend is xterm (`if (backend === "xterm") secretMasker = new TerminalSecretMasker(...)`). Under ghostty the per-tab menu toggle and the `terminal.secret_masking` preference mask nothing, and the Settings hints say masking is xterm-only.
- `terminalBackendFromPrefs` (`terminal/backend.ts`) puts a control terminal whose masking starts on on xterm whatever the ghostty preference says, so a control window never runs ghostty.
- ghostty-web `0.4.0-next.20.g1858a59` (`dist/index.d.ts`) has the same line interface (`buffer.active.getLine(y)` with `translateToString`, `isWrapped` and `getCell`), `viewportY`, `onRender`, `onScroll` and the renderer's cell metrics, and no `registerMarker` or `registerDecoration`.
- Chan scrolls the ghostty viewport by fractional rows on macOS (`GhosttyViewportController.handleWheel` calls `scrollLines` with a fraction), so anything drawn over ghostty's canvas has to follow a fractional row offset.

## Desired contract

With masking on, a ghostty terminal masks the values an xterm terminal masks, in the same colour, with the buffer still copyable and selection unchanged. The per-tab menu toggle, the preference and the control-window default behave as they do under xterm, and a control terminal whose masking starts on runs whichever backend the ghostty preference picks.

## What to do

- Split `secretMasking.ts` into backend-neutral detection (the matcher and `findSecretMaskSpans`, typed against a minimal line interface both buffers satisfy) and two painters: the existing xterm decorations and a ghostty layer.
- The ghostty layer is a pointer-transparent overlay over ghostty's canvas, repainted at most once per frame on `onRender`, `onScroll` and resize from a scan of the visible rows and the rows they wrap with. With no markers to track lines, each repaint rescans what is visible. Spans are placed from the renderer's cell metrics, the host padding and the fractional viewport offset.
- Drop the ghostty carve-outs: the forced xterm in `terminalBackendFromPrefs`, the Settings hints that call masking xterm-only, and any doc that says the same.
- Keep the masker's self-disable path: a failure turns masking off for that terminal and says so.

## Acceptance

- Unit tests drive detection and the ghostty layer against a fake ghostty buffer: a masked `NAME=value` line, a value that wraps, a viewport scrolled by whole and fractional rows, the alternate screen, and masking toggled off.
- In the macOS desktop, read by eye: a `FOO_TOKEN=...` line is masked under ghostty as under xterm, stays masked through output, a trackpad scroll through the scrollback and a resize, and copies unmasked; with the ghostty preference on, a control terminal opens on ghostty with masking on.
- svelte-check and the full vitest suite green; browser checks 93 (`terminal-secret-masking`) and 94 (`terminal-ghostty-toggle`) green, extended to cover masking under ghostty.
