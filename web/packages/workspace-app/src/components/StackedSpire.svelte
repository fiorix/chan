<script lang="ts">
  import { onMount } from "svelte";
  import { canvasCssNumber, runWebgl2Animation } from "./canvasAnimation";
  import { createProcessingMeshRenderer } from "./processingMesh";
  import { buildStackedSpire } from "./stackedSpire";

  let canvas = $state<HTMLCanvasElement | undefined>();
  onMount(() => {
    if (!canvas) return;
    const host = canvas;
    return runWebgl2Animation(host, (gl) => {
      let renderer: ReturnType<typeof createProcessingMeshRenderer>;
      try { renderer = createProcessingMeshRenderer(gl); }
      catch (error) { console.warn("[chan] Stacked Spire WebGL renderer unavailable:", error); return null; }
      function draw(timeMs: number): void {
        const clock = timeMs * 0.009;
        const edges = canvasCssNumber(host, "--stacked-spire-edges", 1) >= 0.5;
        const scene = buildStackedSpire(clock, edges);
        renderer.begin(
          canvasCssNumber(host, "--stacked-spire-field-scale", 1),
          canvasCssNumber(host, "--stacked-spire-tone", 0.7),
          canvasCssNumber(host, "--stacked-spire-opacity", 0.6),
          [0, 0, 0],
          true,
        );
        for (const shape of scene) renderer.draw(shape);
      }
      return {
        resize(_width, _height, reducedMotion, timeMs) { draw(reducedMotion ? 2000 : timeMs); },
        frame: (timeMs) => draw(timeMs),
        reducedMotion: () => draw(2000),
        destroy: renderer.destroy,
      };
    }, { contextAttributes: { depth: true, preserveDrawingBuffer: false } });
  });
</script>

<div class="stacked-spire" aria-hidden="true"><canvas bind:this={canvas}></canvas></div>

<style>
  .stacked-spire {
    position: absolute; inset: 0; z-index: 0;
    --stacked-spire-field-scale: 1;
    --stacked-spire-tone: 0.7;
    --stacked-spire-opacity: 0.6;
    --stacked-spire-edges: 1;
    pointer-events: none; overflow: hidden;
  }
  canvas { width: 100%; height: 100%; display: block; }
  :global([data-theme="light"]) .stacked-spire {
    --stacked-spire-tone: 0;
    --stacked-spire-opacity: 0.4;
  }
  :global([data-theme="dark"]) .stacked-spire {
    --stacked-spire-tone: 0.7;
    --stacked-spire-opacity: 0.6;
  }
</style>
