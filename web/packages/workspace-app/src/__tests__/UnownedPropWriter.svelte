<script lang="ts">
  // Writes a field of a prop its parent passed without `bind:`, the write the
  // development build reports as an ownership_invalid_mutation.
  let { thing }: { thing: { n: number } } = $props();
</script>

<button onclick={() => (thing.n += 1)}>{thing.n}</button>
