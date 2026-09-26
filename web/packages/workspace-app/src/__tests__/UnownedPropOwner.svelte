<script lang="ts">
  // The parent the ownership check needs: it owns the state and passes it down
  // unbound.
  import UnownedPropWriter from "./UnownedPropWriter.svelte";

  const thing = $state({ n: 0 });
</script>

<UnownedPropWriter {thing} />
