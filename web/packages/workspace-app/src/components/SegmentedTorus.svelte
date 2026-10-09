<script lang="ts">
  import { onMount } from "svelte";
  import { canvasCssNumber, runWebgl2Animation } from "./canvasAnimation";
  import { createSegmentedTorusRenderer, type SegmentedTorusRenderer } from "./segmentedTorus";

  const TIME_SCALE = 0.5;
  const STATIC_SECONDS = 0;
  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;
    return runWebgl2Animation(host, (gl) => {
      let renderer: SegmentedTorusRenderer;
      try {
        renderer = createSegmentedTorusRenderer(gl);
      } catch (error) {
        console.warn("[chan] Segmented Torus WebGL renderer unavailable:", error);
        return null;
      }
      function draw(seconds: number): void {
        renderer.draw(
          seconds,
          canvasCssNumber(host, "--segmented-torus-field-scale", 1),
          canvasCssNumber(host, "--segmented-torus-tone", 0.41),
          canvasCssNumber(host, "--segmented-torus-opacity", 0.65),
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
    }, { contextAttributes: { antialias: true, depth: true } });
  });
</script>

<div class="segmented-torus" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .segmented-torus {
    position: absolute;
    inset: 0;
    z-index: 0;
    --segmented-torus-field-scale: 1;
    --segmented-torus-tone: 0.41;
    --segmented-torus-opacity: 0.65;
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .segmented-torus {
    --segmented-torus-tone: 0;
    --segmented-torus-opacity: 0.45;
  }
  :global([data-theme="dark"]) .segmented-torus {
    --segmented-torus-tone: 0.41;
    --segmented-torus-opacity: 0.65;
  }
  @media (prefers-reduced-motion: reduce) {
    .segmented-torus { opacity: 0.84; }
  }
</style>
