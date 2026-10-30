<script lang="ts">
  // Test host for fields.test.ts: a SettingField over a SliderField, or
  // over a plain control, with a save status the test drives.
  import { setContext } from "svelte";
  import SettingField from "./SettingField.svelte";
  import SliderField from "./SliderField.svelte";
  import { SAVE_STATUS, type SaveStatus } from "./commit";

  let { withSlider = true }: { withSlider?: boolean } = $props();
  let status = $state<SaveStatus>("idle");
  setContext(SAVE_STATUS, () => status);

  export function setStatus(next: SaveStatus): void {
    status = next;
  }
</script>

<SettingField label="Background opacity" pref="terminal.background_opacity">
  {#if withSlider}
    <SliderField
      value={95}
      min={80}
      max={100}
      step={1}
      format={(v) => (v >= 100 ? "100% (off)" : `${v}%`)}
      ariaLabel="opacity"
      oncommit={() => {}}
    />
  {:else}
    <span class="plain">plain</span>
  {/if}
</SettingField>
