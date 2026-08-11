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
<span class="value">{format(pos)}</span>

<style>
  .value {
    color: var(--text-secondary);
    font-size: 13px;
    min-width: 4.5em;
    text-align: right;
  }
</style>
