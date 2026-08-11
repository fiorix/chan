<script lang="ts">
  // Clamped number input for Settings rows. One-way: `value` is the
  // committed number (null when the field means "unset") and
  // `oncommit` fires the write on blur or Enter. The text buffer is
  // local so typing never fights the buffer reseed; it reseeds when
  // `value` changes externally.
  //
  // Commit policy: empty commits null when `nullable`, otherwise the
  // field falls back to `invalidFallback ?? min`; unparseable text
  // does the same. The committed number is clamped to [min, max] and
  // the callback hears which bound clamped it, so a caller that warns
  // on clamping (the screensaver timeout) keeps its message. Nothing
  // is committed when the result already equals `value`.

  let {
    value,
    min,
    max,
    step = 1,
    nullable = false,
    invalidFallback,
    placeholder,
    disabled = false,
    ariaLabel,
    oncommit,
    ...rest
  }: {
    value: number | null;
    min: number;
    max: number;
    step?: number;
    nullable?: boolean;
    invalidFallback?: number;
    placeholder?: string;
    disabled?: boolean;
    ariaLabel: string;
    oncommit: (value: number | null, clampedTo: "min" | "max" | null) => void;
  } & Record<string, unknown> = $props();

  // Static placeholder seed; the effect reseeds from `value` on mount
  // and on every external change.
  let text = $state("");
  $effect(() => {
    text = value === null ? "" : String(value);
  });

  function commit(): void {
    const trimmed = text.trim();
    if (trimmed === "" && nullable) {
      text = "";
      if (value !== null) oncommit(null, null);
      return;
    }
    const parsed = trimmed === "" ? NaN : Number(trimmed);
    const fellBack = !Number.isFinite(parsed);
    let n = fellBack ? (invalidFallback ?? min) : Math.round(parsed);
    let clampedTo: "min" | "max" | null = null;
    if (n < min) {
      n = min;
      clampedTo = "min";
    } else if (n > max) {
      n = max;
      clampedTo = "max";
    } else if (fellBack && invalidFallback === undefined) {
      // Empty/unparseable text fell back onto the min bound; report it
      // as clamped so the caller's warning still fires.
      clampedTo = "min";
    }
    text = String(n);
    if (n === value) return;
    oncommit(n, clampedTo);
  }

  function onKeydown(event: KeyboardEvent & { currentTarget: HTMLInputElement }): void {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commit();
    event.currentTarget.blur();
  }
</script>

<input
  type="number"
  {min}
  {max}
  {step}
  value={text}
  {placeholder}
  {disabled}
  oninput={(event) => (text = event.currentTarget.value)}
  onblur={commit}
  onkeydown={onKeydown}
  aria-label={ariaLabel}
  {...rest}
/>
