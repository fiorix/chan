# Rich Prompt control strip

Status: REGISTERED for v0.84.0, grounded 2026-08-02, ruled 2026-08-03, specified 2026-08-03, ready to implement.

## What

The Rich Prompt's bottom-right hint becomes an interactive control strip, so a user with no keyboard can drive the composer. Every action the strip advertises becomes a real button. The primary control submits, and while a prompt is in flight it becomes the cancel control; cancelling returns it to submit. The up-arrow recall and edit affordances become a second button. The queued count and the transient note stay non-interactive text.

The strip is always present, on every pointer type. Its labels keep the existing keyboard hints, so a keyboard user reads exactly what they read now and every chord keeps working unchanged.

## Verified current state

- The hint is a non-interactive `<div class="rp-label" aria-hidden="true">` (`web/packages/workspace-app/src/components/RichPrompt.svelte:481`) rendering one composite `labelText` string, so nothing in it can be tapped.
- `labelText` (`:143`) resolves four ways: a transient note alone; `${queuedCount} queued · ↑ edit · esc cancel` while pending; `${queuedCount} queued · ↑ recall · ${submitLabel}` when a queue exists and nothing is pending; and `${submitLabel}` otherwise.
- `submitLabel` (`:60`) is `submit with cmd+enter` on mac and `submit with ctrl+enter` elsewhere.
- The three actions already exist as CM6 keymap handlers, each taking the live `EditorView`: `submitFromView` (`:283`, bound to `Mod-Enter`), `recallFromView` (`:221`, `ArrowUp`), and `dropOrAbandonFromView` (`:397`, `Escape`).
- `submitFromView` returns early when `isPending` or the document is blank, so submitting is already inert in exactly the states where a button must not act.
- `recallFromView` while pending cancels the queued message and keeps its text in an unlocked composer. `dropOrAbandonFromView` while pending cancels and clears the text. These are two distinct actions, not variants of one.
- `recallFromView` outside the pending state returns `false` when `content.length > 0 || !lastQueued`, so recall is only meaningful with an empty composer and a remembered message.
- `dropOrAbandonFromView` falls through to `abandonDraft()`, which hides the whole bubble, whenever the `lastQueued` guard fails. `onMount` restores a pending prompt without setting `lastQueued` when the loaded draft is blank, so a pending bubble can genuinely hold `lastQueued === null`. A cancel button wired straight to `dropOrAbandonFromView` would therefore hide the composer instead of cancelling.
- `Wysiwyg` keeps its `EditorView` private and exposes only closure wrappers (`findAdapter`, the `fmt.*` toggles, `focus` / `focusAt` / `focusEnd`), so a click handler cannot reach the view through the component ref.
- `docSync.svelte.ts:383` sets the house pattern for capturing a mounting view: `ViewPlugin.define((view) => ...)` self-registers from inside the extension bundle, with no imperative wiring from the host.
- `web/` contains no `pointer: coarse`, `hover: none`, or touch-capability branching, so a touch-only variant would be the first of its kind in the tree.
- Three raw-source pin tests regex this component: `richPromptComponent.test.ts`, `richPromptSurface.test.ts`, and `richPromptCaretPersistence.test.ts`.

## Contract

### Strip composition

The strip renders up to three slots, right-aligned in the existing order:

```
state                     text slot    secondary   primary
------------------------- ------------ ----------- ------------------
idle, empty composer      (none)       (none)      submit (disabled)
idle, composer has text   (none)       (none)      submit
queue, nothing pending    "N queued"   recall      submit
prompt pending            "N queued"   edit        cancel
transient note showing    note text    per state   per state
```

A transient note replaces the count in the text slot only. It never removes or disables a button: a user who reads `queue full, try again` must be able to press submit again immediately.

### Primary button

