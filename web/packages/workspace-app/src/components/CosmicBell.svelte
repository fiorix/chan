<script lang="ts">
  import { onMount } from "svelte";
  import { canvasCssNumber, runWebgl2Animation } from "./canvasAnimation";
  import { createCosmicBellRenderer, type CosmicBellRenderer } from "./cosmicBell";

  // Each 450-degree sweep takes twelve seconds at the resting speed.
  const TIME_SCALE = 0.5;
  const STATIC_SECONDS = 1.4;
  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;
    return runWebgl2Animation(host, (gl) => {
      let renderer: CosmicBellRenderer;
      try {
        renderer = createCosmicBellRenderer(gl);
      } catch (error) {
        console.warn("[chan] Cosmic Bell WebGL renderer unavailable:", error);
        return null;
      }

      function draw(seconds: number): void {
        renderer.draw(
          seconds,
          canvasCssNumber(host, "--cosmic-bell-field-scale", 1.05),
          canvasCssNumber(host, "--cosmic-bell-tone", 0.345),
          canvasCssNumber(host, "--cosmic-bell-opacity", 0.42),
        );
      }
      function drawAt(timeMs: number): void {
        draw(timeMs * 0.001 * TIME_SCALE);
      }
      return {
        resize(_width, _height, reducedMotion, timeMs) {
          if (reducedMotion) draw(STATIC_SECONDS);
          else drawAt(timeMs);
        },
        frame: drawAt,
        reducedMotion: () => draw(STATIC_SECONDS),
        destroy: renderer.destroy,
      };
    });
  });
</script>

<div class="cosmic-bell" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .cosmic-bell {
    position: absolute;
    inset: 0;
    z-index: 0;
    --cosmic-bell-field-scale: 1.05;
    --cosmic-bell-tone: 0.345;
    --cosmic-bell-opacity: 0.42;
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .cosmic-bell {
    --cosmic-bell-tone: 0;
    --cosmic-bell-opacity: 0.75;
  }
  :global([data-theme="dark"]) .cosmic-bell {
    --cosmic-bell-tone: 0.345;
    --cosmic-bell-opacity: 0.42;
  }
  @media (prefers-reduced-motion: reduce) {
    .cosmic-bell {
      opacity: 0.84;
    }
  }
</style>
