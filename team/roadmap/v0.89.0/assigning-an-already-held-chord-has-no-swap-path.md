# Assigning a chord another command already holds refuses, with no way forward

Status: REGISTERED 2026-08-11 as v0.89.0 scope, on the owner's ruling during the round. Promoted from the draft `assigning-an-already-held-chord-has-no-swap-path`, which was raised out of the deck-chord review and was not accepted at triage. It was promoted because [the-deck-chords-are-invisible-to-the-shortcut-registry](the-deck-chords-are-invisible-to-the-shortcut-registry.md) makes the owner's own request *expressible* and then leaves it *refused*, so shipping that item alone delivers a worse state on this path than today. Verification against the tree before promotion corrected the draft on two counts and found one thing the draft did not know, recorded in place below. The second of those changes the item's shape and is the reason this is not a small UI task.

## What

`onCaptureKeydown` in `components/CommandChordAssign.svelte` resolves the captured keystroke, runs `keymapConflicts` against the resolved entries for the slot, and on a hit does exactly one thing:

```
    if (conflicts.length > 0) {
      conflictLabel = labelForId(conflicts[0].id);
      return; // hold capture open so the user can pick a free chord
    }
```

That comment is the whole behaviour and the whole gap. The dialog names the command holding the chord and holds the capture open. There is no "assign anyway", no "swap with", and no way to clear the other command's binding from where the user is standing. The only other exit is `Escape`, which abandons the assignment.

So exchanging two commands' chords, which is the rebind people actually want, takes three assignments: park the first command on a throwaway chord, assign the second to the freed chord, then move the first to its destination. Nothing in the UI says so, and a user who reaches the refusal has no next step offered.

The refusal itself is correct and this item does not remove it. Silently stealing a chord would leave the other command unreachable with no indication. The gap is that refusing is the *only* thing the dialog does.

## Why it is in this round rather than the next

The owner asked for `Cmd+Enter` to present a deck. The deck item was accepted on the ruling that the shipped defaults stay and the two actions become rebindable, so the preference lives in the user's own config rather than changing a default under everyone with the muscle memory.

That ruling is only satisfiable if the rebind is reachable. Once the deck item registers deck preview on `Mod+Enter`, that chord is held, and reaching the owner's ask requires exactly the three-assignment dance above, whose second step the dialog refuses. **The work requested to satisfy the ask ends by blocking it.** The deck item says so in its own Rough size section and recommends a lane be given both.

## Corrected from the draft

- **The registry holds 32 entries, not 27.** The draft's "every one of the 27 registry ids is affected" understates the population. `SHORTCUTS` in `state/shortcuts.ts` holds 32, a count the deck item establishes with a per-group breakdown.
- **The conflict block is at `onCaptureKeydown`, and the draft's line range is slightly off.** Cite it by symbol; the item's own round is shipping a rule about exactly this, and the file is being edited by the same lane.

## The finding the draft did not have: "unbound" is not a representable state

The draft's second acceptance line asks that taking a chord from another command leave that command "visibly unbound rather than silently shadowed". **That state does not exist in the data model**, which the draft did not check and which decides the item's shape.

The override table is keyed by command id, holding a per-slot chord. `assignOverride` writes a chord into a slot. `clearOverride` **deletes** the slot entry, and deletes the command's entry entirely when no slot remains. There is no sentinel and no null: an absent entry means *the built-in default applies*, not *this command has no chord*.

So "take this chord and leave the other command unbound" cannot be expressed today. Clearing a built-in's override restores its built-in chord, which is the opposite of unbinding it. Three ways forward, and the item requires one be chosen deliberately rather than discovered:

1. **Swap only.** A conflict offers an exchange: both commands end up with a chord, neither is unbound, and the unrepresentable state never arises. Cheapest, needs no wire change, and covers the owner's actual case, which is a swap.
2. **A representable unbound state.** An explicit sentinel in the override map, which is a persisted wire-format change (`KeymapOverridesWire`) and reaches the grid's rendering of a command with no chord.
3. **Take-anyway restricted to commands that already carry an override**, where clearing genuinely returns them to a built-in rather than to nothing. Narrower than it sounds, and the asymmetry needs explaining in the UI.

