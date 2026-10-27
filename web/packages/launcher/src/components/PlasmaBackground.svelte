<script lang="ts">
  import { onMount } from "svelte";
  import { createPlasmaBackground, DEFAULT_WAVE_SPEED, hasBackgroundGpu } from "../lib/plasmaBackground";

  let { speed = DEFAULT_WAVE_SPEED }: { speed?: number } = $props();
  let canvas: HTMLCanvasElement;

  onMount(() => {
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!motion) return;
    let wave: ReturnType<typeof createPlasmaBackground> | undefined;
    let gpu: boolean | undefined;
    const sync = () => {
      const active = !motion.matches && !document.hidden && window.__chanLauncherSettled !== false;
      if (active && (gpu ??= hasBackgroundGpu())) {
        wave ??= createPlasmaBackground(canvas, () => speed);
        wave?.start();
      } else {
        wave?.stop();
        // Reduced motion and GPU absence mean a flat background, not a still wave.
        if (motion.matches) wave?.clear();
      }
    };
    sync();
    motion.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("chan-launcher-settled", sync);
    return () => {
      wave?.destroy();
      motion.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("chan-launcher-settled", sync);
    };
  });
</script>

<canvas bind:this={canvas} class="plasma-background" aria-hidden="true"></canvas>

<style>
  .plasma-background {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: -1;
    pointer-events: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .plasma-background { display: none; }
  }
</style>
