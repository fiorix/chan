<script lang="ts">
  import YuruyurauRotationalField from "./YuruyurauRotationalField.svelte";
  import { buildHexagonalBloomBasePoints } from "./hexagonalBloom";

  const PHASE_SPEED = Math.PI / 4;
</script>

<YuruyurauRotationalField
  buildBasePoints={buildHexagonalBloomBasePoints}
  rotationCount={6}
  sourceTimePerMs={PHASE_SPEED * 0.001}
  centerFadeRadius={140}
/>
