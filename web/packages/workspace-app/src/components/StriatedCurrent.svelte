<script lang="ts">
  import YuruyurauPointCloud from "./YuruyurauPointCloud.svelte";
  import {
    buildStriatedCurrentPoints,
    STRIATED_CURRENT_BOUNDS,
  } from "./striatedCurrent";

  const PHASE_SPEED = (3 * Math.PI) / 4;
</script>

<YuruyurauPointCloud
  buildPoints={buildStriatedCurrentPoints}
  bounds={STRIATED_CURRENT_BOUNDS}
  sourceTimePerMs={PHASE_SPEED * 0.001}
/>