This item does not pre-decide which. It requires that the choice is made and stated, because option 1 is small and option 2 is a persisted format change, and the draft's "small to medium, mostly interaction design" sizing is only true of option 1.

## Resolution chosen: swap only, ruled 2026-08-11

Option 1. Proposed by the lane with its reasoning and ruled before any of it was built, which is the ordering this item asked for.

What decides it is not sizing. Under the shipped defaults the deck item establishes, `app.slides.preview` holds `Mod+Enter` and `app.slides.present` holds `Mod+Shift+Enter`, and **neither carries an override**. Option 3, take-anyway restricted to commands that already carry one, would therefore refuse precisely the exchange this item was widened into scope to enable, because the holding command has no override to clear. That is a disqualifying fact about the owner's own case rather than a preference between designs. Option 2 buys a persisted `KeymapOverridesWire` change and grid rendering work to serve a take-anyway gesture nobody asked for.

One constraint travels with the choice and keeps the unrepresentable state out of reach by construction: **the swap is offered only when the target already holds a chord in the slot being assigned.** A chordless target is the one shape that could leave a command unbound, so no swap is offered for it. Under shipped defaults every registry entry carries a built-in, so the case does not arise today; the guard exists so it cannot arise later.

Consequences for the acceptance below, recorded rather than dropped:

- The line requiring the keymap grid to show an unbound command surviving a reload is **not applicable** to this resolution. Swap-only cannot produce a command with no chord, since both commands hold one before and after, so the state that line describes is unreachable rather than unimplemented. This is the item's own instruction being followed.
- Every other line stands unchanged, including the registry-uniqueness assertion, which is the one that catches a swap that half-applies.

## Contract

- A conflict names the command holding the chord and offers at least one way to resolve it without leaving the dialog.
- Resolving a conflict never leaves a command silently unreachable. If a resolution can leave a command with no chord, that state is representable, persisted and visible in the keymap grid; if it is not representable, the resolution that would produce it is not offered.
- The refusal path survives for the user who wants neither resolution.

## Boundaries

- **In scope:** `components/CommandChordAssign.svelte`, the conflict state it renders, and whichever of `assignOverride` / `clearOverride` in `state/keymapOverrides.svelte.ts` the chosen resolution composes from. Plus the keymap grid's rendering of whatever end state is chosen, and the persisted override shape if and only if option 2 is taken.
- **Out: the built-in supersession gaps.** A user who rebinds a command may still have the built-in firing, in `App.svelte`'s keydown branches and in the desktop key bridge. That is the unpromoted draft `built-in-chord-supersession-is-checked-inconsistently` and it is not this item. This item makes rebinding *reachable*; it does not audit what happens after a rebind.
- **Out: chords dispatched outside the registry.** CodeMirror keymaps and hardcoded component branches are invisible to conflict detection, which is `editor-chords-are-missing-from-the-shortcut-registry`, also unpromoted. A swap that appears clean in the dialog can still double-fire against an unregistered CM6 binding, exactly as every rebind does today. Not caused here and not fixed here.
- **Out: changing any shipped default chord.** The owner ruled on that in the deck item and this item exists so the ruling is reachable, not so it can be sidestepped.

## Sequencing

This lands **after** the deck item, in the same lane. Both edit the keymap surface, and the deck item is what creates the held-chord case this one resolves; doing them in the other order means building the resolution against a conflict that does not exist yet and cannot be exercised end to end.

The acceptance below is the honest end-to-end check for both items together, and it is the owner's original request: after both land, `Cmd+Enter` presents.

## Acceptance

