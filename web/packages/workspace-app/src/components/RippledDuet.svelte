<script lang="ts">
  import YuruyurauPointCloud from "./YuruyurauPointCloud.svelte";
  import {
    buildRippledDuetPoints,
    RIPPLED_DUET_BOUNDS,
  } from "./rippledDuet";

  const PHASE_SPEED = (4 * Math.PI) / 3;
</script>

<YuruyurauPointCloud
  buildPoints={buildRippledDuetPoints}
  bounds={RIPPLED_DUET_BOUNDS}
  sourceTimePerMs={PHASE_SPEED * 0.001}
/>
