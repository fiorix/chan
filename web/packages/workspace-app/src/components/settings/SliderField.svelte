<script lang="ts">
  // Debounced range slider for Settings rows. One-way: `value` is the
  // committed position and `oncommit` fires the write once after
  // `delay`. The local position lets the thumb track the drag and
  // reseeds when `value` changes externally; a $bindable write-back
  // would fight the buffer reseed, which is why there is none.
  //
  // The timer is deliberately NOT cleared on destroy, preserving the
  // hand-rolled debounces this replaces: a section switch mid-debounce
  // still lands the commit.
  //
  // Nothing beside the slider changes size while it is in use, so a
  // click lands where it was aimed: the value label keeps the width of
  // its widest form, and a save flashes the value instead of the field's
  // Saving / Saved note, which would narrow the slider.

  import { getContext } from "svelte";
  import { FIELD_SAVE, type FieldSave } from "./commit";

  let {
    value,
    min,
    max,
    step,
    delay = 200,
    format = (v: number) => String(v),
    ariaLabel,
    oncommit,
  }: {
    value: number;
    min: number;
    max: number;
    step: number;
    delay?: number;
    format?: (value: number) => string;
    ariaLabel: string;
    oncommit: (value: number) => void;
  } = $props();

  // Static placeholder seed; the effect reseeds from `value` on mount
  // and on every external change.
  let pos = $state(0);
  $effect(() => {
    pos = value;
  });

  const field = getContext<FieldSave | undefined>(FIELD_SAVE);
  $effect(() => {
    field?.claimNote();
  });
  let flashing = $state(false);
  $effect(() => {
    if (field?.status() === "saved") flashing = true;
  });
  const labelChars = $derived(Math.max(...[min, max, value].map((v) => format(v).length)));

  let timer: ReturnType<typeof setTimeout> | null = null;
  function onInput(): void {
    if (timer) clearTimeout(timer);
    const v = pos;
    timer = setTimeout(() => {
      timer = null;
      oncommit(v);
    }, delay);
  }
</script>

<input
  type="range"
  {min}
  {max}
  {step}
  bind:value={pos}
  oninput={onInput}
  aria-label={ariaLabel}
/>
<span
  class="value"
  class:saved={flashing}
  style:width={`${labelChars}ch`}
  onanimationend={() => (flashing = false)}>{format(pos)}</span
>

<style>
  .value {
    flex: none;
    color: var(--text-secondary);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    text-align: right;
    white-space: nowrap;
  }
  .value.saved {
    animation: slider-saved 1.2s ease-out;
  }
  @keyframes slider-saved {
    from {
      color: var(--accent);
    }
    to {
      color: var(--text-secondary);
    }
  }
</style>
