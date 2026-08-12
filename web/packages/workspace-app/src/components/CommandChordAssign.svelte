<script lang="ts">
  // The launcher row's chord cell as an assign affordance. Shows the
  // command's resolved chord (user override or the SHORTCUTS baseline) or an
  // "Assign" prompt when it has none, and on click captures a new chord for
  // the current client's OS slot, checks it against the resolved keymap, and
  // either assigns it or reports the conflict. A conflict names the holding
  // command and, when the exchange would leave both commands chorded,
  // dispatchable, and collision-free (the conditions live at the offer
  // site), offers a swap that exchanges the two - never a take, because an
  // unbound command is not a representable state. A cleared override falls
  // back to the built-in
  // chord. Commands can opt into a read-only chord display for aliases such
  // as Close pane inheriting the close-tab/window chords.
  //
  // Capture runs on a dedicated focusable element that swallows its keydowns,
  // so it never reaches the launcher's arrow/enter navigation or types into
  // the search input. Escape or a click away cancels.

  import { tick } from "svelte";
  import { X } from "lucide-svelte";
  import { SHORTCUTS } from "../state/shortcuts";
  import { captureChord, keymapConflicts } from "../state/keymapAssign";
  import { allCommands, type Command } from "../state/commands";
  import {
    assignOverride,
    clearOverride,
    currentSlot,
    formattedChordForSlot,
    overrideChordForSlot,
    resolvedKeymapEntriesForSlot,
    type OverrideSlot,
  } from "../state/keymapOverrides.svelte";

  let {
    cmd,
    slot = currentSlot(),
    onCaptureEnd,
  }: {
    cmd: Command;
    // Which OS slot to assign. Defaults to the current client's slot (the
    // launcher's quick-assign); the per-OS grid passes an explicit slot.
    slot?: OverrideSlot;
    // Called after capture commits or is cancelled by Escape, so the caller
    // can return focus. Not called on a click-away blur.
    onCaptureEnd?: () => void;
  } = $props();

  let capturing = $state(false);
  let conflictLabel = $state<string | null>(null);
  // Set when the captured chord is held and this command currently holds
  // a chord in the same slot: the one resolution that can never leave a
  // command chordless. "Unbound" is not a representable state (an absent
  // override means the built-in applies), so the conflict state offers a
  // swap, never a take - and offers nothing when this command has no
  // chord to give, which is the only shape that could manufacture it.
  let swapOffer = $state<{
    holderId: string;
    holderLabel: string;
    chord: string;
    targetChord: string;
  } | null>(null);
  let captureEl = $state<HTMLButtonElement>();

  const editable = $derived(cmd.shortcutEditable !== false);
  const shortcutIds = $derived(cmd.shortcutIds?.length ? cmd.shortcutIds : [cmd.id]);
  const chord = $derived.by(() => {
    const values = shortcutIds
      .map((id) => formattedChordForSlot(id, slot))
      .filter((value): value is string => value !== null);
    const unique = [...new Set(values)];
    return unique.join(" / ") || null;
  });
  const hasOverride = $derived(
    editable && overrideChordForSlot(cmd.id, slot) !== undefined,
  );

  // A conflicting binding's display name: catalog title, else the SHORTCUTS
  // label (editor / terminal chords are registry-only), else the raw id.
  function labelForId(id: string): string {
    const command = allCommands().find((c) => c.id === id);
    if (command) return command.title;
    return SHORTCUTS.find((s) => s.id === id)?.label ?? id;
  }

  async function startCapture(e: MouseEvent): Promise<void> {
    e.stopPropagation();
    conflictLabel = null;
    swapOffer = null;
    capturing = true;
    await tick();
    captureEl?.focus();
  }

  function endCapture(refocus: boolean): void {
    capturing = false;
    conflictLabel = null;
    swapOffer = null;
    if (refocus) onCaptureEnd?.();
  }

  function onCaptureKeydown(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      endCapture(true);
      return;
    }
    e.preventDefault();
    const candidate = captureChord(e);
    if (!candidate) return; // modifier-only or bare key: keep composing
    const entries = resolvedKeymapEntriesForSlot(allCommands(), slot);
    const conflicts = keymapConflicts(candidate, entries, cmd.id);
    if (conflicts.length > 0) {
      const holderId = conflicts[0].id;
      conflictLabel = labelForId(holderId);
      // A swap moves the holder onto THIS command's current chord, so it
      // is only offerable when the exchange resolves the whole conflict
      // and both halves actually move:
      //  - the candidate has exactly one holder; with two, the swap
      //    settles one and ships a fresh collision with the other;
      //  - the holder is a catalog command whose dispatch resolves
      //    through the override layer; a registry-only editor or
      //    terminal chord is bound by its own surface, so an override
      //    written for it displays as moved while the old chord keeps
      //    firing and the new one is dead;
      //  - this command's chord exists and is free once this command
      //    vacates it (no third command holding it).
      const holder = allCommands().find((c) => c.id === holderId);
      const holderSwappable = holder !== undefined && holder.shortcutEditable !== false;
      const targetChord = entries.find((entry) => entry.id === cmd.id)?.chord;
      const thirdParty = targetChord
        ? keymapConflicts(
            targetChord,
            entries.filter((entry) => entry.id !== cmd.id && entry.id !== holderId),
            cmd.id,
          )
        : [];
      swapOffer =
        conflicts.length === 1 &&
        holderSwappable &&
        targetChord &&
        thirdParty.length === 0
          ? { holderId, holderLabel: conflictLabel, chord: candidate, targetChord }
          : null;
      return; // hold capture open so the user can pick a free chord
    }
    swapOffer = null;
    assignOverride(cmd.id, candidate, slot);
    endCapture(true);
  }

  // The swap gesture: the captured chord goes to this command, and the
  // holding command takes the chord this command held. Two assignments,
  // both commands stay chorded; the refusal path above is untouched for
  // the user who wants neither.
  function doSwap(e: MouseEvent): void {
    e.stopPropagation();
    const offer = swapOffer;
    if (!offer) return;
    assignOverride(offer.holderId, offer.targetChord, slot);
    assignOverride(cmd.id, offer.chord, slot);
    endCapture(true);
  }

  function reset(e: MouseEvent): void {
    e.stopPropagation();
    clearOverride(cmd.id, slot);
  }
