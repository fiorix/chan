<script lang="ts">
  // A radio-pill group, matching the shared launcher/settings pill shape.
  // Controlled: `value` is the current selection
  // and `onselect` fires the write. The pill CSS lives in SettingField
  // (the one .pill block under components/settings/); this renders the
  // bare markup and must be nested in a SettingField.

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
