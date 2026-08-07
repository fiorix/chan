<script lang="ts">
  import { onMount } from "svelte";
  import {
    canvasCssNumber,
    runWebgl2Animation,
  } from "./canvasAnimation";
  import {
    createTurbulentOculusRenderer,
    type TurbulentOculusRenderer,
  } from "./turbulentOculus";

  const STATIC_TIME_SECONDS = 4.5;
  const MAX_RENDER_PIXELS = 160_000;

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;

    return runWebgl2Animation(
      host,
      (gl) => {
        let renderer: TurbulentOculusRenderer;
        try {
          renderer = createTurbulentOculusRenderer(gl);
        } catch (error) {
          console.warn(
            "[chan] Turbulent Oculus WebGL renderer unavailable:",
            error,
          );
          return null;
        }

        function draw(timeSeconds: number): void {
          const tone = canvasCssNumber(
            host,
            "--turbulent-oculus-tone",
            0.855,
          );
          const opacity = canvasCssNumber(
            host,
            "--turbulent-oculus-opacity",
            0.36,
          );
          renderer.draw(timeSeconds, tone, opacity);
        }

        function drawAt(timeMs: number): void {
          draw(timeMs * 0.001);
        }

        return {
          resize(_width, _height, reducedMotion, timeMs) {
            if (reducedMotion) draw(STATIC_TIME_SECONDS);
            else drawAt(timeMs);
          },
          frame: drawAt,
          reducedMotion: () => draw(STATIC_TIME_SECONDS),
          destroy: renderer.destroy,
        };
      },
      {
        frameRate: 24,
        maxDpr: 1,
        maxPixels: MAX_RENDER_PIXELS,
      },
    );
  });
</script>

<div class="turbulent-oculus" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .turbulent-oculus {
    position: absolute;
    inset: 0;
    z-index: 0;
    --turbulent-oculus-tone: 0.855;
    --turbulent-oculus-opacity: 0.36;
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .turbulent-oculus {
    --turbulent-oculus-tone: 0;
    --turbulent-oculus-opacity: 0.23;
  }
  :global([data-theme="dark"]) .turbulent-oculus {
    --turbulent-oculus-tone: 0.855;
    --turbulent-oculus-opacity: 0.36;
  }
  @media (prefers-reduced-motion: reduce) {
    .turbulent-oculus {
      opacity: 0.82;
    }
  }
</style>
