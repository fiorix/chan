<script lang="ts">
  let { label, values }: { label: string; values: { at: number; value: number | null }[] } = $props();
  const maximum = $derived(Math.max(1, ...values.map((p) => p.value ?? 0)));
  const first = $derived(values[0]?.at ?? 0);
  const span = $derived(Math.max(1, (values.at(-1)?.at ?? first) - first));
  const path = $derived.by(() => {
    let drawing = false;
    let lastAt = -Infinity;
    return values.map((p) => {
      if (p.value === null) { drawing = false; return ""; }
      if (p.at - lastAt > 2500) drawing = false;
      const segment = `${drawing ? "L" : "M"}${((p.at - first) / span * 600).toFixed(1)},${(58 - p.value / maximum * 54).toFixed(1)}`;
      drawing = true; lastAt = p.at;
      return segment;
    }).join(" ");
  });
</script>
<svg viewBox="0 0 600 62" preserveAspectRatio="none" role="img" aria-label={label}>
  <title>{label}; {values.length} samples</title>
  <path d="M0,58H600" class="baseline" /><path d={path} />
</svg>
<style>
  svg { display: block; width: 100%; height: 62px; color: var(--pane-highlight-color, var(--pane-active-focus, var(--pane-focus))); }
  path { fill: none; stroke: currentColor; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
  .baseline { stroke: var(--border); stroke-width: 1; }
</style>
