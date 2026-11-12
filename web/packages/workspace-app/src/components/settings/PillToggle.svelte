<script lang="ts">
  // A checkbox pill, sharing the radio-pill shape. Controlled: `checked`
  // is the current value and `ontoggle` fires the write. `disabled`
  // covers the busy state the per-workspace copies already styled.
  // The pill CSS lives in SettingField (the one .pill block under
  // components/settings/); this renders the bare markup and must be
  // nested in a SettingField.

  let {
    checked,
    label,
    disabled = false,
    setting,
    ontoggle,
  }: {
    checked: boolean;
    label: string;
    disabled?: boolean;
    /// The settings index id of a toggle that shares its field with other
    /// controls, as the anchor a link from the launcher lands on.
    setting?: string;
    ontoggle: (checked: boolean) => void;
  } = $props();
</script>

<label class="pill" class:on={checked} data-setting={setting}>
  <input
    type="checkbox"
    {checked}
    {disabled}
    onchange={(e) => ontoggle(e.currentTarget.checked)}
  />
  <span>{label}</span>
</label>