</script>

{#if capturing}
  <span class="assign">
    <button
      class="capture"
      class:conflict={conflictLabel !== null}
      bind:this={captureEl}
      type="button"
      aria-label={`Press a shortcut for ${cmd.title}, or Escape to cancel`}
      onkeydown={onCaptureKeydown}
      onblur={() => endCapture(false)}
      onclick={(e) => e.stopPropagation()}
    >
      {conflictLabel !== null ? `In use by ${conflictLabel}` : "Press keys"}
    </button>
    {#if swapOffer}
      <!-- mousedown preventDefault keeps the capture button focused, so
           its blur handler does not end the capture before this click
           lands. -->
      <button
        class="swap"
        type="button"
        aria-label={`Swap chords with ${swapOffer.holderLabel}`}
        title={`Swap chords with ${swapOffer.holderLabel}`}
        onmousedown={(e) => e.preventDefault()}
        onclick={doSwap}
      >
        Swap
      </button>
    {/if}
  </span>
{:else if !editable}
  <span
    class="chord-btn readonly"
    class:empty={!chord}
    aria-label={chord
      ? `${cmd.title} uses ${chord}`
      : `${cmd.title} has no editable shortcut`}
  >
    {chord ?? "Built in"}
  </span>
{:else}
  <span class="assign">
    <button
      class="chord-btn"
      class:empty={!chord}
      type="button"
      aria-label={chord
        ? `Change shortcut for ${cmd.title}`
        : `Assign a shortcut to ${cmd.title}`}
      onclick={startCapture}
    >
      {chord ?? "Assign"}
    </button>
    {#if hasOverride}
      <button
        class="reset"
        type="button"
        aria-label={`Reset ${cmd.title} to its default shortcut`}
        onclick={reset}
      >
        <X size={13} strokeWidth={2} aria-hidden="true" />
      </button>
    {/if}
  </span>
{/if}

<style>
  .assign {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .chord-btn {
    padding: 1px 7px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--code-bg);
    color: var(--text-secondary);
    font-size: 11px;
    font-family: inherit;
    white-space: nowrap;
    cursor: pointer;
  }
  .chord-btn:hover {
    border-color: color-mix(in srgb, var(--text) 34%, transparent);
    color: var(--text);
  }
  .chord-btn.empty {
    background: transparent;
    border-style: dashed;
    opacity: 0.75;
  }
  .chord-btn.readonly {
    display: inline-block;
    cursor: default;
    opacity: 0.82;
  }
  .chord-btn.readonly:hover {
    border-color: var(--border);
    color: var(--text-secondary);
  }
  .reset {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 2px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .reset:hover {
    background: color-mix(in srgb, var(--text) 12%, transparent);
    color: var(--text);
  }
  .capture {
    padding: 1px 8px;
    border: 1px solid color-mix(in srgb, var(--accent, var(--text)) 60%, transparent);
    border-radius: 5px;
    background: color-mix(in srgb, var(--accent, var(--text)) 12%, transparent);
    color: var(--text);
    font-size: 11px;
    font-family: inherit;
    white-space: nowrap;
    cursor: pointer;
  }
  .capture.conflict {
    border-color: color-mix(in srgb, var(--danger, #d9534f) 70%, transparent);
    background: color-mix(in srgb, var(--danger, #d9534f) 14%, transparent);
    color: var(--text);
  }
  .swap {
    padding: 1px 7px;
    border: 1px solid color-mix(in srgb, var(--accent, var(--text)) 60%, transparent);
    border-radius: 5px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 11px;
    font-family: inherit;
    white-space: nowrap;
    cursor: pointer;
  }
  .swap:hover {
    border-color: color-mix(in srgb, var(--text) 34%, transparent);
    color: var(--text);
  }
</style>
