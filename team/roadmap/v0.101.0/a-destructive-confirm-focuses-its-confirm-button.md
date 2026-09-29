# The shared confirm dialog focuses its confirm button, so Enter answers a destructive confirm

Status: accepted for v0.101.0 by the owner on 2026-09-29; raised for a decision on 2026-09-28 by the independent review of the drawing's refused save (`dev/v0101-team/reviews/review-Frontend-14.md` in the development tree, finding F8, with the lead's notes), read in code and not run. The mechanism is older than that range and is on `main` before this landing; the review met it in a new use, the close of a drawing whose save was refused, which that range adds and which has not landed.

## Owner ruling

Accepted on 2026-09-29 for v0.101.0. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. This item enters: an Enter pressed as a destructive confirm opens discards unsaved text, replaces another writer's changes on disk, deletes a file or ends a shell, and the fix is two files. The shape, as ruled: a confirm marked destructive focuses Cancel, on all nine of the call sites that mark one; every other confirm keeps its confirm focused, and Escape and a click outside still cancel. Its cost is one more key press on those nine dialogs for a user who confirms by the keyboard.

## What was seen

The workspace app's confirm dialog parks focus on its confirm button whenever it opens, whatever the confirm is (`web/packages/workspace-app/src/components/ConfirmModal.svelte:9-17`), and Enter clicks the focused button (`:25-31`). `uiConfirm` takes a `destructive` flag that styles the confirm button and names no button to focus (`src/state/confirm.svelte.ts:32-61`; the style at `ConfirmModal.svelte:42-47`). So an Enter pressed as a destructive confirm opens answers it. Escape and a click outside answer cancel (`confirm.svelte.ts:32-34`).

The confirms the app marks destructive include "Reload from disk?", which replaces a tab's unsaved changes with the file on disk (`src/state/tabs.svelte.ts:8004-8013`); "Keep your version?", which replaces another writer's changes on disk (`:8040-8047`); a broken draft's discard (`src/state/store.svelte.ts:708-714`); and a file's delete (`:6025-6029`, `:6081-6087`). The review's steps are in the drawing's refused save, not landed: Cmd+W on a drawing whose save was refused opens a dialog whose focused button is "Close without saving", and Enter then discards the text (the review's F8, read at `b055b1137`).

On 2026-09-28 the drawing's refused save landed, and the review's steps with it: a close of a drawing whose save was refused opens `Close without saving?`, marked destructive, and with a running terminal in the same close `Close tabs?`, marked destructive too (`src/state/tabs.svelte.ts:2946-2963`); the dialog still focuses its confirm as it opens and Enter still clicks the focused button (`src/components/ConfirmModal.svelte:9-17`, `:25-31`), so Enter answers `Close without saving` or `Close` (read at `b39274a1a`, not run).

**Read again at `4c4ada0a1` on 2026-09-29,** under `web/packages/workspace-app/src/`; read, not run. The dialog focuses its confirm as it opens, and Enter clicks the focused button with no guard against a repeated key (`components/ConfirmModal.svelte:9-17`, `:25-31`). Nine call sites pass `destructive: true`: Restart terminal (`components/TerminalTab.svelte:2179`), a broken draft's discard (`state/store.svelte.ts:715`), two file deletes (`:6042`, `:6100`), the import of a metadata archive (`state/commands/workspace.ts:53`), Close tabs and Close without saving (`state/tabs.svelte.ts:3010`, `:3019`), Reload from disk (`:8260`) and Keep your version (`:8295`). The shared command deck's confirm card already defaults to cancel and ignores a repeated or unreleased Enter (`web/packages/web-shared/src/components/CommandDeck.svelte:213`, `:307`, `:360`), so the two confirm surfaces disagree until this item is built.

## Desired contract

A confirm that discards what the user typed or wrote does not take an Enter pressed without reading it as a yes: its cancel is the focused button. The rule is the shared dialog's, the same for every confirm marked destructive.

## What to do

Let the dialog focus its cancel for a confirm marked destructive and its confirm for the others, and keep the focus's return to the surface that opened it (`confirm.svelte.ts:27-30`). Red first, mounted: a destructive confirm opened and Enter pressed answers cancel; a confirm that is not destructive answers yes.

## Boundaries

`web/packages/workspace-app/src/components/ConfirmModal.svelte` and `src/state/confirm.svelte.ts`, with their tests. A caller changes only if one of its destructive confirms must keep its confirm focused, which it then says.

## Acceptance

1. Enter on a destructive confirm as it opens answers cancel, pinned mounted, red first.
2. A confirm that is not destructive still answers yes to Enter.
3. Escape and a click outside still cancel, and the focus goes back where it was.
