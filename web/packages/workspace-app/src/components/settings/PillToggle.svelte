<script lang="ts">
  // A checkbox pill, sharing the radio-pill shape. Controlled: `checked`
  // is the current value and `ontoggle` fires the write. `disabled`
  // covers the busy state the per-workspace copies already styled.

  let {
    checked,
    label,
    disabled = false,
    ontoggle,
  }: {
    checked: boolean;
    label: string;
    disabled?: boolean;
    ontoggle: (checked: boolean) => void;
  } = $props();
</script>

<label class="pill" class:on={checked}>
  <input
    type="checkbox"
    {checked}
    {disabled}
    onchange={(e) => ontoggle(e.currentTarget.checked)}
  />
  <span>{label}</span>
</label>

<style>
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
  .pill input[type="checkbox"] {
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
  .pill:has(input:disabled) {
    cursor: not-allowed;
    opacity: 0.7;
  }
</style>
