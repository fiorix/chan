<script lang="ts">
  import YuruyurauRotationalField from "./YuruyurauRotationalField.svelte";
  import { buildFourteenfoldBloomBasePoints } from "./fourteenfoldBloom";

  const PHASE_SPEED = Math.PI / 4;
</script>

<YuruyurauRotationalField
  buildBasePoints={buildFourteenfoldBloomBasePoints}
  rotationCount={14}
  sourceTimePerMs={PHASE_SPEED * 0.001}
  centerFadeRadius={140}
/>
