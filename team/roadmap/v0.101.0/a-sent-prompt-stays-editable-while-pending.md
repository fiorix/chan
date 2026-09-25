# A sent prompt stays editable while it is pending

Status: raised during v0.101.0 on 2026-09-25 from the second source-text test lane (a probe in its mounted RichPrompt tests) and confirmed by the independent review of that lane at `main` `a83900a29`.

## What was seen

After a submit, the RichPrompt composer greys the card while the message is sent, but the editor is not read-only. The lock compartment lives inside the extensions the composer hands Wysiwyg (`components/RichPrompt.svelte:88-102`), Wysiwyg reconfigures only its own outer compartment, and CodeMirror keeps an existing compartment's content, so the lock keeps its unlocked value; `submitFromView` (`:318`) calls `beginPendingPrompt` (`:334`) and never reconfigures the lock. The `beforeinput` guard catches typed text but not keymap edits, so Backspace and Enter change the grey card. If the send then fails (`failPendingPrompt`, `:346`), the card that comes back holds the edited text, not what was sent.

## Desired contract

A pending card cannot be edited by any input, and a failed send restores exactly the text that was sent.

## What to do

Reconfigure the lock compartment to locked right after `beginPendingPrompt`, and pin both the keymap edit and the failed-send restore in the mounted RichPrompt tests.

## Boundaries

`web/packages/workspace-app/src/components/RichPrompt.svelte` and its tests.
