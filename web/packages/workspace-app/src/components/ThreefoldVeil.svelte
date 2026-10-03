<script lang="ts">
  import YuruyurauPointCloud from "./YuruyurauPointCloud.svelte";
  import {
    buildThreefoldVeilPoints,
    THREEFOLD_VEIL_BOUNDS,
  } from "./threefoldVeil";

  const PHASE_SPEED = Math.PI;
</script>

<YuruyurauPointCloud
  buildPoints={buildThreefoldVeilPoints}
  bounds={THREEFOLD_VEIL_BOUNDS}
  sourceTimePerMs={PHASE_SPEED * 0.001}
/>
