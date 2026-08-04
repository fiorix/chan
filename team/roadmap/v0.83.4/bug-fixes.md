# v0.83.4 bug fixes

Status: REGISTERED for v0.83.4, grounded 2026-08-04, specified 2026-08-04.

One bucket, one commit per fix, each with its own focused tests. These are the two small fixes called out of the 2026-08-04 gateway grounding round; they are independent of each other and of the gateway items.

## Rich Prompt: a failed draft create blanks the composer forever

Root cause, read in code and observed live (an `Unhandled Promise Rejection: Error: forbidden` per attempt): `RichPrompt.svelte`'s `onMount` awaits `ensureDraft()` with no catch, and the composer renders only under `{#if draftPath}`. Any failure of `POST /api/drafts/new` (the gateway CSRF 403 of `gateway-served-surface-failures.md`, a client timeout, a dropped response) rejects the unguarded await, `draftPath` stays empty, and the bubble shows its chrome with no editable area, no error, and no way out.

Contract: a failed draft create or content load leaves the bubble in a visible error state naming the failure and offering retry; retry re-runs the create/load path and mounts the composer on success. No rejection escapes `onMount` unhandled. A retry that succeeds after the server already created a draft may create a second draft; orphaned drafts are reaped by the existing drafts lifecycle and are acceptable.

Acceptance: vitest drives the component (or the extracted mount logic) through create-failure, load-failure, and retry-then-success, pinning the error surface and the recovery; no unhandled rejection is logged in any leg.

Implementation evidence (2026-08-04):

- `cd web/packages/workspace-app && npm test -- src/components/RichPrompt.mountGuard.test.ts src/components/richPromptPendingMachine.test.ts`: 2 test files passed, 5 tests passed.
- `cd web/packages/workspace-app && npm run check`: `svelte-check` found 0 errors and 0 warnings.

## Ghostty: keyboard paste suppressed on every origin

Root cause, read in code: the custom-key-handler wrapper for the Ghostty backend inverts the chan-level handler's return (`TerminalTab.svelte`, `(e) => !handleTerminalKeyEvent(e)`). For the paste chord the chan handler deliberately returns without preventing default (the design is to let the browser's native paste event through, pinned by the xterm chord test), but through the inversion Ghostty's `handleKeyDown` then calls `preventDefault()` before its own early-return, and the native paste event never fires. Keyboard paste (Cmd+V / Ctrl+Shift+V) is dead on the Ghostty backend on every origin, loopback included; the xterm backend is unaffected.

Contract: keyboard paste on the Ghostty backend delivers the native paste event exactly as xterm does, with no change to any other chord's routing and no change inside the pinned ghostty-web package.

Acceptance: a chord test mirrors the existing xterm paste-chord pin for the Ghostty wrapper ("does not suppress the native paste"), and the existing ghostty compatibility tests stay green.

## Boundaries

- No Rich Prompt behavior change beyond the error surface and retry; the submit strip and its in-flight states are untouched.
- No ghostty-web upgrade, patch, or private-API workaround.
- No new settings.
