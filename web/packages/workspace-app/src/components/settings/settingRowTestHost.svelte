<script lang="ts">
  // Test host for settingsIndex.live.test.ts: draws one index entry the way
  // a launcher row does, from a derived read inside a component, where a
  // read that wrote state would throw.
  import { settingEntry } from "./settingsIndex";

  let { id }: { id: string } = $props();

  const value = $derived(settingEntry(id).read());
</script>

<output>{String(value)}</output>
