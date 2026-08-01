<script lang="ts">
  import YuruyurauPointCloud from "./YuruyurauPointCloud.svelte";
  import {
    buildLorenzConstellationPoints,
    LORENZ_CONSTELLATION_BOUNDS,
  } from "./lorenzConstellation";

  // Half the source sketch's 60 frames/second cadence, per product direction.
  const SOURCE_FRAME_SPEED = 30;
</script>

<YuruyurauPointCloud
  buildPoints={buildLorenzConstellationPoints}
  bounds={LORENZ_CONSTELLATION_BOUNDS}
  sourceTimePerMs={SOURCE_FRAME_SPEED * 0.001}
/>
