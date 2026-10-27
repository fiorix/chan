<script lang="ts">
  import AllWindows from "../components/AllWindows.svelte";
  import Carousel from "../components/Carousel.svelte";
  import type { MachineTree } from "../lib/machineTree";
  let { tree }: { tree: MachineTree } = $props();
  const items = [{ key: "all-windows", label: "All windows" }, { key: "other", label: "Other" }];
</script>

<Carousel deck="computers" {items} label="Computers">
  {#snippet card(item)}
    {#if item.key === "all-windows"}<AllWindows {tree} />{:else}<section class="card"></section>{/if}
  {/snippet}
</Carousel>
