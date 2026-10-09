<script lang="ts">
  import { onMount } from "svelte";
  import {
    canvasCssNumber,
    runWebgl2Animation,
  } from "./canvasAnimation";
  import {
    createTenfoldDahliaRenderer,
    type TenfoldDahliaRenderer,
  } from "./tenfoldDahlia";

  const STATIC_TIME_SECONDS = 0;
  const TIME_SCALE = 0.25;
  const MAX_RENDER_PIXELS = 130_000;

  let canvas = $state<HTMLCanvasElement | undefined>();

  onMount(() => {
    if (!canvas) return;
    const host = canvas;

    return runWebgl2Animation(
      host,
      (gl) => {
        let renderer: TenfoldDahliaRenderer;
        try {
          renderer = createTenfoldDahliaRenderer(gl);
        } catch (error) {
          console.warn(
            "[chan] Tenfold Dahlia WebGL renderer unavailable:",
            error,
          );
          return null;
        }

        function draw(timeSeconds: number): void {
          const fieldScale = canvasCssNumber(
            host,
            "--tenfold-dahlia-field-scale",
            0.65,
          );
          const tone = canvasCssNumber(
            host,
            "--tenfold-dahlia-tone",
            0.58,
          );
          const opacity = canvasCssNumber(
            host,
            "--tenfold-dahlia-opacity",
            0.655,
          );
          const exposure = canvasCssNumber(
            host,
            "--tenfold-dahlia-exposure",
            0.55,
          );
          renderer.draw(
            timeSeconds,
            fieldScale,
            tone,
            opacity,
            exposure,
          );
        }

        function drawAt(timeMs: number): void {
          draw(timeMs * 0.001 * TIME_SCALE);
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
        frameRate: 20,
        maxDpr: 1,
        maxPixels: MAX_RENDER_PIXELS,
      },
    );
  });
</script>

<div class="tenfold-dahlia" aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .tenfold-dahlia {
    position: absolute;
    inset: 0;
    z-index: 0;
    --tenfold-dahlia-field-scale: 0.65;
    --tenfold-dahlia-tone: 0.58;
    --tenfold-dahlia-opacity: 0.655;
    --tenfold-dahlia-exposure: 0.55;
    background-color: rgb(28, 28, 30);
    pointer-events: none;
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  :global([data-theme="light"]) .tenfold-dahlia {
    --tenfold-dahlia-tone: 0;
    --tenfold-dahlia-opacity: 0.28;
    --tenfold-dahlia-exposure: 1.2;
    background-color: rgb(255, 255, 255);
  }
  :global([data-theme="dark"]) .tenfold-dahlia {
    --tenfold-dahlia-tone: 0.58;
    --tenfold-dahlia-opacity: 0.655;
    --tenfold-dahlia-exposure: 0.55;
    background-color: rgb(28, 28, 30);
  }
  @media (prefers-reduced-motion: reduce) {
    .tenfold-dahlia {
      opacity: 0.84;
    }
  }
</style>
