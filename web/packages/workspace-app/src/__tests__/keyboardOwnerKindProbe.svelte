<script lang="ts">
  import { owner } from "../state/keyboardOwner.svelte";

  const kind = $derived(owner()?.kind ?? "none");
</script>

<span data-owner={kind}></span>
