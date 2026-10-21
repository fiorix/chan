<script lang="ts">
  import { onMount } from "svelte";
  import { canvasCssNumber, runWebgl2Animation } from "./canvasAnimation";
  import { createProcessingMeshRenderer } from "./processingMesh";
  import { buildTorusLantern } from "./torusLantern";

  let canvas = $state<HTMLCanvasElement | undefined>();
  onMount(() => {
    if (!canvas) return;
    const host = canvas;
    return runWebgl2Animation(host, (gl) => {
      let renderer: ReturnType<typeof createProcessingMeshRenderer>;
      try { renderer = createProcessingMeshRenderer(gl); }
      catch (error) { console.warn("[chan] Torus Lantern WebGL renderer unavailable:", error); return null; }
      function draw(timeMs: number): void {
        const clock = timeMs * 0.00015;
        const { scene, light } = buildTorusLantern(clock);
        renderer.begin(
          canvasCssNumber(host, "--torus-lantern-field-scale", 1.3),
          canvasCssNumber(host, "--torus-lantern-tone", 0.48),
          canvasCssNumber(host, "--torus-lantern-opacity", 0.575),
          light,
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

<div class="torus-lantern" aria-hidden="true"><canvas bind:this={canvas}></canvas></div>

<style>
  .torus-lantern {
    position: absolute; inset: 0; z-index: 0;
    --torus-lantern-field-scale: 1.3;
    --torus-lantern-tone: 0.48;
    --torus-lantern-opacity: 0.575;
    pointer-events: none; overflow: hidden;
  }
  canvas { width: 100%; height: 100%; display: block; }
  :global([data-theme="light"]) .torus-lantern {
    --torus-lantern-tone: 0;
    --torus-lantern-opacity: 0.4;
  }
  :global([data-theme="dark"]) .torus-lantern {
    --torus-lantern-tone: 0.48;
    --torus-lantern-opacity: 0.575;
  }
</style>
