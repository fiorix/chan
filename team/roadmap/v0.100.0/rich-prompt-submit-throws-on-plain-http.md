# Rich Prompt submit throws on a devserver reached over plain http

Status: raised for v0.100.0 on the owner's instruction to fold the frontend review's most critical findings into this version. From the review (finding PB-01, high, trivial), re-verified against `main` at `d3de0180b` by reading.

## What was seen

`crypto.randomUUID` exists only in a secure context. A devserver reached over plain http at a LAN address is not one, and that is a supported way to run chan. The workspace app calls `randomUUID` at six sites and five of them guard it (`state/editorBuffer.ts`, `state/docSync.svelte.ts`, `api/client.ts`, `state/extensions.svelte.ts`, `api/desktop.ts`), each with its own hand-rolled fallback. The sixth, the submit path in `web/packages/workspace-app/src/components/RichPrompt.svelte`, calls it bare. On such a server Mod+Enter in the composer throws inside the CodeMirror keymap handler: the message is never sent, no pending card appears, and nothing is reported.

## Desired contract

An id is minted through one helper that works in every context chan is served in, and no call site reaches for `crypto.randomUUID` directly.

## Boundaries

`web/packages/workspace-app/src/components/RichPrompt.svelte`, one id helper in the workspace app, and the five existing guarded copies folded onto it. One trap: `components/richPromptComponent.test.ts` pins the bare call as source text (`const id = crypto.randomUUID();`) and goes red on the fix, so it is replaced by the behavioural test below in the same change.

## Acceptance

1. With `crypto.randomUUID` undefined, submitting from the composer sends the message and shows its pending card.
2. A source-independent check (a test that walks the package's modules, or a lint step) fails when a new direct `crypto.randomUUID` call appears outside the helper.
3. Ids stay unique across two windows of one session.
