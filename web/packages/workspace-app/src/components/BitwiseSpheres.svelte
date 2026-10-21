<script lang="ts">
  import { onMount } from "svelte";
  import { canvasCssNumber, runWebgl2Animation } from "./canvasAnimation";
  import { createBitwiseSpheresRenderer } from "./bitwiseSpheres";

  let canvas = $state<HTMLCanvasElement | undefined>();
  onMount(() => {
    if (!canvas) return;
    const host = canvas;
    return runWebgl2Animation(host, (gl) => {
      let renderer: ReturnType<typeof createBitwiseSpheresRenderer>;
      try { renderer = createBitwiseSpheresRenderer(gl); }
      catch (error) { console.warn("[chan] Bitwise Spheres WebGL renderer unavailable:", error); return null; }
      function draw(timeMs: number): void {
        renderer.draw(
          1 + Math.floor(timeMs * 0.03),
          canvasCssNumber(host, "--bitwise-spheres-field-scale", 1.2),
          canvasCssNumber(host, "--bitwise-spheres-tone", 0.52),
          canvasCssNumber(host, "--bitwise-spheres-opacity", 0.295),
        );
      }
      return {
        resize(_width, _height, reducedMotion, timeMs) { draw(reducedMotion ? 1000 : timeMs); },
        frame: draw,
        reducedMotion: () => draw(1000),
        destroy: renderer.destroy,
      };
    }, { contextAttributes: { depth: true } });
  });
</script>

<div class="bitwise-spheres" aria-hidden="true"><canvas bind:this={canvas}></canvas></div>

<style>
  .bitwise-spheres {
    position: absolute; inset: 0; z-index: 0;
    --bitwise-spheres-field-scale: 1.2;
    --bitwise-spheres-tone: 0.52;
    --bitwise-spheres-opacity: 0.295;
    pointer-events: none; overflow: hidden;
  }
  canvas { width: 100%; height: 100%; display: block; }
  :global([data-theme="light"]) .bitwise-spheres {
    --bitwise-spheres-tone: 0;
    --bitwise-spheres-opacity: 0.35;
  }
  :global([data-theme="dark"]) .bitwise-spheres {
    --bitwise-spheres-tone: 0.52;
    --bitwise-spheres-opacity: 0.295;
  }
</style>