- Not pending: the label is `submitLabel`, and the action is `submitFromView`. It is disabled when the document is blank, matching the guard the handler already applies.
- Pending: the label is `esc cancel`, and the action cancels the queued message and returns the composer to its editable state, at which point the button reads `submitLabel` again.
- The primary button never hides the bubble. It is bound to a dedicated cancel action rather than to `dropOrAbandonFromView`, because that handler's fallthrough reaches `abandonDraft()` when `lastQueued` is null, which a restored blank pending bubble genuinely produces. The cancel action sends the cancel only when `lastQueued` is set, and otherwise just returns the composer to local editing.

### Secondary button

- Pending: the label is `↑ edit`, and the action is `recallFromView`, which pulls the queued text back into an unlocked composer.
- Not pending, with a queue and a message this client still remembers: the label is `↑ recall`, and the action is `recallFromView`. A queue depth on its own is not enough, because it can be a teammate's `cs terminal write`, which nothing here can pull back; offering recall there would be a control that does nothing.
- Disabled when the composer already has text, matching `recallFromView`'s own `content.length > 0` guard, and absent entirely when there is nothing to recall.

### Focus and caret

Every button suppresses the default pointer-down focus transfer, so pressing one never blurs the composer or moves the caret. The existing handlers keep their own focus calls, which is what returns the caret to the editor after the action lands.

### Accessibility

`aria-hidden="true"` comes off the strip, since it now holds real controls. Each control is a `<button type="button">` carrying its visible text as its accessible name. The count and the note remain plain text, not controls, and the note is announced politely rather than assertively.

## Implementation shape

- `RichPrompt` captures its mounting view by adding `ViewPlugin.define((view) => ...)` to `richPromptExtensions`, mirroring `docSync`. Click handlers delegate to the existing `*FromView` functions with that captured view.
- `submitFromView`, `recallFromView`, and `dropOrAbandonFromView` keep their exact signatures and bodies, and every keymap entry stays as it is. The buttons are new callers, not a rewrite of the actions, which keeps the keymap and handler-body pins green.
- `labelText` is replaced by derived per-slot values: the text-slot string, the secondary button's label and enabled state, and the primary button's label, action, and enabled state. Nothing else reads `labelText`.
- `lastQueued` becomes reactive state, since the secondary control's presence now depends on it and a plain binding would leave the strip stale.
- Buttons render at the strip's current type scale, and their tap target is the button's own box at a 24px minimum, which grows the strip by a few pixels. The target is deliberately not an absolutely positioned overlay: one tall enough to matter would reach past the strip and swallow taps aimed at the composer's last line, which sits directly above with only its 8px padding in between.

## Acceptance checks

Source and unit tests must prove:

- the primary button's label and action follow the pending state, and a cancel returns it to the submit label with an editable composer;
- the primary button is disabled on a blank composer and never invokes `abandonDraft`, including when a pending prompt was restored with `lastQueued === null`;
- the secondary button reads `↑ edit` while pending and `↑ recall` otherwise, is disabled when the composer has text, and is absent both with nothing to recall and when the only queue depth came from another client;
- a transient note leaves both buttons present and operable; and
- the strip is not `aria-hidden`, and each control is a button with its visible text as its accessible name.

The behavioral checks extend the existing real-mount harness rather than adding a second rig. That harness builds its tab as a plain object, which no derived can observe, so it moves to a `$state` proxy and the file takes the `.svelte.test.ts` extension that runes require.

Update the composite `labelText` pins in `richPromptComponent.test.ts`, which describe a string that no longer exists as one value. `submitLabel` is untouched, so the `submit with cmd+enter` pin stays green on its own, and the keymap and handler-body pins must stay green too, which is the evidence that the actions themselves were not rewritten.

Add one focused real-browser smoke: type into the composer, press the submit button, prove the message queues and the primary control becomes cancel; press cancel, prove the message is dropped and the control reads submit again; queue another, press the edit button, and prove the text returns to an unlocked composer.

## Boundaries

- No touch-only or pointer-media branching.
- No change to any keyboard chord, handler signature, or handler body.
- No icons; the controls carry the existing text labels.
- The transient note stays advisory text and does not become a control.
- No change to the prompt queue protocol, the pending state machine, or its timings.
- The bubble's abandon path stays on Escape and is not promoted to a button.
