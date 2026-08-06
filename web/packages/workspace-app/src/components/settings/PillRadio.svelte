<script lang="ts">
  // A radio-pill group, matching the shared launcher/settings pill shape.
  // Controlled: `value` is the current selection
  // and `onselect` fires the write. The pill CSS is kept local so the
  // component does not depend on a sibling's styles being mounted.

  let {
    value,
    options,
    name,
    ariaLabel,
    onselect,
  }: {
    value: string;
    options: readonly { value: string; label: string }[];
    name: string;
    ariaLabel: string;
    onselect: (value: string) => void;
  } = $props();
</script>

<div class="pills" role="radiogroup" aria-label={ariaLabel}>
  {#each options as opt (opt.value)}
    <label class="pill" class:on={value === opt.value}>
      <input
        type="radio"
        {name}
        value={opt.value}
        checked={value === opt.value}
        onchange={() => onselect(opt.value)}
      />
      <span>{opt.label}</span>
    </label>
  {/each}
</div>

<style>
  .pills {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border: 1px solid var(--btn-border);
    border-radius: 4px;
    background: var(--btn-bg);
    cursor: pointer;
    font-size: 14px;
  }
  .pill input[type="radio"] {
    width: auto;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
  }
  .pill > span {
    color: var(--text);
  }
  .pill:hover {
    border-color: var(--btn-hover);
  }
  .pill.on {
    background: var(--hover-bg);
  }
</style>
