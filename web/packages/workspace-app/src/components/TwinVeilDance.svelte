<script lang="ts">
  import YuruyurauPointCloud from "./YuruyurauPointCloud.svelte";
  import {
    buildTwinVeilDancePoints,
    TWIN_VEIL_DANCE_BOUNDS,
  } from "./twinVeilDance";

  const PHASE_SPEED = (4 * Math.PI) / 3;
</script>

<YuruyurauPointCloud
  buildPoints={buildTwinVeilDancePoints}
  bounds={TWIN_VEIL_DANCE_BOUNDS}
  sourceTimePerMs={PHASE_SPEED * 0.001}
/>
