<script lang="ts">
  // Debounced text input for Settings rows. One-way: `value` is the
  // committed text and `oncommit` fires the write once after `delay`,
  // so a per-keystroke PATCH is avoided while an in-flight edit is
  // preserved. The local text reseeds when `value` changes externally
  // (commit round-trip or a cross-window reseed).
  //
  // The timer is deliberately NOT cleared on destroy: that is the
  // behaviour the hand-rolled debounces this replaces all had, so a
  // section switch mid-debounce still lands the commit.

  let {
    value,
    delay = 400,
    placeholder,
    ariaLabel,
    spellcheck = false,
    oncommit,
  }: {
    value: string;
    delay?: number;
    placeholder?: string;
    ariaLabel: string;
    spellcheck?: boolean;
    oncommit: (value: string) => void;
  } = $props();

  // Static placeholder seed; the effect reseeds from `value` on mount
  // and on every external change.
  let text = $state("");
  $effect(() => {
    text = value;
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  function onInput(event: Event & { currentTarget: HTMLInputElement }): void {
    text = event.currentTarget.value;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      oncommit(text);
    }, delay);
  }
</script>

<input
  type="text"
  value={text}
  oninput={onInput}
  {placeholder}
  {spellcheck}
  aria-label={ariaLabel}
/>