- Exchanging two commands' chords is one gesture from the conflict state, and afterwards both commands fire on their new chords and neither fires on its old one. Verified by pressing both chords in a running client, not by reading the resolver.
- The chosen resolution is named in the item and its cost is stated: swap-only, a representable unbound state with its wire change, or take-anyway restricted to overridden commands.
- If a resolution can leave a command with no chord, the keymap grid shows that command as unbound and it survives a reload. If the chosen resolution cannot produce that state, the item says so and the acceptance line is recorded as not applicable rather than quietly dropped.
- The refusal path still exists and still names the holding command when the user picks neither resolution.
- **The owner's original request completes end to end**: from shipped defaults, `Cmd+Enter` presents a deck and `Mod+Shift+Enter` previews it, reached through the dialog without hand-editing configuration and without the three-assignment dance.
- No chord ends up held by two commands for any `(platform, os)` pair as a result of a swap. The registry-uniqueness test that [ctrl-shift-w-closes-the-window-not-the-tab](ctrl-shift-w-closes-the-window-not-the-tab.md) introduces covers built-in defaults; a swap is the user-override analogue and needs its own assertion.

## Result, recorded 2026-08-11

Landed at `eab0d179`, two files, `components/CommandChordAssign.svelte` and its test, +97/-21. The encoding follow-up is `ab24ffdb`.

The conflict state keeps the refusal and adds a swap gesture beside it, so the dialog gained a resolution rather than trading one behaviour for another. One click performs both `assignOverride` calls and both commands end chorded.

**The offerability boundary is enforced twice, and the second check was not asked for.** The ruling above requires the swap be offered only when the target holds a chord in the slot, which keeps the unrepresentable unbound state unreachable. The lane added a second condition on top: the target's chord is checked against every entry except the two principals, so the offer is withheld when performing the swap would land the target's chord on a **fourth** command. The stated boundary prevents a swap from unbinding something; this one prevents a swap from creating a collision somewhere the user was not looking.

The acceptance line about a command being left visibly unbound is recorded **not applicable** for the reason ruled above: unreachable by this resolution rather than unimplemented.

### The uniqueness assertion could not be written as the item describes it

The last acceptance line asks that no chord end up held by two commands as a result of a swap. Written as absolute uniqueness it fails immediately on shipped defaults, because the registry **already** contains a collision: `app.find.open` carries a `native` `Mod+F` and `terminal.find` carries both a `web` and a `native` `Mod+F`. That is recorded in [ctrl-shift-w-closes-the-window-not-the-tab](ctrl-shift-w-closes-the-window-not-the-tab.md), whose own planned registry-uniqueness test meets the same wall.

What shipped is a **delta**: a swap introduces no new collision in any of the four slots, plus a non-vacuity pin asserting the swap actually moved both commands. The pin is the load-bearing half, because a delta assertion over a no-op is trivially satisfiable and would pass on a swap that never happened.

### A green gate on a malformed artifact

Worth recording because no gate in this repository would have caught it. The test file committed at `eab0d179` used a literal NUL byte as a delimiter in a composite Set key. The choice is defensible, since no command id can contain one, but a single NUL makes git classify the whole file as **binary**: the four new tests produced no diff, could not be blamed, and could not be hand-merged. The suite was green and correct throughout.

`ab24ffdb` writes the same character as a source escape, leaving runtime behaviour byte-identical and the file ASCII text. Note that the fixing commit still displays as `Bin` because its parent blob was binary; diffs after it are normal. Tests answer whether code behaves, not whether the artifact is well formed for the tools around it, and nothing in the gate examines whether a source file is text.

### Not discharged

Pressing both chords in a running client, which the acceptance names explicitly as not satisfiable by reading the resolver. The gesture and both assignments are pinned by dialog-level jsdom tests, which is strictly less than the line asks for.

**The pair's end-to-end line is now reachable rather than met.** From shipped defaults, `Cmd+Enter` presenting and `Mod+Shift+Enter` previewing through the dialog is code-complete across this item and the deck item as of `eab0d179`. It is the owner's original sentence and it is the first cell of the host smoke batch, not a footnote to it.

```citations
web/packages/workspace-app/src/components/CommandChordAssign.svelte	doSwap	2	doSwap
web/packages/workspace-app/src/components/CommandChordAssign.svelte	swap button	1	onmousedown
```

## Rough size

Small to medium, and which one depends entirely on the resolution chosen above. Option 1, swap-only, is genuinely small: `assignOverride` and `clearOverride` already compose into a swap and the work is what the conflict state offers. Option 2 is medium and touches a persisted format.

The draft's sizing assumed option 1 without noticing that its own acceptance line asked for option 2. That is the correction that matters most here.
