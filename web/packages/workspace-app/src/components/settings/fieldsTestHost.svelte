<script lang="ts">
  // Test host for fields.test.ts: owns the prop as $state so the test
  // can drive an external value change (Svelte 5 dropped $set).
  import TextField from "./TextField.svelte";

  let { oncommit }: { oncommit: (value: string) => void } = $props();
  let value = $state("before");

  export function reseed(next: string): void {
    value = next;
  }
</script>

<TextField {value} ariaLabel="field" {oncommit} />
